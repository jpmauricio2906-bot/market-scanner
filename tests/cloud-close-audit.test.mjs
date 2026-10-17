import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AuditError, validateUniverse, validateSnapshot, minimumCapture, readPublicConfig,
  requestJson, fetchSnapshot, upsertIncident, closeRecoveredIncident, renderReport, escapeMarkdown, parseArguments }
  from '../tools/check-close-audit.mjs';
import { notificationAction, tickerIncidents } from '../tools/check-close-audit.mjs';
import { scheduledSession, auditInstant, newYorkParts } from '../tools/close-audit-schedule.mjs';

const universe = validateUniverse(JSON.parse(await readFile(new URL('../data/universe.json', import.meta.url), 'utf8')));
const calendar = JSON.parse(await readFile(new URL('../supabase/calendar.json', import.meta.url), 'utf8'));
const sessionDate = '2026-10-19';
const captured = '2026-10-20T00:30:00+00:00';
const options = { sessionDate, now: Date.parse('2026-10-20T01:00:00Z') };
const checks = ['calendar_confirmed', 'final_history_valid', 'projection_consistent',
  'history_coverage_valid', 'no_active_repairs', 'no_current_rejections',
  'googlefinance_received', 'yahoo_received', 'worker_active', 'worker_recent_success'];
function fixture() {
  return [{ session_date: sessionDate, captured_at: captured, report: {
    schema_version: 1, session_date: sessionDate, captured_at: captured, universe: [...universe],
    expected: 250, complete: 250, ok: true,
    summary: { expected: 250, complete: 250, issues: 0, active_repairs: 0, latest_rejected: 0 }, issues: [],
    checks: { universe_count: 250, ...Object.fromEntries(checks.map(name => [name, true])) },
    automatic: {
      googlefinance: { received: 1000, distinct_tickers: 250, last_received_at: '2026-10-20T00:25:00Z', execution_origin_recorded: false },
      yahoo: { received: 250, distinct_tickers: 250, last_received_at: '2026-10-20T00:25:00Z', execution_origin_recorded: false },
      worker: { active: true, recent_successes: 60, recent_failures: 0, last_success_at: '2026-10-20T00:29:00Z' }
    }
  } }];
}
const errorCode = code => error => error instanceof AuditError && error.code === code;
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
const noSleep = async () => {};

test('accepts the exact 250-symbol close snapshot and rejects duplicate universe identities', () => {
  assert.equal(validateSnapshot(fixture(), universe, options).ok, true);
  const rows = fixture(); rows[0].report.universe[0] = rows[0].report.universe[1];
  assert.throws(() => validateSnapshot(rows, universe, options), errorCode('SNAPSHOT_UNIVERSE_INVALID'));
  assert.throws(() => validateUniverse([...universe.slice(1), universe[1]]), errorCode('UNIVERSE_INVALID'));
});
test('missing, duplicate and malformed snapshots cannot pass as healthy', () => {
  assert.throws(() => validateSnapshot([], universe, options), errorCode('SNAPSHOT_MISSING'));
  assert.throws(() => validateSnapshot([...fixture(), ...fixture()], universe, options), errorCode('SNAPSHOT_AMBIGUOUS'));
  assert.throws(() => validateSnapshot('<html>error</html>', universe, options), errorCode('SNAPSHOT_MISSING'));
  const rows = fixture(); rows[0].report.schema_version = 2;
  assert.throws(() => validateSnapshot(rows, universe, options), errorCode('SNAPSHOT_SCHEMA_INVALID'));
});
test('requires exact session, completed count, issue count and safe finite counts', () => {
  for (const mutation of [r => r.expected = 249, r => r.complete = NaN,
    r => r.summary.issues = 1, r => r.summary.active_repairs = Infinity,
    r => r.summary.complete = 249]) {
    const rows = fixture(); mutation(rows[0].report);
    assert.throws(() => validateSnapshot(rows, universe, options), errorCode('SNAPSHOT_COUNTS_INVALID'));
  }
  const rows = fixture(); rows[0].session_date = '2026-10-16';
  assert.throws(() => validateSnapshot(rows, universe, options), errorCode('SNAPSHOT_SCHEMA_INVALID'));
});
test('pending close and global incident are valid failures, not malformed reports', () => {
  const rows = fixture(), report = rows[0].report;
  Object.assign(report, { complete: 249, ok: false });
  Object.assign(report.summary, { complete: 249, issues: 1 });
  report.checks.final_history_valid = false;
  report.issues.push({ ticker: 'DELL', code: 'MISSING_FINAL_CLOSE', status: 'PENDIENTE',
    last_final_date: '2026-10-16', next_retry_at: '2026-10-20T01:30:00Z' });
  assert.equal(validateSnapshot(rows, universe, options).ok, false);
  const global = fixture(), r = global[0].report;
  r.ok = false; r.checks.worker_active = false; r.automatic.worker.active = false;
  r.issues.push({ ticker: null, code: 'WORKER_NOT_ACTIVE', status: 'REVISAR' }); r.summary.issues = 1;
  assert.equal(validateSnapshot(global, universe, options).complete, 250);
});
test('a repaired historical failure does not become an incident when current snapshot is healthy', () => {
  const rows = fixture(); rows[0].report.summary.completed_repairs = 21;
  assert.equal(validateSnapshot(rows, universe, options).issues.length, 0);
});
test('unknown issue identities, codes and duplicate issue entries are rejected', () => {
  for (const issue of [{ ticker: 'NOT-A-TICKER', code: 'ACTIVE_REPAIR' },
    { ticker: null, code: 'ARBITRARY_MESSAGE' }, { ticker: 'DELL', code: 'ACTIVE_REPAIR', next_retry_at: 'tomorrow' }]) {
    const rows = fixture(), report = rows[0].report;
    report.ok = false; report.summary.issues = 1; report.issues = [issue];
    assert.throws(() => validateSnapshot(rows, universe, options), errorCode('SNAPSHOT_ISSUE_INVALID'));
  }
  const rows = fixture(), report = rows[0].report;
  report.ok = false; report.summary.issues = 2;
  report.issues = [0, 1].map(() => ({ ticker: 'DELL', code: 'ACTIVE_REPAIR' }));
  assert.throws(() => validateSnapshot(rows, universe, options), errorCode('SNAPSHOT_ISSUE_DUPLICATED'));
});
test('rejects pre-deadline, future, invalid and inconsistent capture times', () => {
  assert.equal(minimumCapture(sessionDate), '2026-10-20T00:30:00.000Z');
  for (const time of ['2026-10-20T00:29:59Z', '2026-10-20T01:03:00Z', '2026-02-30T00:30:00Z', '2026-10-20 00:30:00']) {
    const rows = fixture(); rows[0].captured_at = rows[0].report.captured_at = time;
    assert.throws(() => validateSnapshot(rows, universe, options), errorCode('SNAPSHOT_TIME_INVALID'));
  }
  const rows = fixture(); rows[0].captured_at = '2026-10-20T00:31:00Z';
  assert.throws(() => validateSnapshot(rows, universe, options), errorCode('SNAPSHOT_TIME_INVALID'));
});
test('the healthy flag cannot bypass checks or missing closes', () => {
  const rows = fixture(); rows[0].report.checks.history_coverage_valid = false;
  assert.throws(() => validateSnapshot(rows, universe, options), errorCode('SNAPSHOT_RESULT_INCONSISTENT'));
  const missing = fixture(); missing[0].report.complete = missing[0].report.summary.complete = 249;
  missing[0].report.ok = false;
  assert.throws(() => validateSnapshot(missing, universe, options), errorCode('SNAPSHOT_RESULT_INCONSISTENT'));
});
test('checks cannot overstate automatic receipt coverage or worker health', () => {
  for (const mutation of [r => r.automatic.googlefinance.distinct_tickers = 249,
    r => r.automatic.yahoo.execution_origin_recorded = true,
    r => r.automatic.worker.recent_successes = 0]) {
    const rows = fixture(); mutation(rows[0].report);
    assert.throws(() => validateSnapshot(rows, universe, options), error => error.code.startsWith('SNAPSHOT_AUTOMATIC_'));
  }
});
test('one successful and one failed worker execution is a valid incident snapshot', () => {
  const rows = fixture(), report = rows[0].report;
  report.ok = false;
  Object.assign(report.automatic.worker, { recent_successes: 1, recent_failures: 1 });
  report.checks.worker_recent_success = false;
  report.issues = [{ ticker: null, code: 'WORKER_EXECUTION_FAILED_OR_MISSING', status: 'REVISAR' }];
  report.summary.issues = 1;
  assert.equal(validateSnapshot(rows, universe, options).ok, false);
});
test('configuration extraction does not evaluate JavaScript and rejects secret keys', () => {
  const source = 'const SUPABASE_URL = "https://example.supabase.co";\nconst SUPABASE_KEY = "sb_publishable_public"; throw new Error("never evaluate");';
  assert.deepEqual(readPublicConfig(source), { url: 'https://example.supabase.co', key: 'sb_publishable_public' });
  assert.throws(() => readPublicConfig(source, { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_private' }), errorCode('PUBLIC_CONFIG_INVALID'));
  assert.throws(() => readPublicConfig(source, { SUPABASE_URL: 'http://example.com' }), errorCode('PUBLIC_CONFIG_INVALID'));
});
test('bounded GET retries recover 503, 429 and transport errors', async () => {
  const responses = [response(null, 503), response(null, 429), response({ ok: true })];
  const waits = [];
  assert.deepEqual(await requestJson('https://example.test', {}, { fetchImpl: async () => responses.shift(),
    sleepImpl: async ms => waits.push(ms) }), { ok: true });
  assert.deepEqual(waits, [500, 1000]);
  let calls = 0;
  assert.deepEqual(await requestJson('https://example.test', {}, { fetchImpl: async () => {
    if (++calls === 1) throw new Error('sensitive transport details'); return response([]);
  }, sleepImpl: noSleep }), []);
  assert.equal(calls, 2);
});
test('HTML, authorization and persistent transport failures produce safe error codes', async () => {
  await assert.rejects(requestJson('https://example.test', {}, { fetchImpl: async () => ({ ok: true,
    status: 200, json: async () => { throw new Error('private HTML'); } }) }), errorCode('HTTP_JSON_INVALID'));
  await assert.rejects(requestJson('https://example.test', {}, { fetchImpl: async () => response({ secret: 'never logged' }, 401) }), errorCode('HTTP_STATUS_401'));
  await assert.rejects(requestJson('https://example.test', {}, { fetchImpl: async () => { throw new Error('private'); }, sleepImpl: noSleep }), errorCode('HTTP_TRANSPORT_ERROR'));
});
test('Supabase access is GET-only, filtered to one session, with bounded missing snapshot polling', async () => {
  let clock = 0, calls = 0;
  const rows = await fetchSnapshot({ url: 'https://example.supabase.co', key: 'sb_publishable_test' }, sessionDate,
    { now: () => clock, sleepImpl: async ms => { clock += ms; }, maxPollMs: 30000,
      fetchImpl: async (url, init) => {
        calls++; assert.equal(url.searchParams.get('session_date'), 'eq.2026-10-19');
        assert.equal(init.method, undefined); assert.equal(init.body, undefined);
        assert.equal(init.headers.apikey, 'sb_publishable_test');
        assert.equal(init.headers.Authorization, undefined);
        assert.equal(url.pathname, '/rest/v1/market_close_audits'); return response([]);
      } });
  assert.deepEqual(rows, []); assert.equal(calls, 3); assert.equal(clock, 30000);
});
test('probe verifies connectivity without waiting for Monday or treating empty rows as an incident', async () => {
  let calls = 0;
  assert.deepEqual(await fetchSnapshot({ url: 'https://example.supabase.co', key: 'sb_publishable_test' }, sessionDate,
    { probe: true, fetchImpl: async () => { calls++; return response([]); },
      sleepImpl: async () => assert.fail('probe must not poll') }), []);
  assert.equal(calls, 1);
});
test('GitHub notification reuses a closed incident found on a later page', async () => {
  const calls = [];
  const issue = await upsertIncident({ repository: 'jpmauricio2906-bot/market-scanner', token: 'test-token', sessionDate, body: 'report' }, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return response(Array.from({ length: 100 }, (_, n) => ({ number: n + 1, body: 'unrelated' })));
      if (calls.length === 2) return response([{ number: 120, state: 'closed', user: { login: 'github-actions[bot]' }, body: '<!-- market-scanner-close-audit:2026-10-19 -->old' }]);
      assert.equal(init.method, 'PATCH'); assert.ok(String(url).endsWith('/issues/120'));
      assert.equal(JSON.parse(init.body).state, 'open'); return response({ number: 120 });
    }
  });
  assert.deepEqual(issue, { number: 120, updated: true }); assert.equal(calls.length, 3);
});
test('GitHub creates only one marked and assigned incident, without retrying ambiguous POST', async () => {
  const calls = [];
  const result = await upsertIncident({ repository: 'jpmauricio2906-bot/market-scanner', token: 'test-token', sessionDate, body: 'report' }, {
    fetchImpl: async (url, init) => {
      calls.push(init); if (calls.length === 1) return response([]);
      const payload = JSON.parse(init.body); assert.deepEqual(payload.assignees, ['jpmauricio2906-bot']);
      assert.match(payload.body, /<!-- market-scanner-close-audit:2026-10-19 -->/);
      return response({ number: 1 }, 201);
    }
  });
  assert.equal(result.updated, false); assert.equal(calls.length, 2);
  let writes = 0;
  await assert.rejects(upsertIncident({ repository: 'o/r', token: 't', sessionDate, body: 'report' }, {
    fetchImpl: async (url, init) => {
      if (!init.method) return response([]); writes++; throw new Error('ambiguous');
    }, sleepImpl: noSleep
  }), errorCode('HTTP_TRANSPORT_ERROR'));
  assert.equal(writes, 1);
});
test('a human marker cannot hijack the workflow incident or cause a human issue to be edited', async () => {
  let calls = 0;
  const result = await upsertIncident({ repository: 'jpmauricio2906-bot/market-scanner', token: 'test-token', sessionDate, body: 'report' }, {
    fetchImpl: async (url, init) => {
      if (++calls === 1) return response([{ number: 1, state: 'open', user: { login: 'human' },
        body: '<!-- market-scanner-close-audit:2026-10-19 -->' }]);
      assert.equal(init.method, 'POST'); assert.ok(String(url).endsWith('/issues'));
      assert.deepEqual(JSON.parse(init.body).assignees, ['jpmauricio2906-bot']);
      return response({ number: 2 }, 201);
    }
  });
  assert.deepEqual(result, { number: 2, updated: false }); assert.equal(calls, 2);
});
test('Markdown renders safe fields without raw HTML, mentions or untrusted table delimiters', () => {
  assert.equal(escapeMarkdown('<@everyone|x>\n'), '&lt;&#64;everyone&#124;x&gt; ');
  const rows = fixture(), report = rows[0].report;
  report.issues = [{ ticker: 'DELL', code: 'ACTIVE_REPAIR', status: '<@user|x>', last_final_date: null, next_retry_at: null }];
  const md = renderReport({ sessionDate, report });
  assert.ok(!md.includes('<@user')); assert.match(md, /&#64;user&#124;x/);
  assert.match(renderReport({ sessionDate, error: 'HTTP_STATUS_503' }), /no se han modificado ni aceptado precios/);
});
test('healthy recovery closes the marked workflow bot incident and never closes human issues', async () => {
  const config = { repository: 'o/r', token: 't', sessionDate, body: 'All healthy' };
  const marker = '<!-- market-scanner-close-audit:2026-10-19 -->';
  let calls = 0;
  const result = await closeRecoveredIncident(config, { fetchImpl: async (url, init) => {
    if (++calls === 1) return response([
      { number: 1, state: 'open', body: marker, user: { login: 'human' } },
      { number: 2, state: 'open', body: marker, user: { login: 'github-actions[bot]' } }
    ]);
    assert.ok(String(url).endsWith('/issues/2'));
    const payload = JSON.parse(init.body); assert.equal(payload.state, 'closed');
    assert.equal(payload.state_reason, 'completed'); return response({ number: 2 });
  } });
  assert.deepEqual(result, { number: 2, closed: true }); assert.equal(calls, 2);
  assert.equal(await closeRecoveredIncident(config, { fetchImpl: async (url, init) => {
    assert.equal(init.method, undefined);
    return response([{ number: 1, state: 'open', body: marker, user: { login: 'human' } }]);
  } }), null);
});
test('fixtures always require --no-notify and CLI rejects invalid target dates', () => {
  assert.equal(parseArguments(['--probe']).probe, true);
  assert.equal(parseArguments(['--input', 'fixture.json', '--session', '2026-10-16', '--no-notify']).noNotify, true);
  assert.throws(() => parseArguments(['--input', 'fixture.json']), errorCode('FIXTURE_REQUIRES_NO_NOTIFY'));
  assert.throws(() => parseArguments(['--session', '2026-02-30']), errorCode('ARGUMENT_INVALID'));
  assert.throws(() => parseArguments(['--unrecognized']), errorCode('ARGUMENT_INVALID'));
});
test('20:30 New York audit boundaries follow daylight and standard time', () => {
  assert.equal(auditInstant('2026-03-09'), '2026-03-10T00:30:00.000Z');
  assert.equal(minimumCapture('2026-11-02'), '2026-11-03T01:30:00.000Z');
  assert.equal(newYorkParts('2026-03-10T00:30:00Z').hour, 20);
  assert.equal(newYorkParts('2026-11-03T01:30:00Z').hour, 20);
  assert.equal(scheduledSession(calendar, '2026-03-10T00:29:59Z').due, false);
  assert.equal(scheduledSession(calendar, '2026-03-10T00:30:00Z').due, true);
  assert.equal(scheduledSession(calendar, '2026-11-03T01:29:59Z').due, false);
  assert.equal(scheduledSession(calendar, '2026-11-03T01:30:00Z').due, true);
});
test('scheduled review uses only today in New York and never reuses a Friday on the weekend', () => {
  const saturday = scheduledSession(calendar, '2026-10-18T00:35:00Z');
  assert.equal(saturday.session, '2026-10-17'); assert.equal(saturday.due, false);
  const sunday = scheduledSession(calendar, '2026-10-19T00:35:00Z');
  assert.equal(sunday.session, '2026-10-18'); assert.equal(sunday.due, false);
  const monday = scheduledSession(calendar, '2026-10-20T00:35:00Z');
  assert.equal(monday.session, '2026-10-19'); assert.equal(monday.due, true);
  assert.equal(scheduledSession(calendar, '2026-10-20T02:30:00Z').due, false);
});
test('exchange holidays are skipped and early-close sessions still audit at 20:30', () => {
  const holiday = scheduledSession(calendar, '2026-07-04T00:35:00Z');
  assert.equal(holiday.session, '2026-07-03'); assert.equal(holiday.tradingDay, false); assert.equal(holiday.due, false);
  assert.ok(calendar.earlyCloses.includes('2026-11-27'));
  const early = scheduledSession(calendar, '2026-11-28T01:35:00Z');
  assert.equal(early.session, '2026-11-27'); assert.equal(early.due, true);
  assert.equal(early.auditAt, '2026-11-28T01:30:00.000Z');
  assert.equal(scheduledSession(calendar, '2026-11-27T18:35:00Z').due, false);
});
test('calendar validity and coverage cannot silently fall back to weekdays', () => {
  assert.throws(() => scheduledSession(calendar, '2029-01-03T01:35:00Z'), /CALENDAR_OUT_OF_RANGE/);
  assert.throws(() => scheduledSession({ ...calendar, timeZone: 'UTC' }, '2026-10-20T00:35:00Z'), /CALENDAR_INVALID/);
});
test('gate implies scheduling and scheduled mode rejects fixed dates, probes and fixtures', () => {
  const gate = parseArguments(['--gate']); assert.equal(gate.gate, true); assert.equal(gate.scheduled, true);
  assert.equal(parseArguments(['--scheduled']).scheduled, true);
  for (const args of [['--scheduled', '--session', '2026-10-19'], ['--scheduled', '--probe'],
    ['--scheduled', '--input', 'f.json', '--no-notify']]) {
    assert.throws(() => parseArguments(args), errorCode('ARGUMENT_INVALID'));
  }
});
test('API errors, missing or malformed snapshots and global-only failures never create GitHub incidents', () => {
  for (const error of ['HTTP_STATUS_503', 'SNAPSHOT_MISSING', 'SNAPSHOT_SCHEMA_INVALID', 'SNAPSHOT_COUNTS_INVALID']) {
    assert.equal(notificationAction({ report: null, error }), 'none');
  }
  const report = fixture()[0].report; report.ok = false;
  report.issues = [{ ticker: null, code: 'WORKER_NOT_ACTIVE' }, { ticker: null, code: 'YAHOO_RECEIPTS_INCOMPLETE' }];
  assert.equal(notificationAction({ report }), 'none'); assert.deepEqual(tickerIncidents(report), []);
  report.issues = [{ ticker: 'DELL', code: 'GOOGLEFINANCE_RECEIPTS_INCOMPLETE' }];
  assert.equal(notificationAction({ report }), 'none');
});
test('only validated ticker incidents notify; dry run and probe modes always suppress writes', () => {
  const report = fixture()[0].report; report.ok = false;
  report.issues = [{ ticker: 'DELL', code: 'ACTIVE_REPAIR' }, { ticker: null, code: 'WORKER_NOT_ACTIVE' }];
  assert.equal(notificationAction({ report }), 'incident'); assert.equal(tickerIncidents(report).length, 1);
  for (const guard of [{ noNotify: true }, { probe: true }, { gate: true }, { error: 'HTTP_STATUS_503' }]) {
    assert.equal(notificationAction({ report, ...guard }), 'none');
  }
  assert.equal(notificationAction({ report: fixture()[0].report }), 'resolve');
  assert.equal(notificationAction({ report: null }), 'none');
});
