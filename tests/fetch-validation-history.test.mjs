import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeYahooHistory, fetchValidationHistory } from '../tools/fetch-validation-history.mjs';
import { normalizeSnapshot } from '../tools/audit-scoring.mjs';

const range = { startDate: '2020-01-01', endExclusive: '2021-01-01' };
function fixture({ open = 100, high = 110, low = 90, close = 105, adjusted = 52.5, volume = 123 } = {}) {
  return { chart: { result: [{ meta: { symbol: 'SPY', currency: 'USD', firstTradeDate: 728317800 },
    timestamp: [Date.parse('2020-01-02T14:30:00Z') / 1000],
    indicators: { quote: [{ open: [open], high: [high], low: [low], close: [close], volume: [volume] }],
      adjclose: [{ adjclose: [adjusted] }] } }] } };
}

test('adjclose ratio scales every price and leaves volume unchanged', () => {
  const result = normalizeYahooHistory(fixture(), 'SPY', range);
  assert.deepEqual(result.rows[0], { fecha: '2020-01-02', ticker: 'SPY',
    open: 50, high: 55, low: 45, close: 52.5, volumen: 123, is_final: true });
  assert.deepEqual(result.priceRows[0], { fecha: '2020-01-02', ticker: 'SPY',
    open: 100, high: 110, low: 90, close: 105, volumen: 123, is_final: true });
});

test('roundoff in adjusted OHLC does not create a bad high/low envelope', () => {
  const result = normalizeYahooHistory(fixture({ open: 0.1, high: 0.1, low: 0.1,
    close: 0.1, adjusted: 1.7 }), 'SPY', range);
  assert.equal(result.quality.adjustedRoundingEnvelopeBars, 1);
  assert.equal(normalizeSnapshot({ rows: result.rows }).quality.invalidRows, 0);
  assert.ok(result.rows[0].high >= Math.max(result.rows[0].open, result.rows[0].close));
  assert.ok(result.rows[0].low <= Math.min(result.rows[0].open, result.rows[0].close));
});

test('provider rounding within tolerance is clamped and material invalid bars are rejected', () => {
  const rounded = normalizeYahooHistory(fixture({ open: 100, high: 100 - 1e-7,
    low: 100 + 1e-7, close: 100, adjusted: 90 }), 'SPY', range);
  assert.equal(rounded.rows.length, 1);
  assert.equal(rounded.quality.quoteRoundingEnvelopeBars, 1);
  assert.equal(rounded.priceRows[0].high, 100);
  assert.equal(rounded.priceRows[0].low, 100);
  const bad = normalizeYahooHistory(fixture({ high: 90 }), 'SPY', range);
  assert.equal(bad.rows.length, 0);
  assert.equal(bad.priceRows.length, 0);
  assert.equal(bad.quality.invalidBars, 1);
});

test('missing adjustment and fractional volume cannot silently enter either basis', () => {
  const missing = fixture(); delete missing.chart.result[0].indicators.adjclose;
  assert.throws(() => normalizeYahooHistory(missing, 'SPY', range), /adjusted close is missing/);
  const invalid = normalizeYahooHistory(fixture({ adjusted: null }), 'SPY', range);
  assert.equal(invalid.quality.missingAdjustment, 1);
  assert.equal(invalid.rows.length, 0);
  assert.equal(normalizeYahooHistory(fixture({ volume: 1.5 }), 'SPY', range).quality.invalidBars, 1);
});

test('duplicate dates and outside-range bars are counted without creating extra observations', () => {
  const body = fixture(), result = body.chart.result[0];
  result.timestamp.push(result.timestamp[0], Date.parse('2021-01-02T14:30:00Z') / 1000);
  for (const value of Object.values(result.indicators.quote[0])) value.push(value[0], value[0]);
  result.indicators.adjclose[0].adjclose.push(52.5, 52.5);
  const normalized = normalizeYahooHistory(body, 'SPY', range);
  assert.equal(normalized.rows.length, 1);
  assert.equal(normalized.quality.duplicateDates, 1);
  assert.equal(normalized.quality.outsideRange, 1);
});

async function withMockResponses(responses, action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'market-scanner-validation-'));
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => {
    assert.ok(requests < responses.length, 'Unexpected external request');
    const response = responses[requests++];
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  try { await action(directory, () => requests); }
  finally {
    globalThis.fetch = original;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true });
  }
}

test('no pre-cutoff history requires a successful identity probe with a later firstTradeDate', async () => {
  await withMockResponses([
    { status: 400, body: { chart: { error: { description: 'Data does not exist before listing' } } } },
    { status: 200, body: { chart: { result: [{ meta: { symbol: 'SPY', currency: 'USD',
      firstTradeDate: Date.parse('2022-01-03') / 1000 } }] } } }
  ], async (directory, requests) => {
    const result = await fetchValidationHistory({ ...range, outputDirectory: directory,
      tickers: ['SPY'], metadataOnly: true, concurrency: 1 });
    assert.equal(requests(), 2);
    assert.equal(result.validTickers, 1);
    assert.equal(result.bars, 0);
    assert.equal(result.diagnostics[0].status, 'no_pre_cutoff_history');
  });
});

test('download/identity failures remain errors rather than an invented non-listing', async () => {
  const failure = { status: 404, body: { chart: { error: { description: 'Symbol unavailable' } } } };
  await withMockResponses([failure, failure], async directory => {
    const result = await fetchValidationHistory({ ...range, outputDirectory: directory,
      tickers: ['SPY'], metadataOnly: true, concurrency: 1 });
    assert.equal(result.validTickers, 0);
    assert.equal(result.diagnostics[0].valid, false);
    assert.match(result.diagnostics[0].error, /HTTP 404/);
    assert.notEqual(result.diagnostics[0].status, 'no_pre_cutoff_history');
  });
});

test('downloaded bases share dates and publish exact instrument coverage and provenance', async () => {
  await withMockResponses([{ status: 200, body: fixture() }], async directory => {
    const result = await fetchValidationHistory({ ...range, outputDirectory: directory,
      tickers: ['SPY'], concurrency: 1 });
    const adjusted = JSON.parse(await fs.readFile(path.join(directory, 'history.json'), 'utf8'));
    const price = JSON.parse(await fs.readFile(path.join(directory, 'price-only.json'), 'utf8'));
    assert.equal(result.validTickers, 1);
    assert.equal(adjusted.priceBasis, 'adjclose-ratio');
    assert.equal(price.priceBasis, 'provider-quote');
    assert.equal(adjusted.instruments[0].status, 'ok');
    assert.equal(adjusted.instruments[0].bars, 1);
    assert.deepEqual(adjusted.rows.map(x => x.fecha), price.rows.map(x => x.fecha));
    assert.match(result.historySha256, /^[a-f0-9]{64}$/);
    assert.match(result.priceOnlySha256, /^[a-f0-9]{64}$/);
  });
});
