const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const workerModule = import(pathToFileURL(path.join(__dirname, '../supabase/functions/market-history-worker/worker.mjs')).href);

const token = 'a'.repeat(64), serviceKey = 'server-only-test-credential';
const job = { id: 1, ticker: 'AAPL', yahoo_symbol: 'AAPL', lease_token: '1d94b063-2a63-4d3d-80bc-d612d91a7e8e' };
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
  return new Request('https://project.supabase.co/functions/v1/market-history-worker', { method, headers, ...(body ? { body } : {}) });
}
async function harness({ jobs = [job], verify = true, fetchOverride, limits } = {}) {
  const { createMarketHistoryWorker } = await workerModule, calls = [];
  const fetchImpl = async (url, options) => {
    const name = new URL(url).pathname.split('/').pop();
    const args = options.body ? JSON.parse(options.body) : null;
    const call = { url, name, options, args }; calls.push(call);
    if (fetchOverride) { const result = await fetchOverride(call, calls); if (result !== undefined) return result; }
    if (name === 'market_verify_worker_token') return json(verify);
    if (name === 'market_claim_repairs') return json(jobs);
    if (name === 'market_replace_history') return json({ status: 'completed', private_detail: 'never returned' });
    if (name === 'market_fail_repair') return new Response(null, { status: 204 });
    if (new URL(url).hostname === 'query1.finance.yahoo.com') return json(yahoo(decodeURIComponent(name)));
    throw new Error('Unexpected network target');
  };
  return { calls, worker: createMarketHistoryWorker({ supabaseUrl: 'https://project.supabase.co', serviceRoleKey: serviceKey,
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
  assert.deepEqual(h.calls.map(c => c.name), ['market_verify_worker_token', 'market_claim_repairs']);
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
  const replacements = h.calls.filter(c => c.name === 'market_replace_history');
  assert.equal(replacements.length, 2);
  const payload = replacements.find(c => c.args.p_job_id === 1).args.p_payload;
  assert.deepEqual(payload, {
    ticker: 'AAPL', source: 'yahoo', symbol: 'AAPL', currency: 'USD', exchange_timezone: 'America/New_York', exchange_name: 'NMS',
    first_trade_epoch: 345479400, regular_market_time: 1792171200,
    requested_at: '2026-10-16T22:00:00.000Z', fetched_at: '2026-10-16T22:00:00.000Z',
    rows: [
      { timestamp: 1792061400, open: 100, high: 110, low: 90, close: null, volume: 1234 },
      { timestamp: 1792147800, open: 0, high: 115, low: 95, close: 110, volume: 2345 },
      { timestamp: 1792147800, open: null, high: null, low: null, close: null, volume: null },
    ], splits: [{ timestamp: 1598880600, numerator: 4, denominator: 1 }],
  });
  assert.equal(replacements[0].args.p_lease_token, job.lease_token);
  assert.equal(h.calls.filter(c => c.name === 'market_fail_repair').length, 0);
  for (const call of h.calls) {
    assert.equal(call.options.redirect, 'error');
    if (new URL(call.url).hostname === 'query1.finance.yahoo.com') {
      assert.equal(call.options.headers.apikey, undefined);
      assert.equal(call.options.headers.Authorization, undefined);
      assert.equal(new URL(call.url).searchParams.get('range'), '3y');
    } else {
      assert.equal(call.options.headers.apikey, serviceKey);
      assert.equal(call.options.headers.Authorization, 'Bearer ' + serviceKey);
    }
  }
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('SQL semantic rejection is already persisted and does not trigger a second failure update', async () => {
  const h = await harness({ fetchOverride: ({ name }) => name === 'market_replace_history'
    ? json({ status: 'rejected', reason: 'private SQL diagnostic' }) : undefined });
  const response = await h.worker(authorized());
  assert.deepEqual(await response.json(), { ok: true, claimed: 1, completed: 0, rejected: 1, failed: 0, unreported: 0 });
  assert.equal(h.calls.filter(c => c.name === 'market_fail_repair').length, 0);
});

for (const [failure, expected] of [['yahoo', 'yahoo_http_429'], ['replace', 'replace_http_400']]) {
  test(failure + ' HTTP failures persist a bounded generic reason with the original lease', async () => {
    const h = await harness({ fetchOverride: ({ name, url }) =>
      (failure === 'yahoo' && new URL(url).hostname === 'query1.finance.yahoo.com') ||
      (failure === 'replace' && name === 'market_replace_history')
        ? new Response('do not leak ' + serviceKey + token, { status: failure === 'yahoo' ? 429 : 400 }) : undefined });
    const response = await h.worker(authorized());
    assert.equal(response.status, 200);
    const text = await response.text(); assert.ok(!text.includes(serviceKey)); assert.ok(!text.includes(token));
    assert.deepEqual(h.calls.find(c => c.name === 'market_fail_repair').args,
      { p_job_id: job.id, p_lease_token: job.lease_token, p_reason: expected });
    if (failure === 'yahoo') assert.equal(h.calls.filter(c => c.name === 'market_replace_history').length, 0);
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
  assert.equal(h.calls.find(c => c.name === 'market_fail_repair').args.p_reason, 'yahoo_timeout');
});

test('overall deadline aborts both jobs and allows independent bounded failure cleanup', async () => {
  const h = await harness({ jobs: [job, second], limits: { budgetMs: 10, yahooMs: 1000 }, fetchOverride: ({ url, options, name }) => {
    if (new URL(url).hostname === 'query1.finance.yahoo.com') return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
    });
    if (name === 'market_fail_repair') assert.equal(options.signal.aborted, false);
  } });
  const response = await h.worker(authorized());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).failed, 2);
  assert.equal(h.calls.filter(c => c.name === 'market_fail_repair').length, 2);
});

test('failed failure persistence returns 503 so the SQL lease can recover after expiry', async () => {
  const h = await harness({ fetchOverride: ({ name, url }) => name === 'market_fail_repair' || new URL(url).hostname === 'query1.finance.yahoo.com'
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
    ['too large', { 'content-length': '2000001' }, 'yahoo_response_too_large'],
  ]) {
    const h = await harness({ fetchOverride: ({ url }) => new URL(url).hostname === 'query1.finance.yahoo.com'
      ? new Response(body, { headers }) : undefined });
    const response = await h.worker(authorized());
    assert.equal(response.status, 200);
    assert.equal(h.calls.find(c => c.name === 'market_fail_repair').args.p_reason, expected);
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
  const { createMarketHistoryWorker } = await workerModule;
  const worker = createMarketHistoryWorker({ fetchImpl() { throw new Error('must not run'); } });
  assert.equal((await worker(authorized())).status, 503);
});
