const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

// Only storage/Yahoo boundaries are mocked. The scheduler, checkpoints, pause
// handling and success/error ordering below run the actual Apps Script code.
function runtime(options = {}) {
  const config = { count: 12, ...options };
  const companies = Array.from({ length: config.count }, (_, i) => ({ ticker: 'T' + String(i).padStart(3, '0') }));
  const base = Date.parse('2026-10-15T22:00:00Z');
  let elapsed = 0, job, activeTicker;
  const props = new Map(), events = [], logs = [], triggers = [];
  const record = (op, details = {}) => events.push({ op, at: elapsed, cursor: job?.cursor, ...details });
  const advance = cost => { elapsed += typeof cost === 'function' ? cost(activeTicker) : cost || 0; };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [base + elapsed])); }
    static now() { return base + elapsed; }
  }
  const properties = {
    getProperty: key => props.get(key) ?? null,
    setProperty(key, value) {
      props.set(key, value);
      if (key.startsWith('MS_JOB_')) record('checkpoint', { kind: key.slice(7), saved: JSON.parse(value) });
    }
  };
  const priceRows = companies.map(c => {
    const row = Array(14).fill(''); row[0] = c.ticker; row[12] = 'FINAL'; row[13] = 500; return row;
  });
  const prices = {
    getRange(row, column, height, width) {
      assert.deepEqual([row, column, height], [2, 1, companies.length]);
      assert.ok(width === 1 || width === 14);
      record('price-read', { width });
      advance(config.priceReadMs);
      return { getValues: () => priceRows.map(values => values.slice(0, width)) };
    }
  };
  const book = {
    getSheetByName(name) {
      record('sheet', { name });
      assert.equal(name, 'Precios', 'runtime/progress must not scan the entire history sheet');
      return prices;
    }
  };
  const ctx = vm.createContext({
    Date: Clock,
    console: { log: value => logs.push(value) },
    LockService: { getScriptLock: () => ({ tryLock() { advance(config.lockMs); return true; }, releaseLock() {} }) },
    Utilities: { formatDate: (date, zone, pattern) => pattern === 'HH' ? '18' : '2026-10-15' },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      deleteTrigger(trigger) { triggers.splice(triggers.indexOf(trigger), 1); record('trigger-remove'); },
      newTrigger(handler) {
        let minutes;
        return {
          timeBased() { return this; },
          everyMinutes(value) { minutes = value; return this; },
          create() {
            record('trigger-create', { handler, minutes });
            triggers.push({ getHandlerFunction: () => handler, minutes });
          }
        };
      }
    },
    SpreadsheetApp: {
      flush() {
        record('spreadsheet-flush', { ticker: activeTicker });
        advance(config.spreadsheetFlushMs);
        if (config.pauseOnFlush) ctx.detenerTemporizadores();
      }
    },
    // A test accidentally reaching the network fails immediately.
    UrlFetchApp: { fetch() { throw new Error('Network disabled in runtime tests'); }, fetchAll() { throw new Error('Network disabled in runtime tests'); } }
  });
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  ctx.msProperties_ = () => properties;
  ctx.msUniverse_ = () => companies;
  ctx.msBook_ = () => { record('book'); advance(config.bookMs); return book; };
  ctx.msAssertHistoryIndex_ = () => {
    record('index'); advance(config.indexMs);
    if (config.indexError) throw new Error(config.indexError);
    return { byTicker: {} };
  };
  ctx.msDate_ = () => '2026-10-15';
  ctx.msIsSession_ = () => true;
  ctx.msExpectedSession_ = () => '2026-10-15';
  ctx.msSupaConfig_ = () => { record('config'); advance(config.configMs); };
  const rows = ticker => Array.from({ length: 500 }, (_, i) => ({ fecha: String(i).padStart(4, '0'), ticker }));
  ctx.msFetchYahooBatch_ = (batch, full) => {
    record('fetch', { tickers: batch.map(c => c.ticker), full });
    advance(config.fetchMs);
    return batch.map(c => config.fetchError ? { error: config.fetchError } : { rows: rows(c.ticker), status: 'FINAL' });
  };
  ctx.msLoadTickerHistory_ = (ss, ticker) => {
    activeTicker = ticker; record('load', { ticker }); advance(config.loadMs);
    return { ticker, byTicker: { [ticker]: rows(ticker).map(row => ({ row })) } };
  };
  ctx.msMergeRows_ = (old, incoming) => incoming;
  ctx.msNeedsFull_ = () => Boolean(config.needsFull);
  ctx.msPublish_ = (incoming, cutoff, ticker) => {
    record('publish', { ticker }); advance(config.publishMs);
    if (config.publishError && ticker === companies[0].ticker) throw new Error(config.publishError);
  };
  ctx.msSaveTicker_ = (cache, ticker) => { record('save', { ticker }); advance(config.saveMs); };
  ctx.msFlushHistory_ = cache => { record('history-flush', { ticker: cache.ticker }); advance(config.historyFlushMs); };
  ctx.msWritePrice_ = (sheet, company, result, now, row) => {
    activeTicker = company.ticker;
    assert.equal(sheet, prices);
    assert.equal(row, companies.findIndex(c => c.ticker === company.ticker) + 2);
    record('price-write', { ticker: company.ticker, error: result.error });
    advance(config.priceWriteMs);
  };
  return {
    ctx, config, companies, props, events, logs, triggers, priceRows,
    newJob(kind = 'daily') { job = ctx.msNewJob_(); ctx.msPutJob_(kind, job); events.length = 0; return job; },
    elapsed: () => elapsed
  };
}

for (const kind of ['daily', 'history']) {
  test(`${kind} fetches at most five tickers and installs a one-minute continuation before sheet or network I/O`, () => {
    const h = runtime({ count: 250 }), job = h.newJob(kind);
    h.ctx.msRunJob_(kind, job);
    assert.deepEqual(h.events[0], { op: 'trigger-create', at: 0, cursor: 0,
      handler: kind === 'daily' ? 'continuarActualizacion' : 'continuarHistorial', minutes: 1 });
    const requests = h.events.filter(event => event.op === 'fetch');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].tickers, h.companies.slice(0, 5).map(c => c.ticker));
    assert.equal(requests[0].full, kind === 'history');
    assert.equal(job.cursor, 5);
    assert.equal(job.completed, 5);
    assert.equal(job.status, 'EN CURSO');
    assert.equal(h.triggers.length, 1);
    assert.equal(h.ctx.msGetJob_(kind).cursor, 5);
  });
}

test('a crash while validating the history index retains the cursor and already-installed continuation', () => {
  const h = runtime({ indexError: 'simulated Google interruption' }), job = h.newJob();
  assert.throws(() => h.ctx.msRunJob_('daily', job), /simulated Google interruption/);
  assert.equal(h.events[0].op, 'trigger-create');
  assert.equal(h.ctx.msGetJob_('daily').cursor, 0);
  assert.equal(h.triggers[0].getHandlerFunction(), 'continuarActualizacion');
  assert.equal(h.events.some(event => event.op === 'fetch'), false);
});

test('book, index and price-list reads consume the 90-second soft budget before a Yahoo batch starts', () => {
  const h = runtime({ bookMs: 30000, indexMs: 30000, priceReadMs: 16000 }), job = h.newJob();
  h.ctx.msRunJob_('daily', job);
  assert.equal(h.elapsed(), 76000);
  assert.equal(h.events.some(event => event.op === 'fetch'), false);
  assert.equal(job.cursor, 0);
  assert.equal(job.completed, 0);
  assert.equal(h.triggers.length, 1);
});

test('the manual entry point also counts lock and connection setup against its first run budget', () => {
  const h = runtime({ lockMs: 20000, configMs: 10000, bookMs: 25000, indexMs: 25000 });
  h.ctx.actualizarMarketScanner();
  assert.equal(h.elapsed(), 80000);
  assert.equal(h.events.some(event => event.op === 'fetch'), false);
  assert.equal(h.ctx.msGetJob_('daily').cursor, 0);
  assert.equal(h.triggers.length, 1);
});

test('slow fetch plus durable sheet writes leave the next ticker for the continuation', () => {
  const h = runtime({ fetchMs: 60000, spreadsheetFlushMs: 20000 }), job = h.newJob();
  h.ctx.msRunJob_('daily', job);
  assert.equal(h.elapsed(), 80000);
  assert.equal(h.events.filter(event => event.op === 'publish').length, 1);
  assert.equal(h.events.filter(event => event.op === 'load').length, 1);
  assert.equal(job.cursor, 1);
  assert.equal(job.completed, 1);
  assert.equal(h.ctx.msGetJob_('daily').cursor, 1);
});

function deferRepair() {
  const h = runtime({ fetchMs: 65000, loadMs: 15000, needsFull: true }), job = h.newJob();
  h.ctx.msRunJob_('daily', job);
  assert.equal(job.repairTicker, h.companies[0].ticker);
  assert.equal(job.cursor, 0);
  assert.equal(job.completed, 0);
  assert.equal(job.retry.length, 0);
  assert.equal(h.events.some(event => event.op === 'publish'), false);
  assert.equal(h.ctx.msGetJob_('daily').repairTicker, h.companies[0].ticker);
  h.config.fetchMs = 0; h.config.loadMs = 0; h.events.length = 0;
  return { h, job };
}

test('a deferred full repair resumes with one full-history request before advancing the same cursor', () => {
  const { h, job } = deferRepair();
  h.ctx.msRunJob_('daily', job);
  const request = h.events.find(event => event.op === 'fetch');
  assert.deepEqual(request.tickers, [h.companies[0].ticker]);
  assert.equal(request.full, true);
  assert.equal(job.cursor, 1);
  assert.equal(job.completed, 1);
  assert.equal(job.repairTicker, undefined);
  assert.equal(h.triggers.length, 1, 'the existing minute trigger is reused');
});

test('a failed deferred full repair is checkpointed for retry and never publishes a partial daily result', () => {
  const { h, job } = deferRepair(); h.config.fetchError = 'HTTP 429';
  h.ctx.msRunJob_('daily', job);
  assert.equal(h.events.find(event => event.op === 'fetch').full, true);
  assert.equal(h.events.some(event => ['publish', 'save', 'history-flush'].includes(event.op)), false);
  assert.equal(job.cursor, 1);
  assert.equal(job.completed, 0);
  assert.deepEqual(plain(job.retry), [h.companies[0].ticker]);
  assert.deepEqual(plain(h.ctx.msGetJob_('daily').retry), [h.companies[0].ticker]);
  assert.equal(h.triggers.length, 1);
});

test('successful tickers publish remotely before local writes and checkpoint only after SpreadsheetApp.flush', () => {
  const h = runtime(), job = h.newJob();
  h.ctx.msRunJob_('daily', job);
  const first = h.companies[0].ticker;
  const sequence = h.events.filter(event => event.ticker === first &&
    ['publish', 'save', 'history-flush', 'price-write', 'spreadsheet-flush'].includes(event.op));
  assert.deepEqual(sequence.map(event => event.op), ['publish', 'save', 'history-flush', 'price-write', 'spreadsheet-flush']);
  assert.ok(sequence.every(event => event.cursor === 0));
  const checkpoint = h.events.findIndex(event => event.op === 'checkpoint');
  assert.ok(checkpoint > h.events.indexOf(sequence.at(-1)));
  assert.equal(h.events[checkpoint].saved.cursor, 1);
  assert.equal(h.events[checkpoint].saved.completed, 1);
});

test('failed remote publication queues retry without changing that ticker history or counting success', () => {
  const h = runtime({ publishError: 'HTTP 503' }), job = h.newJob();
  h.ctx.msRunJob_('daily', job);
  const first = h.companies[0].ticker;
  assert.equal(h.events.some(event => event.ticker === first && ['save', 'history-flush', 'spreadsheet-flush'].includes(event.op)), false);
  assert.match(h.events.find(event => event.op === 'price-write' && event.ticker === first).error, /HTTP 503/);
  assert.deepEqual(plain(job.retry), [first]);
  assert.equal(job.completed, 4);
  assert.equal(job.cursor, 5);
  assert.deepEqual(plain(h.ctx.msGetJob_('daily').retry), [first]);
});

test('an already-paused job performs no I/O and a mid-run stop preserves exactly the completed ticker', () => {
  const paused = runtime(), pausedJob = paused.newJob(); paused.props.set('MS_PAUSED', 'true');
  paused.ctx.msRunJob_('daily', pausedJob);
  assert.equal(paused.events.length, 0);
  const h = runtime({ pauseOnFlush: true }), job = h.newJob();
  h.ctx.msRunJob_('daily', job);
  assert.equal(h.props.get('MS_PAUSED'), 'true');
  assert.equal(h.events.filter(event => event.op === 'publish').length, 1);
  assert.equal(job.cursor, 1);
  assert.equal(job.completed, 1);
  assert.equal(h.ctx.msGetJob_('daily').cursor, 1);
  assert.equal(h.triggers.length, 0);
});

test('progress reads only the 250-row Precios summary, never history data or index validation', () => {
  const h = runtime({ count: 250 });
  h.priceRows[1][13] = 87; h.priceRows[2][13] = 0; h.priceRows[2][12] = 'ERROR: HTTP 429';
  h.ctx.msAssertHistoryIndex_ = () => { throw new Error('progress must not validate history'); };
  h.ctx.msLoadTickerHistory_ = () => { throw new Error('progress must not load history'); };
  const coverage = h.ctx.verEstadoMarketScanner();
  assert.equal(coverage.length, 250);
  assert.deepEqual(h.events.filter(event => event.op === 'sheet').map(event => event.name), ['Precios']);
  assert.deepEqual(h.events.filter(event => event.op === 'price-read').map(event => event.width), [14]);
  assert.equal(h.events.some(event => event.op === 'fetch'), false);
  const report = JSON.parse(h.logs.at(-1));
  assert.equal(report.con500Sesiones, 248);
  assert.deepEqual(report.historiaCorta, [h.companies[1].ticker]);
  assert.equal(report.errores[0].ticker, h.companies[2].ticker);
});
