/** Public read-only Yahoo daily data. This script never fits rules or calculates returns. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const project = fileURLToPath(new URL('../', import.meta.url));
const isoDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid date: ${value}`);
  }
  return value;
};

/** Yahoo adjusted close incorporates cash distributions and splits. Scale all
 * OHLC by adjclose/close consistently; retain Yahoo volume as supplied. These
 * synthetic adjusted bars approximate reinvested distributions. They do not
 * model actual dividend cash dates, taxes or point-in-time vendor revisions. */
export function normalizeYahooHistory(body, ticker, { startDate, endExclusive }) {
  const result = body.chart?.result?.[0];
  if (!result) throw new Error(body.chart?.error?.description || 'Yahoo result is empty');
  const quote = result.indicators?.quote?.[0];
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose;
  if (!quote || !adjusted) throw new Error('OHLC or adjusted close is missing');
  const rows = [], priceRows = [], dates = new Set();
  const quality = { suppliedBars: (result.timestamp || []).length, outsideRange: 0,
    invalidBars: 0, missingAdjustment: 0, duplicateDates: 0,
    quoteRoundingEnvelopeBars: 0, adjustedRoundingEnvelopeBars: 0 };
  for (let i = 0; i < (result.timestamp || []).length; i++) {
    const fecha = new Date(result.timestamp[i] * 1000).toISOString().slice(0, 10);
    if (fecha < startDate || fecha >= endExclusive) { quality.outsideRange++; continue; }
    const open = quote.open?.[i], high = quote.high?.[i], low = quote.low?.[i];
    const close = quote.close?.[i], volumen = quote.volume?.[i], adjclose = adjusted[i];
    if (![open, high, low, close].every(x => Number.isFinite(x) && x > 0)
      || !Number.isSafeInteger(volumen) || volumen < 0
      || high < Math.max(open, close, low) - close * 1e-6
      || low > Math.min(open, close, high) + close * 1e-6) {
      quality.invalidBars++; continue;
    }
    if (!Number.isFinite(adjclose) || adjclose <= 0) { quality.missingAdjustment++; continue; }
    if (dates.has(fecha)) { quality.duplicateDates++; continue; }
    dates.add(fecha);
    const factor = adjclose / close;
    // The material consistency check above runs before any clamp. Only provider
    // rounding within 1e-6 * close and floating-point multiplication envelopes
    // are normalized, never material bad bars such as SHEL's two rejected rows.
    const quoteHigh = Math.max(high, open, close), quoteLow = Math.min(low, open, close);
    if (quoteHigh !== high || quoteLow !== low) quality.quoteRoundingEnvelopeBars++;
    const adjustedOpen = open * factor;
    const adjustedHigh = Math.max(quoteHigh * factor, adjustedOpen, adjclose);
    const adjustedLow = Math.min(quoteLow * factor, adjustedOpen, adjclose);
    if (adjustedHigh !== quoteHigh * factor || adjustedLow !== quoteLow * factor) quality.adjustedRoundingEnvelopeBars++;
    rows.push({ fecha, ticker, open: adjustedOpen, high: adjustedHigh,
      low: adjustedLow, close: adjclose, volumen, is_final: true });
    priceRows.push({ fecha, ticker, open, high: quoteHigh, low: quoteLow, close, volumen, is_final: true });
  }
  rows.sort((a, b) => a.fecha.localeCompare(b.fecha));
  priceRows.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return { rows, priceRows, quality, metadata: {
    ticker, providerSymbol: result.meta?.symbol ?? null,
    exchange: result.meta?.exchangeName ?? null, currency: result.meta?.currency ?? null,
    providerTimezone: result.meta?.exchangeTimezoneName ?? null,
    firstTradeDate: Number.isFinite(result.meta?.firstTradeDate)
      ? new Date(result.meta.firstTradeDate * 1000).toISOString().slice(0, 10) : null,
    dividendEvents: Object.keys(result.events?.dividends || {}).length,
    splitEvents: Object.keys(result.events?.splits || {}).length,
    rows: rows.length, firstDate: rows[0]?.fecha ?? null, lastDate: rows.at(-1)?.fecha ?? null
  } };
}

export async function fetchValidationHistory({ startDate = '2016-01-01', endExclusive = '2024-01-01',
  outputDirectory, tickers = null, concurrency = 4, metadataOnly = false }) {
  isoDate(startDate); isoDate(endExclusive);
  if (startDate >= endExclusive) throw new Error('startDate must precede endExclusive');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency must be 1..8');
  if (!outputDirectory) throw new Error('An outputDirectory is required');
  const universeBytes = await fs.readFile(path.join(project, 'data/universe.json'));
  const universe = JSON.parse(universeBytes);
  const selected = universe.instruments.filter(item => tickers === null || tickers.includes(item.ticker));
  if (!selected.length || (tickers && tickers.some(t => !selected.some(item => item.ticker === t)))) {
    throw new Error('Use ticker symbols from the canonical universe');
  }
  const output = path.resolve(outputDirectory), rawDirectory = path.join(output, 'raw');
  await fs.mkdir(metadataOnly ? output : rawDirectory, { recursive: true });
  const capturedAt = new Date().toISOString(), diagnostics = [], rows = [], priceRows = [];
  let nextIndex = 0, completed = 0;
  async function worker() {
    while (nextIndex < selected.length) {
      const instrument = selected[nextIndex++];
      const symbol = instrument.yahooTicker || instrument.ticker;
      const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
      url.search = new URLSearchParams({ period1: String(Date.parse(startDate) / 1000),
        period2: String(Date.parse(endExclusive) / 1000), interval: '1d', events: 'div,splits',
        includeAdjustedClose: 'true' }).toString();
      const diagnostic = { ticker: instrument.ticker, requestedSymbol: symbol, url: url.href };
      try {
        let response, raw;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
            raw = await response.text();
            if (response.status !== 429 && response.status < 500) break;
          } catch (error) { if (attempt === 3) throw error; }
          if (attempt < 3) await sleep(1000 * 2 ** attempt);
        }
        diagnostic.httpStatus = response.status;
        diagnostic.retrievedAt = new Date().toISOString();
        diagnostic.rawSha256 = sha256(raw);
        if (!metadataOnly) {
          diagnostic.rawFile = `raw/${instrument.ticker}.json`;
          await fs.writeFile(path.join(rawDirectory, instrument.ticker + '.json'), raw);
        }
        if (!response.ok) {
          // A request before an instrument's first quoted session returns 400
          // or 404 for some symbols. Confirm vendor firstTradeDate separately;
          // never silently classify an outage or unknown symbol as a new IPO.
          const errorBody = JSON.parse(raw);
          diagnostic.providerError = errorBody.chart?.error ?? null;
          if ([400, 404].includes(response.status)) {
            const identityUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
            identityUrl.search = new URLSearchParams({ range: '5d', interval: '1d' }).toString();
            const identityResponse = await fetch(identityUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
            const identityRaw = await identityResponse.text();
            const identity = JSON.parse(identityRaw).chart?.result?.[0]?.meta;
            const firstTradeDate = Number.isFinite(identity?.firstTradeDate)
              ? new Date(identity.firstTradeDate * 1000).toISOString().slice(0, 10) : null;
            if (!metadataOnly) {
              diagnostic.identityRawFile = `raw/${instrument.ticker}-identity.json`;
              await fs.writeFile(path.join(rawDirectory, instrument.ticker + '-identity.json'), identityRaw);
            }
            diagnostic.identityProbe = { url: identityUrl.href, httpStatus: identityResponse.status,
              rawSha256: sha256(identityRaw), firstTradeDate,
              symbol: identity?.symbol ?? null, currency: identity?.currency ?? null };
            if (identityResponse.ok && identity?.symbol === symbol && identity?.currency === 'USD'
              && firstTradeDate && firstTradeDate >= endExclusive) {
              Object.assign(diagnostic, { valid: true, status: 'no_pre_cutoff_history', rows: 0,
                firstDate: null, lastDate: null, firstTradeDate, providerSymbol: symbol, currency: 'USD' });
              diagnostics.push(diagnostic); completed++;
              continue;
            }
          }
          throw new Error(`Yahoo HTTP ${response.status}`);
        }
        const parsed = normalizeYahooHistory(JSON.parse(raw), instrument.ticker, { startDate, endExclusive });
        Object.assign(diagnostic, parsed.metadata, { quality: parsed.quality, valid: true, status: 'downloaded' });
        if (diagnostic.providerSymbol !== symbol) throw new Error('Provider symbol does not match requested identity');
        if (diagnostic.currency !== 'USD') throw new Error('Expected USD instrument');
        if (!metadataOnly) { rows.push(...parsed.rows); priceRows.push(...parsed.priceRows); }
      } catch (error) {
        Object.assign(diagnostic, { valid: false, error: error.message });
      }
      diagnostics.push(diagnostic); completed++;
      if (completed % 25 === 0 || completed === selected.length) {
        console.log(JSON.stringify({ completedTickers: completed, totalTickers: selected.length,
          validTickers: diagnostics.filter(item => item.valid).length }));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
  diagnostics.sort((a, b) => a.ticker.localeCompare(b.ticker));
  rows.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.fecha.localeCompare(b.fecha));
  priceRows.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.fecha.localeCompare(b.fecha));
  const completedAt = new Date().toISOString();
  const availability = { schemaVersion: 1, capturedAt, completedAt, provider: 'Yahoo Finance chart v8, daily',
    startDate, endExclusive, metadataOnly, selectedTickers: selected.length,
    universeAsOf: universe.asOf, universeSha256: sha256(universeBytes),
    sourceSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
    validTickers: diagnostics.filter(item => item.valid).length,
    bars: diagnostics.reduce((sum, item) => sum + (item.valid ? item.rows || 0 : 0), 0),
    adjustment: 'Multiply provider open/high/low/close by adjclose/close. Keep provider volume unchanged. Normalize high/low envelopes only for provider rounding within 1e-6 of close or multiplication roundoff; reject material OHLC inconsistencies.',
    methodology: 'Only identity, coverage, validity and provider corporate-action event counts are inspected. No returns or strategy outcomes are calculated.',
    limitations: [ 'Current 2026 universe is selected retrospectively; delisted and historical membership are absent.',
      'Vendor data are retrieved now and may contain revisions unavailable at the historical date.',
      'Adjusted OHLC approximates reinvested distributions; no dividend taxation or cash-payment timing.',
      'Selection of this earlier period is retrospective; it is not a live forward performance test.' ], diagnostics };
  if (!metadataOnly) {
    const instruments = diagnostics.map(item => ({ ticker: item.ticker,
      status: !item.valid ? 'error' : item.status === 'no_pre_cutoff_history' ? 'not_listed' : 'ok',
      firstDate: item.firstDate ?? null, lastDate: item.lastDate ?? null, bars: item.rows ?? 0,
      providerFirstTradeDate: item.firstTradeDate ?? null, error: item.error ?? null }));
    const history = { capturedAt, completedAt, source: availability.provider, priceBasis: 'adjclose-ratio',
      requestedStartDate: startDate, requestedEndExclusive: endExclusive,
      priceAdjustment: availability.adjustment, universeAsOf: universe.asOf, instruments, rows };
    const serialized = JSON.stringify(history) + '\n';
    availability.historySha256 = sha256(serialized);
    availability.historyFile = 'history.json';
    await fs.writeFile(path.join(output, 'history.json'), serialized);
    const priceOnly = JSON.stringify({ ...history, priceBasis: 'provider-quote',
      priceAdjustment: 'Provider quote OHLC and volume, without adjclose/close scaling. Cash dividends excluded.',
      rows: priceRows }) + '\n';
    availability.priceOnlySha256 = sha256(priceOnly);
    availability.priceOnlyFile = 'price-only.json';
    await fs.writeFile(path.join(output, 'price-only.json'), priceOnly);
  }
  await fs.writeFile(path.join(output, 'availability.json'), JSON.stringify(availability, null, 2) + '\n');
  return availability;
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--metadata-only') { options.metadataOnly = true; continue; }
    const value = args[++i];
    if (value === undefined) throw new Error('Missing argument value');
    switch (args[i - 1]) {
      case '--start': options.startDate = value; break;
      case '--end-exclusive': options.endExclusive = value; break;
      case '--output': options.outputDirectory = value; break;
      case '--tickers': options.tickers = value.split(','); break;
      case '--concurrency': options.concurrency = Number(value); break;
      default: throw new Error(`Unknown argument: ${args[i - 1]}`);
    }
  }
  const result = await fetchValidationHistory(options);
  console.log(JSON.stringify({ outputDirectory: options.outputDirectory, metadataOnly: result.metadataOnly,
    startDate: result.startDate, endExclusive: result.endExclusive, selectedTickers: result.selectedTickers,
    validTickers: result.validTickers, bars: result.bars,
    failures: result.diagnostics.filter(item => !item.valid).map(item => ({ ticker: item.ticker, error: item.error })) }, null, 2));
  if (result.diagnostics.some(item => !item.valid)) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
