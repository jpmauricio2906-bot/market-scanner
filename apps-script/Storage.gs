/** Recent quotes enter one server RPC. No history is read, merged or published here. */
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
  return {url: url + '/rest/v1/rpc/market_ingest_recent', headers: headers};
}

function msIngestRecent_(payloads) {
  const config = msSupaConfig_();
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
  if (!body || body.version !== 2 || !Array.isArray(body.results) || body.results.length !== payloads.length)
    throw new Error('Supabase: respuesta RPC incompatible con la versión 2.');
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
  console.log('Conexión RPC correcta. No se cargaron cotizaciones.');
}

function msCell_(value) { return value === null || value === undefined ? '' : value; }
function msWritePrice_(sheet, company, result, now, rowNumber) {
  if (result.error) { sheet.getRange(rowNumber, 13).setValue('ERROR: ' + result.error); return; }
  const status = result.status + (result.reason ? ' · ' + result.reason : '');
  if (result.current) {
    const r = result.current;
    sheet.getRange(rowNumber, 1, 1, 9).setValues([[company.ticker, company.name, r.fecha, r.open, r.high, r.low, r.close, r.volumen, result.previous_close].map(msCell_)]);
    sheet.getRange(rowNumber, 12, 1, 3).setValues([[now.toISOString(), status, msCell_(result.history_count)]]);
  } else {
    // Rejected/pending quotes preserve the last displayed prices and their timestamp.
    sheet.getRange(rowNumber, 13, 1, 2).setValues([[status, msCell_(result.history_count)]]);
  }
}
