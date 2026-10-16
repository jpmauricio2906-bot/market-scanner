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
function msHistoryDate_(value, timeZone) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ?
    Utilities.formatDate(value, timeZone, 'yyyy-MM-dd') : null;
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

function msObject_(r, timeZone) {
  return {fecha: msHistoryDate_(r[0], timeZone), ticker: String(r[1]), open: r[2], high: r[3], low: r[4], close: r[5], volumen: r[6]};
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
  const timeZone = sheet.getParent().getSpreadsheetTimeZone();
  const values = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues() : [];
  const byTicker = {}, free = [], keys = {}, dirty = {};
  values.forEach(function(array, n) {
    if (array.every(x => x === '')) { free.push(n); return; }
    const row = msObject_(array, timeZone), line = n + 2;
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
  return {sheet: sheet, values: values, byTicker: byTicker, free: free, dirty: dirty};
}

function msMergeRows_(old, fresh, replace) {
  const map = {};
  if (!replace) old.forEach(r => { map[r.fecha] = r; });
  fresh.forEach(r => { map[r.fecha] = r; });
  return Object.keys(map).sort().slice(-500).map(date => map[date]);
}

function msSaveTicker_(cache, ticker, rows) {
  const old = cache.byTicker[ticker] || [], byDate = {}, next = [], keep = {};
  rows.forEach(r => { keep[r.fecha] = true; });
  old.forEach(function(item) {
    if (keep[item.row.fecha]) byDate[item.row.fecha] = item.index;
    else { cache.free.push(item.index); cache.values[item.index] = Array(7).fill(''); cache.dirty[item.index] = true; }
  });
  rows.forEach(function(row) {
    let index = byDate[row.fecha];
    if (index === undefined) index = cache.free.length ? cache.free.pop() : cache.values.length;
    const array = msArray_(row);
    if (JSON.stringify(cache.values[index]) !== JSON.stringify(array)) { cache.values[index] = array; cache.dirty[index] = true; }
    next.push({index: index, row: row});
  });
  cache.byTicker[ticker] = next;
}

function msFlushHistory_(cache) {
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

function msWritePrice_(sheet, company, result, now) {
  const companies = msUniverse_(), n = companies.findIndex(c => c.ticker === company.ticker) + 2;
  if (n < 2 || sheet.getRange(n, 1).getValue() !== company.ticker) throw new Error('Precios cambió: ejecutar prepararMarketScanner.');
  if (result.error) {
    // Preserve last successful values and fetch time; mark the failure explicitly.
    sheet.getRange(n, 13).setValue('ERROR: ' + result.error); return;
  }
  const r = result.current;
  sheet.getRange(n, 1, 1, 9).setValues([[company.ticker, company.name, r.fecha, r.open, r.high, r.low, r.close, r.volumen, result.previous]]);
  sheet.getRange(n, 12, 1, 2).setNumberFormat('@').setValues([[now.toISOString(), result.status]]);
  if (Number.isInteger(result.historyCount)) sheet.getRange(n, 14).setValue(result.historyCount);
}
