/** Sheets downloads recent quotes; Supabase owns all market-data decisions. */
const MS_HEADERS = {Precios: ['Ticker','Nombre','Fecha','Open','High','Low','Close','Volumen','Cierre previo','Cambio $','Cambio %','Actualizado','Estado','Filas historial','Yahoo ticker','Bolsa','Tipo','Categoria','Emisor','Apalancamiento diario','Inverso']};
const MS_SERVER_STATUSES = ['FINAL','PROVISIONAL','RECHAZADO','PENDIENTE_DE_ACTUALIZAR','REEMPLAZO_PENDIENTE'];
const MS_RUN_LIMITS = {tickers: 20, group: 5, targetMs: 60000, reserveMs: 10000, continuationMinutes: 1};
const MS_JOB_HANDLERS = ['actualizarMarketScanner','continuarActualizacion'];
const MS_RETIRED_HANDLERS = ['continuarHistorial','iniciarHistorialSemanal','guardarSnapshotDiario','guardarSnapshotDiarioReemplazar','_procesarLote','syncDailySnapshot'];

function msUniverse_() {
  if (typeof MS_UNIVERSE === 'undefined' || MS_UNIVERSE.length !== 250 ||
      MS_UNIVERSE.filter(c => c.type === 'STOCK').length !== 200 || MS_UNIVERSE.filter(c => c.type === 'ETF').length !== 50 ||
      new Set(MS_UNIVERSE.map(c => c.ticker)).size !== MS_UNIVERSE.length) throw new Error('Universe.gs debe contener 200 empresas y 50 ETF.');
  return MS_UNIVERSE;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Market Scanner')
    .addItem('1. Preparar Precios', 'prepararMarketScanner')
    .addItem('2. Comprobar conexión', 'comprobarConexion')
    .addItem('Actualizar precios ahora', 'actualizarMarketScanner')
    .addItem('Ver progreso', 'verEstadoMarketScanner')
    .addSeparator().addItem('Activar temporizadores', 'instalarTemporizadores')
    .addItem('Detener temporizadores', 'detenerTemporizadores').addToUi();
}

function msLocked_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { console.log('Otro proceso está trabajando; se reintentará.'); return; }
  try { return fn(); } finally { lock.releaseLock(); }
}

function prepararMarketScanner() {
  return msLocked_(function() {
    const ss = SpreadsheetApp.getActiveSpreadsheet(), companies = msUniverse_(), count = companies.length, last = count + 1;
    if (!ss) throw new Error('Vincular este proyecto a Google Sheets.');
    let sheet = ss.getSheetByName('Precios');
    if (sheet) {
      const headers = sheet.getRange(1, 1, 1, MS_HEADERS.Precios.length).getValues()[0];
      if (headers.some(value => value !== '') && JSON.stringify(headers) !== JSON.stringify(MS_HEADERS.Precios))
        throw new Error('Precios: encabezados incompatibles. Usar la plantilla de 250 tickers.');
      const old = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, Math.min(count, sheet.getLastRow() - 1), 1).getValues() : [];
      if (old.some((row, n) => row[0] && row[0] !== companies[n].ticker)) throw new Error('Precios: lista distinta a Universe.gs. Revisar antes de preparar.');
    } else sheet = ss.insertSheet('Precios');
    if (sheet.getMaxRows() < last) sheet.insertRowsAfter(sheet.getMaxRows(), last - sheet.getMaxRows());
    sheet.getRange(1, 1, 1, MS_HEADERS.Precios.length).setValues([MS_HEADERS.Precios]).setBackground('#16324f').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1, count, 2).setValues(companies.map(c => [c.ticker, c.name]));
    sheet.getRange(2, 10, count, 2).setFormulas(companies.map(function(c, n) {
      const r = n + 2;
      return ['=IF(AND(ISNUMBER(G' + r + '),ISNUMBER(I' + r + ')),G' + r + '-I' + r + ',"")',
        '=IF(AND(ISNUMBER(J' + r + '),ISNUMBER(I' + r + '),I' + r + '>0),J' + r + '/I' + r + ',"")'];
    }));
    sheet.getRange(2, 15, count, 2).setValues(companies.map(c => [c.yahooTicker || c.ticker, c.exchange]));
    sheet.getRange(2, 17, count, 5).setValues(companies.map(c => [c.type, c.category || '', c.issuer || '', c.dailyLeverage ?? 1, Boolean(c.inverse)]));
    sheet.getRange('D2:G' + last).setNumberFormat('0.00'); sheet.getRange('I2:J' + last).setNumberFormat('0.00');
    sheet.getRange('K2:K' + last).setNumberFormat('0.00%'); sheet.getRange('H2:H' + last).setNumberFormat('#,##0');
    sheet.getRange('L2:M' + last).setNumberFormat('@'); sheet.getRange('N2:N' + last).setNumberFormat('0');
    SpreadsheetApp.flush(); msProperties_().setProperty('SPREADSHEET_ID', ss.getId());
    console.log('Precios lista. Supabase valida las cotizaciones y administra el historial.');
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
    ScriptApp.newTrigger('actualizarMarketScanner').timeBased().everyHours(1).create();
    const job = msGetJob_();
    if (job && job.status === 'EN CURSO') msEnsureRecurring_('continuarActualizacion', MS_RUN_LIMITS.continuationMinutes);
    console.log('Timer horario activo, de 09 a 20 en Nueva York, lunes a viernes. Supabase comprueba las sesiones de bolsa.');
  });
}
function detenerTemporizadores() {
  msProperties_().setProperty('MS_PAUSED', 'true');
  MS_JOB_HANDLERS.concat(MS_RETIRED_HANDLERS).forEach(msRemoveHandler_);
  console.log('Timers detenidos. El grupo activo termina y conserva su punto de reanudación.');
}
function verEstadoMarketScanner() {
  const companies = msUniverse_(), values = msBook_().getSheetByName('Precios').getRange(2, 1, companies.length, 14).getValues();
  const coverage = companies.map(function(company, n) {
    if (values[n][0] !== company.ticker) throw new Error('Precios cambió: ejecutar prepararMarketScanner.');
    return {ticker: company.ticker, sesiones: values[n][13], estado: values[n][12]};
  });
  console.log(JSON.stringify({job: msGetJob_(), instrumentos: companies.length, coverage: coverage, validacion: 'Supabase'}));
  return coverage;
}
