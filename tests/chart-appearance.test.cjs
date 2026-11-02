const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appearance = require('../js/chart-appearance.js');
const { STORAGE_KEY, createStore, lwOptions, chartOptions, rgba } = appearance;
const defaults = Object.freeze({ color: '#123abc', width: 1.5, dash: 'solid' });

function memory(initial) {
  const values = new Map(initial === undefined ? [] : [[STORAGE_KEY, initial]]);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

test('preferences round-trip under the versioned key and patches retain previous fields', () => {
  const storage = memory(), store = createStore(storage);
  assert.equal(STORAGE_KEY, 'marketScanner.chartAppearance.v1');
  assert.equal(store.persistent(), true);
  assert.deepEqual(store.get('price', defaults), defaults);
  store.set('price', { color: '#abcdef', width: 3 });
  store.set('price', { dash: 'dashed' });
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), {
    version: 1, styles: { price: { color: '#abcdef', width: 3, dash: 'dashed' } }
  });
  assert.deepEqual(createStore(storage).get('price', defaults), { color: '#abcdef', width: 3, dash: 'dashed' });
});

test('defaults, input patches and returned styles remain independent copies', () => {
  const store = createStore(memory());
  const patch = Object.freeze({ width: 4, dash: 'dotted' });
  const result = store.set('price', patch);
  result.width = 1;
  const value = store.get('price', defaults);
  value.color = '#ffffff';
  value.width = 2;
  assert.deepEqual(store.get('price', defaults), { color: '#123abc', width: 4, dash: 'dotted' });
  assert.deepEqual(defaults, { color: '#123abc', width: 1.5, dash: 'solid' });
  assert.deepEqual(patch, { width: 4, dash: 'dotted' });
});

test('only known style fields, full hex colors, allowed numeric widths and dash names are accepted', () => {
  const store = createStore(memory());
  store.set('price', { color: '#ABCDEF', width: 1.5, dash: 'long-dashed', label: 'ignored' });
  for (const color of ['red', '#abc', '#12345678', 'url(javascript:alert(1))', null, 123456]) store.set('price', { color });
  for (const width of ['2', 0, -1, 2.5, 5, NaN, Infinity, null]) store.set('price', { width });
  for (const dash of ['unknown', 'constructor', '__proto__', [], null, 2]) store.set('price', { dash });
  for (const patch of [null, [], true, 'solid', 4]) store.set('price', patch);
  assert.deepEqual(store.get('price'), { color: '#ABCDEF', width: 1.5, dash: 'long-dashed' });
  store.set('price', { color: 'red', width: 4, dash: 'dotted' });
  assert.deepEqual(store.get('price'), { color: '#ABCDEF', width: 4, dash: 'dotted' });
});

test('broken JSON, unknown versions and malformed containers are ignored without rewriting storage', () => {
  for (const raw of ['broken', 'null', '[]', '3', '"string"', '{"version":2,"styles":{"price":{"width":4}}}',
    '{"version":"1","styles":{"price":{"width":4}}}', '{"version":1,"styles":[]}', '{"version":1}']) {
    const storage = memory(raw), store = createStore(storage);
    assert.deepEqual(store.get('price', defaults), defaults, raw);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(store.persistent(), true);
  }
});

test('tampered saved values are sanitized independently and prototype keys are excluded', () => {
  const raw = '{"version":1,"styles":{' +
    '"price":{"color":"#aabbcc","width":"4","dash":"__proto__","extra":true},' +
    '"compare:SPY":{"width":3,"dash":"sparse-dotted"},"volume":[],"bad key":{"width":4},' +
    '"__proto__":{"color":"#ffffff"},"constructor":{"width":4},"prototype":{"width":4}}}';
  const store = createStore(memory(raw));
  assert.deepEqual(store.get('price', defaults), { ...defaults, color: '#aabbcc' });
  assert.deepEqual(store.get('compare:SPY', defaults), { ...defaults, width: 3, dash: 'sparse-dotted' });
  assert.deepEqual(store.get('volume', defaults), defaults);
  for (const key of ['bad key', '__proto__', 'constructor', 'prototype']) assert.deepEqual(store.get(key), {});
  assert.equal({}.color, undefined);
});

test('stable keys accept comparison symbols and reject unsafe, reserved or overly long names', () => {
  const storage = memory(), store = createStore(storage);
  const valid = ['price', 'sma_50', 'compare:SPY', 'compare:BRK-B', 'compare:BRK.B', 'x'.repeat(80)];
  for (const key of valid) store.set(key, { width: 3 });
  for (const key of ['', 'Precio actual', 'compare:<script>', 'compare/SPY', 'x'.repeat(81),
    '__proto__', 'prototype', 'constructor', 'toString', 'hasOwnProperty', null, 123]) {
    assert.deepEqual(store.set(key, { width: 4 }), {});
    assert.deepEqual(store.get(key, defaults), defaults);
  }
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(STORAGE_KEY)).styles), valid);
});

test('denied storage reads leave a working in-memory store', () => {
  const store = createStore({
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); }
  });
  assert.equal(store.persistent(), false);
  store.set('price', { color: '#102030' });
  assert.deepEqual(store.get('price', defaults), { ...defaults, color: '#102030' });
  assert.equal(store.persistent(), false);
  store.reset('price');
  assert.deepEqual(store.get('price', defaults), defaults);
  const absent = createStore(null);
  absent.set('price', { width: 4 });
  assert.equal(absent.get('price').width, 4);
  assert.equal(absent.persistent(), false);
});

test('a failed write retains changes in memory and a later successful write persists them', () => {
  const backing = memory('{"version":1,"styles":{"price":{"color":"#112233"}}}');
  let denied = true;
  const store = createStore({ getItem: backing.getItem, setItem(key, value) {
    if (denied) throw new Error('QuotaExceededError');
    backing.setItem(key, value);
  } });
  assert.equal(store.persistent(), true);
  store.set('price', { width: 4 });
  assert.equal(store.persistent(), false);
  assert.deepEqual(store.get('price', defaults), { ...defaults, color: '#112233', width: 4 });
  assert.deepEqual(createStore(backing).get('price'), { color: '#112233' });
  denied = false;
  store.set('compare:SPY', { dash: 'dashed' });
  assert.equal(store.persistent(), true);
  assert.deepEqual(createStore(backing).get('price'), { color: '#112233', width: 4 });
});

test('reset changes only selected keys and survives a storage round-trip', () => {
  const storage = memory(), store = createStore(storage);
  store.set('price', { width: 4 });
  store.set('sma_50', { color: '#aaaaaa' });
  store.set('compare:SPY', { color: '#bbbbbb' });
  store.reset(['price', '__proto__', 'missing']);
  const restored = createStore(storage);
  assert.deepEqual(restored.get('price', defaults), defaults);
  assert.deepEqual(restored.get('sma_50'), { color: '#aaaaaa' });
  assert.deepEqual(restored.get('compare:SPY'), { color: '#bbbbbb' });
  restored.reset('sma_50');
  assert.deepEqual(restored.get('sma_50'), {});
  assert.deepEqual(restored.get('compare:SPY'), { color: '#bbbbbb' });
  restored.reset();
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), { version: 1, styles: {} });
});

test('comparison instruments and translated display labels cannot change another stable key', () => {
  const store = createStore(memory());
  const english = { id: 'price', label: 'Price' }, spanish = { id: 'price', label: 'Precio' };
  store.set(english.id, { color: '#001122' });
  store.set('compare:SPY', { color: '#334455' });
  store.set('compare:QQQ', { color: '#667788' });
  assert.deepEqual(store.get(spanish.id), { color: '#001122' });
  store.set(spanish.id, { width: 4 });
  assert.deepEqual(store.get(english.id), { color: '#001122', width: 4 });
  assert.deepEqual(store.get('compare:SPY'), { color: '#334455' });
  assert.deepEqual(store.get('compare:QQQ'), { color: '#667788' });
  assert.deepEqual(store.get(english.label), {});
  assert.deepEqual(store.get(spanish.label), {});
});

test('chart adapters map dash styles and preserve fractional widths only for Chart.js', () => {
  const mappings = [['solid', 0, []], ['dashed', 2, [6, 4]], ['dotted', 1, [2, 3]],
    ['long-dashed', 3, [10, 5]], ['sparse-dotted', 4, [2, 7]]];
  for (const [dash, lineStyle, borderDash] of mappings) {
    const style = Object.freeze({ color: '#AbCdEf', width: 1.5, dash });
    assert.deepEqual(lwOptions(style), { color: '#AbCdEf', lineWidth: 2, lineStyle });
    assert.deepEqual(chartOptions(style), { borderColor: '#AbCdEf', borderWidth: 1.5, borderDash });
    const result = chartOptions(style);
    result.borderDash.push(100);
    assert.deepEqual(chartOptions(style).borderDash, borderDash);
  }
  for (const width of [1, 1.5, 2, 3, 4]) assert.equal(lwOptions({ ...defaults, width }).lineWidth, Math.round(width));
  assert.deepEqual(lwOptions(null), { color: '#3b82f6', lineWidth: 2, lineStyle: 0 });
  assert.deepEqual(chartOptions({ color: 'red', width: Infinity, dash: 'constructor' }), {
    borderColor: '#3b82f6', borderWidth: 2, borderDash: []
  });
});

test('rgba converts full hex colors and clamps opacity without changing inputs', () => {
  assert.equal(rgba('#12aBcD', .25), 'rgba(18, 171, 205, 0.25)');
  assert.equal(rgba('#000000', 0), 'rgba(0, 0, 0, 0)');
  assert.equal(rgba('#ffffff', -2), 'rgba(255, 255, 255, 0)');
  assert.equal(rgba('#ffffff', 2), 'rgba(255, 255, 255, 1)');
  assert.equal(rgba('#ffffff', NaN), 'rgba(255, 255, 255, 1)');
  assert.equal(rgba('url(unsafe)', .2), 'rgba(59, 130, 246, 0.2)');
});

test('browser global works when the localStorage property itself is denied', () => {
  const context = vm.createContext({});
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('SecurityError'); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/chart-appearance.js'), 'utf8'), context);
  const api = context.MarketChartAppearance, store = api.createStore();
  assert.equal(typeof api.lwOptions, 'function');
  assert.equal(store.persistent(), false);
  store.set('price', { color: '#123456' });
  assert.equal(store.get('price').color, '#123456');
});
