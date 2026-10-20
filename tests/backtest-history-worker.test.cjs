const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const workerModule = import(pathToFileURL(path.join(__dirname, '../supabase/functions/backtest-history-worker/worker.mjs')).href);

const token = 'a'.repeat(64), serviceKey = 'server-only-test-credential';
const job = { id: 1, ticker: 'AAPL', yahoo_symbol: 'AAPL', lease_token: '1d94b063-2a63-4d3d-80bc-d612d91a7e8e',
  requested_start: '2015-10-16', requested_end: '2026-10-16' };
const second = { ...job, id: 2, ticker: 'MSFT', yahoo_symbol: 'MSFT', lease_token: '598612f1-88a0-4635-8d49-f41a44b37d0c' };
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function yahoo(symbol = 'AAPL') {
  return { chart: { result: [{ meta: { symbol, currency: 'USD', exchangeTimezoneName: 'America/New_York',
    exchangeName: 'NMS', firstTradeDate: 345479400, regularMarketTime: 1792171200 },
    timestamp: [1792061400, 1792147800], indicators: { quote: [{
      open: [100, 105], high: [110, 115], low: [90, 95], close: [105, 110], volume: [1234, 2345],
    }] }, events: { splits: { '1598880600': { date: 1598880600, numerator: 4, denominator: 1 } } } }] } };
}
function request({ method = 'POST', headers = {}, body } = {}) {
  return new Request('https://project.supabase.co/functions/v1/backtest-history-worker', { method, headers, ...(body ? { body } : {}) });
}
async function harness({ jobs = [job], verify = true, fetchOverride, limits } = {}) {
  const { createBacktestHistoryWorker } = await workerModule, calls = [];
  const fetchImpl = async (url, options) => {
    const name = new URL(url).pathname.split('/').pop();
    const args = options.body ? JSON.parse(options.body) : null;
    const call = { url, name, options, args }; calls.push(call);
    if (fetchOverride) { const result = await fetchOverride(call, calls); if (result !== undefined) return result; }
    if (name === 'market_verify_worker_token') return json(verify);
    if (name === 'backtest_claim_history') return json(jobs);
    if (name === 'backtest_replace_history') return json({ status: 'completed', private_detail: 'never returned' });
    if (name === 'backtest_fail_history') return new Response(null, { status: 204 });
    if (new URL(url).hostname === 'query1.finance.yahoo.com') return json(yahoo(decodeURIComponent(name)));
    throw new Error('Unexpected network target');
  };
  return { calls, worker: createBacktestHistoryWorker({ supabaseUrl: 'https://project.supabase.co', serviceRoleKey: serviceKey,
    fetchImpl, now: () => Date.parse('2026-10-16T22:00:00Z'), limits }) };
}
function authorized(extra = {}) { return request({ headers: { 'X-Market-Worker-Token': token }, ...extra }); }

test('only POST and the private worker token authorize queue access; JWTs and public keys alone do not', async () => {
  const h = await harness();
  for (const method of ['GET', 'OPTIONS', 'PUT']) {
    const response = await h.worker(request({ method }));
    assert.equal(response.status, 405); assert.equal(response.headers.get('Allow'), 'POST');
  }
  for (const headers of [{}, { Authorization: 'Bearer valid-user-jwt' }, { apikey: 'sb_publishable_test' },
    { Authorization: 'Bearer ' + serviceKey }]) {
    assert.equal((await h.worker(request({ headers }))).status, 401);
  }
  assert.equal(h.calls.length, 0);
});

test('malformed tokens never reach the database, and a wrong well-formed token cannot claim repairs', async () => {
  const h = await harness({ verify: false });
  for (const value of ['bad', 'g'.repeat(64), 'a'.repeat(65)]) {
    assert.equal((await h.worker(request({ headers: { 'X-Market-Worker-Token': value } }))).status, 401);
  }
  assert.equal(h.calls.length, 0);
  assert.equal((await h.worker(authorized())).status, 401);
  assert.deepEqual(h.calls.map(c => c.name), ['market_verify_worker_token']);
  assert.deepEqual(h.calls[0].args, { p_token: token });
});

test('token verification fails closed without exposing remote errors or credentials', async () => {
  const h = await harness({ fetchOverride: ({ name }) => name === 'market_verify_worker_token'
    ? new Response('private SQL error ' + serviceKey + token, { status: 500 }) : undefined });
  const response = await h.worker(authorized());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'worker_unavailable' });
  assert.deepEqual(h.calls.map(c => c.name), ['market_verify_worker_token']);
});

test('empty queue is a no-op and callers cannot choose tickers, limits or a payload', async () => {
  const h = await harness({ jobs: [] });
  const response = await h.worker(authorized({ body: JSON.stringify({ p_limit: 250, ticker: 'OTHER', payload: yahoo() }) }));
  assert.deepEqual(await response.json(), { ok: true, claimed: 0, completed: 0, rejected: 0, failed: 0, unreported: 0 });
  assert.deepEqual(h.calls.map(c => c.name), ['market_verify_worker_token', 'backtest_claim_history']);
  assert.deepEqual(h.calls[1].args, { p_limit: 2 });
});

test('two leased jobs run concurrently and send complete source payloads to SQL without price validation', async () => {
  let yahooStarted = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const raw = yahoo(); raw.chart.result[0].timestamp.push(1792147800);
  raw.chart.result[0].indicators.quote[0].close[0] = null;
  raw.chart.result[0].indicators.quote[0].open[1] = 0;
  const h = await harness({ jobs: [job, second], fetchOverride: async ({ url, name }) => {
    if (new URL(url).hostname !== 'query1.finance.yahoo.com') return;
    if (++yahooStarted === 2) release();
    await barrier;
    const body = structuredClone(raw); body.chart.result[0].meta.symbol = name;
    return json(body);
  } });
  const response = await h.worker(authorized());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, claimed: 2, completed: 2, rejected: 0, failed: 0, unreported: 0 });
  const replacements = h.calls.filter(c => c.name === 'backtest_replace_history');
  assert.equal(replacements.length, 2);
  const payload = replacements.find(c => c.args.p_job_id === 1).args.p_payload;
  assert.deepEqual(payload, {
    ticker: 'AAPL', source: 'yahoo', symbol: 'AAPL', currency: 'USD', exchange_timezone: 'America/New_York', exchange_name: 'NMS',
    first_trade_epoch: 345479400, regular_market_time: 1792171200,
    requested_at: '2026-10-16T22:00:00.000Z', fetched_at: '2026-10-16T22:00:00.000Z',
    requested_start: job.requested_start, requested_end: job.requested_end,
    source_sha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
    rows: [
      { timestamp: 1792061400, open: 100, high: 110, low: 90, close: null, volume: 1234 },
      { timestamp: 1792147800, open: 0, high: 115, low: 95, close: 110, volume: 2345 },
      { timestamp: 1792147800, open: null, high: null, low: null, close: null, volume: null },
    ], splits: [{ timestamp: 1598880600, numerator: 4, denominator: 1 }],
  });
  // Concurrent downloads and SHA-256 operations may finish in either order.
  // The lease must follow its own job, independent of arrival order at the RPC.
  for (const leased of [job, second]) {
    const replacement = replacements.find(call => call.args.p_job_id === leased.id);
    assert.equal(replacement?.args.p_lease_token, leased.lease_token);
    assert.equal(replacement?.args.p_payload.ticker, leased.ticker);
  }
  assert.equal(h.calls.filter(c => c.name === 'backtest_fail_history').length, 0);
  for (const call of h.calls) {
    assert.equal(call.options.redirect, 'error');
    if (new URL(call.url).hostname === 'query1.finance.yahoo.com') {
      assert.equal(call.options.headers.apikey, undefined);
      assert.equal(call.options.headers.Authorization, undefined);
      assert.equal(new URL(call.url).searchParams.get('range'), null);
      assert.equal(new URL(call.url).searchParams.get('period1'), String(Date.parse(job.requested_start) / 1000));
      assert.equal(new URL(call.url).searchParams.get('period2'), String(Date.parse(job.requested_end) / 1000 + 86400));
    } else {
      assert.equal(call.options.headers.apikey, serviceKey);
      assert.equal(call.options.headers.Authorization, 'Bearer ' + serviceKey);
    }
  }
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('SQL semantic rejection is already persisted and does not trigger a second failure update', async () => {
  const h = await harness({ fetchOverride: ({ name }) => name === 'backtest_replace_history'
    ? json({ status: 'rejected', reason: 'private SQL diagnostic' }) : undefined });
  const response = await h.worker(authorized());
  assert.deepEqual(await response.json(), { ok: true, claimed: 1, completed: 0, rejected: 1, failed: 0, unreported: 0 });
  assert.equal(h.calls.filter(c => c.name === 'backtest_fail_history').length, 0);
});

for (const [failure, expected] of [['yahoo', 'yahoo_http_429'], ['replace', 'replace_http_400']]) {
  test(failure + ' HTTP failures persist a bounded generic reason with the original lease', async () => {
    const h = await harness({ fetchOverride: ({ name, url }) =>
      (failure === 'yahoo' && new URL(url).hostname === 'query1.finance.yahoo.com') ||
      (failure === 'replace' && name === 'backtest_replace_history')
        ? new Response('do not leak ' + serviceKey + token, { status: failure === 'yahoo' ? 429 : 400 }) : undefined });
    const response = await h.worker(authorized());
    assert.equal(response.status, 200);
    const text = await response.text(); assert.ok(!text.includes(serviceKey)); assert.ok(!text.includes(token));
    assert.deepEqual(h.calls.find(c => c.name === 'backtest_fail_history').args,
      { p_job_id: job.id, p_lease_token: job.lease_token, p_reason: expected });
    if (failure === 'yahoo') assert.equal(h.calls.filter(c => c.name === 'backtest_replace_history').length, 0);
  });
}

test('network timeout aborts Yahoo and records the failure before returning', async () => {
  const h = await harness({ limits: { yahooMs: 5 }, fetchOverride: ({ url, options }) => {
    if (new URL(url).hostname === 'query1.finance.yahoo.com') return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private transport details')), { once: true });
    });
  } });
  const response = await h.worker(authorized());
  assert.equal(response.status, 200);
  assert.equal(h.calls.find(c => c.name === 'backtest_fail_history').args.p_reason, 'yahoo_timeout');
});

test('overall deadline aborts both jobs and allows independent bounded failure cleanup', async () => {
  const h = await harness({ jobs: [job, second], limits: { budgetMs: 10, yahooMs: 1000 }, fetchOverride: ({ url, options, name }) => {
    if (new URL(url).hostname === 'query1.finance.yahoo.com') return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
    });
    if (name === 'backtest_fail_history') assert.equal(options.signal.aborted, false);
  } });
  const response = await h.worker(authorized());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).failed, 2);
  assert.equal(h.calls.filter(c => c.name === 'backtest_fail_history').length, 2);
});

test('failed failure persistence returns 503 so the SQL lease can recover after expiry', async () => {
  const h = await harness({ fetchOverride: ({ name, url }) => name === 'backtest_fail_history' || new URL(url).hostname === 'query1.finance.yahoo.com'
    ? new Response('unavailable', { status: 503 }) : undefined });
  const response = await h.worker(authorized());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, claimed: 1, completed: 0, rejected: 0, failed: 1, unreported: 1 });
});

test('malformed, duplicate or oversized claimed batches never fetch any ticker', async () => {
  for (const jobs of [[job, second, { ...job, id: 3 }], [job, job], [job, { ...job, id: '1' }], [{ ...job, lease_token: 'bad' }], { jobs: [job] }]) {
    const h = await harness({ jobs });
    assert.equal((await h.worker(authorized())).status, 503);
    assert.equal(h.calls.some(c => new URL(c.url).hostname === 'query1.finance.yahoo.com'), false);
  }
});

test('oversized or invalid Yahoo JSON is rejected as transport data without echoing its body', async () => {
  for (const [body, headers, expected] of [
    ['malformed JSON ' + token, {}, 'yahoo_invalid_json'],
    ['too large', { 'content-length': '4000001' }, 'yahoo_response_too_large'],
  ]) {
    const h = await harness({ fetchOverride: ({ url }) => new URL(url).hostname === 'query1.finance.yahoo.com'
      ? new Response(body, { headers }) : undefined });
    const response = await h.worker(authorized());
    assert.equal(response.status, 200);
    assert.equal(h.calls.find(c => c.name === 'backtest_fail_history').args.p_reason, expected);
    assert.ok(!(await response.text()).includes(token));
  }
});

test('claimed Yahoo symbols stay in an encoded path on the fixed Yahoo host', async () => {
  const symbol = 'AAPL/../../escape?target=https://other.invalid';
  const h = await harness({ jobs: [{ ...job, yahoo_symbol: symbol }] });
  assert.equal((await h.worker(authorized())).status, 200);
  const call = h.calls.find(c => new URL(c.url).hostname === 'query1.finance.yahoo.com');
  assert.ok(call.url.includes(encodeURIComponent(symbol)));
  assert.equal(new URL(call.url).hostname, 'query1.finance.yahoo.com');
});

test('missing platform credentials fail closed without any network call', async () => {
  const { createBacktestHistoryWorker } = await workerModule;
  const worker = createBacktestHistoryWorker({ fetchImpl() { throw new Error('must not run'); } });
  assert.equal((await worker(authorized())).status, 503);
});

test('invalid dates or an unbounded lease range are refused before Yahoo', async () => {
  for (const values of [{ requested_start: '2015-02-30' }, { requested_end: '2026-13-01' },
    { requested_start: '2000-01-01' }, { requested_start: '2027-01-01' }, { requested_start: undefined }]) {
    const h = await harness({ jobs: [{ ...job, ...values }] });
    assert.equal((await h.worker(authorized())).status, 503);
    assert.equal(h.calls.some(c => new URL(c.url).hostname === 'query1.finance.yahoo.com'), false);
  }
});

test('new secret keys use the apikey header without incorrectly presenting them as JWTs', async () => {
  const { createBacktestHistoryWorker } = await workerModule;
  const calls = [];
  const worker = createBacktestHistoryWorker({ supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'sb_secret_server_only', fetchImpl: async (url, options) => {
      calls.push(options.headers);
      return json(url.endsWith('/market_verify_worker_token') ? true : []);
    } });
  assert.equal((await worker(authorized())).status, 200);
  assert.equal(calls.length, 2);
  for (const headers of calls) {
    assert.equal(headers.apikey, 'sb_secret_server_only');
    assert.equal(headers.Authorization, undefined);
  }
});
