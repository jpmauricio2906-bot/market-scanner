// Dedicated, read-only history client. Scanner and ticker charts keep their
// existing 500-session store and never import or download this archive.
import {isSession, validDate} from './lab.mjs?v=2';

export const LONG_HISTORY_PRICE_BASIS = 'yahoo_split_adjusted_ohlc_excluding_cash_dividends';
export const MAX_HISTORY_BARS = 800000;
const coverageColumns = 'ticker,first_date,last_date,row_count,requested_start,requested_end,updated_at,status,last_error,price_basis,source,snapshot_id';
const barColumns = 'fecha,ticker,open,high,low,close,volumen,is_final';
const tickerPattern = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const abortError = () => new DOMException('Aborted', 'AbortError');

function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
  });
}

async function requestJson(url, {headers, signal, fetcher}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    checkAbort(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(abort, 30000);
    try {
      const response = await fetcher(url, {headers, signal: controller.signal, cache: 'no-store'});
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await pause(500 * (attempt + 1), signal); continue;
        }
        throw new Error(`La solicitud de datos falló (HTTP ${response.status}).`);
      }
      return await response.json();
    } catch (error) {
      checkAbort(signal);
      if (error.name === 'AbortError') throw new Error('La solicitud de datos agotó el tiempo de espera. Vuelve a intentarlo.');
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}

function validateCoverage(value, ticker) {
  if (Array.isArray(value) && value.length === 1 && value[0].ticker === ticker && value[0].status !== 'ready' && value[0].last_error) {
    throw new Error(`${ticker}: el historial largo no ha superado los controles de calidad. Prueba otra selección mientras se revisan los datos.`);
  }
  if (!Array.isArray(value) || value.length !== 1 || value[0].ticker !== ticker || value[0].status !== 'ready') {
    throw new Error(`${ticker}: el historial largo todavía no está disponible. Vuelve a intentarlo cuando termine su actualización.`);
  }
  const item = value[0];
  if (!uuidPattern.test(item.snapshot_id || '') || !Number.isSafeInteger(item.row_count) || item.row_count < 1 || item.row_count > 4000 ||
      ![item.first_date, item.last_date, item.requested_start, item.requested_end].every(validDate) ||
      item.first_date > item.last_date || item.first_date < item.requested_start || item.last_date > item.requested_end ||
      !Number.isFinite(Date.parse(item.updated_at)) || item.source !== 'Yahoo Finance' || item.price_basis !== LONG_HISTORY_PRICE_BASIS) {
    throw new Error(`${ticker}: la cobertura del historial largo no es válida. No se ejecutará el backtest.`);
  }
  // Keep provider diagnostics out of UI markup and preserve accepted snapshot
  // metadata even when a later refresh failed. Status ready certifies this copy.
  return Object.fromEntries(coverageColumns.split(',').map(key => [key, item[key] ?? null]));
}

function normalizeBars(rows, coverage) {
  const ticker = coverage.ticker;
  if (rows.length !== coverage.row_count || rows[0]?.fecha !== coverage.first_date || rows.at(-1)?.fecha !== coverage.last_date) {
    throw new Error(`${ticker}: la descarga no coincide con la cobertura publicada. Vuelve a cargar el historial.`);
  }
  return rows.map((row, index) => {
    const numbers = [row.open, row.high, row.low, row.close, row.volumen];
    if (row.ticker !== ticker || row.is_final !== true || !isSession(row.fecha) ||
        (index && row.fecha <= rows[index - 1].fecha) || !numbers.every(Number.isFinite) ||
        Math.min(row.open, row.high, row.low, row.close) <= 0 || row.high < Math.max(row.open, row.close, row.low) ||
        row.low > Math.min(row.open, row.close) || !Number.isSafeInteger(row.volumen) || row.volumen < 0) {
      throw new Error(`Barra inválida o no confirmada: ${ticker} ${row.fecha}.`);
    }
    return [row.fecha, ticker, ...numbers];
  });
}

/** Download only selected instruments, with three bounded concurrent streams.
 * Each instrument is an atomic provider snapshot: verify its identifier before
 * and after pagination; retry once if the server replaced it during the read.
 */
export async function fetchBacktestHistory({tickers, baseUrl, headers, signal, onProgress = null, fetcher = globalThis.fetch}) {
  if (!Array.isArray(tickers) || !tickers.length || tickers.length > 250 ||
      tickers.some(ticker => !tickerPattern.test(ticker)) || new Set(tickers).size !== tickers.length) {
    throw new Error('Selecciona entre 1 y 250 activos únicos para cargar el historial largo.');
  }
  if (typeof baseUrl !== 'string' || !/^https:\/\//.test(baseUrl)) throw new Error('La URL de Supabase debe usar HTTPS.');
  if (typeof fetcher !== 'function') throw new Error('No se pudo conectar para descargar los datos.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw abortError();
  signal?.addEventListener('abort', abort, {once: true});
  const requestOptions = {headers, signal: controller.signal, fetcher};
  const root = baseUrl.replace(/\/+$/, '') + '/rest/v1/';
  const results = new Array(tickers.length);
  let next = 0, completed = 0, received = 0, firstError = null;
  const readCoverage = async ticker => validateCoverage(await requestJson(root + 'backtest_history_coverage?' +
    new URLSearchParams({select: coverageColumns, ticker: 'eq.' + ticker}), requestOptions), ticker);
  async function readTicker(ticker) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await readCoverage(ticker), rows = [];
      let cursor = null, finished = false;
      for (let page = 0; page < 64; page++) {
        checkAbort(controller.signal);
        const params = new URLSearchParams({select: barColumns, ticker: 'eq.' + ticker,
          is_final: 'eq.true', order: 'fecha.asc', limit: '1000'});
        if (cursor) params.set('fecha', 'gt.' + cursor);
        const batch = await requestJson(root + 'backtest_history?' + params, requestOptions);
        if (!Array.isArray(batch)) throw new Error('Respuesta de Supabase no válida.');
        if (!batch.length) { finished = true; break; }
        const last = batch.at(-1)?.fecha;
        if (!validDate(last) || (cursor && last <= cursor)) throw new Error('La paginación de Supabase no avanzó. Revisa el orden de ticker y fecha.');
        rows.push(...batch);
        if (rows.length > 4000) throw new Error('El historial supera el límite seguro de paginación. Revisa la retención de datos.');
        cursor = last; received += batch.length;
        onProgress?.({completed, total: tickers.length, received, ticker});
      }
      if (!finished) throw new Error('El historial supera el límite seguro de paginación. Revisa la retención de datos.');
      const after = await readCoverage(ticker);
      if (before.snapshot_id !== after.snapshot_id) continue;
      return {rows: normalizeBars(rows, after), coverage: after};
    }
    throw new Error(`${ticker}: el historial cambió durante la descarga. Vuelve a cargarlo para obtener una copia consistente.`);
  }
  try {
    await Promise.allSettled(Array.from({length: Math.min(3, tickers.length)}, async () => {
      try {
        while (next < tickers.length) {
          checkAbort(controller.signal);
          const index = next++, ticker = tickers[index];
          results[index] = await readTicker(ticker); completed++;
          onProgress?.({completed, total: tickers.length, received, ticker});
        }
      } catch (error) { if (!firstError) firstError = error; controller.abort(); }
    }));
    if (firstError) throw firstError;
    checkAbort(controller.signal);
    const rows = results.flatMap(result => result.rows);
    if (rows.length > MAX_HISTORY_BARS) throw new Error('El historial debe contener como máximo 800.000 barras.');
    return {finalizedData: rows, source: {kind: 'backtest_history', confirmedOnly: true,
      loadedAt: new Date().toISOString(), priceBasis: LONG_HISTORY_PRICE_BASIS, provider: 'Yahoo Finance',
      coverage: results.map(result => result.coverage)}};
  } finally { signal?.removeEventListener('abort', abort); }
}

// Calendar-year window, including a February 29 -> February 28 clamp.
export function defaultHistoryStart(endDate, firstEligibleDate) {
  if (!validDate(endDate) || !validDate(firstEligibleDate)) return firstEligibleDate || '';
  const year = Number(endDate.slice(0, 4)) - 10;
  const candidate = year + endDate.slice(4);
  const start = validDate(candidate) ? candidate : `${year}-02-28`;
  return start < firstEligibleDate ? firstEligibleDate : start;
}
