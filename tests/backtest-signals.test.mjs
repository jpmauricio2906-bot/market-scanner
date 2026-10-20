import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { buildSignalPanel } from '../tools/backtest-signals.mjs';
import { auditSnapshot, legacyComposite, legacySignals } from '../tools/audit-scoring.mjs';

const require = createRequire(import.meta.url);
const scoring = require('../tools/baselines/scoring-v2.cjs');

function history(ticker = 'TEST', count = 90) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.03 + 7 * Math.sin(index / 7) + Math.sin(index * 1.3);
    const open = close + Math.cos(index) * 0.6;
    return { ticker, fecha: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
      open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close,
      volumen: 1000000 + Math.round(Math.sin(index / 2) * 350000), is_final: true };
  });
}

test('each signal is causal: future bars and capture dates cannot change any earlier signal', async () => {
  const rows = history('TEST', 120);
  const early = await buildSignalPanel({ rows: rows.slice(0, 80), latestDate: rows[79].fecha });
  const later = await buildSignalPanel({ rows: rows.toReversed(), latestDate: '2099-01-01' });
  assert.deepEqual(later.series[0].bars.slice(0, 80), early.series[0].bars);
  assert.deepEqual(later.series[0].signals.slice(0, 80), early.series[0].signals);
  const perturbed = rows.map((row, i) => i < 80 ? row : { ...row,
    open: row.open * 10, high: row.high * 10, low: row.low * 10, close: row.close * 10 });
  const changed = await buildSignalPanel(perturbed);
  assert.deepEqual(changed.series[0].signals.slice(0, 80), early.series[0].signals);
});

test('50 accepted bars are required and signals always align with normalized dated bars', async () => {
  const panel = await buildSignalPanel([...history('SHORT', 49), ...history('READY', 50)].toReversed());
  for (const { bars, signals } of panel.series) {
    assert.equal(bars.length, signals.length);
    bars.forEach((bar, index) => assert.equal(signals[index].date, bar.date));
    signals.slice(0, 49).forEach(signal => {
      assert.equal(signal.oldSignal, 'WAIT');
      assert.equal(signal.newSignal, 'WAIT');
      for (const key of ['oldComposite', 'newComposite', 'trendScore', 'entryScore', 'exitScore']) {
        assert.equal(signal[key], null);
      }
    });
  }
  assert.notEqual(panel.series.find(row => row.ticker === 'READY').signals[49].newSignal, 'WAIT');
  assert.equal(panel.quality.warmupBars, 98);
  assert.equal(panel.quality.eligibleSignals, 1);
});

test('latest result and every eligible prefix preserve exact v1 and frozen v2 scores', async () => {
  const rows = [...history('AAA', 87), ...history('BBB', 92)];
  const panel = await buildSignalPanel({ rows });
  const audit = auditSnapshot({ rows });
  for (const series of panel.series) {
    const expected = audit.rows.find(row => row.ticker === series.ticker);
    const actual = series.signals.at(-1);
    // The live audit can evolve beyond v2. Only unchanged Composite and v1
    // fields are expected to match it; strategy labels come from frozen v2.
    for (const key of ['oldSignal', 'oldComposite', 'newComposite']) {
      assert.equal(actual[key], expected[key], key);
    }
    series.signals.slice(49).forEach((signal, offset) => {
      const prefix = series.bars.slice(0, offset + 50);
      const oldComposite = legacyComposite(legacySignals(prefix));
      assert.equal(signal.oldComposite, oldComposite);
      assert.equal(signal.oldSignal, oldComposite >= 70 ? 'BUY' : oldComposite <= 30 ? 'SELL' : 'HOLD');
      const v2 = scoring.analyze(prefix);
      assert.equal(signal.newSignal, v2.signal);
      for (const key of ['trendScore', 'entryScore', 'exitScore']) assert.equal(signal[key], v2[key], key);
    });
  }
});

test('input retains older bars while each signal window rolls at exactly 500 bars', async () => {
  const rows = history('LONG', 530);
  const panel = await buildSignalPanel(rows);
  const { bars, signals } = panel.series[0];
  assert.equal(bars.length, 530);
  assert.equal(panel.quality.truncatedRows, 0);
  assert.equal(panel.quality.rollingWindowSignals, 30);
  for (const index of [499, 500, 529]) {
    const audit = auditSnapshot(rows.slice(0, index + 1));
    const expected = audit.rows[0];
    for (const key of ['oldSignal', 'oldComposite', 'newComposite']) {
      assert.equal(signals[index][key], expected[key], index + ' ' + key);
    }
    const v2 = scoring.analyze(bars.slice(Math.max(0, index + 1 - 500), index + 1));
    assert.equal(signals[index].newSignal, v2.signal);
    for (const key of ['trendScore', 'entryScore', 'exitScore']) assert.equal(signals[index][key], v2[key], index + ' ' + key);
  }
  const earlier = await buildSignalPanel(rows.slice(0, 510));
  assert.deepEqual(signals.slice(0, 510), earlier.series[0].signals);
});

test('validation excludes malformed and provisional bars without changing model inputs', async () => {
  const rows = history('VALID', 80);
  const reference = await buildSignalPanel(rows);
  const invalid = [null, { ...rows[0], open: null }, { ...rows[0], fecha: '2024-02-30' },
    { ...rows[0], volumen: true }, { ...rows[0], high: rows[0].close - 1 }];
  const provisional = [{ ...rows.at(-1), fecha: '2024-04-01', is_final: false },
    { ...rows.at(-1), fecha: '2024-04-02', status: 'PROVISIONAL' }];
  const actual = await buildSignalPanel([...rows, ...invalid, ...provisional, rows[0]]);
  assert.deepEqual(actual.series, reference.series);
  assert.equal(actual.quality.invalidRows, invalid.length);
  assert.equal(actual.quality.provisionalRows, provisional.length);
  assert.equal(actual.quality.duplicateRows, 1);
  assert.equal(actual.quality.acceptedRows, 80);
  const tuples = rows.map(row => [row.fecha, row.ticker, row.open, row.high, row.low, row.close, row.volumen]);
  const unknown = await buildSignalPanel(tuples);
  assert.deepEqual(unknown.series, reference.series);
  assert.equal(unknown.quality.unknownFinalityRows, 80);
  await assert.rejects(buildSignalPanel([...rows, { ...rows[0], volumen: 7 }]), /Conflicting duplicate/);
  await assert.rejects(buildSignalPanel({}), /nonempty row array/);
  await assert.rejects(buildSignalPanel([{ ticker: 'EMPTY' }]), /no usable OHLCV/);
});

test('reproducibility metadata hashes actual sources and distinguishes serialized from raw input hash', async () => {
  const document = { rows: history('TEST', 50), source: 'fixture', capturedAt: '2026-10-20T01:00:00Z' };
  const digest = value => createHash('sha256').update(value).digest('hex');
  const panel = await buildSignalPanel(document);
  assert.deepEqual(await buildSignalPanel(document), panel);
  assert.equal(panel.metadata.inputSha256, digest(JSON.stringify(document)));
  assert.match(panel.metadata.inputHashMethod, /JSON.stringify/);
  assert.equal(panel.metadata.currentEngine.sourceSha256,
    digest(await readFile(new URL('../tools/baselines/scoring-v2.cjs', import.meta.url))));
  assert.equal(panel.metadata.currentEngine.version, '2.0.0');
  assert.equal(panel.metadata.currentEngine.sourceSha256, '4780c5aec98a969c77d597972c0034f89b40cd6418e56ad61d26a2646ab83794');
  assert.equal(panel.metadata.baseline.implementationSha256,
    digest(await readFile(new URL('../tools/audit-scoring.mjs', import.meta.url))));
  assert.equal(panel.metadata.panelSourceSha256,
    digest(await readFile(new URL('../tools/backtest-signals.mjs', import.meta.url))));
  assert.deepEqual(panel.metadata.currentEngine.thresholds, scoring.THRESHOLDS);
  assert.deepEqual(panel.metadata.baseline.thresholds, { buy: 70, sell: 30 });
  const rawHash = digest('raw snapshot bytes');
  const raw = await buildSignalPanel(document, { inputSha256: rawHash });
  assert.equal(raw.metadata.inputSha256, rawHash);
  assert.equal(raw.metadata.inputHashMethod, 'original input file bytes');
  assert.ok(panel.metadata.limitations.some(text => text.includes('not an unseen forward test')));
});

test('invalid windows, unsafe warmups and malformed hash options are rejected', async () => {
  const rows = history();
  for (const historyDays of [0, 49, 501, Infinity, 500.1]) {
    await assert.rejects(buildSignalPanel(rows, { historyDays }), /historyDays/);
  }
  for (const minSignalDays of [0, 49, 501, 50.5]) {
    await assert.rejects(buildSignalPanel(rows, { minSignalDays }), /minSignalDays/);
  }
  await assert.rejects(buildSignalPanel(rows, { inputSha256: 'unverified' }), /inputSha256/);
  await assert.rejects(buildSignalPanel(rows, { onProgress: true }), /onProgress/);
});

test('optional progress reports complete tickers without altering the signal panel', async () => {
  const rows = [...history('BBB', 51), ...history('AAA', 50)];
  const progress = [];
  const actual = await buildSignalPanel(rows, { onProgress: item => progress.push(item) });
  assert.deepEqual(actual, await buildSignalPanel(rows));
  assert.deepEqual(progress, [
    { ticker: 'AAA', completedTickers: 1, totalTickers: 2, eligibleSignals: 1 },
    { ticker: 'BBB', completedTickers: 2, totalTickers: 2, eligibleSignals: 3 }
  ]);
});
