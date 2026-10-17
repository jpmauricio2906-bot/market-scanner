import test from 'node:test';
import assert from 'node:assert/strict';
import { activityPlan, recordActivity, ActivityError, validateMetadata } from '../tools/record-close-audit-activity.mjs';
const NOW = Date.parse('2026-10-20T00:35:00Z');
const SHA = 'a'.repeat(40), COMMIT = 'b'.repeat(40);
const metadata = (ageDays = 1) => ({ schema_version: 1, monitor: 'daily-close-audit',
  last_checked_at: new Date(NOW - ageDays * 86400000).toISOString(),
  session_date: new Date(NOW - ageDays * 86400000 - 4 * 3600000).toISOString().slice(0, 10) });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
const file = value => ({ type: 'file', encoding: 'base64', sha: SHA,
  content: Buffer.from(JSON.stringify(value)).toString('base64') });
const code = expected => error => error instanceof ActivityError && error.code === expected;

test('fresh activity, including exactly 28 days, needs no commit', () => {
  assert.equal(activityPlan(metadata(1), NOW).needed, false);
  assert.equal(activityPlan(metadata(28), NOW).needed, false);
  assert.equal(activityPlan(metadata(29), NOW).needed, true);
  assert.equal(activityPlan(null, NOW).metadata.session_date, '2026-10-19');
});
test('fresh record performs only a read without requiring a token', async () => {
  let calls = 0;
  const result = await recordActivity({ now: NOW }, { fetchImpl: async (url, init) => {
    calls++; assert.equal(init.method, undefined); assert.equal(init.headers.Authorization, undefined);
    assert.equal(url, 'https://api.github.com/repos/jpmauricio2906-bot/market-scanner/contents/.github/close-audit-activity.json?ref=main');
    return response(file(metadata()));
  } });
  assert.deepEqual(result, { changed: false, needed: false, dry_run: false }); assert.equal(calls, 1);
});
test('expired record writes only the fixed main path using the existing SHA', async () => {
  let calls = 0;
  const result = await recordActivity({ now: NOW, token: 'never-return-this' }, { fetchImpl: async (url, init) => {
    if (++calls === 1) return response(file(metadata(29)));
    assert.equal(url, 'https://api.github.com/repos/jpmauricio2906-bot/market-scanner/contents/.github/close-audit-activity.json');
    assert.equal(init.method, 'PUT'); assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body); assert.equal(body.branch, 'main'); assert.equal(body.sha, SHA);
    assert.equal(body.message, 'Update daily close audit activity record');
    assert.deepEqual(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')),
      { schema_version: 1, monitor: 'daily-close-audit', last_checked_at: '2026-10-20T00:35:00.000Z', session_date: '2026-10-19' });
    return response({ commit: { sha: COMMIT }, token: 'never-return-this' });
  } });
  assert.deepEqual(result, { changed: true, needed: true, dry_run: false, commit_sha: COMMIT });
  assert.ok(!JSON.stringify(result).includes('never-return-this')); assert.equal(calls, 2);
});
test('only a real HTTP 404 permits initial file creation, without a SHA', async () => {
  let calls = 0;
  const result = await recordActivity({ now: NOW, token: 'token' }, { fetchImpl: async (url, init) => {
    if (++calls === 1) return response({ message: 'Not Found' }, 404);
    assert.equal(init.method, 'PUT'); assert.equal(Object.hasOwn(JSON.parse(init.body), 'sha'), false);
    return response({ commit: { sha: COMMIT } }, 201);
  } });
  assert.equal(result.changed, true); assert.equal(calls, 2);
});
test('dry run reads missing or expired metadata but never writes or requires a token', async () => {
  for (const read of [response(null, 404), response(file(metadata(29)))]) {
    let calls = 0;
    assert.deepEqual(await recordActivity({ now: NOW, dryRun: true }, { fetchImpl: async (url, init) => {
      calls++; assert.equal(init.method, undefined); return read;
    } }), { changed: false, needed: true, dry_run: true });
    assert.equal(calls, 1);
  }
});
test('wrong repository or API origin is rejected before any request', async () => {
  for (const invalid of [{ repository: 'other/repo' }, { apiUrl: 'http://api.github.com' },
    { apiUrl: 'https://api.github.com.evil.test' }, { apiUrl: 'https://api.github.com/' }]) {
    await assert.rejects(recordActivity({ ...invalid, now: NOW, token: 'secret' },
      { fetchImpl: async () => assert.fail('must reject before network') }), code('ACTIVITY_DESTINATION_INVALID'));
  }
});
test('untrusted metadata, wrong identity and future timestamps never overwrite a file', async () => {
  const bad = [null, false, 0, '', [], { ...metadata(29), monitor: 'human-file' }, { ...metadata(29), extra: 'human text' },
    { ...metadata(29), session_date: '2026-02-30' }, { ...metadata(29), last_checked_at: '2026-10-21T00:35:00Z' },
    { ...metadata(29), session_date: '2026-10-19' }, { ...metadata(29), schema_version: 2 }];
  for (const value of bad) {
    let calls = 0;
    await assert.rejects(recordActivity({ now: NOW, token: 'secret' }, { fetchImpl: async (url, init) => {
      calls++; assert.equal(init.method, undefined); return response(file(value));
    } }), code('ACTIVITY_METADATA_INVALID'));
    assert.equal(calls, 1);
  }
});
test('malformed Contents response or HTML is not mistaken for an absent file', async () => {
  for (const invalid of [{ ...file(metadata()), type: 'dir' }, { ...file(metadata()), sha: '../other' },
    { ...file(metadata()), content: '!not base64!' }, { message: '404' }]) {
    let calls = 0;
    await assert.rejects(recordActivity({ now: NOW, token: 'secret' }, { fetchImpl: async () => {
      calls++; return response(invalid);
    } }), code('ACTIVITY_FILE_INVALID'));
    assert.equal(calls, 1);
  }
  await assert.rejects(recordActivity({ now: NOW }, { fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => { throw new Error('private HTML'); } }) }), code('ACTIVITY_FILE_INVALID'));
});
test('non-404 read errors cannot cause a write or expose an error payload', async () => {
  for (const status of [401, 403, 409, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(recordActivity({ now: NOW, token: 'secret' }, { fetchImpl: async () => {
      calls++; return response({ message: 'private details' }, status);
    } }), code(`ACTIVITY_HTTP_STATUS_${status}`));
    assert.equal(calls, 1);
  }
});
test('an ambiguous or failed PUT is never retried', async () => {
  for (const failTransport of [false, true]) {
    let calls = 0, writes = 0;
    await assert.rejects(recordActivity({ now: NOW, token: 'secret' }, { fetchImpl: async (url, init) => {
      calls++; if (!init.method) return response(file(metadata(29)));
      writes++; if (failTransport) throw new Error('ambiguous private details');
      return response({ private: 'details' }, 503);
    } }), code(failTransport ? 'ACTIVITY_HTTP_TRANSPORT_ERROR' : 'ACTIVITY_HTTP_STATUS_503'));
    assert.equal(calls, 2); assert.equal(writes, 1);
  }
});
test('a write requires a token; a stale record still cannot be changed anonymously', async () => {
  let calls = 0;
  await assert.rejects(recordActivity({ now: NOW }, { fetchImpl: async (url, init) => {
    calls++; assert.equal(init.method, undefined); return response(file(metadata(29)));
  } }), code('ACTIVITY_WRITE_TOKEN_REQUIRED'));
  assert.equal(calls, 1);
});
test('activity dates use New York across standard-time midnight', () => {
  const instant = Date.parse('2026-11-03T01:35:00Z');
  const plan = activityPlan(null, instant);
  assert.equal(plan.metadata.session_date, '2026-11-02');
  assert.equal(validateMetadata(plan.metadata, instant).monitor, 'daily-close-audit');
});
