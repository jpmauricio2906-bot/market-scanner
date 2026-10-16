/** One row per (fecha,ticker). Local storage is retried safely after remote upsert. */
function msProperties_() { return PropertiesService.getScriptProperties(); }

function msBook_() {
  const id = msProperties_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Ejecutar prepararMarketScanner primero.');
  return SpreadsheetApp.openById(id);
}

function msSupaConfig_() {
  const props = msProperties_(), url = (props.getProperty('SUPABASE_URL') || '').replace(/\/+$/, '');
  const key = props.getProperty('SUPABASE_WRITE_KEY') || '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) throw new Error('Configurar SUPABASE_URL en Propiedades del script.');
  if (!key || key.startsWith('sb_publishable_')) throw new Error('Configurar SUPABASE_WRITE_KEY privada en Propiedades del script.');
  const headers = {apikey: key};
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  return {url: url + '/rest/v1/market_history', headers: headers};
}

function msSupaRequest_(suffix, method, rows) {
  const config = msSupaConfig_(), headers = Object.assign({}, config.headers);
  if (method === 'post') headers.Prefer = 'resolution=merge-duplicates,return=minimal';
  const options = {method: method, headers: headers, muteHttpExceptions: true};
  if (rows) { options.contentType = 'application/json'; options.payload = JSON.stringify(rows); }
  const response = UrlFetchApp.fetch(config.url + suffix, options), code = response.getResponseCode();
  // Do not log response bodies (gateway responses can include credentials).
  if (code < 200 || code >= 300) throw new Error('Supabase HTTP ' + code + ': revisar clave, RLS y SQL.');
  return response;
}

function comprobarConexion() {
  msSupaRequest_('?select=fecha,ticker&limit=1', 'get');
  console.log('Conexión de lectura correcta. La escritura se comprueba con datos reales validados.');
}

function msPublish_(rows, cutoff, ticker) {
  if (!rows.length || rows.some(r => r.ticker !== ticker || !msValidBar_(r))) throw new Error('Publicación rechazada: OHLCV inválido');
  // A complete <=500-row ticker series is one transaction, including split restatements.
  if (rows.length > 500) throw new Error('Publicación supera 500 sesiones por empresa');
  msSupaRequest_('?on_conflict=fecha,ticker', 'post', rows.map(r => Object.assign({}, r, {is_final: true})));
  // Retention is ticker-specific; never delete an entire date or the whole table.
  if (cutoff) msSupaRequest_('?ticker=eq.' + encodeURIComponent(ticker) + '&fecha=lt.' + cutoff, 'delete');
}

function msArray_(r) { return [r.fecha, r.ticker, r.open, r.high, r.low, r.close, r.volumen]; }
function msHistoryDate_(value, timeZone, memo) {
  if (value instanceof Date) {
    const stamp = value.getTime();
    if (!Number.isFinite(stamp)) return null;
    if (memo && Object.prototype.hasOwnProperty.call(memo, stamp)) return memo[stamp];
    const date = Utilities.formatDate(value, timeZone, 'yyyy-MM-dd');
    if (memo) memo[stamp] = date;
    return date;
  }
  // An imported spreadsheet serial denotes a day, not a UTC timestamp to convert to New York.
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
  }
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const midnight = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/.exec(value);
  return midnight ? midnight[1] : null;
}

function msObject_(r, timeZone, memo) {
  return {fecha: msHistoryDate_(r[0], timeZone, memo), ticker: String(r[1]), open: r[2], high: r[3], low: r[4], close: r[5], volumen: r[6]};
}

function msHistoryIssue_(row, array) {
  if (array[0] === '' || array[0] === null || array[0] === undefined)
    return {column: 'A', message: 'Fecha vacía. Revisar la importación; no se puede deducir la fecha.'};
  if (!row.fecha) return {column: 'A', message: 'Fecha inválida. Usar fecha de celda, YYYY-MM-DD, serial entero o ISO de medianoche UTC.'};
  if (!msIsSession_(row.fecha)) return {column: 'A', message: 'Fecha fuera de una sesión de bolsa válida del calendario 2024–2030.'};
  if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(row.ticker || '')) return {column: 'B', message: 'Ticker vacío o inválido.'};
  const prices = [['open','C','Open'], ['high','D','High'], ['low','E','Low'], ['close','F','Close']];
  for (let i = 0; i < prices.length; i++) {
    const field = prices[i], value = row[field[0]];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      return {column: field[1], message: field[2] + ' debe ser un número positivo, no texto ni una celda vacía.'};
  }
  if (row.low > Math.min(row.open, row.close)) return {column: 'E', message: 'Low supera Open o Close; OHLC incoherente.'};
  if (row.high < Math.max(row.open, row.close)) return {column: 'D', message: 'High es inferior a Open o Close; OHLC incoherente.'};
  if (row.low > row.high) return {column: 'E', message: 'Low supera High; OHLC incoherente.'};
  if (!Number.isSafeInteger(row.volumen) || row.volumen < 0) return {column: 'G', message: 'Volumen debe ser un número entero no negativo.'};
  return null;
}

function msLoadHistory_(sheet) {
  const values = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues() : [];
  return msParseHistory_(sheet, values);
}

function msParseHistory_(sheet, values, positions, ticker, required, memo) {
  const timeZone = sheet.getParent().getSpreadsheetTimeZone(), dates = memo || {};
  const byTicker = {}, free = [], keys = {}, dirty = {};
  values.forEach(function(array, n) {
    const line = positions ? positions[n] : n + 2;
    if (array.every(x => x === '')) {
      if (positions && n < required) throw new Error('Historial!A' + line + ': bloque indexado incompleto. Ejecutar prepararMarketScanner.');
      free.push(n); return;
    }
    if (ticker && array[1] !== ticker) throw new Error('Historial!B' + line + ': índice desactualizado. Ejecutar prepararMarketScanner.');
    const row = msObject_(array, timeZone, dates);
    if (!msValidBar_(row)) {
      const issue = msHistoryIssue_(row, array);
      throw new Error('Historial!' + (issue ? issue.column : 'A') + line + ': ' + (issue ? issue.message : 'OHLCV inválido.') + ' No se modificó el historial.');
    }
    const key = row.ticker + '|' + row.fecha;
    if (keys[key]) throw new Error('Historial!B' + line + ': Fecha + Ticker duplicados con la fila ' + keys[key] + '. No se modificó el historial.');
    // Sheets returns date cells as Date; compare canonical dates to avoid rewriting unchanged bars.
    values[n] = msArray_(row);
    keys[key] = line;
    (byTicker[row.ticker] || (byTicker[row.ticker] = [])).push({index: n, row: row});
  });
  return {sheet: sheet, values: values, byTicker: byTicker, free: free, dirty: dirty, positions: positions, ticker: ticker};
}

function msInvalidateHistoryIndex_() { msProperties_().setProperty('MS_HISTORY_INDEX_READY', ''); }

function msBuildHistoryIndex_(ss, validatedCache) {
  msInvalidateHistoryIndex_();
  const sheet = ss.getSheetByName('Historial'), companies = msUniverse_(), tickers = companies.map(c => c.ticker);
  const known = new Set(tickers), blocks = {}, counts = {}, properties = {}, lastRow = sheet.getLastRow();
  const values = lastRow > 1 ? sheet.getRange(2, 2, lastRow - 1, 1).getValues() : [];
  let previous = null, nextRow = Math.max(2, lastRow + 1);
  values.forEach(function(array, i) {
    const ticker = array[0];
    if (ticker === '') { previous = null; return; }
    if (!known.has(ticker)) throw new Error('Historial!B' + (i + 2) + ': ticker fuera del universo. Revisar antes de preparar.');
    if (ticker !== previous) {
      if (blocks[ticker]) throw new Error('Historial: ordenar por Ticker y Fecha antes de construir el índice.');
      blocks[ticker] = [i + 2, 0];
    }
    blocks[ticker][1]++; counts[ticker] = (counts[ticker] || 0) + 1; previous = ticker;
  });
  Object.keys(validatedCache.byTicker).forEach(function(ticker) {
    if (!known.has(ticker)) throw new Error('Historial: ticker fuera del universo. Revisar antes de preparar.');
  });
  tickers.forEach(function(ticker) {
    const count = (validatedCache.byTicker[ticker] || []).length;
    if (count > 500 || (counts[ticker] || 0) !== count) throw new Error('Historial: bloque de ' + ticker + ' cambió o supera 500 sesiones. Preparar de nuevo.');
    const segments = count ? [blocks[ticker]] : [];
    if (count < 500) { segments.push([nextRow, 500 - count]); nextRow += 500 - count; }
    properties['MS_HISTORY_IDX_' + ticker] = JSON.stringify({version: 1, sheetId: sheet.getSheetId(), count: count, segments: segments});
  });
  if (nextRow - 1 > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), nextRow - 1 - sheet.getMaxRows());
  const meta = {version: 1, bookId: ss.getId(), sheetId: sheet.getSheetId(), tickers: tickers};
  properties.MS_HISTORY_INDEX_READY = ''; // The ready marker is committed separately, after every range exists.
  msProperties_().setProperties(properties);
  msProperties_().setProperty('MS_HISTORY_INDEX_READY', JSON.stringify(meta));
  return meta;
}

function msAssertHistoryIndex_(ss) {
  let meta;
  try { meta = JSON.parse(msProperties_().getProperty('MS_HISTORY_INDEX_READY') || 'null'); } catch (error) { meta = null; }
  const sheet = ss.getSheetByName('Historial'), tickers = msUniverse_().map(c => c.ticker);
  if (!meta || meta.version !== 1 || meta.bookId !== ss.getId() || !sheet || meta.sheetId !== sheet.getSheetId() ||
      JSON.stringify(meta.tickers) !== JSON.stringify(tickers)) throw new Error('Índice de Historial ausente o desactualizado. Ejecutar prepararMarketScanner.');
  return meta;
}

function msLoadTickerHistory_(ss, ticker, metadata) {
  const meta = metadata || msAssertHistoryIndex_(ss), sheet = ss.getSheetByName('Historial');
  if (!sheet || meta.bookId !== ss.getId() || meta.sheetId !== sheet.getSheetId())
    throw new Error('Índice de Historial desactualizado. Ejecutar prepararMarketScanner.');
  let index;
  try { index = JSON.parse(msProperties_().getProperty('MS_HISTORY_IDX_' + ticker) || 'null'); } catch (error) { index = null; }
  if (!meta.tickers.includes(ticker) || !index || index.version !== meta.version || index.sheetId !== meta.sheetId ||
      !Number.isInteger(index.count) || index.count < 0 || index.count > 500 || !Array.isArray(index.segments) ||
      index.segments.length < 1 || index.segments.length > 2)
    throw new Error('Índice de ' + ticker + ' inválido. Ejecutar prepararMarketScanner.');
  const positions = [];
  index.segments.forEach(function(segment) {
    if (!Array.isArray(segment) || segment.length !== 2 || !Number.isInteger(segment[0]) || segment[0] < 2 ||
        !Number.isInteger(segment[1]) || segment[1] < 1 || segment[1] > 500 || segment[0] + segment[1] - 1 > sheet.getMaxRows())
      throw new Error('Rango indexado de ' + ticker + ' inválido. Ejecutar prepararMarketScanner.');
    for (let i = 0; i < segment[1]; i++) positions.push(segment[0] + i);
  });
  if (positions.length !== 500 || new Set(positions).size !== 500)
    throw new Error('Capacidad indexada de ' + ticker + ' inválida. Ejecutar prepararMarketScanner.');
  const values = [];
  index.segments.forEach(segment => values.push.apply(values, sheet.getRange(segment[0], 1, segment[1], 7).getValues()));
  return msParseHistory_(sheet, values, positions, ticker, index.count, meta.dateMemo || (meta.dateMemo = {}));
}

function msMergeRows_(old, fresh, replace) {
  const map = {};
  if (!replace) old.forEach(r => { map[r.fecha] = r; });
  fresh.forEach(r => { map[r.fecha] = r; });
  return Object.keys(map).sort().slice(-500).map(date => map[date]);
}

function msSaveTicker_(cache, ticker, rows) {
  if (cache.positions && (ticker !== cache.ticker || rows.length > cache.positions.length)) throw new Error('Escritura fuera del bloque indexado de ' + ticker + '.');
  const old = cache.byTicker[ticker] || [], byDate = {}, next = [], keep = {};
  rows.forEach(r => { keep[r.fecha] = true; });
  old.forEach(function(item) {
    if (keep[item.row.fecha]) byDate[item.row.fecha] = item.index;
    else { cache.free.push(item.index); cache.values[item.index] = Array(7).fill(''); cache.dirty[item.index] = true; }
  });
  rows.forEach(function(row) {
    let index = byDate[row.fecha];
    if (index === undefined) index = cache.free.length ? cache.free.pop() : cache.values.length;
    if (cache.positions && index >= cache.positions.length) throw new Error('Capacidad de Historial agotada para ' + ticker + '.');
    const array = msArray_(row);
    if (JSON.stringify(cache.values[index]) !== JSON.stringify(array)) { cache.values[index] = array; cache.dirty[index] = true; }
    next.push({index: index, row: row});
  });
  cache.byTicker[ticker] = next;
}

function msFlushHistory_(cache) {
  if (cache.positions) {
    const writes = Object.keys(cache.dirty).map(function(key) {
      const n = Number(key);
      if (!Number.isInteger(n) || n < 0 || n >= cache.positions.length) throw new Error('Escritura fuera del índice de Historial.');
      return {row: cache.positions[n], values: cache.values[n]};
    }).sort((a, b) => a.row - b.row);
    for (let i = 0; i < writes.length;) {
      const start = i;
      while (++i < writes.length && writes[i].row === writes[i - 1].row + 1) {}
      cache.sheet.getRange(writes[start].row, 1, i - start, 7).setValues(writes.slice(start, i).map(item => item.values));
    }
    cache.dirty = {}; return;
  }
  const sheet = cache.sheet, required = cache.values.length + 1;
  if (required > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), required - sheet.getMaxRows());
  const indexes = Object.keys(cache.dirty).map(Number).sort((a, b) => a - b);
  for (let i = 0; i < indexes.length;) {
    const start = indexes[i]; let end = start;
    while (++i < indexes.length && indexes[i] === end + 1) end = indexes[i];
    sheet.getRange(start + 2, 1, end - start + 1, 7).setValues(cache.values.slice(start, end + 1));
  }
  SpreadsheetApp.flush(); cache.dirty = {};
}

function msWritePrice_(sheet, company, result, now, rowNumber) {
  const n = rowNumber === undefined ? msUniverse_().findIndex(c => c.ticker === company.ticker) + 2 : rowNumber;
  if (!Number.isInteger(n) || n < 2 || (rowNumber === undefined && sheet.getRange(n, 1).getValue() !== company.ticker)) throw new Error('Precios cambió: ejecutar prepararMarketScanner.');
  if (result.error) {
    // Preserve last successful values and fetch time; mark the failure explicitly.
    sheet.getRange(n, 13).setValue('ERROR: ' + result.error); return;
  }
  const r = result.current;
  sheet.getRange(n, 1, 1, 9).setValues([[company.ticker, company.name, r.fecha, r.open, r.high, r.low, r.close, r.volumen, result.previous]]);
  const metadata = [now.toISOString(), result.status];
  if (Number.isInteger(result.historyCount)) metadata.push(result.historyCount);
  sheet.getRange(n, 12, 1, metadata.length).setValues([metadata]);
}
