/** Google Finance supplies the live sheet; Supabase owns validation and history. */
const MS_HEADERS = {Precios: ['Ticker','Nombre','Fecha','Open','High','Low','Close','Volumen','Cierre previo','Cambio $','Cambio %','Enviado','Estado','Filas historial','Yahoo ticker','Bolsa','Tipo','Categoria','Emisor','Apalancamiento diario','Inverso','Retraso proveedor min','Estado historial','Historial comprobado']};
const MS_SERVER_STATUSES = ['FINAL','PROVISIONAL','RECHAZADO','PENDIENTE_DE_ACTUALIZAR','REEMPLAZO_PENDIENTE'];
const MS_RUN_LIMITS = {tickers: 20, group: 5, targetMs: 60000, reserveMs: 10000, continuationMinutes: 1};
const MS_JOB_HANDLERS = ['actualizarCotizacionesAhora','actualizarMarketScanner','continuarActualizacion'];
const MS_RETIRED_HANDLERS = ['continuarHistorial','iniciarHistorialSemanal','guardarSnapshotDiario','guardarSnapshotDiarioReemplazar','_procesarLote','syncDailySnapshot'];

function msUniverse_() {
  if (typeof MS_UNIVERSE === 'undefined' || MS_UNIVERSE.length !== 250 ||
      MS_UNIVERSE.filter(c => c.type === 'STOCK').length !== 200 || MS_UNIVERSE.filter(c => c.type === 'ETF').length !== 50 ||
      new Set(MS_UNIVERSE.map(c => c.ticker)).size !== MS_UNIVERSE.length) throw new Error('Universe.gs debe contener 200 empresas y 50 ETF.');
  return MS_UNIVERSE;
}

function msGoogleSymbol_(company) {
  const exchange = {NASDAQ: 'NASDAQ', NYSE: 'NYSE', NYSEARCA: 'NYSEARCA', CBOEBZX: 'BATS'}[company.exchange];
  if (!exchange) throw new Error('Bolsa sin equivalencia GOOGLEFINANCE: ' + company.exchange + '.');
  return exchange + ':' + company.ticker.replace(/-/g, '.');
}

/**
 * Interprets the SOXS provider's UTC wall time as an actual instant.
 * The input Date carries the spreadsheet's timezone, so retain its displayed
 * date and clock before interpreting that clock as UTC. Other tickers do not
 * use this adapter, and a genuinely future provider time stays in the future.
 * @param {Date} value The GOOGLEFINANCE tradetime result for SOXS.
 * @return {Date} The provider's UTC instant, displayed in the sheet's timezone.
 * @customfunction
 */
function MARKET_SCANNER_UTC_TIME(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Falta una hora válida del proveedor.');
  const book = SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error('Vincular este proyecto a Google Sheets.');
  return new Date(Utilities.formatDate(value, book.getSpreadsheetTimeZone(), "yyyy-MM-dd'T'HH:mm:ss") + 'Z');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Market Scanner')
    .addItem('1. Preparar Precios', 'prepararMarketScanner')
    .addItem('2. Comprobar conexión', 'comprobarConexion')
    .addItem('Actualizar cotizaciones y aplicación ahora', 'actualizarCotizacionesAhora')
    .addItem('Sincronizar cierres Yahoo en segundo plano', 'actualizarMarketScanner')
    .addItem('Ver progreso', 'verEstadoMarketScanner')
    .addSeparator().addItem('Activar temporizadores', 'instalarTemporizadores')
    .addItem('Detener temporizadores', 'detenerTemporizadores').addToUi();
}

function msLocked_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { console.log('Otro proceso está trabajando; se reintentará.'); return; }
  try { return fn(); } finally { lock.releaseLock(); }
}

function msQuoteLocked_(fn) {
  // A live upload can run while the independent Yahoo history job owns ScriptLock.
  const lock = LockService.getDocumentLock() || LockService.getUserLock();
  if (!lock.tryLock(1000)) throw new Error('Ya hay un envío de cotizaciones en curso; espera a que termine.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function prepararMarketScanner() {
  return msLocked_(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet(), companies = msUniverse_(), count = companies.length, last = count + 1;
    if (!ss) throw new Error('Vincular este proyecto a Google Sheets.');
    let sheet = ss.getSheetByName('Precios'), migrate = false, previous = [], utcColumn = 0;
    if (sheet) {
      // Keep the provider formula separate from the custom function, whose
      // argument must be a direct cell reference to recalculate reliably.
      for (let first = 1; first <= sheet.getMaxColumns(); first += 64) {
        const names = sheet.getRange(1, first, 1, Math.min(64, sheet.getMaxColumns() - first + 1)).getValues()[0];
        names.forEach(function(name, n) {
          if (name !== 'SOXS hora UTC') return;
          if (utcColumn) throw new Error('Precios: encabezado SOXS hora UTC duplicado.');
          utcColumn = first + n;
        });
      }
      const width = Math.min(sheet.getMaxColumns(), MS_HEADERS.Precios.length);
      const headers = sheet.getRange(1, 1, 1, width).getValues()[0];
      const legacy = headers.slice(0, 21), extras = headers.slice(21);
      const oldHeaders = MS_HEADERS.Precios.slice(0, 21); oldHeaders[11] = 'Actualizado';
      // The shipped Excel template has its instructions in W:X. Reserve those
      // columns for runtime status by shifting the guide intact to Z:AA.
      const templateGuide = extras.length === 3 && extras[0] === '' && extras[1] === 'Market Scanner' && extras[2] === '';
      migrate = JSON.stringify(legacy) === JSON.stringify(oldHeaders) && (extras.every(value => value === '') || templateGuide);
      if (headers.some(value => value !== '') &&
          !migrate && JSON.stringify(headers) !== JSON.stringify(MS_HEADERS.Precios))
        throw new Error('Precios: encabezados incompatibles. Usar la plantilla de 250 tickers.');
      const old = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, Math.min(count, sheet.getLastRow() - 1), 1).getValues() : [];
      if (old.some((row, n) => row[0] && row[0] !== companies[n].ticker)) throw new Error('Precios: lista distinta a Universe.gs. Revisar antes de preparar.');
      if (migrate && old.length) previous = sheet.getRange(2, 12, old.length, 2).getValues();
      if (migrate && templateGuide) {
        sheet.insertColumnsAfter(22, 3);
        if (utcColumn > 22) utcColumn += 3;
      }
    } else sheet = ss.insertSheet('Precios');
    if (sheet.getMaxRows() < last) sheet.insertRowsAfter(sheet.getMaxRows(), last - sheet.getMaxRows());
    if (sheet.getMaxColumns() < MS_HEADERS.Precios.length)
      sheet.insertColumnsAfter(sheet.getMaxColumns(), MS_HEADERS.Precios.length - sheet.getMaxColumns());
    if (!utcColumn) {
      utcColumn = sheet.getMaxColumns() + 1;
      sheet.insertColumnsAfter(sheet.getMaxColumns(), 1);
    }
    let utcLabel = '';
    for (let column = utcColumn; column > 0; column = Math.floor((column - 1) / 26))
      utcLabel = String.fromCharCode(65 + (column - 1) % 26) + utcLabel;
    sheet.getRange(1, 1, 1, MS_HEADERS.Precios.length).setValues([MS_HEADERS.Precios]).setBackground('#16324f').setFontColor('#ffffff').setFontWeight('bold');
    sheet.getRange(1, utcColumn).setValue('SOXS hora UTC');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1, count, 2).setValues(companies.map(c => [c.ticker, c.name]));
    sheet.getRange(2, 3, count, 9).setFormulas(companies.map(function(c, n) {
      const r = n + 2;
      const gf = function(attribute) {
        const formula = c.ticker === 'SOXS' && attribute === 'tradetime'
          ? 'MARKET_SCANNER_UTC_TIME(' + utcLabel + r + ')'
          : 'GOOGLEFINANCE("' + msGoogleSymbol_(c) + '","' + attribute + '")';
        return '=IFERROR(' + formula + ',"")';
      };
      return ['tradetime','priceopen','high','low','price','volume','closeyest'].map(gf).concat([
        '=IF(AND(ISNUMBER(G' + r + '),ISNUMBER(I' + r + ')),G' + r + '-I' + r + ',"")',
        '=IF(AND(ISNUMBER(J' + r + '),ISNUMBER(I' + r + '),I' + r + '>0),J' + r + '/I' + r + ',"")']);
    }));
    const soxsRow = companies.findIndex(c => c.ticker === 'SOXS') + 2;
    sheet.getRange(soxsRow, utcColumn).setFormulas([['=IFERROR(GOOGLEFINANCE("NYSEARCA:SOXS","tradetime"),"")']]);
    sheet.getRange(soxsRow, utcColumn).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange(2, 22, count, 1).setFormulas(companies.map(c => ['=IFERROR(GOOGLEFINANCE("' + msGoogleSymbol_(c) + '","datadelay"),"")']));
    if (migrate) {
      sheet.getRange(2, 23, count, 2).setValues(companies.map((c, n) => [previous[n] && previous[n][1] || '', previous[n] && previous[n][0] || '']));
      sheet.getRange(2, 12, count, 2).setValues(companies.map(() => ['', 'PENDIENTE DE SUBIR']));
    }
    sheet.getRange(2, 15, count, 2).setValues(companies.map(c => [c.yahooTicker || c.ticker, c.exchange]));
    sheet.getRange(2, 17, count, 5).setValues(companies.map(c => [c.type, c.category || '', c.issuer || '', c.dailyLeverage ?? 1, Boolean(c.inverse)]));
    sheet.getRange('D2:G' + last).setNumberFormat('0.00'); sheet.getRange('I2:J' + last).setNumberFormat('0.00');
    sheet.getRange('K2:K' + last).setNumberFormat('0.00%'); sheet.getRange('H2:H' + last).setNumberFormat('#,##0');
    sheet.getRange('C2:C' + last).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange('L2:M' + last).setNumberFormat('@'); sheet.getRange('N2:N' + last).setNumberFormat('0');
    sheet.getRange('V2:V' + last).setNumberFormat('0'); sheet.getRange('W2:X' + last).setNumberFormat('@');
    SpreadsheetApp.flush(); msProperties_().setProperty('SPREADSHEET_ID', ss.getId());
    console.log('Precios lista con GOOGLEFINANCE para 250 instrumentos. El primer cálculo puede quedar pendiente; no se espera en bucle. Supabase valida y administra el historial.');
  });
}

function actualizarCotizacionesAhora(e) {
  const started = Date.now();
  return msQuoteLocked_(function() {
    if (e && e.triggerUid && (msProperties_().getProperty('MS_PAUSED') === 'true' || !msTimerWindow_(new Date()))) return;
    const companies = msUniverse_(), sheet = msBook_().getSheetByName('Precios');
    if (!sheet || sheet.getMaxColumns() < MS_HEADERS.Precios.length) throw new Error('Ejecutar prepararMarketScanner para instalar las fórmulas.');
    // One rectangular read captures the whole universe, without individual Yahoo requests.
    const values = sheet.getRange(2, 1, companies.length, MS_HEADERS.Precios.length).getValues();
    if (values.some((line, n) => line[0] !== companies[n].ticker)) throw new Error('Precios cambió: ejecutar prepararMarketScanner.');
    const fetchedAt = new Date().toISOString();
    const payloads = companies.map(function(company, n) {
      const line = values[n], sourceTime = line[2];
      return {ticker: company.ticker, source: 'googlefinance', symbol: msGoogleSymbol_(company), currency: 'USD',
        source_quote_at: sourceTime instanceof Date && Number.isFinite(sourceTime.getTime()) ? sourceTime.toISOString() : sourceTime,
        open: line[3], high: line[4], low: line[5], close: line[6], volume: line[7], previous_close: line[8],
        datadelay_minutes: line[21], fetched_at: fetchedAt};
    });
    let results;
    try { results = msIngestSheetQuotes_(payloads); }
    catch (error) {
      sheet.getRange(2, 12, companies.length, 3).setValues(values.map(line => [line[11], 'ERROR: ' + error.message, line[13]]));
      throw error;
    }
    const byTicker = new Map(results.map(result => [result.ticker, result]));
    sheet.getRange(2, 12, companies.length, 3).setValues(companies.map(function(company) {
      const result = byTicker.get(company.ticker);
      return [fetchedAt, msStatus_(result), msCell_(result.history_count)];
    }));
    if (results.some(result => result.needs_replacement)) {
      sheet.getRange(2, 23, companies.length, 2).setValues(companies.map(function(company, n) {
        const result = byTicker.get(company.ticker);
        return result.needs_replacement ? ['REEMPLAZO_PENDIENTE', fetchedAt] : [values[n][22], values[n][23]];
      }));
    }
    SpreadsheetApp.flush();
    const report = {instrumentos: companies.length, aceptados: results.filter(r => r.status === 'FINAL' || r.status === 'PROVISIONAL').length,
      pendientes: results.filter(r => r.status === 'PENDIENTE_DE_ACTUALIZAR' || r.status === 'REEMPLAZO_PENDIENTE').length,
      rechazados: results.filter(r => r.status === 'RECHAZADO').length, enviado: fetchedAt, segundos: (Date.now() - started) / 1000};
    console.log(JSON.stringify(report));
    return report;
  });
}

function msGetJob_() {
  const raw = msProperties_().getProperty('MS_JOB_RECENT_V2');
  return raw ? JSON.parse(raw) : null;
}
function msPutJob_(job) { msProperties_().setProperty('MS_JOB_RECENT_V2', JSON.stringify(job)); }
function msNewJob_() {
  return {version: 2, cursor: 0, round: 0, retry: [], failed: [], pending: [], rejected: [], completed: 0,
    started: new Date().toISOString(), status: 'EN CURSO'};
}
function msTimerWindow_(now) {
  const date = Utilities.formatDate(now, 'America/New_York', 'yyyy-MM-dd');
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay(), hour = Number(Utilities.formatDate(now, 'America/New_York', 'HH'));
  return weekday >= 1 && weekday <= 5 && hour >= 9 && hour <= 20;
}

function actualizarMarketScanner(e) {
  const started = Date.now();
  return msLocked_(function() {
    if (e && e.triggerUid && (msProperties_().getProperty('MS_PAUSED') === 'true' || !msTimerWindow_(new Date()))) return;
    if (!e || !e.triggerUid) msProperties_().setProperty('MS_PAUSED', 'false');
    msSupaConfig_();
    let job = msGetJob_();
    if (!job || job.status !== 'EN CURSO') job = msNewJob_();
    msPutJob_(job); msRunJob_(job, started);
  });
}
function continuarActualizacion() {
  const started = Date.now();
  return msLocked_(function() { const job = msGetJob_(); if (job && job.status === 'EN CURSO') msRunJob_(job, started); });
}

function msRunJob_(job, started) {
  if (msProperties_().getProperty('MS_PAUSED') === 'true') return;
  const deadline = (started === undefined ? Date.now() : started) + MS_RUN_LIMITS.targetMs;
  msEnsureRecurring_('continuarActualizacion', MS_RUN_LIMITS.continuationMinutes);
  const companies = msUniverse_(), ss = msBook_(), sheet = ss.getSheetByName('Precios');
  const tickers = sheet.getRange(2, 1, companies.length, 1).getValues();
  if (tickers.some((row, n) => row[0] !== companies[n].ticker)) throw new Error('Precios cambió: ejecutar prepararMarketScanner.');
  const work = job.round === 0 ? companies.map(c => c.ticker) : job.work;
  let processed = 0;
  while (job.cursor < work.length && processed < MS_RUN_LIMITS.tickers && Date.now() + MS_RUN_LIMITS.reserveMs < deadline && msProperties_().getProperty('MS_PAUSED') !== 'true') {
    const symbols = work.slice(job.cursor, job.cursor + Math.min(MS_RUN_LIMITS.group, MS_RUN_LIMITS.tickers - processed));
    const batch = symbols.map(ticker => companies.find(company => company.ticker === ticker));
    const downloaded = msFetchYahooBatch_(batch), payloads = downloaded.filter(item => item.payload).map(item => item.payload);
    let server = [], rpcError = null;
    if (payloads.length) {
      try { server = msIngestRecent_(payloads); }
      catch (error) { rpcError = error.message; }
    }
    const outcomes = batch.map(function(company, n) {
      const result = downloaded[n].error ? {error: downloaded[n].error} : rpcError ? {error: rpcError} : server.find(item => item.ticker === company.ticker);
      return {company: company, result: result};
    });
    const now = new Date();
    // Finish this small group durably before advancing; a crash replays an idempotent RPC.
    outcomes.forEach(function(item) {
      const row = companies.findIndex(company => company.ticker === item.company.ticker) + 2;
      msWritePrice_(sheet, item.company, item.result, now, row);
    });
    SpreadsheetApp.flush();
    outcomes.forEach(function(item) {
      const result = item.result, ticker = item.company.ticker;
      if (result.error) { job.retry.push(ticker); job.lastError = ticker + ': ' + result.error; }
      else if (result.status === 'RECHAZADO') job.rejected.push(ticker);
      else if (result.status === 'PENDIENTE_DE_ACTUALIZAR' || result.status === 'REEMPLAZO_PENDIENTE') job.pending.push(ticker);
      else job.completed++;
    });
    job.cursor += symbols.length; processed += symbols.length; job.updated = now.toISOString(); msPutJob_(job);
  }
  if (job.cursor >= work.length) {
    if (job.retry.length && job.round < 2) {
      job.work = [...new Set(job.retry)]; job.retry = []; job.cursor = 0; job.round++;
    } else {
      job.failed = [...new Set(job.retry)]; job.retry = [];
      job.status = job.failed.length ? 'INCOMPLETO' : job.rejected.length ? 'COMPLETADO CON RECHAZOS' : job.pending.length ? 'COMPLETADO CON PENDIENTES' : 'COMPLETADO';
      job.finished = new Date().toISOString(); msRemoveHandler_('continuarActualizacion');
    }
    msPutJob_(job);
  }
  console.log(job.status + ' | aceptados ' + job.completed + '/' + companies.length + ' | siguiente lote automático cada minuto');
}

function msRemoveHandler_(handler) {
  ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === handler).forEach(trigger => ScriptApp.deleteTrigger(trigger));
}
function msEnsureRecurring_(handler, minutes) {
  if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === handler)) ScriptApp.newTrigger(handler).timeBased().everyMinutes(minutes).create();
}
function instalarTemporizadores() {
  return msLocked_(function() {
    msSupaConfig_(); msBook_();
    MS_JOB_HANDLERS.concat(MS_RETIRED_HANDLERS).forEach(msRemoveHandler_);
    msProperties_().setProperty('MS_PAUSED', 'false');
    ScriptApp.newTrigger('actualizarCotizacionesAhora').timeBased().everyMinutes(5).create();
    ScriptApp.newTrigger('actualizarMarketScanner').timeBased().everyHours(1).create();
    const job = msGetJob_();
    if (job && job.status === 'EN CURSO') msEnsureRecurring_('continuarActualizacion', MS_RUN_LIMITS.continuationMinutes);
    console.log('Cotizaciones GOOGLEFINANCE cada 5 minutos y cierres Yahoo cada hora, de 09 a 20 en Nueva York, lunes a viernes. Supabase comprueba las sesiones de bolsa.');
  });
}
function detenerTemporizadores() {
  msProperties_().setProperty('MS_PAUSED', 'true');
  MS_JOB_HANDLERS.concat(MS_RETIRED_HANDLERS).forEach(msRemoveHandler_);
  console.log('Timers detenidos. El grupo activo termina y conserva su punto de reanudación.');
}
function verEstadoMarketScanner() {
  const companies = msUniverse_(), values = msBook_().getSheetByName('Precios').getRange(2, 1, companies.length, MS_HEADERS.Precios.length).getValues();
  const coverage = companies.map(function(company, n) {
    if (values[n][0] !== company.ticker) throw new Error('Precios cambió: ejecutar prepararMarketScanner.');
    return {ticker: company.ticker, sesiones: values[n][13], estado: values[n][12], historial: values[n][22], historial_comprobado: values[n][23]};
  });
  console.log(JSON.stringify({job: msGetJob_(), instrumentos: companies.length, coverage: coverage, validacion: 'Supabase'}));
  return coverage;
}
