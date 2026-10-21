// Experimental, browser/Node-compatible strategy adapter. Production v3 is
// imported verbatim; its implementation and published validation stay frozen.
import '../scoring.js';

const scoring = globalThis.MarketScoring;
export const STRATEGY_DEFAULTS = Object.freeze({
  preset: 'v3', entryScore: 60, trendScore: 55, momentum: 55,
  maxEntryExtensionAtr: 3, minEntryDistanceAtr: -1.5, relativeVolume: 1.2,
  strongOnly: false, exitMode: 'long_trend', exitPeriod: 200,
  exitConfirmations: 3, exitScore: 60,
  momentumWeight: 0.5, positionWeight: 0.3, volumeWeight: 0.2
});
const BUY = new Set(['BUY', 'STRONG_BUY']);
const SELL = new Set(['SELL', 'STRONG_SELL']);
const dateOf = bar => bar.date ?? bar.fecha;
const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const isFinal = bar => bar.is_final !== false && bar.status !== 'PROVISIONAL';
const score = value => Math.round(Math.max(0, Math.min(100, value)));

/**
 * Presets are literal fixed strategies. Editing values requires custom.
 * Custom is a separate experiment: even its default values do not promise v3
 * signals, because its relative-volume gate applies to every candidate buy.
 */
export function validateStrategy(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Strategy config must be an object.');
  if (Object.keys(config).some(key => !Object.hasOwn(STRATEGY_DEFAULTS, key))) throw new Error('Unknown strategy parameter.');
  const result = { ...STRATEGY_DEFAULTS, ...config };
  if (!['v3', 'sma200', 'custom'].includes(result.preset)) throw new Error('Unknown strategy preset.');
  if (result.preset !== 'custom') {
    return { ...STRATEGY_DEFAULTS, preset: result.preset,
      exitMode: result.preset === 'v3' ? 'v3' : 'long_trend', exitPeriod: result.preset === 'v3' ? 50 : 200 };
  }
  for (const key of ['entryScore', 'trendScore', 'momentum', 'exitScore']) {
    if (!Number.isFinite(result[key]) || result[key] < 0 || result[key] > 100) throw new Error(`${key} must be between 0 and 100.`);
  }
  for (const key of ['maxEntryExtensionAtr', 'minEntryDistanceAtr']) {
    if (!Number.isFinite(result[key]) || result[key] < -20 || result[key] > 20) throw new Error(`${key} must be between -20 and 20 ATR.`);
  }
  if (result.minEntryDistanceAtr > result.maxEntryExtensionAtr) throw new Error('Minimum entry distance must not exceed maximum entry extension.');
  if (!Number.isFinite(result.relativeVolume) || result.relativeVolume < 0 || result.relativeVolume > 10) throw new Error('relativeVolume must be between 0 and 10.');
  if (typeof result.strongOnly !== 'boolean') throw new Error('strongOnly must be boolean.');
  if (!['v3', 'long_trend'].includes(result.exitMode)) throw new Error('Unknown exitMode.');
  if (!Number.isSafeInteger(result.exitPeriod) || result.exitPeriod < 20 || result.exitPeriod > 250) throw new Error('exitPeriod must be an integer between 20 and 250.');
  if (!Number.isSafeInteger(result.exitConfirmations) || result.exitConfirmations < 1 || result.exitConfirmations > 10) throw new Error('exitConfirmations must be an integer between 1 and 10.');
  for (const key of ['momentumWeight', 'positionWeight', 'volumeWeight']) {
    if (!Number.isFinite(result[key]) || result[key] < 0 || result[key] > 1) throw new Error('Entry component weights must be between 0 and 1.');
  }
  if (Math.abs(result.momentumWeight + result.positionWeight + result.volumeWeight - 1) > 1e-9) throw new Error('Entry component weights must sum to 1.');
  return result;
}

export function strategyWarmup(config = {}) {
  const selected = validateStrategy(config);
  return selected.exitMode === 'long_trend' ? Math.max(50, selected.exitPeriod + selected.exitConfirmations - 1) : 50;
}

function classifyCustom(analysis, selected) {
  if (analysis.signal === 'WAIT' || analysis.provisional || analysis.stale) return { signal: 'WAIT', entryScore: null, rawEntryScore: null };
  const { components, metrics } = analysis;
  // analyze() already capped its Entry Score under fixed v3 thresholds. Start
  // from the same three components, then apply the EXPERIMENT'S actual gates.
  // Reusing the capped score would silently ignore relaxed parameter values.
  const rawEntryScore = score(components.momentum * selected.momentumWeight + components.position * selected.positionWeight + components.volume * selected.volumeWeight);
  const eligible = analysis.trendScore >= selected.trendScore && components.momentum >= selected.momentum &&
    metrics.priceDirection > 0 && metrics.distanceAtr >= selected.minEntryDistanceAtr &&
    metrics.distanceAtr <= selected.maxEntryExtensionAtr &&
    Number.isFinite(metrics.relativeVolume) && metrics.relativeVolume >= selected.relativeVolume;
  const entryScore = eligible ? rawEntryScore : Math.min(49, rawEntryScore);
  // Custom v3 exits vary the score threshold, while retaining v3's structural
  // safeguards (persistent support break or its defined emergency breakdown).
  if (selected.exitMode === 'v3' && (metrics.exitPersistent || metrics.exitEmergency) && analysis.exitScore >= selected.exitScore) {
    return { signal: metrics.exitPersistent && metrics.sellBreakoutConfirmed ? 'STRONG_SELL' : 'SELL', entryScore, rawEntryScore };
  }
  if (eligible && rawEntryScore >= selected.entryScore) {
    // Price structure and the two-close level are identical to v3; custom's
    // minimum relative volume is used for BOTH confirming breakout candles.
    const confirmedBreakout = metrics.previousRelativeVolume >= selected.relativeVolume &&
      analysis.previousClose > metrics.frozenHigh20 && analysis.currentClose >= metrics.frozenHigh20 &&
      analysis.currentClose > metrics.sma50;
    const strong = analysis.trendScore >= Math.max(65, selected.trendScore) &&
      components.momentum >= Math.max(65, selected.momentum) && rawEntryScore >= Math.max(75, selected.entryScore) &&
      components.volume >= 65 && confirmedBreakout;
    return { signal: strong ? 'STRONG_BUY' : selected.strongOnly ? 'HOLD' : 'BUY', entryScore, rawEntryScore };
  }
  return { signal: 'HOLD', entryScore, rawEntryScore };
}

/**
 * One row per input bar. Every scoring call sees only its own prefix, capped
 * at 500 sessions. Input must be normalized historical OHLCV, ordered by date.
 * Rows without a finality flag are accepted as stored historical observations;
 * explicit provisional rows force WAIT and cannot certify a long-trend exit.
 * A complete expected session calendar is required; missing sessions reset the
 * long-trend confirmation streak. The platform separately rejects data gaps.
 * No return calculation, parameter search, optimization, or future bars occur.
 */
export function buildStrategyFeatures(bars, { calendarDates } = {}) {
  if (!Array.isArray(bars)) throw new Error('bars must be an array.');
  if (!bars.length) return { bars, rows: [], longTrend: new Map() };
  if (!Array.isArray(calendarDates) || !calendarDates.length ||
      calendarDates.some((date, index) => !validDate(date) || (index > 0 && date <= calendarDates[index - 1]))) {
    throw new Error('calendarDates must contain unique ascending expected exchange dates.');
  }
  const sessions = new Map(calendarDates.map((date, index) => [date, index]));
  bars.forEach((bar, index) => {
    const date = dateOf(bar);
    if (!validDate(date) || (index > 0 && date <= dateOf(bars[index - 1]))) throw new Error('Bars must have unique ascending ISO dates.');
    if (!sessions.has(date)) throw new Error('Bar date is outside the supplied exchange calendar.');
    if (![bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0) ||
        bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close)) throw new Error(`Invalid OHLC prices on ${date}.`);
  });
  const rows = bars.map((bar, index) => {
    const date = dateOf(bar), session = sessions.get(date);
    const prefix = bars.slice(Math.max(0, index + 1 - 500), index + 1);
    const analysis = scoring.analyze(prefix, { minSignalDays: 50, provisional: !isFinal(bar), stale: false });
    // A provisional historical observation cannot be a completed signal input.
    if (prefix.some(row => !isFinal(row))) analysis.signal = 'WAIT';
    // Cache only fields actually used by strategies, not explanatory strings or
    // unused indicators. This bounds memory for a full-universe optimization.
    const metrics = Object.fromEntries(['priceDirection', 'distanceAtr', 'relativeVolume', 'exitPersistent',
      'exitEmergency', 'sellBreakoutConfirmed', 'previousRelativeVolume', 'frozenHigh20', 'sma50']
      .map(key => [key, analysis.metrics[key]]));
    return { date, session, analysis: { signal: analysis.signal, provisional: analysis.provisional, stale: analysis.stale,
      trendScore: analysis.trendScore, entryScore: analysis.entryScore, exitScore: analysis.exitScore,
      components: { momentum: analysis.components.momentum, position: analysis.components.position, volume: analysis.components.volume }, metrics },
      previousClose: prefix.at(-2)?.close, currentClose: bar.close };
  });
  return { bars, rows, longTrend: new Map() };
}

function longTrendFeatures(features, period) {
  if (features.longTrend.has(period)) return features.longTrend.get(period);
  const { bars, rows } = features;
  let streak = 0, confirmedWindowCount = 0;
  const differences = new Float64Array(bars.length).fill(NaN), streaks = new Uint16Array(bars.length), confirmations = new Uint8Array(bars.length);
  bars.forEach((bar, index) => {
    confirmedWindowCount += Number(isFinal(bar));
    if (index >= period) confirmedWindowCount -= Number(isFinal(bars[index - period]));
    if (index + 1 >= period) {
      // Preserve the exact centered Neumaier arithmetic of the frozen adapter.
      let centeredSum = 0, compensation = 0;
      for (let j = index - period + 1; j <= index; j++) {
        const difference = bars[j].close - bar.close, next = centeredSum + difference;
        compensation += Math.abs(centeredSum) >= Math.abs(difference) ? (centeredSum - next) + difference : (difference - next) + centeredSum;
        centeredSum = next;
      }
      differences[index] = (centeredSum + compensation) / period;
    }
    const confirmed = !Number.isNaN(differences[index]) && confirmedWindowCount === period;
    const contiguous = index > 0 && rows[index].session === rows[index - 1].session + 1;
    streak = confirmed && isFinal(bar) && differences[index] > 0 ? (contiguous ? streak : 0) + 1 : 0;
    streaks[index] = streak;
    confirmations[index] = Number(confirmed);
  });
  const result = { differences, streaks, confirmations };
  features.longTrend.set(period, result);
  return result;
}

export function buildStrategySignals(bars, config = {}, { calendarDates, features = null } = {}) {
  const selected = validateStrategy(config);
  if (!Array.isArray(bars)) throw new Error('bars must be an array.');
  if (!bars.length) return [];
  const cached = features ?? buildStrategyFeatures(bars, { calendarDates });
  // A shorter causal prefix may reuse a previously calculated feature cache.
  if (cached.rows.length < bars.length || bars.some((bar, index) => cached.bars[index] !== bar)) throw new Error('Strategy features do not match bars.');
  const longTrend = selected.exitMode === 'long_trend' ? longTrendFeatures(cached, selected.exitPeriod) : null;
  return bars.map((bar, index) => {
    const { date, analysis, previousClose } = cached.rows[index];
    const custom = selected.preset === 'custom' ? classifyCustom({ ...analysis,
      previousClose, currentClose: bar.close }, selected) : null;
    let signal = custom?.signal ?? analysis.signal;
    const row = { date, oldSignal: analysis.signal, newSignal: signal,
      trendScore: analysis.trendScore, entryScore: custom ? custom.entryScore : analysis.entryScore,
      exitScore: analysis.exitScore, momentum: analysis.components.momentum ?? null,
      relativeVolume: analysis.metrics.relativeVolume ?? null, distanceAtr: analysis.metrics.distanceAtr ?? null,
      ...(custom ? { rawEntryScore: custom.rawEntryScore, v3EntryScore: analysis.entryScore } : {}) };
    if (selected.exitMode === 'long_trend') {
      const smaMinusClose = Number.isNaN(longTrend.differences[index]) ? null : longTrend.differences[index];
      const confirmed = Boolean(longTrend.confirmations[index]), streak = longTrend.streaks[index];
      const exitConfirmed = streak >= selected.exitConfirmations && signal !== 'WAIT';
      row.longTrendSma = smaMinusClose === null ? null : bar.close + smaMinusClose;
      row.longTrendSmaMinusClose = smaMinusClose;
      row.longTrendBelowStreak = streak;
      row.longTrendSmaConfirmed = confirmed;
      row.longTrendExitConfirmed = exitConfirmed;
      row.longTrendBuySellConflict = exitConfirmed && BUY.has(signal);
      row.newSignal = signal === 'WAIT' ? 'WAIT' : exitConfirmed ? 'SELL' : SELL.has(signal) ? 'HOLD' : signal;
    }
    return row;
  });
}
