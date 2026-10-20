// Browser-compatible experimental fork of tools/backtest-execution.mjs.
// The historical validation engine remains frozen and unchanged.
// Deterministic long/cash execution. Signals must already have been calculated
// using only the history available at each row's close.
const DAY_MS = 86400000;
const BUY = new Set(['BUY', 'STRONG_BUY']);
const SELL = new Set(['SELL', 'STRONG_SELL']);
const VALID_SIGNALS = new Set([...BUY, ...SELL, 'HOLD', 'WAIT']);
const sum = values => values.reduce((total, value) => total + value, 0);
const mean = values => values.length ? sum(values) / values.length : null;
const pct = value => value === null ? null : value * 100;
const dateOf = bar => bar.date ?? bar.fecha;
const dayNumber = date => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(dayNumber(date)) && new Date(dayNumber(date) * DAY_MS).toISOString().slice(0, 10) === date;
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function tradeStatistics(trades) {
  // A stale terminal mark is a valuation assumption, not an observed closed trade.
  const settled = trades.filter(trade => trade.exitIsExecutable);
  const winners = settled.filter(trade => trade.netProfit > 1e-9);
  const losers = settled.filter(trade => trade.netProfit < -1e-9);
  const grossWinningProfit = sum(winners.map(trade => trade.netProfit));
  const grossLosingLoss = -sum(losers.map(trade => trade.netProfit));
  return {
    tradeCount: trades.length, closedTrades: settled.length,
    signalExits: settled.filter(trade => trade.exitReason === 'signal').length,
    terminalExits: settled.filter(trade => trade.exitReason === 'terminal').length,
    syntheticTerminalExits: trades.length - settled.length,
    wins: winners.length, losses: losers.length,
    breakevenTrades: settled.length - winners.length - losers.length,
    winRate: settled.length ? winners.length / settled.length : null,
    profitFactor: grossLosingLoss > 0 ? grossWinningProfit / grossLosingLoss : null,
    profitFactorNoLosses: settled.length > 0 && grossLosingLoss === 0,
    grossWinningProfit, grossLosingLoss,
    averageTradeReturn: mean(settled.map(trade => trade.netReturn)),
    averageHoldingSessions: mean(settled.map(trade => trade.holdingSessions)),
    medianHoldingSessions: median(settled.map(trade => trade.holdingSessions)),
    averageHoldingCalendarDays: mean(settled.map(trade => trade.holdingCalendarDays))
  };
}

/**
 * Equal or custom initial capital sleeves, fractional shares, no rebalancing, shorts,
 * leverage, dividends or interest. Rates are decimal ratios unless suffixed Pct.
 * commissionBps and slippageBps are charged on EACH side of a transaction.
 * The predeclared final close liquidates all positions, independently of signals.
 * Supply the full expected exchange calendar, including warmup dates, to detect
 * missing sessions. Otherwise the union of observed bars is an imperfect proxy.
 * An explicitly empty bar array reserves that ticker's sleeve in permanent cash;
 * the caller must distinguish unavailable instruments from failed data downloads.
 */
export function runPortfolio(panel, options = {}) {
  const strategy = options.strategy ?? 'new';
  if (!['old', 'new', 'buy_hold'].includes(strategy)) throw new Error('Unknown strategy.');
  const initialCapital = options.initialCapital ?? 100000;
  const commissionBps = options.commissionBps ?? 0;
  const slippageBps = options.slippageBps ?? 5;
  const warmupBars = options.warmupBars ?? 50;
  const initialPosition = options.initialPosition ?? 'cash';
  if (!['cash', 'long'].includes(initialPosition)) throw new Error('initialPosition must be cash or long.');
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new Error('initialCapital must be positive.');
  for (const [name, value] of Object.entries({ commissionBps, slippageBps })) {
    if (!Number.isFinite(value) || value < 0 || value >= 10000) throw new Error(`${name} must be between 0 and 10000 bps (exclusive).`);
  }
  if (!Number.isSafeInteger(warmupBars) || warmupBars < 1) throw new Error('warmupBars must be a positive integer.');
  if (!Array.isArray(panel?.series) || !panel.series.length) throw new Error('panel.series must be nonempty.');
  const seenTickers = new Set(), observedDates = new Set();
  for (const series of panel.series) {
    if (typeof series.ticker !== 'string' || !series.ticker || seenTickers.has(series.ticker)) throw new Error('Tickers must be nonempty and unique.');
    seenTickers.add(series.ticker);
    if (!Array.isArray(series.bars)) throw new Error(`Bars must be an array for ${series.ticker}.`);
    if (strategy !== 'buy_hold' && (!Array.isArray(series.signals) || series.signals.length !== series.bars.length)) {
      throw new Error(`Signals must align with bars for ${series.ticker}.`);
    }
    let previousDate = null;
    series.bars.forEach((bar, index) => {
      const date = dateOf(bar);
      if (!validDate(date) || (previousDate && date <= previousDate)) throw new Error(`Bars must have unique ascending ISO dates for ${series.ticker}.`);
      if (![bar.open, bar.close].every(value => Number.isFinite(value) && value > 0)) throw new Error(`Invalid execution prices for ${series.ticker} on ${date}.`);
      const signal = series.signals?.[index];
      if (signal?.date && signal.date !== date) throw new Error(`Signal date is misaligned for ${series.ticker}.`);
      if (strategy !== 'buy_hold' && signal != null && !VALID_SIGNALS.has(signal[`${strategy}Signal`])) throw new Error(`Invalid ${strategy} signal for ${series.ticker} on ${date}.`);
      previousDate = date;
      observedDates.add(date);
    });
  }
  if (!observedDates.size) throw new Error('At least one ticker must have historical bars.');
  let weights = null;
  if (options.weights !== undefined) {
    const provided = options.weights;
    if (!provided || typeof provided !== 'object' || Array.isArray(provided) ||
        Object.keys(provided).length !== seenTickers.size ||
        Object.keys(provided).some(ticker => !seenTickers.has(ticker)) ||
        [...seenTickers].some(ticker => !Object.hasOwn(provided, ticker) ||
          !Number.isFinite(provided[ticker]) || provided[ticker] <= 0)) {
      throw new Error('weights must contain one positive finite fraction for every selected ticker, and no other ticker.');
    }
    const weightSum = sum(Object.values(provided));
    if (Math.abs(weightSum - 1) > 1e-9) throw new Error('weights must sum to 1.');
    // Only remove summation roundoff after validating the requested total.
    weights = Object.fromEntries(Object.entries(provided).map(([ticker, weight]) => [ticker, weight / weightSum]));
  }
  const inactiveTickers = panel.series.filter(series => !series.bars.length).map(series => series.ticker);
  const suppliedCalendar = options.calendarDates != null;
  if (suppliedCalendar && (!Array.isArray(options.calendarDates) || !options.calendarDates.length ||
      options.calendarDates.some((date, index) => !validDate(date) || (index > 0 && date <= options.calendarDates[index - 1])))) {
    throw new Error('calendarDates must contain unique ascending ISO session dates.');
  }
  const calendarDates = [...new Set(suppliedCalendar ? options.calendarDates : observedDates)].sort();
  const calendarIndex = new Map(calendarDates.map((date, index) => [date, index]));
  if (suppliedCalendar && [...observedDates].some(date => !calendarIndex.has(date))) {
    throw new Error('A bar date is outside the supplied exchange calendar.');
  }
  const observedSorted = [...observedDates].sort();
  const defaultStarts = panel.series.map(series => dateOf(series.bars[warmupBars] ?? {})).filter(Boolean).sort();
  const requestedStartDate = options.startDate ?? defaultStarts[0] ?? observedSorted[0];
  const requestedEndDate = options.endDate ?? observedSorted.at(-1);
  if (!validDate(requestedStartDate) || !validDate(requestedEndDate) || requestedStartDate > requestedEndDate) throw new Error('Invalid evaluation date range.');
  const dates = calendarDates.filter(date => date >= requestedStartDate && date <= requestedEndDate);
  if (!dates.length) throw new Error('Evaluation period contains no calendar sessions.');
  const startDate = dates[0], endDate = dates.at(-1);
  const commission = commissionBps / 10000, slippage = slippageBps / 10000;
  const allocation = initialCapital / panel.series.length;
  const equalWeights = weights === null || Object.values(weights).every(weight => weight === Object.values(weights)[0]);
  const capitalFor = ticker => equalWeights ? allocation : initialCapital * weights[ticker];
  const sleeves = panel.series.map(series => ({ ...series,
    byDate: new Map(series.bars.map((bar, index) => [dateOf(bar), index])),
    initialCapital: capitalFor(series.ticker), cash: capitalFor(series.ticker), units: 0, entry: null,
    lastClose: null, lastMarkDate: null, maxEquity: capitalFor(series.ticker), maxDrawdown: 0,
    commissionCost: 0, slippageCost: 0, notionalTraded: 0, trades: [],
    staleMarkSessions: 0, staleSignalSkips: 0, investedSessions: 0,
    terminalStale: false, everEntered: false
  }));
  const trades = [], executions = [], equityCurve = [];
  let peakEquity = initialCapital, previousEquity = initialCapital;
  let cumulativeCommission = 0, cumulativeSlippage = 0, exposureSum = 0;
  let staleMarkSessions = 0, staleSignalSkips = 0;

  function recordExecution(sleeve, { date, side, referencePrice, signalDate, reason, dateIndex, markDate = date, executable = true }) {
    const buying = side === 'BUY';
    const executionPrice = referencePrice * (buying ? 1 + slippage : 1 - slippage);
    const units = buying ? sleeve.cash / (executionPrice * (1 + commission)) : sleeve.units;
    const executionNotional = units * executionPrice;
    const commissionCost = executionNotional * commission;
    const slippageCost = units * referencePrice * slippage;
    const event = { ticker: sleeve.ticker, date, side, reason, signalDate,
      referencePrice, executionPrice, units, executionNotional,
      commissionCost, slippageCost, totalCost: commissionCost + slippageCost,
      markDate, executable };
    executions.push(event);
    sleeve.commissionCost += commissionCost;
    sleeve.slippageCost += slippageCost;
    sleeve.notionalTraded += units * referencePrice;
    cumulativeCommission += commissionCost;
    cumulativeSlippage += slippageCost;
    if (buying) {
      sleeve.entry = { ...event, initialCash: sleeve.cash, dateIndex };
      sleeve.units = units;
      sleeve.cash = 0;
      sleeve.everEntered = true;
    } else {
      const proceeds = executionNotional - commissionCost, entry = sleeve.entry;
      const netProfit = proceeds - entry.initialCash;
      const trade = { ticker: sleeve.ticker, entryDate: entry.date, entrySignalDate: entry.signalDate,
        exitDate: date, exitSignalDate: signalDate, exitReason: reason,
        entryReferencePrice: entry.referencePrice, exitReferencePrice: referencePrice,
        entryPrice: entry.executionPrice, exitPrice: executionPrice, units,
        capitalInvested: entry.initialCash, netProceeds: proceeds, netProfit,
        netReturn: netProfit / entry.initialCash,
        commissionCost: entry.commissionCost + commissionCost,
        slippageCost: entry.slippageCost + slippageCost,
        totalCost: entry.totalCost + event.totalCost,
        holdingSessions: dateIndex - entry.dateIndex + (reason === 'terminal' ? 1 : 0),
        holdingCalendarDays: dayNumber(date) - dayNumber(entry.date),
        exitMarkDate: markDate, exitIsExecutable: executable };
      trades.push(trade);
      sleeve.trades.push(trade);
      sleeve.cash = proceeds;
      sleeve.units = 0;
      sleeve.entry = null;
    }
  }

  dates.forEach((date, dateIndex) => {
    const expectedPreviousDate = calendarDates[calendarIndex.get(date) - 1] ?? null;
    let preTerminalInvested = 0, preTerminalEquity = 0, stalePositions = 0;
    for (const sleeve of sleeves) {
      const barIndex = sleeve.byDate.get(date);
      const bar = barIndex === undefined ? null : sleeve.bars[barIndex];
      const previousBar = barIndex > 0 ? sleeve.bars[barIndex - 1] : null;
      const previousDate = previousBar ? dateOf(previousBar) : null;
      const ready = barIndex !== undefined && barIndex >= warmupBars;
      const contiguous = ready && previousDate === expectedPreviousDate;
      const previousSignal = ready ? sleeve.signals?.[barIndex - 1]?.[`${strategy}Signal`] : null;
      const initialEntry = initialPosition === 'long' && !sleeve.everEntered;
      const actionable = strategy === 'buy_hold' || initialEntry ? !sleeve.everEntered :
        sleeve.units === 0 ? BUY.has(previousSignal) : SELL.has(previousSignal);
      if (ready && actionable && !contiguous) {
        sleeve.staleSignalSkips++;
        staleSignalSkips++;
      }
      if (bar && contiguous && actionable) {
        const side = strategy === 'buy_hold' || initialEntry || sleeve.units === 0 ? 'BUY' : 'SELL';
        recordExecution(sleeve, { date, side, referencePrice: bar.open,
          signalDate: strategy === 'buy_hold' || initialEntry ? null : previousDate,
          reason: strategy === 'buy_hold' ? 'benchmark' : initialEntry ? 'initial_position' : 'signal', dateIndex });
      }
      if (bar) {
        sleeve.lastClose = bar.close;
        sleeve.lastMarkDate = date;
      }
      const investedValue = sleeve.units * (sleeve.lastClose ?? 0);
      const equity = sleeve.cash + investedValue;
      preTerminalInvested += investedValue;
      preTerminalEquity += equity;
      if (sleeve.units > 0) {
        sleeve.investedSessions++;
        if (!bar) {
          sleeve.staleMarkSessions++;
          staleMarkSessions++;
          stalePositions++;
        }
      }
      if (dateIndex === dates.length - 1 && sleeve.units > 0) {
        sleeve.terminalStale = !bar;
        recordExecution(sleeve, { date, side: 'SELL', referencePrice: sleeve.lastClose,
          signalDate: null, reason: 'terminal', dateIndex, markDate: sleeve.lastMarkDate,
          executable: Boolean(bar) });
      }
      const closingEquity = sleeve.cash + sleeve.units * (sleeve.lastClose ?? 0);
      sleeve.maxEquity = Math.max(sleeve.maxEquity, closingEquity);
      sleeve.maxDrawdown = Math.min(sleeve.maxDrawdown, closingEquity / sleeve.maxEquity - 1);
    }
    const cash = sum(sleeves.map(sleeve => sleeve.cash));
    const investedValue = sum(sleeves.map(sleeve => sleeve.units * (sleeve.lastClose ?? 0)));
    const equity = cash + investedValue;
    const exposureBeforeTerminal = preTerminalEquity > 0 ? preTerminalInvested / preTerminalEquity : 0;
    exposureSum += exposureBeforeTerminal;
    peakEquity = Math.max(peakEquity, equity);
    equityCurve.push({ date, equity, cash, investedValue,
      exposure: equity > 0 ? investedValue / equity : 0, exposureBeforeTerminal,
      dailyReturn: equity / previousEquity - 1, drawdown: equity / peakEquity - 1,
      stalePositions, commissionCost: cumulativeCommission, slippageCost: cumulativeSlippage });
    previousEquity = equity;
  });

  const finalEquity = equityCurve.at(-1).equity;
  const returns = equityCurve.map(row => row.dailyReturn);
  const averageDailyReturn = mean(returns);
  const dailyVariance = returns.length > 1 ? sum(returns.map(value => (value - averageDailyReturn) ** 2)) / (returns.length - 1) : 0;
  const dailyVolatility = Math.sqrt(dailyVariance);
  const calendarDays = Math.max(1, dayNumber(endDate) - dayNumber(startDate));
  const calendarYears = calendarDays / 365.25;
  const metrics = {
    initialCapital, finalEquity, netProfit: finalEquity - initialCapital,
    totalReturn: finalEquity / initialCapital - 1,
    cagr: (finalEquity / initialCapital) ** (1 / calendarYears) - 1,
    maxDrawdown: Math.min(0, ...equityCurve.map(row => row.drawdown)),
    annualizedVolatility: dailyVolatility * Math.sqrt(252),
    sharpeRatio: dailyVolatility > 0 ? averageDailyReturn / dailyVolatility * Math.sqrt(252) : null,
    averageExposure: exposureSum / dates.length,
    commissionCost: cumulativeCommission, slippageCost: cumulativeSlippage,
    totalCost: cumulativeCommission + cumulativeSlippage,
    turnover: sum(sleeves.map(sleeve => sleeve.notionalTraded)) / initialCapital,
    ...tradeStatistics(trades)
  };
  for (const field of ['totalReturn', 'cagr', 'maxDrawdown', 'annualizedVolatility', 'averageExposure', 'winRate', 'averageTradeReturn']) metrics[`${field}Pct`] = pct(metrics[field]);
  const perTicker = sleeves.map(sleeve => ({
    ticker: sleeve.ticker, initialCapital: sleeve.initialCapital, finalEquity: sleeve.cash,
    inactive: !sleeve.bars.length,
    netProfit: sleeve.cash - sleeve.initialCapital, totalReturn: sleeve.cash / sleeve.initialCapital - 1,
    totalReturnPct: (sleeve.cash / sleeve.initialCapital - 1) * 100,
    maxDrawdown: sleeve.maxDrawdown, investedSessions: sleeve.investedSessions,
    investedSessionFraction: sleeve.investedSessions / dates.length,
    commissionCost: sleeve.commissionCost, slippageCost: sleeve.slippageCost,
    totalCost: sleeve.commissionCost + sleeve.slippageCost,
    staleMarkSessions: sleeve.staleMarkSessions, staleSignalSkips: sleeve.staleSignalSkips,
    lastMarkDate: sleeve.lastMarkDate, terminalStale: sleeve.terminalStale,
    ...tradeStatistics(sleeve.trades)
  }));
  return {
    strategy, options: { initialCapital, commissionBps, slippageBps, warmupBars, initialPosition, ...(weights ? { weights } : {}) },
    period: { startDate, endDate, requestedStartDate, requestedEndDate, sessions: dates.length, calendarDays, calendarYears },
    assumptions: {
      allocation: weights ? 'Custom initial per-ticker sleeves; fractional shares; no rebalancing or cash redistribution.' : 'Equal initial per-ticker sleeves; fractional shares; no rebalancing.',
      inactiveTickers: 'Tickers with explicitly empty history keep their initial allocation in cash throughout; no redistribution or invented prices.',
      execution: 'Previous completed session signal executes at the next contiguous session open.',
      terminal: 'All holdings liquidated at the predeclared final close, including both-side costs. A missing final bar produces a flagged synthetic mark excluded from settled trade statistics.',
      benchmark: `Buy at first eligible evaluation-period open after ${warmupBars} history bars and hold to terminal close.`,
      cashAnnualReturn: 0, riskFreeAnnualRate: 0, volatilitySessionsPerYear: 252,
      initialPosition: initialPosition === 'long' ? 'Enter at first eligible open regardless of signal, then follow strategy.' : 'Start every sleeve in cash.',
      cagrBasis: 'Actual calendar-date span / 365.25, minimum one day.',
      priceReturnOnly: true, dividendsIncluded: false,
      exposure: 'Mean invested share of equity at each close before any terminal liquidation.',
      profitFactor: 'Sum of positive net settled trade profits / absolute sum of negative net settled trade profits; null if no losses.',
      calendarSource: suppliedCalendar ? 'supplied expected sessions' : 'union of observed panel dates'
    },
    metrics, equityCurve, trades, executions, perTicker,
    dataQuality: {
      staleMarkSessions, staleSignalSkips, inactiveTickers,
      staleTerminalTickers: sleeves.filter(sleeve => sleeve.terminalStale).map(sleeve => sleeve.ticker),
      calendarIsObservedUnion: !suppliedCalendar,
      warnings: [
        ...(!suppliedCalendar ? ['Calendar inferred from observed dates cannot detect a session missing from every ticker.'] : []),
        ...(inactiveTickers.length ? [`${inactiveTickers.length} ticker(s) have explicitly empty history; their ${weights ? 'custom' : 'equal'} initial allocations remain in cash throughout.`] : []),
        ...(sleeves.some(sleeve => sleeve.terminalStale) ? ['Some terminal valuations use stale prices and are not observable executions.'] : [])
      ]
    }
  };
}
