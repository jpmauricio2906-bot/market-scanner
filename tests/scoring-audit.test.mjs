import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditSnapshot, normalizeSnapshot, legacyComposite, legacySignals,
  LEGACY_SOURCE_SHA256 } from '../tools/audit-scoring.mjs';

const cli = fileURLToPath(new URL('../tools/audit-scoring.mjs', import.meta.url));

function history(ticker = 'VLO', count = 80) {
  return Array.from({ length: count }, (_, index) => {
    const close = index < 70 ? 100 + index * 0.5 + Math.sin(index) : 136 - (index - 69) * 2;
    return { ticker, fecha: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
      open: close + 0.3, high: close + 1, low: close - 1, close, volumen: 1000000, is_final: true };
  });
}

const tuple = row => [row.fecha, row.ticker, row.open, row.high, row.low, row.close, row.volumen];
const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 });

test('frozen baseline preserves the original oversold optimism on a falling series', () => {
  const { series } = normalizeSnapshot(history());
  const signals = legacySignals(series[0].bars);
  assert.equal(signals.stoch_rsi, 1);
  assert.equal(signals.rsi, 1);
  assert.equal(legacyComposite(signals), 58);
  assert.match(LEGACY_SOURCE_SHA256, /^[a-f0-9]{64}$/);
  const report = auditSnapshot(history());
  const row = report.rows[0];
  assert.equal(row.oldSignal, 'HOLD');
  assert.equal(row.oldComposite, 58);
  assert.equal(row.newStochRsiSignal, 0);
  assert.ok(row.newComposite < row.oldComposite);
  assert.ok(row.entryScore < 50);
  assert.ok(['SELL', 'STRONG_SELL'].includes(row.newSignal));
  assert.match(report.vlo.label, /2026-03-21; not a current quotation/);
});

test('Supabase rows, Yahoo rows envelopes and workbook tuples produce identical scores', () => {
  const rows = history();
  const expected = auditSnapshot(rows);
  const yahoo = auditSnapshot({ rows: rows.toReversed() });
  const workbook = auditSnapshot(rows.map(tuple).toReversed());
  const aliases = auditSnapshot(rows.map(row => ({ ...row, ticker: ' vlo ', fecha: undefined,
    date: row.fecha, volumen: undefined, volume: String(row.volumen), close: String(row.close) })));
  assert.deepEqual(yahoo.rows, expected.rows);
  assert.deepEqual(workbook.rows, expected.rows);
  assert.deepEqual(aliases.rows, expected.rows);
  assert.deepEqual(workbook.summary, expected.summary);
  assert.equal(expected.quality.unknownFinalityRows, 0);
  assert.equal(workbook.quality.unknownFinalityRows, rows.length);
});

test('validation reports rejected rows and excludes provisional candles from both models', () => {
  const rows = history();
  const expected = auditSnapshot(rows);
  const bad = [
    { ...rows[0], open: null },
    { ...rows[0], fecha: '2026-02-30' },
    { ...rows[0], volumen: true },
    { ...rows[0], high: rows[0].close - 1 },
    { ...rows[0], ticker: '???' },
    null,
    { ...rows.at(-1), fecha: '2026-03-22', is_final: false, close: 120 },
    { ...rows.at(-1), fecha: '2026-03-23', status: 'PROVISIONAL' }
  ];
  const actual = auditSnapshot([...bad, ...rows, rows[0]]);
  assert.deepEqual(actual.rows, expected.rows);
  assert.equal(actual.quality.invalidRows, 6);
  assert.equal(actual.quality.provisionalRows, 2);
  assert.equal(actual.quality.duplicateRows, 1);
  assert.equal(actual.quality.acceptedRows, rows.length);
  assert.throws(() => normalizeSnapshot([...rows, { ...rows[0], vol: 1, volumen: 2 }]), /Conflicting duplicate/);
});

test('short histories and explicitly dated stale histories are WAIT without manufacturing data', () => {
  const rows = [...history(), ...history('NEW', 10), ...history('OLD', 70)];
  const report = auditSnapshot({ rows, capturedAt: '2026-03-22T10:00:00Z', latestDate: '2026-03-21' });
  const short = report.rows.find(row => row.ticker === 'NEW');
  const stale = report.rows.find(row => row.ticker === 'OLD');
  assert.equal(short.oldSignal, 'WAIT');
  assert.equal(short.newSignal, 'WAIT');
  assert.equal(short.oldComposite, null);
  assert.equal(short.newComposite, null);
  assert.equal(short.entryScore, null);
  assert.equal(stale.newSignal, 'WAIT');
  assert.equal(stale.stale, true);
  assert.ok(Number.isFinite(stale.trendScore));
  assert.equal(report.summary.oldWait, 1);
  assert.equal(report.summary.newWait, 2);
  assert.equal(report.asOf.mixedTickerDates, true);
  assert.deepEqual(report.asOf.staleTickers, ['NEW', 'OLD']);
  assert.equal(report.summary.ranges.oldComposite.count, 2);
  assert.equal(Object.values(report.summary.newCounts).reduce((sum, count) => sum + count, 0), 3);
  const undated = auditSnapshot(rows);
  assert.equal(undated.rows.find(row => row.ticker === 'OLD').stale, false);
  assert.equal(undated.asOf.expectedLatestDate, null);
});

test('history truncation matches the scanner window and results are deterministic', () => {
  const rows = history('TEST', 600).map((row, index) => {
    const close = 100 + index / 10;
    return { ...row, open: close, high: close + 1, low: close - 1, close };
  });
  const report = auditSnapshot({ rows });
  assert.equal(report.quality.truncatedRows, 100);
  assert.equal(report.rows[0].days, 500);
  assert.deepEqual(report.rows, auditSnapshot(rows.slice(-500)).rows);
  assert.deepEqual(report, auditSnapshot({ rows }));
  assert.throws(() => auditSnapshot(rows, { minSignalDays: 1 }), /minSignalDays/);
  assert.throws(() => normalizeSnapshot(rows, { historyDays: 0 }), /historyDays/);
  assert.throws(() => auditSnapshot({}), /nonempty row array/);
  assert.throws(() => auditSnapshot([{ ticker: 'EMPTY' }]), /no usable OHLCV/);
});

test('CLI emits reproducible JSON to stdout or a file, with source hash and dated VLO', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'market-scoring-audit-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const input = join(temporary, 'snapshot.json'), output = join(temporary, 'report', 'audit.json');
  await writeFile(input, '\uFEFF' + JSON.stringify({ rows: history(), source: 'test capture',
    retrievedAt: '2026-03-22T10:00:00Z', retrievedAtByTicker: { VLO: '2026-03-22T09:00:00Z' } }));
  const stdoutRun = run(['--input', input]);
  assert.equal(stdoutRun.status, 0, stdoutRun.stderr);
  const stdoutReport = JSON.parse(stdoutRun.stdout);
  assert.match(stdoutReport.inputSha256, /^[a-f0-9]{64}$/);
  assert.equal(stdoutReport.vlo.capturedAt, '2026-03-22T09:00:00Z');
  assert.equal(stdoutReport.source, 'test capture');
  const fileRun = run(['--input', input, '--output', output]);
  assert.equal(fileRun.status, 0, fileRun.stderr);
  const fileReport = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(fileReport, stdoutReport);
  assert.equal(JSON.parse(fileRun.stdout).output, output);
  assert.equal(run(['--help']).status, 0);
});

test('CLI rejects missing input, invalid JSON, ambiguous options and input overwrite', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'market-scoring-errors-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const input = join(temporary, 'snapshot.json');
  await writeFile(input, '{broken');
  for (const args of [[], ['--input', input, '--output', input], ['--input', input],
    ['--input', input, '--unknown', 'value'], ['--input', input, '--input', input]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Scoring audit:/);
  }
  assert.equal(await readFile(input, 'utf8'), '{broken');
});
