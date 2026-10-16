const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const fixedNow = '2026-10-15T22:00:00Z';
const clone = value => JSON.parse(JSON.stringify(value));
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return Date.parse(fixedNow); }
}

function context(extra = {}) {
  const props = new Map(), triggers = [], logs = [];
  const ctx = vm.createContext({
    Date: FixedDate, console: { log: message => logs.push(message) },
    Utilities: { formatDate(date, timezone, pattern) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
      }).formatToParts(date).map(item => [item.type, item.value]));
      return pattern === 'HH' ? parts.hour : `${parts.year}-${parts.month}-${parts.day}`;
    } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => props.get(key) ?? null,
      setProperty: (key, value) => props.set(key, value)
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      deleteTrigger: trigger => triggers.splice(triggers.indexOf(trigger), 1),
      newTrigger: handler => ({ timeBased() { return this; }, everyMinutes() { return this; },
        create() { triggers.push({ getHandlerFunction: () => handler }); } })
    }, ...extra
  });
  for (const filename of ['Universe.gs', 'Yahoo.gs', 'Storage.gs', 'Code.gs']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'apps-script', filename), 'utf8'), ctx, { filename });
  }
  return { ctx, props, triggers, logs };
}

class Sheet {
  constructor(name, rows) { this.name = name; this.rows = rows; this.cells = new Map(); this.formulas = new Map(); this.formats = []; }
  key(row, col) { return row + ',' + col; }
  cell(row, col) { return this.cells.get(this.key(row, col)) ?? ''; }
  getMaxRows() { return this.rows; }
  getParent() { return this.book; }
  insertRowsAfter(after, count) { assert.equal(after, this.rows); this.rows += count; }
  getLastRow() { return Math.max(0, ...[...this.cells.keys(), ...this.formulas.keys()].map(key => Number(key.split(',')[0]))); }
  setFrozenRows(rows) { this.frozenRows = rows; }
  getRange(row, col = 1, height = 1, width = 1) {
    if (typeof row === 'string') {
      const match = row.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      assert.ok(match, 'supported A1 format range');
      const column = letters => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
      col = column(match[1]); width = column(match[3]) - col + 1;
      row = Number(match[2]); height = Number(match[4]) - row + 1;
    }
    assert.ok(row + height - 1 <= this.rows, this.name + ': range stays within allocated rows');
    const sheet = this;
    const write = (target, values) => {
      assert.equal(values.length, height);
      values.forEach((valuesRow, y) => {
        assert.equal(valuesRow.length, width);
        valuesRow.forEach((value, x) => target.set(sheet.key(row + y, col + x), value));
      });
    };
    return {
      getValues: () => Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => sheet.cell(row + y, col + x))),
      getValue: () => sheet.cell(row, col),
      setValues(values) { write(sheet.cells, values); return this; },
      setValue(value) { assert.equal(height * width, 1); write(sheet.cells, [[value]]); return this; },
      setFormulas(values) { write(sheet.formulas, values); return this; },
      setNumberFormat(format) { sheet.formats.push({ row, col, height, width, format }); return this; },
      setBackground() { return this; }, setFontColor() { return this; }, setFontWeight() { return this; },
      sort(columns) {
        const values = this.getValues();
        values.sort((a, b) => {
          for (const item of columns) {
            const diff = String(a[item.column - col]).localeCompare(String(b[item.column - col]));
            if (diff) return item.ascending ? diff : -diff;
          }
          return 0;
        });
        write(sheet.cells, values); return this;
      }
    };
  }
}

function workbook() {
  const sheets = new Map();
  return {
    getId: () => 'test-sheet-250',
    timezone: 'UTC',
    getSpreadsheetTimeZone() { return this.timezone; },
    setSpreadsheetTimeZone(timezone) { this.timezone = timezone; },
    getSheetByName: name => sheets.get(name) || null,
    insertSheet(name) { const sheet = new Sheet(name, name === 'Precios' ? 200 : 1000); sheet.book = this; sheets.set(name, sheet); return sheet; }
  };
}

test('generated Apps Script universe matches all 250 JSON instruments and preserves ETF identity and signed exposure', () => {
  const { ctx } = context();
  const actual = clone(ctx.msUniverse_());
  const json = JSON.parse(fs.readFileSync(path.join(root, 'data/universe.json'), 'utf8'));
  const etfs = JSON.parse(fs.readFileSync(path.join(root, 'data/etfs.json'), 'utf8')).etfs;
  assert.equal(actual.length, 250);
  assert.equal(actual.filter(item => item.type === 'STOCK').length, 200);
  assert.equal(actual.filter(item => item.type === 'ETF').length, 50);
  assert.deepEqual(actual.map(item => item.ticker), json.instruments.map(item => item.ticker));
  assert.deepEqual(actual.slice(0, 200).map(item => item.ticker), json.companies.map(item => item.ticker));
  for (const expected of json.instruments) {
    const item = actual.find(instrument => instrument.ticker === expected.ticker);
    for (const key of ['name', 'exchange', 'type']) assert.equal(item[key], expected[key], item.ticker + '.' + key);
    assert.equal(item.yahooTicker, expected.yahooTicker || expected.ticker);
    if (item.type === 'ETF') {
      for (const key of ['category', 'issuer', 'dailyLeverage', 'inverse', 'resetPeriod', 'sourceUrl']) {
        assert.equal(item[key], expected[key], item.ticker + '.' + key);
        assert.equal(item[key], etfs.find(etf => etf.ticker === item.ticker)[key]);
      }
    }
  }
  assert.equal(actual.find(item => item.ticker === 'USD').dailyLeverage, 2);
  assert.equal(actual.find(item => item.ticker === 'SOXS').dailyLeverage, -3);
  assert.equal(actual.find(item => item.ticker === 'SOXS').inverse, true);
  assert.equal(actual.find(item => item.ticker === 'MAGS').type, 'ETF');
});

test('ETF selection retains every ticker even when issuer and company identifiers are shared', () => {
  const { ctx } = context();
  const etfs = ctx.msUniverse_().filter(item => item.type === 'ETF');
  assert.ok(new Set(etfs.map(item => item.issuer)).size < etfs.length, 'multiple funds from the same issuer are retained');
  for (const item of etfs) { item.companyKey = 'shared-etf-trust'; item.cik = '0000000001'; }
  const retained = ctx.msUniverse_().filter(item => item.type === 'ETF');
  assert.equal(retained.length, 50);
  assert.equal(new Set(retained.map(item => item.ticker)).size, 50);
  for (const ticker of ['TQQQ', 'QQQ', 'LABU', 'XBI', 'SOXX', 'USD', 'SOXL', 'SOXS', 'UPRO', 'QLD', 'MAGS']) {
    assert.ok(retained.some(item => item.ticker === ticker), ticker);
  }
});

test('clean sheet setup reaches row 251, allocates 125,000 history slots and writes formulas and ETF metadata without discarding history', () => {
  const book = workbook(), history = book.insertSheet('Historial');
  const oldBars = [
    ['2026-10-14', 'USD', 100, 105, 98, 103, 1000000],
    ['2026-10-14', 'AAPL', 100, 105, 98, 103, 1000000]
  ];
  history.getRange(2, 1, 2, 7).setValues(oldBars);
  const { ctx, props } = context({ SpreadsheetApp: { getActiveSpreadsheet: () => book } });
  ctx.prepararMarketScanner();
  const prices = book.getSheetByName('Precios'), instruments = ctx.msUniverse_();
  assert.equal(book.timezone, 'UTC', 'imported dates keep the file timezone');
  assert.equal(props.get('SPREADSHEET_ID'), 'test-sheet-250');
  assert.equal(prices.getMaxRows(), 251);
  assert.equal(history.getMaxRows(), 125001);
  assert.equal(prices.getLastRow(), 251);
  assert.equal(prices.frozenRows, 1);
  assert.equal(history.frozenRows, 1);
  assert.deepEqual(prices.getRange(1, 17, 1, 5).getValues()[0], ['Tipo', 'Categoria', 'Emisor', 'Apalancamiento diario', 'Inverso']);
  for (let index = 0; index < instruments.length; index++) {
    const row = index + 2, item = instruments[index];
    assert.equal(prices.cell(row, 1), item.ticker);
    assert.equal(prices.formulas.get(prices.key(row, 10)), `=IF(AND(ISNUMBER(G${row}),ISNUMBER(I${row})),G${row}-I${row},"")`);
    assert.equal(prices.formulas.get(prices.key(row, 11)), `=IF(AND(ISNUMBER(J${row}),ISNUMBER(I${row}),I${row}>0),J${row}/I${row},"")`);
    assert.deepEqual(prices.getRange(row, 17, 1, 5).getValues()[0], [item.type, item.category || '', item.issuer || '', item.dailyLeverage ?? 1, Boolean(item.inverse)]);
  }
  const usdRow = instruments.findIndex(item => item.ticker === 'USD') + 2;
  assert.equal(prices.cell(usdRow, 14), 1);
  assert.ok(prices.formats.some(format => format.col === 11 && format.row + format.height - 1 === 251));
  assert.deepEqual(history.getRange(2, 1, 2, 7).getValues(), [...oldBars].sort((a, b) => a[1].localeCompare(b[1])));
});

test('preparation validates a missing date before sorting, expanding or writing to the workbook', () => {
  const book = workbook(), history = book.insertSheet('Historial');
  history.getRange(2, 1, 1, 7).setValues([['', 'ACN', 365.69000244140625, 372.8699951171875, 364.8800048828125, 372.260009765625, 2110700]]);
  const before = [...history.cells], { ctx, props } = context({ SpreadsheetApp: { getActiveSpreadsheet: () => book } });
  assert.throws(() => ctx.prepararMarketScanner(), /Historial!A2: Fecha vacía/);
  assert.deepEqual([...history.cells], before);
  assert.equal(history.getMaxRows(), 1000);
  assert.equal(history.frozenRows, undefined);
  assert.equal(book.getSheetByName('Precios'), null);
  assert.equal(book.timezone, 'UTC');
  assert.equal(props.has('SPREADSHEET_ID'), false);
});

test('preparation preserves a UTC date cell and accepts its existing valid history', () => {
  const book = workbook(), history = book.insertSheet('Historial');
  const { ctx } = context({ SpreadsheetApp: { getActiveSpreadsheet: () => book } });
  const date = new ctx.Date('2026-01-02T00:00:00Z');
  history.getRange(2, 1, 1, 7).setValues([[date, 'AAPL', 100, 105, 98, 103, 1000000]]);
  ctx.prepararMarketScanner();
  assert.equal(book.timezone, 'UTC');
  assert.equal(history.cell(2, 1), date, 'no bulk date conversion is needed');
  assert.equal(ctx.msLoadHistory_(history).values[0][0], '2026-01-02');
});

function jobHarness() {
  const book = workbook();
  const built = context({ SpreadsheetApp: { getActiveSpreadsheet: () => book } });
  const { ctx } = built;
  ctx.prepararMarketScanner();
  const instruments = ctx.msUniverse_(), dates = [];
  for (let date = '2026-10-15'; dates.length < 500; date = ctx.msAddDays_(date, -1)) {
    if (ctx.msIsSession_(date)) dates.unshift(date);
  }
  const cache = { byTicker: {} }, series = new Map(), fetched = [], published = [], saved = [];
  for (const item of instruments) {
    const rows = dates.map(fecha => ({ fecha, ticker: item.ticker, open: 100, high: 105, low: 98, close: 103, volumen: 1000000 }));
    series.set(item.ticker, rows);
    cache.byTicker[item.ticker] = rows.map((row, index) => ({ row, index }));
  }
  ctx.msBook_ = () => book;
  ctx.msLoadHistory_ = () => cache;
  ctx.msFetchYahooBatch_ = (batch, history) => {
    fetched.push({ history, tickers: batch.map(item => item.ticker) });
    return batch.map(item => {
      const rows = series.get(item.ticker);
      return { rows: history ? rows : rows.slice(-1), current: rows.at(-1), previous: 103,
        firstTradeDate: rows[0].fecha, splitDates: [], shortHistory: false, status: 'CIERRE' };
    });
  };
  ctx.msPublish_ = (rows, cutoff, ticker) => {
    assert.ok(rows.every(row => row.ticker === ticker));
    assert.equal(cutoff, dates[0]);
    published.push(ticker);
  };
  ctx.msSaveTicker_ = (_, ticker, rows) => { assert.equal(rows.length, 500); saved.push(ticker); };
  ctx.msFlushHistory_ = () => {};
  return { ...built, book, fetched, published, saved, instruments };
}

test('daily continuation crosses the former 200-company boundary, updates all 50 ETF rows and completes at 250', () => {
  const { ctx, book, instruments, fetched, published, saved, logs, triggers } = jobHarness();
  const job = ctx.msNewJob_(); job.cursor = 195; job.completed = 195;
  ctx.msRunJob_('daily', job);
  const expected = instruments.slice(195).map(item => item.ticker);
  assert.deepEqual(fetched.flatMap(batch => clone(batch.tickers)), clone(expected));
  assert.ok(fetched.every(batch => batch.history === false));
  assert.deepEqual(published, clone(expected));
  assert.deepEqual(saved, clone(expected));
  assert.equal(job.cursor, 250);
  assert.equal(job.completed, 250);
  assert.equal(job.status, 'COMPLETADO');
  assert.equal(ctx.msGetJob_('daily').completed, 250);
  assert.equal(triggers.length, 0);
  assert.ok(logs.some(message => message.includes('correctos 250/250')));
  const prices = book.getSheetByName('Precios');
  for (let index = 200; index < 250; index++) {
    const row = index + 2, item = instruments[index];
    assert.equal(prices.cell(row, 3), '2026-10-15');
    assert.equal(prices.cell(row, 7), 103);
    assert.equal(prices.cell(row, 14), 500);
    assert.equal(prices.cell(row, 17), 'ETF');
    assert.equal(prices.cell(row, 20), item.dailyLeverage);
    assert.equal(prices.cell(row, 21), item.inverse);
    assert.ok(prices.formulas.get(prices.key(row, 10)).includes('G' + row));
  }
});

test('history continuation preserves the 20-ticker batch limit through ETF rows and completes all 250', () => {
  const { ctx, instruments, fetched, published, logs, triggers } = jobHarness();
  const job = ctx.msNewJob_(); job.cursor = 195; job.completed = 195;
  ctx.msRunJob_('history', job);
  assert.equal(job.cursor, 215);
  assert.equal(job.completed, 215);
  assert.equal(job.status, 'EN CURSO');
  assert.equal(triggers[0].getHandlerFunction(), 'continuarHistorial');
  assert.equal(ctx.msGetJob_('history').cursor, 215);
  ctx.msRunJob_('history', job);
  assert.equal(job.cursor, 235);
  assert.equal(job.status, 'EN CURSO');
  ctx.msRunJob_('history', job);
  assert.equal(job.cursor, 250);
  assert.equal(job.completed, 250);
  assert.equal(job.status, 'COMPLETADO');
  assert.equal(triggers.length, 0);
  assert.deepEqual(published, clone(instruments.slice(195).map(item => item.ticker)));
  assert.ok(fetched.every(batch => batch.history && batch.tickers.length <= 5));
  assert.ok(logs.some(message => message.includes('correctos 250/250')));
});
