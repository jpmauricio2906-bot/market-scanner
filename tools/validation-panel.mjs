// Causal v2/v3 signal reconstruction only. No portfolio returns or fitting.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { normalizeSnapshot } from './audit-scoring.mjs';

const require = createRequire(import.meta.url);
const baseline = require('./baselines/scoring-v2.cjs');
const current = require('../js/scoring.js');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const WORKER_KIND = 'validation-signal-worker';
const tickerName = value => {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(value.trim().toUpperCase())) {
    throw new Error('Instrument ticker must be a nonempty valid symbol.');
  }
  return value.trim().toUpperCase();
};

function buildOne({ bars }, { historyDays, minSignalDays }) {
  let warmupBars = 0, eligibleSignals = 0, rollingWindowSignals = 0;
  const signals = bars.map((bar, index) => {
    if (index + 1 < minSignalDays) {
      warmupBars++;
      return { date: bar.date, oldSignal: 'WAIT', newSignal: 'WAIT',
        oldTrendScore: null, oldEntryScore: null, oldExitScore: null,
        trendScore: null, entryScore: null, exitScore: null,
        exitConfirmed: false, exitPersistent: false, exitEmergency: false,
        buyBreakoutConfirmed: false, sellBreakoutConfirmed: false, technicalConfirmation: null };
    }
    eligibleSignals++;
    if (index + 1 > historyDays) rollingWindowSignals++;
    const prefix = bars.slice(Math.max(0, index + 1 - historyDays), index + 1);
    const options = { minSignalDays, provisional: false, stale: false };
    const old = baseline.analyze(prefix, options), next = current.analyze(prefix, options);
    return { date: bar.date, oldSignal: old.signal, newSignal: next.signal,
      oldTrendScore: old.trendScore, oldEntryScore: old.entryScore, oldExitScore: old.exitScore,
      trendScore: next.trendScore, entryScore: next.entryScore, exitScore: next.exitScore,
      exitConfirmed: Boolean(next.metrics.exitConfirmed),
      exitPersistent: Boolean(next.metrics.exitPersistent), exitEmergency: Boolean(next.metrics.exitEmergency),
      buyBreakoutConfirmed: Boolean(next.metrics.buyBreakoutConfirmed),
      sellBreakoutConfirmed: Boolean(next.metrics.sellBreakoutConfirmed),
      technicalConfirmation: next.technicalConfirmation ?? null };
  });
  return { signals, counts: { warmupBars, eligibleSignals, rollingWindowSignals } };
}

if (!isMainThread && workerData?.kind === WORKER_KIND) {
  parentPort.on('message', ({ index, series, settings }) => {
    try { parentPort.postMessage({ index, result: buildOne(series, settings) }); }
    catch (error) { parentPort.postMessage({ index, error: error.message }); }
  });
}

async function buildAll(series, settings, workers, onProgress) {
  const results = new Array(series.length);
  let completedTickers = 0, eligibleSignals = 0;
  const record = (index, result) => {
    results[index] = result;
    completedTickers++;
    eligibleSignals += result.counts.eligibleSignals;
    if (onProgress) onProgress({ ticker: series[index].ticker, completedTickers,
      totalTickers: series.length, eligibleSignals });
  };
  if (workers === 1 || series.length === 1) {
    series.forEach((item, index) => record(index, buildOne(item, settings)));
    return results;
  }
  const pool = [];
  let nextIndex = 0, finished = false;
  try {
    await new Promise((resolve, reject) => {
      const fail = error => { if (!finished) { finished = true; reject(error); } };
      for (let i = 0; i < Math.min(workers, series.length); i++) {
        // The worker needs no CLI loaders or runtime flags; desktop runtimes may
        // expose parent flags that Node explicitly forbids for worker threads.
        const worker = new Worker(new URL(import.meta.url), { workerData: { kind: WORKER_KIND }, execArgv: [] });
        pool.push(worker);
        let assignedIndex = null;
        const dispatch = () => {
          if (nextIndex >= series.length || finished) return;
          assignedIndex = nextIndex++;
          worker.postMessage({ index: assignedIndex, series: series[assignedIndex], settings });
        };
        worker.on('message', message => {
          if (finished) return;
          try {
            if (message.index !== assignedIndex) throw new Error('Worker returned a misaligned ticker result.');
            if (message.error) throw new Error(`Signal worker for ${series[message.index].ticker}: ${message.error}`);
            record(message.index, message.result);
            if (completedTickers === series.length) { finished = true; resolve(); }
            else dispatch();
          } catch (error) { fail(error); }
        });
        worker.once('error', fail);
        worker.once('exit', code => { if (!finished) fail(new Error(`Signal worker exited unexpectedly (${code}).`)); });
        dispatch();
      }
    });
  } finally {
    finished = true;
    await Promise.all(pool.map(worker => worker.terminate()));
  }
  return results;
}

/**
 * Only explicit not_listed instruments become empty permanent-cash sleeves.
 * A failed download or a missing expected symbol must never silently become cash.
 * All history is retained for execution; only each scoring prefix rolls at 500.
 * Workers change scheduling, not semantics; cache provenance excludes worker count.
 */
async function prepareValidationPanel(document, {
  inputSha256 = null, workers = 4, historyDays = 500, minSignalDays = 50,
  onProgress = null, expectedTickers = null
} = {}) {
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32) throw new Error('workers must be an integer between 1 and 32.');
  if (!Number.isSafeInteger(historyDays) || historyDays < 50 || historyDays > 500) throw new Error('historyDays must be an integer between 50 and 500.');
  if (!Number.isSafeInteger(minSignalDays) || minSignalDays < 50 || minSignalDays > historyDays) throw new Error('minSignalDays must be an integer between 50 and historyDays.');
  if (inputSha256 !== null && !/^[a-f0-9]{64}$/i.test(inputSha256)) throw new Error('inputSha256 must be a SHA-256 hexadecimal digest of the original input bytes.');
  if (onProgress !== null && typeof onProgress !== 'function') throw new Error('onProgress must be a synchronous function.');
  if (expectedTickers !== null && (!Array.isArray(expectedTickers) || !expectedTickers.length)) throw new Error('expectedTickers must be a nonempty array.');
  const expected = expectedTickers?.map(tickerName) ?? null;
  if (expected && new Set(expected).size !== expected.length) throw new Error('expectedTickers must be unique.');
  const instruments = new Map();
  if (document?.instruments !== undefined) {
    if (!Array.isArray(document.instruments) || !document.instruments.length) throw new Error('instruments must be a nonempty array.');
    for (const record of document.instruments) {
      const ticker = tickerName(record?.ticker);
      if (instruments.has(ticker)) throw new Error(`Duplicate instrument ${ticker}.`);
      if (!['ok', 'not_listed'].includes(record.status)) throw new Error(`Instrument ${ticker} has rejected status ${record.status ?? 'missing'}.`);
      instruments.set(ticker, record.status);
    }
  }
  const normalized = normalizeSnapshot(document, { historyDays: Number.MAX_SAFE_INTEGER });
  if (normalized.quality.invalidRows) throw new Error(`Input contains ${normalized.quality.invalidRows} invalid OHLCV rows; repair the source before validation.`);
  const byTicker = new Map(normalized.series.map(item => [item.ticker, item]));
  const universe = [...(expected ?? (instruments.size ? [...instruments.keys()] : [...byTicker.keys()]))].sort();
  const universeSet = new Set(universe);
  for (const ticker of byTicker.keys()) if (!universeSet.has(ticker)) throw new Error(`Observed ticker ${ticker} is outside the declared universe.`);
  for (const ticker of instruments.keys()) if (!universeSet.has(ticker)) throw new Error(`Instrument ${ticker} is outside the declared universe.`);
  const series = universe.map(ticker => {
    const present = byTicker.get(ticker), status = instruments.get(ticker);
    if (instruments.size && !status) throw new Error(`Expected ticker ${ticker} has no instrument status.`);
    if (status === 'not_listed') {
      if (present) throw new Error(`Not-listed ticker ${ticker} unexpectedly has input rows.`);
      return { ticker, bars: [] };
    }
    if (!present?.bars.length) throw new Error(`Expected ticker ${ticker} has no usable history and no explicit not_listed status.`);
    return present;
  });
  const [baselineSource, currentSource, normalizerSource, panelSource] = await Promise.all([
    readFile(new URL('./baselines/scoring-v2.cjs', import.meta.url)),
    readFile(new URL('../js/scoring.js', import.meta.url)),
    readFile(new URL('./audit-scoring.mjs', import.meta.url)), readFile(new URL(import.meta.url))
  ]);
  const settings = { historyDays, minSignalDays };
  const documentSha256 = sha256(JSON.stringify(document));
  const cacheProvenance = { schemaVersion: 1, kind: 'v2-v3-validation-signal-panel',
    inputSha256: inputSha256?.toLowerCase() ?? documentSha256, documentSha256,
    inputHashMethod: inputSha256 === null ? 'JSON.stringify(document), UTF-8' : 'original input file bytes',
    baselineSourceSha256: sha256(baselineSource), currentSourceSha256: sha256(currentSource),
    normalizerSourceSha256: sha256(normalizerSource), panelSourceSha256: sha256(panelSource),
    settings, universe, instrumentStatuses: universe.map(ticker => ({ ticker,
      status: instruments.get(ticker) ?? 'observed' })) };
  return { series, normalized, settings, cacheProvenance, workers, onProgress };
}

/** Validate input and hash all semantic dependencies without calculating signals. */
export async function validationPanelProvenance(document, options = {}) {
  const { cacheProvenance } = await prepareValidationPanel(document, options);
  const cacheKey = sha256(JSON.stringify(cacheProvenance));
  return { cacheKey, cacheKeySha256: cacheKey, cacheProvenance };
}

export async function buildValidationPanel(document, options = {}) {
  const { series, normalized, settings, cacheProvenance, workers, onProgress } = await prepareValidationPanel(document, options);
  const results = await buildAll(series, settings, workers, onProgress);
  const counts = results.reduce((totals, item) => {
    for (const key of Object.keys(totals)) totals[key] += item.counts[key];
    return totals;
  }, { warmupBars: 0, eligibleSignals: 0, rollingWindowSignals: 0 });
  const dates = series.flatMap(item => item.bars.length ? [item.bars[0].date, item.bars.at(-1).date] : []).sort();
  return {
    series: series.map((item, index) => ({ ...item, signals: results[index].signals })),
    quality: { ...normalized.quality, ...counts, inactiveTickers: series.filter(item => !item.bars.length).map(item => item.ticker) },
    metadata: { schemaVersion: 1, kind: cacheProvenance.kind,
      inputSha256: cacheProvenance.inputSha256, inputHashMethod: cacheProvenance.inputHashMethod,
      source: document?.source ?? null, capturedAt: document?.retrievedAt ?? document?.capturedAt ?? null,
      captureLatestDate: document?.latestDate ?? null, firstBarDate: dates[0], lastBarDate: dates.at(-1), settings,
      baseline: { version: baseline.VERSION, sourceSha256: cacheProvenance.baselineSourceSha256, thresholds: { ...baseline.THRESHOLDS } },
      currentEngine: { version: current.VERSION, sourceSha256: cacheProvenance.currentSourceSha256, thresholds: { ...current.THRESHOLDS } },
      panelSourceSha256: cacheProvenance.panelSourceSha256,
      cacheProvenance, cacheKey: sha256(JSON.stringify(cacheProvenance)), cacheKeySha256: sha256(JSON.stringify(cacheProvenance)),
      cacheReuse: 'Require an exact cacheProvenance match against the current input, sources, settings and declared universe before reuse. Worker count is not a semantic parameter.',
      timing: 'Each signal uses only its own dated close and at most historyDays preceding bars; execute no earlier than the next contiguous session open.',
      limitations: [
        'Historical reconstruction is not evidence of original point-in-time data or universe availability.',
        'The current universe may contain hindsight selection and survivorship bias.',
        'An older previously uninspected holdout is not prospective or conventional forward chronological validation when design used later observations.',
        'Capture latestDate does not label earlier historical bars stale; execution must separately validate exchange-calendar gaps.',
        'Explicit provisional rows are excluded; unknown finality is counted and treated as stored history.',
        'Only confirmed not_listed instrument records reserve empty cash sleeves; download failures are rejected.',
        'This artifact contains signals only, not fitted thresholds, returns, commissions or profitability claims.'
      ] }
  };
}
