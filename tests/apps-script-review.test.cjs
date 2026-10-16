const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fixedNow = '2026-10-15T22:00:00Z';
const projectRoot = path.join(__dirname, '..');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return Date.parse(fixedNow); }
}

function context() {
  const props = new Map(), triggers = [];
  const ctx = vm.createContext({
    console: {log() {}}, Date: FixedDate,
    Utilities: {formatDate(date, timezone, pattern) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23',
      }).formatToParts(date).map(item => [item.type, item.value]));
      return pattern === 'HH' ? parts.hour : `${parts.year}-${parts.month}-${parts.day}`;
    }},
    PropertiesService: {getScriptProperties: () => ({
      getProperty: key => props.get(key) || null,
      setProperty: (key, value) => props.set(key, value),
    })},
    ScriptApp: {
      getProjectTriggers: () => triggers,
      deleteTrigger: trigger => triggers.splice(triggers.indexOf(trigger), 1),
      newTrigger: handler => ({
        timeBased() { return this; }, everyMinutes() { return this; },
        create() { triggers.push({getHandlerFunction: () => handler}); },
      }),
    },
  });
  for (const name of ['Yahoo.gs', 'Storage.gs', 'Code.gs']) {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, 'apps-script', name), 'utf8'), ctx, {filename: name});
  }
  return ctx;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function sessions(ctx, count, end = '2026-10-15', close = 100) {
  const rows = [];
  for (let date = end; rows.length < count; date = ctx.msAddDays_(date, -1)) {
    if (ctx.msIsSession_(date)) rows.unshift({fecha: date, ticker: 'AAPL', open: close, high: close + 2,
      low: close - 2, close, volumen: 1000});
  }
  return rows;
}

function parsed(ctx, rows, history = false, extra = {}) {
  const result = {
    meta: {symbol: 'AAPL', currency: 'USD', exchangeTimezoneName: 'America/New_York', ...extra.meta},
    timestamp: rows.map(row => Date.parse(row.fecha + 'T13:30:00Z') / 1000),
    indicators: {quote: [{
      open: rows.map(row => row.open), high: rows.map(row => row.high), low: rows.map(row => row.low),
      close: rows.map(row => row.close), volume: rows.map(row => row.volumen),
    }]},
    ...(extra.events ? {events: extra.events} : {}),
  };
  return ctx.msParseYahoo_({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({chart: {result: [result]}}),
  }, {ticker: 'AAPL'}, history, new Date(fixedNow));
}

test('a restart after over one month cannot pass 500 rows with a missing block of sessions', () => {
  const ctx = context();
  const old = sessions(ctx, 500, '2026-08-28');
  const fresh = parsed(ctx, sessions(ctx, 20));
  const merged = ctx.msMergeRows_(old, fresh.rows, false);
  assert.equal(merged.length, 500, 'the count alone hides the missing sessions');
  assert.equal(ctx.msContinuous_(merged, '2026-10-15'), false);
  assert.equal(ctx.msNeedsFull_(old, fresh, merged, '2026-10-15'), true);
});

test('a revised overlapping OHLC price rebuilds the whole series; a volume-only revision does not', () => {
  const ctx = context(), old = sessions(ctx, 500);
  const corrected = parsed(ctx, sessions(ctx, 20, '2026-10-15', 50));
  const correctedMerge = ctx.msMergeRows_(old, corrected.rows, false);
  assert.equal(ctx.msNeedsFull_(old, corrected, correctedMerge, '2026-10-15'), true);
  const volumeRows = sessions(ctx, 20).map(row => ({...row, volumen: 2000}));
  const volume = parsed(ctx, volumeRows);
  assert.equal(ctx.msNeedsFull_(old, volume, ctx.msMergeRows_(old, volume.rows, false), '2026-10-15'), false);
});

test('a newly reported split requests full history even if overlapping prices have not yet changed', () => {
  const ctx = context(), old = sessions(ctx, 500, '2026-10-14');
  const timestamp = Date.parse('2026-10-15T13:30:00Z') / 1000;
  const fresh = parsed(ctx, sessions(ctx, 20), false, {
    events: {splits: {[timestamp]: {date: timestamp, numerator: 2, denominator: 1, splitRatio: '2:1'}}},
  });
  assert.equal(ctx.msNeedsFull_(old, fresh, ctx.msMergeRows_(old, fresh.rows, false), '2026-10-15'), true);
});

function jobContext(old, dailyResult, fullResult, failPublication = false) {
  const ctx = context(), events = [];
  ctx.msBook_ = () => ({getSheetByName: () => ({})});
  ctx.msUniverse_ = () => [{ticker: 'AAPL'}];
  ctx.msLoadHistory_ = () => ({byTicker: {AAPL: old.map((row, index) => ({row, index}))}});
  ctx.msFetchYahooBatch_ = (companies, history) => {
    events.push({type: 'fetch', history, tickers: companies.map(company => company.ticker)});
    return [history ? fullResult : dailyResult];
  };
  ctx.msPublish_ = (rows, cutoff, ticker) => {
    events.push({type: 'publish', rows: clone(rows), cutoff, ticker});
    if (failPublication) throw new Error('Supabase HTTP 503');
  };
  ctx.msSaveTicker_ = (cache, ticker, rows) => events.push({type: 'local', rows: clone(rows), ticker});
  ctx.msFlushHistory_ = () => events.push({type: 'flush'});
  ctx.msWritePrice_ = (sheet, company, result) => events.push({type: result.error ? 'error' : 'price'});
  return {ctx, events};
}

test('daily gap repair publishes a complete replacement before committing local history', () => {
  const build = context(), old = sessions(build, 500, '2026-08-28');
  const daily = parsed(build, sessions(build, 20, '2026-10-15', 50));
  const full = parsed(build, sessions(build, 500, '2026-10-15', 50), true);
  const {ctx, events} = jobContext(old, daily, full);
  const job = ctx.msNewJob_();
  ctx.msRunJob_('daily', job);
  assert.deepEqual(events.filter(event => event.type === 'fetch').map(event => event.history), [false, true]);
  const publication = events.find(event => event.type === 'publish');
  const local = events.find(event => event.type === 'local');
  assert.equal(publication.rows.length, 500);
  assert.equal(local.rows.length, 500);
  assert(local.rows.every(row => row.close === 50), 'no old price scale remains');
  assert.equal(local.rows[0].fecha, full.rows[0].fecha);
  assert.equal(publication.cutoff, full.rows[0].fecha);
  assert(events.indexOf(publication) < events.indexOf(local), 'remote must succeed before local commit');
  assert.equal(job.completed, 1);
  assert.equal(job.status, 'COMPLETADO');
});

test('failed remote publication leaves local history unchanged and persists a retry checkpoint', () => {
  const build = context(), old = sessions(build, 500), daily = parsed(build, sessions(build, 20));
  const {ctx, events} = jobContext(old, daily, null, true);
  const job = ctx.msNewJob_();
  ctx.msRunJob_('daily', job);
  assert.equal(events.filter(event => event.type === 'publish').length, 1);
  assert.equal(events.some(event => event.type === 'local' || event.type === 'flush'), false);
  assert.equal(job.completed, 0);
  assert.equal(job.round, 1);
  assert.deepEqual(clone(job.work), ['AAPL']);
  assert.equal(ctx.msGetJob_('daily').cursor, 0);
  assert.equal(ctx.ScriptApp.getProjectTriggers()[0].getHandlerFunction(), 'continuarActualizacion');
});

test('a failed corrective download never falls back to publishing a fragmented daily merge', () => {
  const build = context(), old = sessions(build, 500, '2026-08-28');
  const daily = parsed(build, sessions(build, 20));
  const {ctx, events} = jobContext(old, daily, {error: 'Yahoo HTTP 429'});
  const job = ctx.msNewJob_();
  ctx.msRunJob_('daily', job);
  assert.deepEqual(events.filter(event => event.type === 'fetch').map(event => event.history), [false, true]);
  assert.equal(events.some(event => event.type === 'publish' || event.type === 'local'), false);
  assert.equal(job.completed, 0);
  assert.deepEqual(clone(job.work), ['AAPL']);
});

test('a verified recent IPO may keep its real short series without downloading every daily run', () => {
  const ctx = context(), rows = sessions(ctx, 4);
  const firstTradeDate = Date.parse(rows[0].fecha + 'T13:30:00Z') / 1000;
  const fresh = parsed(ctx, rows, false, {meta: {firstTradeDate}});
  const old = rows.slice(0, -1);
  const merged = ctx.msMergeRows_(old, fresh.rows, false);
  assert.equal(merged.length, 4);
  assert.equal(ctx.msNeedsFull_(old, fresh, merged, '2026-10-15'), false);
});
