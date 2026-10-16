/** Sheets submits snapshots; both server RPCs validate their own data source. */
function msProperties_() { return PropertiesService.getScriptProperties(); }

function msBook_() {
  const id = msProperties_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Ejecutar prepararMarketScanner primero.');
  return SpreadsheetApp.openById(id);
}

function msSupaConfig_(rpcName) {
  const props = msProperties_(), url = (props.getProperty('SUPABASE_URL') || '').replace(/\/+$/, '');
  const key = props.getProperty('SUPABASE_WRITE_KEY') || '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) throw new Error('Configurar SUPABASE_URL en Propiedades del script.');
  if (!key || key.startsWith('sb_publishable_')) throw new Error('Configurar SUPABASE_WRITE_KEY privada en Propiedades del script.');
  const headers = {apikey: key};
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  return {url: url + '/rest/v1/rpc/' + (rpcName || 'market_ingest_recent'), headers: headers};
}

function msIngestRecent_(payloads) {
  return msRpc_(payloads, 'market_ingest_recent', 2);
}
function msIngestSheetQuotes_(payloads) {
  return msRpc_(payloads, 'market_ingest_sheet_quotes', 3);
}
function msRpc_(payloads, rpcName, version) {
  const config = msSupaConfig_(rpcName);
  let response;
  try {
    response = UrlFetchApp.fetch(config.url, {method: 'post', headers: config.headers,
      contentType: 'application/json', payload: JSON.stringify({p_batch: payloads}), muteHttpExceptions: true});
  } catch (error) { throw new Error('Supabase: fallo de transporte.'); }
  const code = response.getResponseCode();
  // Never log gateway response bodies or request headers containing the private key.
  if (code < 200 || code >= 300) throw new Error('Supabase RPC HTTP ' + code + ': revisar conexión, clave y despliegue SQL.');
  let body;
  try { body = JSON.parse(response.getContentText()); } catch (error) { throw new Error('Supabase: respuesta JSON no válida.'); }
  if (!body || body.version !== version || !Array.isArray(body.results) || body.results.length !== payloads.length)
    throw new Error('Supabase: respuesta RPC incompatible con la versión ' + version + '.');
  const expected = new Set(payloads.map(item => item.ticker)), received = new Set();
  body.results.forEach(function(result) {
    if (!result || !expected.has(result.ticker) || received.has(result.ticker) || !MS_SERVER_STATUSES.includes(result.status) ||
        !['reason','current','previous_close','history_count','last_final_date','needs_replacement'].every(key => Object.prototype.hasOwnProperty.call(result, key)) ||
        (result.current !== null && (typeof result.current !== 'object' || Array.isArray(result.current))))
      throw new Error('Supabase: resultados incompletos o inconsistentes.');
    if (result.current && !['fecha','open','high','low','close','volumen'].every(key => Object.prototype.hasOwnProperty.call(result.current, key)))
      throw new Error('Supabase: cotización incompleta en la respuesta RPC.');
    received.add(result.ticker);
  });
  return body.results;
}

function comprobarConexion() {
  msIngestRecent_([]);
  msIngestSheetQuotes_([]);
  console.log('Conexiones Yahoo v2 y GOOGLEFINANCE v3 correctas. No se cargaron cotizaciones.');
}

function msCell_(value) { return value === null || value === undefined ? '' : value; }
function msStatus_(result) { return result.status + (result.reason ? ' · ' + result.reason : ''); }
function msWritePrice_(sheet, company, result, now, rowNumber) {
  // Yahoo's slow history synchronization must never replace native quote formulas
  // or the time/status of the independent whole-sheet upload in columns L:M.
  if (!result.error) sheet.getRange(rowNumber, 14).setValue(msCell_(result.history_count));
  sheet.getRange(rowNumber, 23, 1, 2).setValues([[result.error ? 'ERROR: ' + result.error : msStatus_(result), now.toISOString()]]);
}
