import test from 'node:test';
import assert from 'node:assert/strict';
import { exclusiveEvents, noSignalExits, evaluateCandidate, executionBarsWithSignals } from '../tools/validate-exits.mjs';
import { marketDates } from '../tools/backtest.mjs';
import { runPortfolio } from '../tools/backtest-execution.mjs';

const date = index => new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
function panel(count = 80) {
  const bars = Array.from({ length: count }, (_, index) => ({ date: date(index),
    open: 100, high: 100, low: 100, close: 100, vol: 1000 }));
  return { series: [{ ticker: 'TEST', bars,
    signals: bars.map(bar => ({ date: bar.date, oldSignal: 'HOLD', newSignal: 'HOLD' })) }] };
}
const options = (fixture, changes = {}) => ({ startDate: date(50), endDate: date(79),
  calendarDates: fixture.series[0].bars.map(bar => bar.date), horizons: [5], ...changes });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('no-exit ablation removes only v2 sales, preserves every v2 purchase and does not mutate the panel', () => {
  const fixture = panel(), labels = ['WAIT', 'HOLD', 'BUY', 'STRONG_BUY', 'SELL', 'STRONG_SELL'];
  labels.forEach((label, index) => Object.assign(fixture.series[0].signals[index], { oldSignal: label, newSignal: label }));
  fixture.series.push({ ticker: 'NOT_LISTED', bars: [], signals: [] });
  const before = structuredClone(fixture), transformed = noSignalExits(fixture);
  assert.deepEqual(fixture, before);
  assert.deepEqual(transformed.series[0].signals.slice(0, 6).map(row => row.oldSignal), ['WAIT', 'HOLD', 'BUY', 'STRONG_BUY', 'HOLD', 'HOLD']);
  assert.deepEqual(transformed.series[0].signals.map(row => row.newSignal), before.series[0].signals.map(row => row.newSignal));
  assert.deepEqual(transformed.series[0].bars, before.series[0].bars);
  assert.deepEqual(transformed.series[1], before.series[1]);
});

test('ordinary and confirmed events use exclusive labels; ALL uses combined family onsets', () => {
  const fixture = panel(), series = fixture.series[0];
  for (const model of ['old', 'new']) {
    for (const [index, value] of [[49, 'BUY'], [50, 'STRONG_BUY'], [60, 'SELL'], [61, 'STRONG_SELL']]) {
      series.signals[index][`${model}Signal`] = value;
    }
  }
  const result = exclusiveEvents(fixture, options(fixture, { horizons: [1] }));
  for (const model of ['old', 'new']) for (const direction of ['buy', 'sell']) {
    const ordinaryIndex = direction === 'buy' ? 49 : 60, confirmedIndex = ordinaryIndex + 1;
    const events = category => result.events.filter(row => row.model === model && row.direction === direction && row.category === category);
    assert.deepEqual(events('all').map(row => row.signalDate), [date(ordinaryIndex)]);
    assert.deepEqual(events('ordinary').map(row => row.signalDate), [date(ordinaryIndex)]);
    assert.deepEqual(events('confirmed').map(row => row.signalDate), [date(confirmedIndex)]);
    const summary = result.summaries.find(row => row.model === model && row.direction === direction && row.category === 'confirmed');
    assert.equal(summary.count, 1); assert.equal(summary.tickers, 1);
    assert.equal(summary.insufficientConfirmedSample, true);
  }
  assert.match(result.interpretation, /windows can overlap across categories/);
});

test('events execute after the signal at the next open and charge both sides of buying or selling to cash', () => {
  const fixture = panel(), series = fixture.series[0];
  series.signals[49].oldSignal = 'BUY'; series.signals[49].newSignal = 'STRONG_SELL';
  series.bars[49].open = 1; series.bars[49].close = 1;
  series.bars[50].open = 100; series.bars[55].open = 90;
  const result = exclusiveEvents(fixture, options(fixture, { commissionBps: 10, slippageBps: 20 }));
  const factor = (1 - 0.002) * (1 - 0.001) / ((1 + 0.002) * (1 + 0.001));
  const buy = result.events.find(row => row.model === 'old' && row.category === 'ordinary');
  const sell = result.events.find(row => row.model === 'new' && row.category === 'confirmed');
  assert.equal(buy.entryDate, date(50)); assert.equal(buy.exitDate, date(55));
  assert.equal(sell.signalDate, date(49)); assert.equal(sell.entryDate, date(50));
  near(buy.assetReturn, -0.1); near(buy.outcome, 0.9 * factor - 1);
  near(sell.outcome, factor - 0.9);
  assert.match(result.interpretation, /not short return/);
});

test('same-category duplicate bursts, overlapping horizons and incomplete end windows are excluded', () => {
  const fixture = panel(), series = fixture.series[0];
  for (const index of [49, 50, 52, 60, 78]) series.signals[index].newSignal = 'BUY';
  const result = exclusiveEvents(fixture, options(fixture));
  const events = result.events.filter(row => row.model === 'new' && row.category === 'ordinary' && row.direction === 'buy');
  assert.deepEqual(events.map(row => row.signalDate), [date(49), date(60)]);
  const empty = result.summaries.find(row => row.model === 'new' && row.category === 'confirmed' && row.direction === 'buy');
  assert.equal(empty.count, 0); assert.equal(empty.meanOutcome, null);
  assert.equal(empty.medianOutcome, null); assert.equal(empty.positiveFraction, null);
  assert.equal(empty.insufficientConfirmedSample, true);
});

test('missing next-open sessions and interior calendar gaps cannot masquerade as complete event windows', () => {
  for (const missing of [50, 53]) {
    const fixture = panel(), series = fixture.series[0], evaluation = options(fixture);
    series.signals[49].newSignal = 'BUY';
    series.bars.splice(missing, 1); series.signals.splice(missing, 1);
    assert.equal(exclusiveEvents(fixture, evaluation).events.length, 0);
  }
});

test('event horizons and costs reject noncausal or nonnumeric inputs', () => {
  const fixture = panel(), evaluation = options(fixture);
  for (const horizons of [[], [0], [-1], [1.1], [Infinity], [NaN], ['5'], [5, 5], null, 5]) {
    assert.throws(() => exclusiveEvents(fixture, { ...evaluation, horizons }), /horizons/);
  }
  for (const key of ['commissionBps', 'slippageBps']) for (const value of [-1, 10000, Infinity, NaN, '0', null]) {
    assert.throws(() => exclusiveEvents(fixture, { ...evaluation, [key]: value }), /costs/);
  }
});

test('future observations cannot change already completed event windows', () => {
  const fixture = panel(), series = fixture.series[0];
  series.signals[49].newSignal = 'STRONG_BUY';
  const before = exclusiveEvents(fixture, options(fixture));
  const changed = structuredClone(fixture);
  for (let index = 60; index < changed.series[0].bars.length; index++) {
    changed.series[0].bars[index].open = 1000 + index;
    changed.series[0].signals[index].newSignal = 'STRONG_SELL';
  }
  const after = exclusiveEvents(changed, options(changed));
  assert.deepEqual(after.events.filter(row => row.exitDate < date(60)), before.events);
});

test('evaluation rejects an incomplete or extra SPY calendar before portfolio calculations', () => {
  const fixture = panel(), calendar = { firstYear: 2020, lastYear: 2020, holidays: ['2020-01-01'] };
  fixture.series[0].ticker = 'SPY';
  const protocol = { historicalHoldout: { warmupStart: '2020-01-01', start: '2020-01-02', end: '2020-02-28' } };
  const universe = { instruments: [{ ticker: 'SPY', type: 'ETF', dailyLeverage: 1 }] };
  assert.throws(() => evaluateCandidate(fixture, { protocol, universe, calendar }), /SPY provider dates do not match/);
  assert.throws(() => evaluateCandidate({ series: [] }, { protocol, universe, calendar }), /SPY provider dates do not match/);
});

test('full evaluator handles synthetic cash sleeves and fixed comparators without hidden scenario assumptions', () => {
  const calendar = { firstYear: 2020, lastYear: 2020, holidays: ['2020-01-01'] };
  const dates = marketDates(calendar, '2020-01-01', '2020-03-31');
  const fixture = { metadata: { firstBarDate: dates[0] }, quality: {}, series: [
    { ticker: 'SPY', bars: dates.map(day => ({ date: day, open: 100, close: 100, high: 100, low: 100, vol: 1000 })),
      signals: dates.map(day => ({ date: day, oldSignal: 'HOLD', newSignal: 'HOLD' })) },
    { ticker: 'IPO', bars: [], signals: [] }
  ] };
  const universe = { instruments: [{ ticker: 'SPY', type: 'ETF', dailyLeverage: 1 }, { ticker: 'IPO', type: 'STOCK' }] };
  const protocol = {
    historicalHoldout: { warmupStart: '2020-01-01', start: dates[50], end: '2020-03-31' },
    knownDevelopmentPeriod: { start: dates[50], end: '2020-03-31' },
    execution: { initialCapital: 1000, commissionBpsPerSide: 0, primarySlippageBpsPerSide: 5, sensitivitySlippageBpsPerSide: [0, 10, 25] },
    fixedSubperiods: [{ id: 'first', start: dates[50], end: dates[55] }, { id: 'second', start: dates[56], end: '2020-03-31' }]
  };
  const result = evaluateCandidate(fixture, { protocol, universe, calendar,
    pricePanel: fixture, developmentPanel: fixture, developmentCalendar: calendar });
  assert.deepEqual(Object.keys(result.main), ['old', 'new', 'buy_hold', 'v2_buy_no_exit']);
  assert.deepEqual(result.main.new.dataQuality.inactiveTickers, ['IPO']);
  assert.equal(result.main.new.metrics.finalEquity, 1000);
  assert.equal(result.main.buy_hold.perTicker.find(row => row.ticker === 'IPO').finalEquity, 500);
  assert.equal(result.criterion.prospectiveValidated, false);
  assert.equal(typeof result.criterion.at10bpsBeatsBuyHold, 'boolean');
  assert.equal(result.main.new.assumptions.dividendsIncluded, true);
  assert.equal(result.development.new.assumptions.dividendsIncluded, false);
  for (const scenario of ['slippage_10bps', 'forced_initial_buy', 'first', 'second', 'SPY', 'quoted_prices_no_dividends', 'known_development_NOT_OOS']) {
    assert.equal(result.scenarios.filter(row => row.scenario === scenario).length, 3);
  }
  assert.equal(result.pairedTickers.count, 2); assert.equal(result.pairedTickers.active, 1);
  assert.equal(result.perTicker.find(row => row.ticker === 'IPO').differenceVsBuyHold, 0);
});

test('aligned execution panel preserves quote signals and adjusted bars with both source identities', () => {
  const quotes = panel(), adjusted = panel();
  quotes.metadata = { inputSha256: 'quote-input', cacheKey: 'quote-panel' };
  adjusted.metadata = { inputSha256: 'adjusted-input', cacheKey: 'adjusted-panel' };
  quotes.series[0].signals[49].oldSignal = 'BUY';
  quotes.series[0].signals[49].newSignal = 'STRONG_BUY';
  adjusted.series[0].signals[49].oldSignal = 'SELL';
  adjusted.series[0].signals[49].newSignal = 'STRONG_SELL';
  adjusted.series[0].bars = adjusted.series[0].bars.map(bar => ({ ...bar,
    open: bar.open * 0.8, high: bar.high * 0.8, low: bar.low * 0.8, close: bar.close * 0.8 }));
  const beforeQuotes = structuredClone(quotes), beforeAdjusted = structuredClone(adjusted);
  const composed = executionBarsWithSignals(adjusted, quotes);
  assert.deepEqual(composed.series[0].signals, quotes.series[0].signals);
  assert.deepEqual(composed.series[0].bars, adjusted.series[0].bars);
  assert.notDeepEqual(composed.series[0].signals, adjusted.series[0].signals);
  assert.equal(composed.metadata.kind, 'quote-signals-with-adjusted-return-bars');
  assert.deepEqual(composed.metadata.signalSource, { priceBasis: 'provider-quote', inputSha256: 'quote-input', cacheKey: 'quote-panel' });
  assert.deepEqual(composed.metadata.returnSource, { priceBasis: 'adjclose-ratio', inputSha256: 'adjusted-input', cacheKey: 'adjusted-panel' });
  assert.match(composed.metadata.priceBasisNote, /only execution and valuation/);
  assert.deepEqual(quotes, beforeQuotes); assert.deepEqual(adjusted, beforeAdjusted);
});

test('aligned quote events execute on adjusted prices without using adjusted-price signals', () => {
  const quotes = panel(), adjusted = panel();
  quotes.series[0].signals[49].oldSignal = 'BUY';
  quotes.series[0].signals[49].newSignal = 'STRONG_BUY';
  adjusted.series[0].signals[49].oldSignal = 'SELL';
  adjusted.series[0].signals[49].newSignal = 'SELL';
  adjusted.series[0].bars[50].open = 80;
  adjusted.series[0].bars[55].open = 99;
  adjusted.series[0].bars[55].close = 99;
  const combined = executionBarsWithSignals(adjusted, quotes);
  const evaluation = { startDate: date(50), endDate: date(55), calendarDates: quotes.series[0].bars.map(bar => bar.date),
    initialCapital: 1000, commissionBps: 0, slippageBps: 5 };
  for (const strategy of ['old', 'new']) {
    const result = runPortfolio(combined, { ...evaluation, strategy });
    assert.equal(result.executions[0].signalDate, date(49));
    assert.equal(result.executions[0].referencePrice, 80);
    assert.equal(result.executions[0].side, 'BUY');
    assert.equal(result.trades[0].exitReferencePrice, 99);
    near(result.metrics.finalEquity, 1000 * (99 / 80) * 0.9995 / 1.0005);
  }
  const events = exclusiveEvents(combined, { ...evaluation, horizons: [5] }).events;
  const confirmed = events.find(row => row.model === 'new' && row.category === 'confirmed');
  assert.equal(confirmed.direction, 'buy');
  near(confirmed.outcome, 99 / 80 * 0.9995 / 1.0005 - 1);
  assert.equal(events.filter(row => row.direction === 'sell').length, 0);
});

test('aligned panel matches tickers by identity and retains instruments absent from both histories', () => {
  const quotes = panel(), adjusted = panel();
  quotes.series.push({ ticker: 'IPO', bars: [], signals: [] });
  adjusted.series.unshift({ ticker: 'IPO', bars: [], signals: [] });
  const combined = executionBarsWithSignals(adjusted, quotes);
  assert.deepEqual(combined.series.map(row => row.ticker), ['IPO', 'TEST']);
  assert.deepEqual(combined.series[0], { ticker: 'IPO', bars: [], signals: [] });
  assert.deepEqual(combined.series[1].signals, quotes.series[0].signals);
});

test('alignment rejects missing, extra, duplicate, unilateral-empty and differently dated histories', () => {
  const quotes = panel(), adjusted = panel();
  assert.throws(() => executionBarsWithSignals(null, quotes), /universes must match/);
  assert.throws(() => executionBarsWithSignals({ series: [] }, quotes), /universes must match/);
  const wrongTicker = structuredClone(quotes); wrongTicker.series[0].ticker = 'OTHER';
  assert.throws(() => executionBarsWithSignals(adjusted, wrongTicker), /Misaligned signal and return history/);
  for (const duplicateSide of ['returns', 'signals']) {
    const duplicated = structuredClone(quotes); duplicated.series.push(structuredClone(duplicated.series[0]));
    const other = structuredClone(quotes); other.series.push({ ticker: 'IPO', bars: [], signals: [] });
    assert.throws(() => executionBarsWithSignals(duplicateSide === 'returns' ? duplicated : other,
      duplicateSide === 'signals' ? duplicated : other), /Duplicate ticker/);
  }
  for (const alter of [
    candidate => { candidate.series[0].bars.pop(); },
    candidate => { candidate.series[0].signals.pop(); },
    candidate => { candidate.series[0].bars = []; candidate.series[0].signals = []; },
    candidate => { candidate.series[0].bars[50].date = date(49); },
    candidate => { candidate.series[0].signals[50].date = date(49); }
  ]) {
    const candidate = structuredClone(quotes); alter(candidate);
    assert.throws(() => executionBarsWithSignals(adjusted, candidate), /Misaligned signal and return/);
  }
  const emptyReturns = { series: [{ ticker: 'TEST', bars: [], signals: [] }] };
  assert.throws(() => executionBarsWithSignals(emptyReturns, quotes), /Misaligned signal and return history/);
});
