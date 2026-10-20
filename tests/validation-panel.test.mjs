import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { buildValidationPanel, validationPanelProvenance } from '../tools/validation-panel.mjs';

const require = createRequire(import.meta.url);
const baseline = require('../tools/baselines/scoring-v2.cjs');
const current = require('../js/scoring.js');
const digest = value => createHash('sha256').update(value).digest('hex');
const local = { workers: 1 };
function history(ticker = 'TEST', count = 80) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.03 + 7 * Math.sin(index / 7) + Math.sin(index * 1.3);
    const open = close + Math.cos(index) * 0.6;
    return { ticker, fecha: new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10),
      open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close,
      volumen: 1000000 + Math.round(Math.sin(index / 2) * 350000), is_final: true };
  });
}

test('every eligible prefix uses the frozen v2 and exact current production analysis', async () => {
  const panel = await buildValidationPanel({ rows: history() }, local);
  const { bars, signals } = panel.series[0];
  assert.equal(baseline.VERSION, '2.0.0');
  assert.equal(panel.metadata.baseline.version, baseline.VERSION);
  assert.equal(panel.metadata.currentEngine.version, current.VERSION);
  signals.slice(0, 49).forEach(row => {
    assert.equal(row.oldSignal, 'WAIT'); assert.equal(row.newSignal, 'WAIT');
    assert.equal(row.entryScore, null); assert.equal(row.exitConfirmed, false);
  });
  for (let index = 49; index < bars.length; index++) {
    const prefix = bars.slice(0, index + 1), old = baseline.analyze(prefix), next = current.analyze(prefix);
    const actual = signals[index];
    assert.equal(actual.date, bars[index].date);
    assert.equal(actual.oldSignal, old.signal); assert.equal(actual.newSignal, next.signal);
    assert.equal(actual.oldEntryScore, old.entryScore); assert.equal(actual.oldExitScore, old.exitScore);
    for (const key of ['trendScore', 'entryScore', 'exitScore', 'technicalConfirmation']) assert.equal(actual[key], next[key]);
    for (const key of ['exitConfirmed', 'exitPersistent', 'exitEmergency', 'buyBreakoutConfirmed', 'sellBreakoutConfirmed']) {
      assert.equal(actual[key], Boolean(next.metrics[key]));
    }
  }
  assert.equal(panel.quality.warmupBars, 49);
  assert.equal(panel.quality.eligibleSignals, bars.length - 49);
});

test('later bars, reversed input order and capture date cannot change an earlier signal', async () => {
  const rows = history('TEST', 110);
  const early = await buildValidationPanel({ rows: rows.slice(0, 75), latestDate: rows[74].fecha }, local);
  const changed = rows.map((row, index) => index < 75 ? row : { ...row,
    open: row.open * 10, high: row.high * 10, low: row.low * 10, close: row.close * 10 });
  const later = await buildValidationPanel({ rows: changed.toReversed(), latestDate: '2099-01-01' }, local);
  assert.deepEqual(later.series[0].signals.slice(0, 75), early.series[0].signals);
  assert.deepEqual(later.series[0].bars.slice(0, 75), early.series[0].bars);
});

test('rolling 500-bar prefixes retain all execution history and match production', async () => {
  const panel = await buildValidationPanel({ rows: history('LONG', 530) }, local);
  const { bars, signals } = panel.series[0];
  assert.equal(bars.length, 530); assert.equal(panel.quality.truncatedRows, 0);
  assert.equal(panel.quality.rollingWindowSignals, 30);
  for (const index of [499, 500, 529]) {
    const prefix = bars.slice(Math.max(0, index + 1 - 500), index + 1);
    assert.equal(signals[index].oldSignal, baseline.analyze(prefix).signal);
    assert.equal(signals[index].newSignal, current.analyze(prefix).signal);
    assert.equal(signals[index].exitScore, current.analyze(prefix).exitScore);
  }
});

test('uniform price and volume scaling preserves relative scoring and technical flags', async () => {
  const rows = history();
  const original = await buildValidationPanel({ rows }, local);
  const scaled = await buildValidationPanel({ rows: rows.map(row => ({ ...row,
    open: row.open * 7, high: row.high * 7, low: row.low * 7, close: row.close * 7,
    volumen: row.volumen * 3 })) }, local);
  assert.deepEqual(scaled.series[0].signals, original.series[0].signals);
});

test('explicit not_listed records reserve empty sleeves, while unknown or failed histories fail', async () => {
  const rows = history('AAA', 55);
  const document = { rows, instruments: [{ ticker: 'AAA', status: 'ok' }, { ticker: 'IPO', status: 'not_listed' }] };
  const panel = await buildValidationPanel(document, { ...local, expectedTickers: ['IPO', 'AAA'] });
  assert.deepEqual(panel.series[1], { ticker: 'IPO', bars: [], signals: [] });
  assert.deepEqual(panel.quality.inactiveTickers, ['IPO']);
  await assert.rejects(buildValidationPanel({ rows }, { ...local, expectedTickers: ['AAA', 'UNKNOWN'] }), /no usable history/);
  for (const status of ['ok', 'error', 'unknown', null]) {
    const broken = structuredClone(document); broken.instruments[1].status = status;
    await assert.rejects(buildValidationPanel(broken, local), /no usable history|rejected status/);
  }
  await assert.rejects(buildValidationPanel({ ...document, rows: [...rows, ...history('IPO', 1)] }, local), /Not-listed ticker/);
  await assert.rejects(buildValidationPanel({ ...document, rows: [...rows, ...history('EXTRA', 1)] }, local), /outside the declared universe/);
  await assert.rejects(buildValidationPanel({ ...document, instruments: [...document.instruments, document.instruments[0]] }, local), /Duplicate instrument/);
  await assert.rejects(buildValidationPanel({ ...document, instruments: [{ ticker: 'AAA', status: 'ok' }] }, { ...local, expectedTickers: ['AAA', 'IPO'] }), /no instrument status/);
});

test('invalid source rows fail rather than converting missing instruments to cash', async () => {
  const rows = history();
  await assert.rejects(buildValidationPanel({ rows: [...rows, { ...rows[0], open: null }] }, local), /invalid OHLCV/);
  await assert.rejects(buildValidationPanel({ rows: [...rows, { ...rows[0], close: rows[0].close + 0.01 }] }, local), /Conflicting duplicate/);
  const panel = await buildValidationPanel({ rows: [...rows, { ...rows.at(-1), fecha: '2020-12-31', is_final: false }] }, local);
  assert.equal(panel.quality.provisionalRows, 1);
  assert.equal(panel.series[0].bars.length, rows.length);
});

test('cache provenance hashes actual source files, input bytes, settings and declared universe', async () => {
  const document = { rows: history('AAA', 50), source: 'fixture', capturedAt: '2026-10-20T00:00:00Z' };
  const inputSha256 = digest('Original capture file bytes');
  const panel = await buildValidationPanel(document, { ...local, inputSha256 });
  const expected = await validationPanelProvenance(document, { ...local, inputSha256, workers: 4 });
  assert.equal(panel.metadata.cacheKey, expected.cacheKey);
  assert.equal(panel.metadata.cacheKeySha256, expected.cacheKeySha256);
  assert.deepEqual(panel.metadata.cacheProvenance, expected.cacheProvenance);
  const provenance = expected.cacheProvenance;
  assert.equal(provenance.inputSha256, inputSha256);
  assert.equal(provenance.documentSha256, digest(JSON.stringify(document)));
  for (const [key, path] of [
    ['baselineSourceSha256', '../tools/baselines/scoring-v2.cjs'], ['currentSourceSha256', '../js/scoring.js'],
    ['normalizerSourceSha256', '../tools/audit-scoring.mjs'], ['panelSourceSha256', '../tools/validation-panel.mjs']
  ]) assert.equal(provenance[key], digest(await readFile(new URL(path, import.meta.url))));
  assert.equal(expected.cacheKey, digest(JSON.stringify(provenance)));
  assert.notEqual((await validationPanelProvenance(document, { ...local, inputSha256, historyDays: 200 })).cacheKey, expected.cacheKey);
  const augmented = { ...document, instruments: [{ ticker: 'AAA', status: 'ok' }, { ticker: 'IPO', status: 'not_listed' }] };
  assert.notEqual((await validationPanelProvenance(augmented, { ...local, inputSha256 })).cacheKey, expected.cacheKey);
  const inferred = await validationPanelProvenance(document, local);
  assert.equal(inferred.cacheProvenance.inputSha256, digest(JSON.stringify(document)));
  assert.match(inferred.cacheProvenance.inputHashMethod, /JSON.stringify/);
});

test('worker pool and serial execution produce identical panels and complete progress without prices', async () => {
  const document = { rows: [...history('BBB', 65), ...history('AAA', 59), ...history('CCC', 51)] };
  const progress = [];
  const serial = await buildValidationPanel(document, local);
  const threaded = await buildValidationPanel(document, { workers: 4, onProgress: record => progress.push(record) });
  assert.deepEqual(threaded, serial);
  assert.deepEqual(progress.map(row => row.completedTickers), [1, 2, 3]);
  assert.deepEqual(progress.map(row => row.ticker).sort(), ['AAA', 'BBB', 'CCC']);
  assert.equal(progress.at(-1).eligibleSignals, serial.quality.eligibleSignals);
  assert.ok(progress.every(row => Object.keys(row).sort().join(',') === 'completedTickers,eligibleSignals,ticker,totalTickers'));
  await assert.rejects(buildValidationPanel(document, { workers: 2, onProgress: () => { throw new Error('Stop progress'); } }), /Stop progress/);
});

test('invalid options and ambiguous universes fail before creating workers', async () => {
  const document = { rows: history('AAA', 50) };
  for (const workers of [0, 1.5, 33]) await assert.rejects(buildValidationPanel(document, { workers }), /workers/);
  for (const historyDays of [49, 501]) await assert.rejects(buildValidationPanel(document, { ...local, historyDays }), /historyDays/);
  for (const minSignalDays of [49, 501]) await assert.rejects(buildValidationPanel(document, { ...local, minSignalDays }), /minSignalDays/);
  await assert.rejects(buildValidationPanel(document, { ...local, inputSha256: 'not a digest' }), /inputSha256/);
  await assert.rejects(buildValidationPanel(document, { ...local, onProgress: true }), /onProgress/);
  await assert.rejects(buildValidationPanel(document, { ...local, expectedTickers: [] }), /expectedTickers/);
  await assert.rejects(buildValidationPanel(document, { ...local, expectedTickers: ['AAA', 'aaa'] }), /unique/);
});
