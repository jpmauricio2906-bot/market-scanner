import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildBacktestCalendar } from '../tools/build-backtest-calendar.mjs';
import { auditLongCoverage } from '../tools/preflight-long-history.mjs';

const calendar = JSON.parse(await fs.readFile(new URL('../data/backtest-calendar.json', import.meta.url), 'utf8'));
const row = (fecha, ticker = 'VLO') => ({ fecha, ticker, open: 10, high: 11, low: 9, close: 10, volumen: 100, is_final: true });
const source = (overrides = {}) => ({ startDate: '2018-12-03', endExclusive: '2018-12-07', diagnostics: [
  { ticker: 'VLO', valid: true, status: 'downloaded', firstTradeDate: '2000-01-01', quality: {}, ...overrides },
] });

test('long calendar reproduces reviewed sources and keeps both mourning closures', async () => {
  assert.deepEqual(calendar, await buildBacktestCalendar());
  assert.equal(calendar.firstYear, 2015);
  assert.equal(calendar.lastYear, 2028);
  for (const date of ['2018-12-05', '2025-01-09', '2022-06-20', '2023-06-19']) assert.ok(calendar.holidays.includes(date));
  for (const date of ['2021-06-18', '2021-12-31', '2027-12-31']) assert.ok(!calendar.holidays.includes(date));
  assert.ok(calendar.earlyCloses.includes('2015-12-24'));
  assert.ok(calendar.earlyCloses.includes('2017-07-03'));
  assert.ok(!calendar.earlyCloses.includes('2015-07-02'));
});

test('coverage uses actual exchange sessions instead of weekdays and includes early closes', () => {
  const audit = auditLongCoverage(source(), ['2018-12-03', '2018-12-04', '2018-12-06'].map(day => row(day)), calendar);
  assert.equal(audit.valid, true);
  assert.equal(audit.requestedSessions, 3);
  const early = auditLongCoverage({ ...source(), startDate: '2015-12-23', endExclusive: '2015-12-26' },
    ['2015-12-23', '2015-12-24'].map(day => row(day)), calendar);
  assert.equal(early.valid, true);
  assert.equal(early.requestedSessions, 2);
});

test('successful request with rejected rows is blocked even if remaining rows look valid', () => {
  const audit = auditLongCoverage(source({ quality: { invalidBars: 1 } }), ['2018-12-03', '2018-12-06'].map(day => row(day)), calendar);
  assert.equal(audit.valid, false);
  assert.equal(audit.diagnostics[0].status, 'quality_blocked');
  assert.deepEqual(audit.diagnostics[0].missingDates, ['2018-12-04']);
  assert.equal(audit.diagnostics[0].rejectedBars, 1);
});

test('recent listings start at verified first trade date; unverified empty response stays blocked', () => {
  const listed = auditLongCoverage(source({ firstTradeDate: '2018-12-06' }), [row('2018-12-06')], calendar);
  assert.equal(listed.valid, true);
  const later = auditLongCoverage(source({ firstTradeDate: '2020-01-02', status: 'no_pre_cutoff_history' }), [], calendar);
  assert.equal(later.valid, true);
  const empty = auditLongCoverage(source({ firstTradeDate: '2020-01-02' }), [], calendar);
  assert.equal(empty.valid, false);
});

test('duplicates, closed sessions, invalid prices and foreign tickers are not accepted', () => {
  const bars = ['2018-12-03', '2018-12-04', '2018-12-06'].map(day => row(day));
  assert.equal(auditLongCoverage(source(), [...bars, bars[0]], calendar).valid, false);
  assert.equal(auditLongCoverage(source(), [...bars, row('2018-12-05')], calendar).valid, false);
  assert.equal(auditLongCoverage(source(), [{ ...bars[0], close: Infinity }, ...bars.slice(1)], calendar).valid, false);
  assert.equal(auditLongCoverage(source(), [...bars, row('2018-12-03', 'UNKNOWN')], calendar).valid, false);
});
