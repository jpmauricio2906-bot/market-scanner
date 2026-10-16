const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const properties = new Map(), reads = [], writes = [], sheets = new Map();
  let dateCalls = 0, flushes = 0;
  const book = {getId: () => 'bounded-history-book', getSpreadsheetTimeZone: () => 'UTC',
    getSheetByName: name => sheets.get(name) || null};
  function makeSheet(name, sheetId) {
    const cells = new Map(); let capacity = 20;
    const sheet = {getParent: () => book, getSheetId: () => sheetId, getMaxRows: () => capacity,
      insertRowsAfter(after, count) { assert.equal(after, capacity); capacity += count; },
      getLastRow() { return Math.max(0, ...[...cells.entries()].filter(([,v]) => v !== '').map(([key]) => Number(key.split(',')[0]))); },
      getRange(row, column = 1, height = 1, width = 1) {
        assert.ok(row >= 1 && row + height - 1 <= capacity, 'allocated range');
        return {
          getValues() { reads.push({name, row, column, height, width}); return Array.from({length: height}, (_, y) => Array.from({length: width}, (_, x) => cells.get(`${row+y},${column+x}`) ?? '')); },
          getValue() { reads.push({name, row, column, height, width}); return cells.get(`${row},${column}`) ?? ''; },
          setValues(values) {
            assert.equal(values.length, height); writes.push({name, row, column, height, width});
            values.forEach((line,y) => { assert.equal(line.length,width); line.forEach((value,x) => cells.set(`${row+y},${column+x}`,value)); }); return this;
          },
          setValue(value) { assert.equal(height * width, 1); return this.setValues([[value]]); }
        };
      }};
    sheets.set(name, sheet); return sheet;
  }
  const history = makeSheet('Historial', 701), prices = makeSheet('Precios', 702);
  history.getRange(1,1,1,7).setValues([['Fecha','Ticker','Open','High','Low','Close','Volumen']]);
  const ctx = vm.createContext({Date, console: {log() {}}, msUniverse_: () => ['AAPL','IPO','MSFT'].map(ticker => ({ticker})),
    PropertiesService: {getScriptProperties: () => ({getProperty: key => properties.get(key) ?? null,
      setProperty: (key,value) => properties.set(key,value),
      setProperties: values => Object.entries(values).forEach(([key,value]) => properties.set(key,value)),
      getProperties: () => Object.fromEntries(properties)})},
    SpreadsheetApp: {flush() { flushes++; }},
    Utilities: {formatDate(date,timeZone) { dateCalls++; const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(item => [item.type,item.value])); return `${parts.year}-${parts.month}-${parts.day}`; }}
  });
  for (const name of ['Yahoo.gs','Storage.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script',name),'utf8'),ctx,{filename:name});
  const dates = [];
  for (let day = '2026-10-15'; dates.length < 500; day = ctx.msAddDays_(day,-1)) if (ctx.msIsSession_(day)) dates.unshift(day);
  const bar = (date,ticker) => [date,ticker,100,105,98,103,1000];
  function seed(nativeDates = false) {
    const rows = [...dates.map(date => bar(date,'AAPL')), ...dates.slice(-2).map(date => bar(date,'IPO')), ...dates.map(date => bar(date,'MSFT'))];
    if (nativeDates) rows.forEach(row => { row[0] = new Date(row[0]+'T00:00:00Z'); });
    history.insertRowsAfter(history.getMaxRows(), rows.length + 1 - history.getMaxRows());
    history.getRange(2,1,rows.length,7).setValues(rows);
    const validated = ctx.msLoadHistory_(history);
    const metadata = ctx.msBuildHistoryIndex_(book,validated);
    reads.length = 0; writes.length = 0;
    return metadata;
  }
  return {ctx,book,history,prices,properties,reads,writes,dates,bar,seed,
    get dateCalls() { return dateCalls; }, get flushes() { return flushes; }};
}

const plain = value => JSON.parse(JSON.stringify(value));

test('indexed jobs read at most 500 rows for the selected ticker, with no full-history fallback', () => {
  const h = harness(); h.seed();
  h.ctx.msLoadHistory_ = () => { throw new Error('a runtime job must not scan the full sheet'); };
  const metadata = h.ctx.msAssertHistoryIndex_(h.book);
  const full = h.ctx.msLoadTickerHistory_(h.book,'AAPL',metadata);
  assert.equal(full.byTicker.AAPL.length,500);
  assert.deepEqual(h.reads,[{name:'Historial',row:2,column:1,height:500,width:7}]);
  h.reads.length = 0;
  const ipo = h.ctx.msLoadTickerHistory_(h.book,'IPO',metadata);
  assert.equal(ipo.byTicker.IPO.length,2);
  assert.equal(ipo.free.length,498);
  assert.equal(ipo.positions.length,500);
  assert.equal(h.reads.length,2);
  assert.equal(h.reads.reduce((total,range) => total + range.height,0),500);
  for (const value of h.properties.values()) assert.ok(Buffer.byteLength(value,'utf8') < 9000);
});

test('IPO growth uses reserved slots and mapped writes leave the following ticker intact', () => {
  const h = harness(); h.seed();
  const following = h.history.getRange(504,1,500,7).getValues(); h.reads.length = 0;
  const cache = h.ctx.msLoadTickerHistory_(h.book,'IPO');
  const fresh = ['2026-10-14','2026-10-15','2026-10-16'].map(date => h.ctx.msObject_(h.bar(date,'IPO'),'UTC'));
  fresh[0].close = 104; fresh[1].close = 104;
  h.ctx.msSaveTicker_(cache,'IPO',fresh);
  h.ctx.msFlushHistory_(cache);
  assert.deepEqual(h.writes,[{name:'Historial',row:502,column:1,height:2,width:7},{name:'Historial',row:1501,column:1,height:1,width:7}]);
  assert.equal(h.flushes,0,'the caller flushes sheet and prices together before checkpointing');
  assert.deepEqual(h.history.getRange(504,1,500,7).getValues(),following);
  const reloaded = h.ctx.msLoadTickerHistory_(h.book,'IPO');
  assert.equal(reloaded.byTicker.IPO.length,3);
  assert.deepEqual(plain(reloaded.byTicker.IPO.map(item => item.row.fecha)).sort(),['2026-10-14','2026-10-15','2026-10-16']);
  assert.throws(() => h.ctx.msSaveTicker_(reloaded,'IPO',Array(501).fill(fresh[0])),/fuera del bloque/);
});

test('indexed retention reuses the expired slot without moving another ticker', () => {
  const h = harness(); h.seed();
  const cache = h.ctx.msLoadTickerHistory_(h.book,'AAPL');
  const fresh = [...h.dates.slice(1),'2026-10-16'].map(date => h.ctx.msObject_(h.bar(date,'AAPL'),'UTC'));
  h.ctx.msSaveTicker_(cache,'AAPL',fresh); h.ctx.msFlushHistory_(cache);
  assert.deepEqual(h.writes,[{name:'Historial',row:2,column:1,height:1,width:7}]);
  const reloaded = h.ctx.msLoadTickerHistory_(h.book,'AAPL');
  assert.equal(reloaded.byTicker.AAPL.length,500);
  assert.equal(reloaded.byTicker.AAPL.filter(item => item.row.fecha === '2026-10-16').length,1);
});

test('missing or stale index metadata stops before reading history', () => {
  const h = harness(); h.seed();
  const marker = h.properties.get('MS_HISTORY_INDEX_READY');
  for (const replacement of ['', '{broken', JSON.stringify({...JSON.parse(marker),bookId:'another-book'}), JSON.stringify({...JSON.parse(marker),sheetId:999}), JSON.stringify({...JSON.parse(marker),tickers:['AAPL']})]) {
    h.properties.set('MS_HISTORY_INDEX_READY',replacement);
    assert.throws(() => h.ctx.msLoadTickerHistory_(h.book,'AAPL'),/prepararMarketScanner/);
    assert.equal(h.reads.length,0);
  }
  h.properties.set('MS_HISTORY_INDEX_READY',marker);
  h.ctx.msInvalidateHistoryIndex_();
  assert.throws(() => h.ctx.msAssertHistoryIndex_(h.book),/prepararMarketScanner/);
});

test('invalid ranges, changed ticker blocks and lost rows fail closed', () => {
  const h = harness(); h.seed();
  const key = 'MS_HISTORY_IDX_AAPL', original = JSON.parse(h.properties.get(key));
  for (const segments of [[[2,250],[2,250]],[[2,501]],[[1501,500]]]) {
    h.properties.set(key,JSON.stringify({...original,segments}));
    assert.throws(() => h.ctx.msLoadTickerHistory_(h.book,'AAPL'),/prepararMarketScanner/);
    assert.equal(h.reads.length,0);
  }
  h.properties.set(key,JSON.stringify(original));
  h.history.getRange(2,2).setValue('MSFT');
  assert.throws(() => h.ctx.msLoadTickerHistory_(h.book,'AAPL'),/Historial!B2: índice desactualizado/);
  h.history.getRange(2,1,1,7).setValues([Array(7).fill('')]);
  assert.throws(() => h.ctx.msLoadTickerHistory_(h.book,'AAPL'),/Historial!A2: bloque indexado incompleto/);
});

test('reserved capacity does not permit malformed or duplicate bars', () => {
  const h = harness(); h.seed();
  h.history.getRange(1004,1,1,7).setValues([['','IPO',100,105,98,103,1000]]);
  assert.throws(() => h.ctx.msLoadTickerHistory_(h.book,'IPO'),/Historial!A1004: Fecha vacía/);
  h.history.getRange(1004,1,1,7).setValues([h.bar('2026-10-14','IPO')]);
  assert.throws(() => h.ctx.msLoadTickerHistory_(h.book,'IPO'),/duplicados con la fila 502/);
  h.history.getRange(1004,1,1,7).setValues([['2026-10-16','IPO','100',105,98,103,1000]]);
  assert.throws(() => h.ctx.msLoadTickerHistory_(h.book,'IPO'),/Historial!C1004:/);
});

test('full preparation and selected batches format each distinct native date only once', () => {
  const h = harness(); h.seed(true);
  assert.equal(h.dateCalls,500,'1002 native dates share 500 distinct timestamps');
  const before = h.dateCalls, metadata = h.ctx.msAssertHistoryIndex_(h.book);
  for (const ticker of ['AAPL','IPO','MSFT']) h.ctx.msLoadTickerHistory_(h.book,ticker,metadata);
  assert.equal(h.dateCalls-before,500,'one transient date memo is shared across selected tickers');
});

test('index readiness is committed after all ranges and properties, and failed builds stay disabled', () => {
  const h = harness(); h.seed();
  const validated = h.ctx.msLoadHistory_(h.history);
  h.history.getRange(2,2).setValue('UNKNOWN');
  assert.throws(() => h.ctx.msBuildHistoryIndex_(h.book,validated),/fuera del universo/);
  assert.equal(h.properties.get('MS_HISTORY_INDEX_READY'),'');
  assert.throws(() => h.ctx.msAssertHistoryIndex_(h.book),/prepararMarketScanner/);
});

test('validated price rows avoid extra reads and write timestamp, status and history count together', () => {
  const h = harness();
  const row = {fecha:'2026-10-15',open:100,high:105,low:98,close:103,volumen:1000};
  h.reads.length = 0; h.writes.length = 0;
  h.ctx.msWritePrice_(h.prices,{ticker:'AAPL',name:'Apple'},{current:row,previous:102,status:'FINAL',historyCount:500},new Date('2026-10-15T22:00:00Z'),2);
  assert.equal(h.reads.length,0);
  assert.deepEqual(h.writes,[{name:'Precios',row:2,column:1,height:1,width:9},{name:'Precios',row:2,column:12,height:1,width:3}]);
  assert.deepEqual(h.prices.getRange(2,12,1,3).getValues()[0],['2026-10-15T22:00:00.000Z','FINAL',500]);
});
