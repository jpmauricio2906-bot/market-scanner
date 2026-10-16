/** Market Scanner: no remote calls from cell formulas, no anonymous Web App. */
const MS_HEADERS = {
  Precios: ['Ticker','Nombre','Fecha','Open','High','Low','Close','Volumen','Cierre previo','Cambio $','Cambio %','Actualizado','Estado','Filas historial','Yahoo ticker','Bolsa','Tipo','Categoria','Emisor','Apalancamiento diario','Inverso'],
  Historial: ['Fecha','Ticker','Open','High','Low','Close','Volumen']
};
const MS_JOB_HANDLERS = ['actualizarMarketScanner','continuarActualizacion','continuarHistorial','iniciarHistorialSemanal'];
const MS_RUN_LIMITS = {tickers: 5, targetMs: 90000, reserveMs: 15000, continuationMinutes: 1};

function msUniverse_() {
  if (typeof MS_UNIVERSE === 'undefined' || MS_UNIVERSE.length !== 250 ||
      MS_UNIVERSE.filter(c => c.type === 'STOCK').length !== 200 || MS_UNIVERSE.filter(c => c.type === 'ETF').length !== 50 ||
      new Set(MS_UNIVERSE.map(c => c.ticker)).size !== MS_UNIVERSE.length) throw new Error('Universe.gs debe contener 200 empresas y 50 ETF: ejecutar node tools/build-universe.mjs.');
  return MS_UNIVERSE;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Market Scanner')
    .addItem('1. Preparar hojas', 'prepararMarketScanner')
    .addItem('2. Comprobar conexión', 'comprobarConexion')
    .addItem('3. Cargar 500 sesiones', 'iniciarHistorial')
    .addItem('Actualizar precios ahora', 'actualizarMarketScanner')
    .addItem('Ver progreso y calidad', 'verEstadoMarketScanner')
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
    const ss = SpreadsheetApp.getActiveSpreadsheet(), companies = msUniverse_();
    const count = companies.length, lastRow = count + 1, historyCapacity = count * 500 + 1;
    if (!ss) throw new Error('Vincular este proyecto a Google Sheets.');
    // Validate the imported data before changing headers, sorting rows or writing formulas.
    // Preserve the sheet timezone: changing it can move imported date cells to the previous day.
    Object.keys(MS_HEADERS).forEach(function(name) {
      const headers = MS_HEADERS[name], sheet = ss.getSheetByName(name);
      if (!sheet) return;
      const old = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
      if (old.some(x => x !== '') && JSON.stringify(old) !== JSON.stringify(headers)) throw new Error(name + ': encabezados incompatibles. Importar plantilla limpia.');
    });
    const importedHistory = ss.getSheetByName('Historial'), importedPrices = ss.getSheetByName('Precios');
    const cache = importedHistory ? msLoadHistory_(importedHistory) : {byTicker: {}};
    const knownTickers = new Set(companies.map(c => c.ticker));
    Object.keys(cache.byTicker).forEach(function(ticker) {
      if (!knownTickers.has(ticker) || cache.byTicker[ticker].length > 500) throw new Error('Historial: ticker fuera del universo o con más de 500 sesiones: ' + ticker + '. Revisar antes de preparar.');
    });
    const old = importedPrices && importedPrices.getLastRow() > 1 ? importedPrices.getRange(2, 1, Math.min(count, importedPrices.getLastRow() - 1), 1).getValues().map(r => r[0]) : [];
    if (old.some((t, i) => t && t !== companies[i].ticker)) throw new Error('Lista distinta a Universe.gs; importar plantilla regenerada para cambiar el universo.');
    msInvalidateHistoryIndex_();
    msProperties_().setProperty('SPREADSHEET_ID', ss.getId());
    Object.keys(MS_HEADERS).forEach(function(name) {
      const headers = MS_HEADERS[name], sheet = ss.getSheetByName(name) || ss.insertSheet(name);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setBackground('#16324f').setFontColor('#ffffff').setFontWeight('bold');
      sheet.setFrozenRows(1);
    });
    const historySheet = ss.getSheetByName('Historial');
    if (historySheet.getMaxRows() < historyCapacity) historySheet.insertRowsAfter(historySheet.getMaxRows(), historyCapacity - historySheet.getMaxRows());
    // Contiguous ticker blocks let a corrected 500-day series be written in a few ranges.
    if (historySheet.getLastRow() > 1) historySheet.getRange(2, 1, historySheet.getLastRow() - 1, 7)
      .sort([{column: 2, ascending: true}, {column: 1, ascending: true}]);
    msBuildHistoryIndex_(ss, cache);
    const sheet = ss.getSheetByName('Precios');
    if (sheet.getMaxRows() < lastRow) sheet.insertRowsAfter(sheet.getMaxRows(), lastRow - sheet.getMaxRows());
    sheet.getRange(2, 1, count, 2).setValues(companies.map(c => [c.ticker, c.name]));
    sheet.getRange(2, 10, count, 2).setFormulas(companies.map(function(company, i) {
      const r = i + 2;
      return ['=IF(AND(ISNUMBER(G' + r + '),ISNUMBER(I' + r + ')),G' + r + '-I' + r + ',"")',
        '=IF(AND(ISNUMBER(J' + r + '),ISNUMBER(I' + r + '),I' + r + '>0),J' + r + '/I' + r + ',"")'];
    }));
    sheet.getRange(2, 14, count, 1).setValues(companies.map(c => [(cache.byTicker[c.ticker] || []).length]));
    sheet.getRange(2, 15, count, 2).setValues(companies.map(c => [c.yahooTicker || c.ticker, c.exchange]));
    sheet.getRange(2, 17, count, 5).setValues(companies.map(c => [c.type, c.category || '', c.issuer || '', c.dailyLeverage ?? 1, Boolean(c.inverse)]));
    sheet.getRange('D2:G' + lastRow).setNumberFormat('0.00'); sheet.getRange('I2:J' + lastRow).setNumberFormat('0.00');
    sheet.getRange('K2:K' + lastRow).setNumberFormat('0.00%'); sheet.getRange('H2:H' + lastRow).setNumberFormat('#,##0');
    sheet.getRange('L2:M' + lastRow).setNumberFormat('@'); sheet.getRange('N2:N' + lastRow).setNumberFormat('0');
    console.log('Hojas e índice listas; Historial conservado. Las actualizaciones procesan como máximo cinco tickers por ejecución.');
  });
}

function msGetJob_(kind) {
  const raw = msProperties_().getProperty('MS_JOB_' + kind);
  return raw ? JSON.parse(raw) : null;
}
function msPutJob_(kind, job) { msProperties_().setProperty('MS_JOB_' + kind, JSON.stringify(job)); }
function msNewJob_() { return {cursor: 0, round: 0, retry: [], failed: [], shortHistory: [], completed: 0, started: new Date().toISOString(), status: 'EN CURSO'}; }

function actualizarMarketScanner(e) {
  const started = Date.now();
  return msLocked_(function() {
    if (e && e.triggerUid && msProperties_().getProperty('MS_PAUSED') === 'true') return;
    if (!e || !e.triggerUid) msProperties_().setProperty('MS_PAUSED', 'false');
    const now = new Date(), today = msDate_(now), hour = Number(Utilities.formatDate(now, 'America/New_York', 'HH'));
    if (e && e.triggerUid && (!msIsSession_(today) || hour < 9 || hour > 20)) return;
    msSupaConfig_();
    let job = msGetJob_('daily');
    if (!job || job.status !== 'EN CURSO') { job = msNewJob_(); msPutJob_('daily', job); }
    msRunJob_('daily', job, started);
  });
}

function iniciarHistorial() {
  const started = Date.now();
  return msLocked_(function() {
    msProperties_().setProperty('MS_PAUSED', 'false');
    msSupaConfig_();
    const old = msGetJob_('history');
    const job = old && old.status === 'EN CURSO' ? old : msNewJob_();
    msPutJob_('history', job);
    msRunJob_('history', job, started);
  });
}
function iniciarHistorialSemanal() { if (msProperties_().getProperty('MS_PAUSED') !== 'true') iniciarHistorial(); }
function continuarHistorial() { return msLocked_(function() { const job = msGetJob_('history'); if (job && job.status === 'EN CURSO') msRunJob_('history', job); }); }
function continuarActualizacion() { return msLocked_(function() { const job = msGetJob_('daily'); if (job && job.status === 'EN CURSO') msRunJob_('daily', job); }); }

function msRunJob_(kind, job, started) {
  if (msProperties_().getProperty('MS_PAUSED') === 'true') return;
  const start = started === undefined ? Date.now() : started, deadline = start + MS_RUN_LIMITS.targetMs;
  const history = kind === 'history', companies = msUniverse_();
  const handler = history ? 'continuarHistorial' : 'continuarActualizacion';
  // Recurring continuation is installed BEFORE I/O: a hard Google timeout cannot strand a job.
  msEnsureRecurring_(handler, MS_RUN_LIMITS.continuationMinutes);
  const ss = msBook_(), index = msAssertHistoryIndex_(ss), prices = ss.getSheetByName('Precios');
  const priceTickers = prices.getRange(2, 1, companies.length, 1).getValues();
  if (priceTickers.some((row, n) => row[0] !== companies[n].ticker)) throw new Error('Precios cambió: ejecutar prepararMarketScanner.');
  const work = job.round === 0 ? companies.map(c => c.ticker) : job.work;
  const repair = !history && job.repairTicker === work[job.cursor];
  if (job.cursor < work.length && Date.now() + MS_RUN_LIMITS.reserveMs < deadline && msProperties_().getProperty('MS_PAUSED') !== 'true') {
    const symbols = work.slice(job.cursor, job.cursor + (repair ? 1 : MS_RUN_LIMITS.tickers));
    const batch = symbols.map(t => companies.find(c => c.ticker === t));
    const now = new Date(), results = msFetchYahooBatch_(batch, history || repair, now);
    for (let i = 0; i < batch.length; i++) {
      // One slow network request can exceed the target. Do not start another ticker then.
      if ((i > 0 && Date.now() + MS_RUN_LIMITS.reserveMs >= deadline) || msProperties_().getProperty('MS_PAUSED') === 'true') break;
      const company = batch[i]; let result = results[i];
      const priceRow = companies.findIndex(c => c.ticker === company.ticker) + 2;
      try {
        if (result.error) throw new Error(result.error);
        const cache = msLoadTickerHistory_(ss, company.ticker, index);
        const old = (cache.byTicker[company.ticker] || []).map(item => item.row);
        let replace = history || repair, merged = msMergeRows_(old, result.rows, replace);
        if (!replace && msNeedsFull_(old, result, merged, msExpectedSession_(now))) {
          // A corrective 3-year download can run in its own continuation, never stranded.
          if (Date.now() + MS_RUN_LIMITS.reserveMs >= deadline) {
            job.repairTicker = company.ticker; msPutJob_(kind, job); break;
          }
          result = msFetchYahooBatch_([company], true, now)[0];
          if (result.error) throw new Error(result.error);
          replace = true; merged = msMergeRows_(old, result.rows, true);
        }
        if (merged.length < 500) {
          result.shortHistory = true;
          if (!result.status.includes('HISTORIA CORTA')) result.status += ' · HISTORIA CORTA ' + merged.length + '/500';
        }
        // Remote first: failed publication never advances local history or the cursor as success.
        msPublish_(result.rows, merged.length === 500 ? merged[0].fecha : null, company.ticker);
        msSaveTicker_(cache, company.ticker, merged);
        msFlushHistory_(cache);
        result.historyCount = merged.length;
        msWritePrice_(prices, company, result, now, priceRow);
        SpreadsheetApp.flush(); // durable sheet writes before the cursor advances
        if (result.shortHistory) job.shortHistory.push(company.ticker);
        job.completed++;
      } catch (error) {
        job.retry.push(company.ticker);
        job.lastError = company.ticker + ': ' + error.message;
        msWritePrice_(prices, company, {error: error.message}, now, priceRow);
        console.log(job.lastError);
      }
      if (job.repairTicker === company.ticker) delete job.repairTicker;
      job.cursor++;
      job.updated = new Date().toISOString();
      msPutJob_(kind, job); // checkpoint every ticker, including failed requests
    }
  }
  if (job.cursor >= work.length) {
    if (job.retry.length && job.round < 2) {
      job.work = job.retry; job.retry = []; job.cursor = 0; job.round++;
    } else {
      job.failed = job.retry; job.retry = []; job.status = job.failed.length ? 'INCOMPLETO' : job.shortHistory.length ? 'COMPLETADO CON HISTORIA CORTA' : 'COMPLETADO';
      job.finished = new Date().toISOString(); msRemoveHandler_(handler);
    }
    msPutJob_(kind, job);
  }
  console.log(kind + ': ' + job.status + ' | correctos ' + job.completed + '/' + companies.length + ' | intento ' + (job.round + 1) + ' | siguiente lote automático cada minuto');
}

function msRemoveHandler_(handler) {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === handler).forEach(t => ScriptApp.deleteTrigger(t));
}
function msEnsureRecurring_(handler, minutes) {
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === handler)) ScriptApp.newTrigger(handler).timeBased().everyMinutes(minutes).create();
}
function instalarTemporizadores() {
  return msLocked_(function() {
    msSupaConfig_(); msAssertHistoryIndex_(msBook_());
    msProperties_().setProperty('MS_PAUSED', 'false');
    // Remove only known scanner timers, including retired handlers from the old project.
    const legacy = ['guardarSnapshotDiario','guardarSnapshotDiarioReemplazar','_procesarLote','syncDailySnapshot'];
    MS_JOB_HANDLERS.concat(legacy).forEach(msRemoveHandler_);
    ScriptApp.newTrigger('actualizarMarketScanner').timeBased().everyHours(1).create();
    ScriptApp.newTrigger('iniciarHistorialSemanal').timeBased().onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(2).everyWeeks(1).inTimezone('America/New_York').create();
    ['daily','history'].forEach(function(kind) { const job = msGetJob_(kind); if (job && job.status === 'EN CURSO') msEnsureRecurring_(kind === 'daily' ? 'continuarActualizacion' : 'continuarHistorial', MS_RUN_LIMITS.continuationMinutes); });
    console.log('Timer cada hora (09–20 ET días de sesión) y reconstrucción semanal.');
  });
}
function detenerTemporizadores() {
  // Record intent even when a downloader owns the lock. It will stop after its current batch.
  msProperties_().setProperty('MS_PAUSED', 'true');
  MS_JOB_HANDLERS.forEach(msRemoveHandler_);
  console.log('Timers detenidos; el lote activo termina y conserva datos y puntos de reanudación.');
}
function verEstadoMarketScanner() {
  const ss = msBook_(), expected = msExpectedSession_(new Date()), companies = msUniverse_();
  const values = ss.getSheetByName('Precios').getRange(2, 1, companies.length, 14).getValues();
  const coverage = companies.map(function(c, n) {
    if (values[n][0] !== c.ticker) throw new Error('Precios cambió: ejecutar prepararMarketScanner.');
    return {ticker: c.ticker, sesiones: values[n][13], estado: values[n][12]};
  });
  console.log(JSON.stringify({cierreEsperado: expected, daily: msGetJob_('daily'), history: msGetJob_('history'),
    instrumentos: companies.length, con500Sesiones: coverage.filter(c => c.sesiones === 500).length,
    historiaCorta: coverage.filter(c => c.sesiones > 0 && c.sesiones < 500).map(c => c.ticker),
    errores: coverage.filter(c => String(c.estado).startsWith('ERROR:')),
    validacion: 'Calidad comprobada al descargar cada ticker; esta consulta de progreso solo lee Precios.'}));
  return coverage;
}
