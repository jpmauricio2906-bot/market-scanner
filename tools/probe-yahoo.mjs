/** Optional recent-download probe. No private credentials, history checks or remote writes. */
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root = new URL('../', import.meta.url);
const universe = JSON.parse(fs.readFileSync(new URL('data/universe.json', root), 'utf8'));
const byTicker = new Map(universe.instruments.map(item => [item.ticker, item]));
const tickers = process.argv.slice(2);
if (!tickers.length) tickers.push('AAPL', 'QQQ', 'SOXL');
if (tickers.length > 20 || tickers.some(ticker => !byTicker.has(ticker))) {
  throw new Error('Use hasta 20 tickers del universo actual. Ejemplo: node tools/probe-yahoo.mjs AAPL QQQ SOXL');
}
const context = vm.createContext({console, Date});
vm.runInContext(fs.readFileSync(new URL('apps-script/Yahoo.gs', root), 'utf8'), context,
  {filename: fileURLToPath(new URL('apps-script/Yahoo.gs', root))});
for (let offset = 0; offset < tickers.length; offset += 5) {
  await Promise.all(tickers.slice(offset, offset + 5).map(async ticker => {
    try {
      const instrument = byTicker.get(ticker), request = context.msYahooRequest_(instrument);
      const requestedAt = new Date().toISOString();
      const response = await fetch(request.url, {headers: request.headers, signal: AbortSignal.timeout(20000)});
      const body = await response.text(), fetchedAt = new Date().toISOString();
      const payload = context.msParseYahoo_({getResponseCode: () => response.status, getContentText: () => body},
        instrument, requestedAt, fetchedAt);
      console.log(JSON.stringify({ticker, requestedAt, fetchedAt, rawRows: payload.rows.length,
        symbol: payload.symbol, exchange: payload.exchange_name, quality: 'Sin evaluar: corresponde a Supabase'}));
    } catch (error) {
      console.error(JSON.stringify({ticker, error: error.message})); process.exitCode = 1;
    }
  }));
}
