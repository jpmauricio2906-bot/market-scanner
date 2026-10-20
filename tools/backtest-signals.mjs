// Build a causal daily signal panel from a local capture. No price fetching,
// threshold fitting or knowledge of later bars is used in either scoring call.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { normalizeSnapshot, legacySignals, legacyComposite, LEGACY_INDICATORS,
  LEGACY_SOURCE_SHA256 } from './audit-scoring.mjs';

const require = createRequire(import.meta.url);
const scoring = require('../js/scoring.js');
const sha256 = value => createHash('sha256').update(value).digest('hex');

/**
 * Retain the complete validated history; truncate only each signal's prefix.
 * Truncating the complete input to its latest 500 rows first would change past
 * results when future rows are appended and discard usable execution history.
 *
 * A capture's latestDate cannot establish whether a historical bar was stale
 * when originally available. Signal eligibility here is assessed on each bar's
 * own date. Point-in-time availability and data revisions remain limitations.
 *
 * inputSha256, when supplied, must hash the original input file bytes. Without
 * it the deterministic serialized-document hash is explicitly labelled.
 */
export async function buildSignalPanel(document, {
  historyDays = 500, minSignalDays = 50, inputSha256 = null, onProgress = null
} = {}) {
  if (!Number.isSafeInteger(historyDays) || historyDays < 50 || historyDays > 500) {
    throw new Error('historyDays must be an integer between 50 and 500.');
  }
  if (!Number.isSafeInteger(minSignalDays) || minSignalDays < 50 || minSignalDays > historyDays) {
    throw new Error('minSignalDays must be an integer between 50 and historyDays.');
  }
  if (inputSha256 !== null && !/^[a-f0-9]{64}$/i.test(inputSha256)) {
    throw new Error('inputSha256 must be a SHA-256 hexadecimal digest of the input file bytes.');
  }
  if (onProgress !== null && typeof onProgress !== 'function') {
    throw new Error('onProgress must be a synchronous function when supplied.');
  }
  const normalized = normalizeSnapshot(document, { historyDays: Number.MAX_SAFE_INTEGER });
  const [engineSource, auditSource, panelSource] = await Promise.all([
    readFile(new URL('../js/scoring.js', import.meta.url)),
    readFile(new URL('./audit-scoring.mjs', import.meta.url)),
    readFile(new URL('./backtest-signals.mjs', import.meta.url))
  ]);
  let eligibleSignals = 0, warmupBars = 0, rollingWindowSignals = 0;
  const series = normalized.series.map(({ ticker, bars }, tickerIndex) => {
    const signals = bars.map((bar, index) => {
      if (index + 1 < minSignalDays) {
        warmupBars++;
        return { date: bar.date, oldSignal: 'WAIT', newSignal: 'WAIT',
          oldComposite: null, newComposite: null, trendScore: null, entryScore: null, exitScore: null };
      }
      eligibleSignals++;
      if (index + 1 > historyDays) rollingWindowSignals++;
      const prefix = bars.slice(Math.max(0, index + 1 - historyDays), index + 1);
      // Directly use the frozen baseline, including its original errors. There
      // is intentionally no alternative or approximated indicator fast path.
      const oldComposite = legacyComposite(legacySignals(prefix));
      const analysis = scoring.analyze(prefix, { minSignalDays, provisional: false, stale: false });
      const newComposite = scoring.computeScore(scoring.computeSignals(prefix), LEGACY_INDICATORS);
      return { date: bar.date,
        oldSignal: oldComposite >= 70 ? 'BUY' : oldComposite <= 30 ? 'SELL' : 'HOLD',
        newSignal: analysis.signal, oldComposite, newComposite,
        trendScore: analysis.trendScore, entryScore: analysis.entryScore, exitScore: analysis.exitScore };
    });
    if (onProgress) onProgress({ ticker, completedTickers: tickerIndex + 1,
      totalTickers: normalized.series.length, eligibleSignals });
    return { ticker, bars, signals };
  });
  const starts = series.flatMap(({ bars }) => bars.length ? [bars[0].date] : []).sort();
  const ends = series.flatMap(({ bars }) => bars.length ? [bars.at(-1).date] : []).sort();
  return {
    series,
    quality: { ...normalized.quality, warmupBars, eligibleSignals, rollingWindowSignals },
    metadata: {
      schemaVersion: 1,
      kind: 'offline-historical-signal-panel',
      inputSha256: inputSha256?.toLowerCase() ?? sha256(JSON.stringify(document)),
      inputHashMethod: inputSha256 === null ? 'JSON.stringify(document), UTF-8' : 'original input file bytes',
      source: document?.source ?? null,
      capturedAt: document?.retrievedAt ?? document?.capturedAt ?? null,
      captureLatestDate: document?.latestDate ?? null,
      firstBarDate: starts[0] ?? null,
      lastBarDate: ends.at(-1) ?? null,
      settings: { historyDays, minSignalDays },
      baseline: {
        source: 'index.html before the Entry Timing revision, 2026-10-19',
        sourceSha256: LEGACY_SOURCE_SHA256,
        implementationSha256: sha256(auditSource),
        thresholds: { buy: 70, sell: 30 },
        weights: Object.fromEntries(LEGACY_INDICATORS.map(({ id, weight }) => [id, weight]))
      },
      currentEngine: { version: scoring.VERSION, sourceSha256: sha256(engineSource),
        thresholds: { ...scoring.THRESHOLDS } },
      panelSourceSha256: sha256(panelSource),
      timing: 'Signal uses OHLCV only through its own dated bar, with at most historyDays bars. Execution must be later than this close.',
      limitations: [
        'This panel reconstructs signals from the captured data; it does not prove those data or this universe were available at each historical date.',
        'Universe selection, delisted instruments, revisions, price adjustments, dividends and original data publication times are not verified by this offline computation.',
        'Explicit provisional rows are excluded; rows without explicit finality are counted as unknown and treated as stored history.',
        'Capture latestDate is not used to label earlier historical bars stale. Exchange calendar gaps require separate execution handling.',
        'Default weights and rule thresholds are unchanged. The new rules were designed after these historical observations; this is retrospective evaluation, not an unseen forward test.',
        'The first minSignalDays minus one accepted bars per instrument are warmup and carry WAIT signals.'
      ]
    }
  };
}
