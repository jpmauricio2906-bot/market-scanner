// Experimental fixed exit rule. This pure transform neither fetches prices,
// fits thresholds, computes returns nor changes the production scoring engine.
export const LONG_TREND_RULE = Object.freeze({
  version: 'lt-sma200-3close-1.0.0',
  smaSessions: 200,
  consecutiveCloses: 3,
  earliestExitBarCount: 202,
  consecutiveMeans: 'consecutive expected exchange sessions',
  strictBelow: true,
  buySource: 'v3',
  sellSignal: 'SELL'
});

const validSignals = new Set(['WAIT', 'HOLD', 'BUY', 'STRONG_BUY', 'SELL', 'STRONG_SELL']);
const buys = new Set(['BUY', 'STRONG_BUY']);
const sells = new Set(['SELL', 'STRONG_SELL']);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/**
 * Consume the quote-price validation panel, whose newSignal is frozen v3.
 * Return oldSignal=v3 and newSignal=LT; no portfolio state is needed.
 *
 * The upstream normalizer strips finality fields after excluding provisional
 * rows. Its caller must explicitly opt into normalizedBarsAreFinal=true.
 * Explicit provisional markers override that option. Without the option, an
 * individual bar is confirmed only when is_final === true. All 200 closes used
 * in a qualifying SMA must be final, as must the three below-SMA closes.
 *
 * The SMA at t contains closes [t-199, t]. There is no SMA before bar 200.
 * Each close is compared with its OWN contemporaneous SMA, never today's SMA
 * applied retrospectively. The first possible three-close exit is bar 202.
 * SMA200 uses 200 observed closes, matching the production history convention.
 * A gap in the supplied expected exchange calendar resets the below-SMA streak;
 * three observed closes across missing exchange sessions cannot certify an exit.
 * WAIT remains WAIT, preserving the upstream unavailable/stale-data guard.
 *
 * Preserve all original v3 diagnostics, including scores and confirmation
 * flags, without relabeling them as LT scores. LT diagnostics are exclusively
 * the longTrend* fields. The metadata states these semantics explicitly.
 */
export function buildLongTrendPanel(panel, { normalizedBarsAreFinal = false, calendarDates } = {}) {
  if (!Array.isArray(panel?.series) || !panel.series.length) throw new Error('panel.series must be nonempty.');
  if (typeof normalizedBarsAreFinal !== 'boolean') throw new Error('normalizedBarsAreFinal must be boolean.');
  if (!Array.isArray(calendarDates) || !calendarDates.length ||
      calendarDates.some((date, i) => !validDate(date) || (i > 0 && date <= calendarDates[i - 1]))) {
    throw new Error('calendarDates must contain unique ascending expected exchange dates.');
  }
  const calendarIndex = new Map(calendarDates.map((date, index) => [date, index]));
  const seen = new Set();
  const counts = { bars: 0, smaWarmupBars: 0, unconfirmedSmaWindows: 0,
    longTrendExitSignals: 0, suppressedV3SellSignals: 0, buySellConflicts: 0, waitGuards: 0 };
  const series = panel.series.map(item => {
    if (typeof item.ticker !== 'string' || !item.ticker || seen.has(item.ticker)) {
      throw new Error('Tickers must be nonempty and unique.');
    }
    seen.add(item.ticker);
    if (!Array.isArray(item.bars) || !Array.isArray(item.signals) || item.bars.length !== item.signals.length) {
      throw new Error(`Bars and signals must align for ${item.ticker}.`);
    }
    let priorDate = null, priorSession = null, streak = 0;
    const finality = [];
    let finalCount = 0;
    const signals = item.bars.map((bar, index) => {
      const row = item.signals[index];
      if (!validDate(bar?.date) || (priorDate && bar.date <= priorDate)) {
        throw new Error(`Bars must have unique ascending ISO dates for ${item.ticker}.`);
      }
      const session = calendarIndex.get(bar.date);
      if (session === undefined) throw new Error(`Bar date is outside the supplied exchange calendar for ${item.ticker}: ${bar.date}.`);
      const contiguous = priorSession !== null && session === priorSession + 1;
      priorSession = session;
      if (!Number.isFinite(bar.close) || bar.close <= 0) throw new Error(`Invalid close for ${item.ticker} on ${bar.date}.`);
      if (row?.date !== bar.date || !validSignals.has(row.newSignal)) {
        throw new Error(`Invalid or misaligned v3 signal for ${item.ticker} on ${bar.date}.`);
      }
      priorDate = bar.date;
      counts.bars++;
      const isFinal = bar.is_final !== false && bar.status !== 'PROVISIONAL' &&
        (bar.is_final === true || normalizedBarsAreFinal);
      finality.push(isFinal);
      finalCount += Number(isFinal);
      if (index >= LONG_TREND_RULE.smaSessions) finalCount -= Number(finality[index - LONG_TREND_RULE.smaSessions]);
      let sma200 = null, smaMinusClose = null;
      if (index + 1 >= LONG_TREND_RULE.smaSessions) {
        // Compare sum(close_j - currentClose) with zero, algebraically equal to
        // currentClose < SMA200. Centering makes constant decimals exactly zero;
        // Neumaier compensation reduces cancellation for mixed differences.
        // There is no price tolerance or threshold that could be calibrated.
        let centeredSum = 0, compensation = 0;
        for (let j = index - LONG_TREND_RULE.smaSessions + 1; j <= index; j++) {
          const difference = item.bars[j].close - bar.close;
          const next = centeredSum + difference;
          compensation += Math.abs(centeredSum) >= Math.abs(difference) ?
            (centeredSum - next) + difference : (difference - next) + centeredSum;
          centeredSum = next;
        }
        smaMinusClose = (centeredSum + compensation) / LONG_TREND_RULE.smaSessions;
        sma200 = bar.close + smaMinusClose;
      } else counts.smaWarmupBars++;
      const confirmedSma = sma200 !== null && finalCount === LONG_TREND_RULE.smaSessions;
      if (sma200 !== null && !confirmedSma) counts.unconfirmedSmaWindows++;
      const belowSma200 = smaMinusClose !== null && smaMinusClose > 0;
      streak = confirmedSma && isFinal && belowSma200 ? (contiguous ? streak : 0) + 1 : 0;
      const rawBreakdown = streak >= LONG_TREND_RULE.consecutiveCloses;
      const exitConfirmed = rawBreakdown && row.newSignal !== 'WAIT';
      const conflict = exitConfirmed && buys.has(row.newSignal);
      const nextSignal = row.newSignal === 'WAIT' ? 'WAIT' :
        exitConfirmed ? LONG_TREND_RULE.sellSignal :
          sells.has(row.newSignal) ? 'HOLD' : row.newSignal;
      if (exitConfirmed) counts.longTrendExitSignals++;
      if (sells.has(row.newSignal) && nextSignal === 'HOLD') counts.suppressedV3SellSignals++;
      if (conflict) counts.buySellConflicts++;
      if (rawBreakdown && row.newSignal === 'WAIT') counts.waitGuards++;
      return { ...row, oldSignal: row.newSignal, newSignal: nextSignal,
        oldTrendScore: row.trendScore ?? null, oldEntryScore: row.entryScore ?? null,
        oldExitScore: row.exitScore ?? null,
        longTrendSma200: sma200, longTrendSmaMinusClose: smaMinusClose,
        longTrendSmaConfirmed: confirmedSma,
        longTrendBelowSma200: belowSma200, longTrendBelowStreak: streak,
        longTrendContiguousPreviousSession: contiguous,
        longTrendExitConfirmed: exitConfirmed, longTrendBuySellConflict: conflict };
    });
    return { ...item, signals };
  });
  return { ...panel, series, quality: { ...panel.quality, longTrend: counts },
    metadata: { ...panel.metadata, kind: 'v3-vs-fixed-long-trend-exits',
      longTrend: { rule: LONG_TREND_RULE, normalizedBarsAreFinal,
        signalMapping: { oldSignal: 'frozen v3 newSignal', newSignal: LONG_TREND_RULE.version },
        diagnostics: 'Original scores/confirmation flags remain v3 diagnostics; longTrend* fields alone describe the experimental exit rule.',
        warmup: 'v3 entries remain eligible under their existing warmup; the portfolio runner applies its predeclared common warmup separately. No long-term exit is possible before 202 final bars; no substitute short-term exit is added.',
        calendar: 'Three below-SMA closes must be consecutive expected exchange sessions. Missing sessions reset the streak; SMA200 still uses 200 observed closes.',
        timing: 'Use quote closes only through the signal date; execute no earlier than the next contiguous session open.',
        terminalLiquidation: 'A common predeclared final liquidation belongs to performance accounting, not this exit rule.' } } };
}
