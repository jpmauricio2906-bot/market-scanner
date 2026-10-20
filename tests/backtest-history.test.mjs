import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fetchBacktestHistory, defaultHistoryStart, LONG_HISTORY_PRICE_BASIS, MAX_HISTORY_BARS} from '../js/backtest/history.mjs';
import {sessionDates, inspectHistory, runExperiment, PRESET_STRATEGIES} from '../js/backtest/lab.mjs';

const dates = sessionDates('2015-10-20', '2026-10-19');
const uuid = digit => `${String(digit).padStart(8, '0')}-0000-4000-8000-000000000000`;
function bars(ticker = 'AAA', count = 2600) {
  return dates.slice(0, count).map((fecha, index) => {
    const close = 100 + index * .02 + 2 * Math.sin(index / 17);
    return {fecha, ticker, open: close - .1, high: close + .5, low: close - .6, close, volumen: 1000 + index % 11 * 100, is_final: true};
  });
}
function fixture(ticker = 'AAA', count = 2600) {
  const rows = bars(ticker, count);
  return {rows, metadata: {ticker, first_date: rows[0].fecha, last_date: rows.at(-1).fecha, row_count: rows.length,
    requested_start: dates[0], requested_end: dates.at(-1), updated_at: '2026-10-20T01:00:00Z', status: 'ready',
    last_error: null, price_basis: LONG_HISTORY_PRICE_BASIS, source: 'Yahoo Finance', snapshot_id: uuid(1)}};
}
const ok = value => ({ok: true, status: 200, json: async () => value});
function api(fixtures, options = {}) {
  const requests = [], coverageReads = new Map();
  let active = 0, peak = 0;
  const fetcher = async (input, requestOptions) => {
    const url = new URL(input), ticker = url.searchParams.get('ticker')?.slice(3);
    requests.push({url, ticker, options: requestOptions}); active++; peak = Math.max(peak, active);
    try {
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      if (requestOptions.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const item = fixtures[ticker];
      if (url.pathname.endsWith('backtest_history_coverage')) {
        const count = (coverageReads.get(ticker) || 0) + 1; coverageReads.set(ticker, count);
        return ok(options.coverage ? options.coverage(item, count, ticker) : item ? [item.metadata] : []);
      }
      assert.ok(url.pathname.endsWith('backtest_history'), 'never fetch the scanner or quotes');
      assert.equal(url.searchParams.get('is_final'), 'eq.true');
      assert.equal(url.searchParams.get('order'), 'fecha.asc');
      const after = url.searchParams.get('fecha')?.slice(3);
      const rows = options.data ? options.data(item, url) : item.rows.filter(row => !after || row.fecha > after);
      return ok(rows.slice(0, options.pageSize || 1000));
    } finally { active--; }
  };
  return {fetcher, requests, coverageReads, peak: () => peak};
}
function load(client, tickers = ['AAA'], extra = {}) {
  return fetchBacktestHistory({tickers, baseUrl: 'https://example.supabase.co', headers: {apikey: 'sb_publishable_test'}, fetcher: client.fetcher, ...extra});
}

test('long archive paginates beyond 500 using only selected assets and preserves snapshot provenance', async () => {
  const client = api({AAA: fixture(), BBB: fixture('BBB')}, {pageSize: 200});
  const progress = [];
  const result = await load(client, ['AAA'], {onProgress: value => progress.push(value)});
  assert.equal(result.finalizedData.length, 2600);
  assert.equal(result.finalizedData[0][0], '2015-10-20');
  assert.ok(client.requests.every(request => request.ticker === 'AAA'));
  assert.equal(client.coverageReads.get('AAA'), 2);
  assert.equal(result.source.kind, 'backtest_history');
  assert.equal(result.source.confirmedOnly, true);
  assert.equal(result.source.priceBasis, LONG_HISTORY_PRICE_BASIS);
  assert.equal(result.source.coverage[0].snapshot_id, uuid(1));
  assert.equal(progress.at(-1).completed, 1);
  assert.equal(progress.at(-1).received, 2600);
});
test('portfolios use at most three simultaneous streams and deterministic selected order', async () => {
  const tickers = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];
  const client = api(Object.fromEntries(tickers.map(ticker => [ticker, fixture(ticker, 60)])), {delay: 1});
  const result = await load(client, tickers);
  assert.equal(client.peak(), 3);
  assert.deepEqual([...new Set(result.finalizedData.map(row => row[1]))], tickers);
});
test('an atomic replacement during pagination retries the asset from its first date', async () => {
  const client = api({AAA: fixture()}, {coverage: (item, count) => [{...item.metadata, snapshot_id: uuid(count === 1 ? 1 : 2)}]});
  const result = await load(client);
  assert.equal(result.finalizedData.length, 2600);
  assert.equal(result.source.coverage[0].snapshot_id, uuid(2));
  assert.equal(client.coverageReads.get('AAA'), 4);
  assert.equal(client.requests.filter(request => request.url.pathname.endsWith('backtest_history') && !request.url.searchParams.has('fecha')).length, 2);
});
test('repeated replacement rejects mixed copies instead of presenting a result', async () => {
  const client = api({AAA: fixture()}, {coverage: (item, count) => [{...item.metadata, snapshot_id: uuid(count)}]});
  await assert.rejects(load(client), /cambió durante la descarga/);
  assert.equal(client.coverageReads.get('AAA'), 4);
});
test('pending, missing and unsupported metadata fail without short-store fallback', async () => {
  for (const metadata of [null, {status: 'pending'}, {price_basis: 'total_return'}, {snapshot_id: null}, {row_count: 5000}]) {
    const item = fixture();
    const client = api({AAA: item}, {coverage: () => metadata === null ? [] : [{...item.metadata, ...metadata}]});
    await assert.rejects(load(client), /historial largo/);
    assert.equal(client.requests.length, 1);
  }
});
test('a failed later refresh may serve the prior accepted snapshot with its diagnostic preserved', async () => {
  const item = fixture(); item.metadata.last_error = 'Provider temporarily unavailable';
  const result = await load(api({AAA: item}));
  assert.equal(result.source.coverage[0].last_error, item.metadata.last_error);
});
test('initial quality rejection explains the unavailable asset without exposing provider diagnostics', async () => {
  const item = fixture(); item.metadata.status = 'pending'; item.metadata.last_error = 'internal provider diagnostic';
  await assert.rejects(load(api({AAA: item})), error => {
    assert.match(error.message, /AAA:.*controles de calidad/);
    assert.doesNotMatch(error.message, /internal provider diagnostic/);
    return true;
  });
});
test('missing bars, non-final rows, invalid prices and wrong tickers reject downloaded data', async () => {
  for (const change of [item => item.rows.splice(10, 1), item => item.rows[10].is_final = false,
    item => item.rows[10].high = 1, item => item.rows[10].ticker = 'BBB']) {
    const item = fixture(); change(item);
    await assert.rejects(load(api({AAA: item})), /no coincide|inválida o no confirmada/);
  }
});
test('a stuck page rejects promptly and never silently truncates history', async () => {
  const client = api({AAA: fixture()}, {data: item => item.rows.slice(0, 100)});
  await assert.rejects(load(client), /paginación.*no avanzó/);
  assert.equal(client.requests.length, 3);
});
test('cancel aborts active downloads and does not fall back to another source', async () => {
  const controller = new AbortController();
  const client = api({AAA: fixture()}, {delay: 10});
  const promise = load(client, ['AAA'], {signal: controller.signal});
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  assert.equal(client.requests.length, 1);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(load(client, ['AAA'], {signal: alreadyAborted.signal}), error => error.name === 'AbortError');
  assert.equal(client.requests.length, 1);
});
test('invalid selections are rejected before any network request', async () => {
  const client = api({AAA: fixture()});
  for (const tickers of [[], ['AAA', 'AAA'], ['A,bad'], Array(251).fill('AAA')]) await assert.rejects(load(client, tickers), /activos únicos/);
  assert.equal(client.requests.length, 0);
});
test('default evaluation reserves warm-up and shows ten calendar years when coverage permits', () => {
  assert.equal(defaultHistoryStart('2026-10-19', '2016-08-09'), '2016-10-19');
  assert.equal(defaultHistoryStart('2026-10-19', '2024-08-09'), '2024-08-09');
  assert.equal(defaultHistoryStart('2028-02-29', '2016-08-09'), '2018-02-28');
  assert.equal(defaultHistoryStart('2026-10-19', null), '');
});
test('expanded lab capacity accepts a long portfolio over the prior cap and remains bounded', () => {
  const base = bars().map(row => [row.fecha, row.ticker, row.open, row.high, row.low, row.close, row.volumen]);
  const tickers = Array.from({length: 100}, (_, index) => 'T' + index);
  const rows = tickers.flatMap(ticker => base.map(row => [row[0], ticker, ...row.slice(2)]));
  const info = inspectHistory(rows, {weights: Object.fromEntries(tickers.map(ticker => [ticker, .01])), strategy: PRESET_STRATEGIES.sma200});
  assert.equal(rows.length, 260000);
  assert.equal(info.coverage.length, 100);
  assert.equal(info.coverage[0].bars, 2600);
  assert.throws(() => inspectHistory(new Array(MAX_HISTORY_BARS + 1), {weights: {AAA: 1}}), /800.000/);
});
test('a decade run keeps costs, exact preset and accepted source identifiers in its export', async () => {
  const response = await load(api({AAA: fixture()}));
  const info = inspectHistory(response.finalizedData, {weights: {AAA: 1}, strategy: PRESET_STRATEGIES.sma200});
  const result = await runExperiment({rows: response.finalizedData, source: response.source,
    config: {weights: {AAA: 1}, strategy: PRESET_STRATEGIES.sma200, initialCapital: 10000, commissionBps: 0,
      slippageBps: 5, startDate: defaultHistoryStart(info.endDate, info.startDate), endDate: info.endDate}});
  assert.ok(result.strategy.period.sessions > 2300);
  assert.equal(result.data.source, 'confirmed_backtest_history');
  assert.equal(result.data.priceBasis, LONG_HISTORY_PRICE_BASIS);
  assert.equal(result.data.sourceSnapshots[0].snapshot_id, uuid(1));
  assert.ok(result.benchmark.metrics.totalCost > 0);
  assert.deepEqual(result.strategy.period, result.benchmark.period);
  assert.equal(result.config.strategy.preset, 'sma200');
});
test('scanner retains its independent 500-session loading path', async () => {
  const config = await readFile(new URL('../js/config.js', import.meta.url), 'utf8');
  const scannerClient = await readFile(new URL('../js/data.js', import.meta.url), 'utf8');
  assert.match(config, /historyDays:\s*500/);
  assert.doesNotMatch(scannerClient, /backtest_history/);
});
