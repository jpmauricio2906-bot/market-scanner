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
function msObject_(r) {
  let date = r[0];
  if (date instanceof Date) date = msDate_(date);
  return {fecha: String(date), ticker: String(r[1]), open: r[2], high: r[3], low: r[4], close: r[5], volumen: r[6]};
}

function msLoadHistory_(sheet) {
  const values = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues() : [];
  const byTicker = {}, free = [], keys = {}, dirty = {};
  values.forEach(function(array, n) {
    if (array.every(x => x === '')) { free.push(n); return; }
    const row = msObject_(array), key = row.ticker + '|' + row.fecha;
    if (!msValidBar_(row) || keys[key]) throw new Error('Historial existente inválido o duplicado, fila ' + (n + 2) + '. Usar la plantilla limpia.');
    // Sheets returns date cells as Date; compare canonical dates to avoid rewriting unchanged bars.
    values[n] = msArray_(row);
    keys[key] = true;
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
