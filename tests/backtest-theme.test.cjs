const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'js/backtest/theme.js'), 'utf8');
function load(saved, blocked = false) {
  const storage = new Map(saved === undefined ? [] : [['ms-theme', saved]]);
  const styles = {}, events = new Map(), writes = [];
  const context = {document: {documentElement: {dataset: {}, style: {setProperty: (key, value) => styles[key] = value}}},
    localStorage: {getItem: key => { if (blocked) throw new Error('denied'); return storage.get(key); },
      setItem: (key, value) => { if (blocked) throw new Error('denied'); writes.push([key, value]); storage.set(key, value); }},
    addEventListener: (key, listener) => events.set(key, listener)};
  vm.runInNewContext(script, context);
  return {theme: context.MarketBacktestTheme, element: context.document.documentElement, styles, storage, writes, events};
}
test('backtesting offers the exact scanner palette definitions and shared storage key', () => {
  const scanner = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const literal = scanner.match(/var THEMES=(\{[\s\S]*?\n\});/)[1];
  const expected = vm.runInNewContext('(' + literal + ')');
  const {theme} = load();
  assert.equal(JSON.stringify(theme.THEMES), JSON.stringify(expected));
  assert.equal(theme.STORAGE_KEY, 'ms-theme');
  assert.equal(Object.keys(theme.THEMES).length, 8);
});
test('saved light palette is applied before UI initialization with native light controls', () => {
  const {theme, styles, element, writes} = load('arctic');
  assert.equal(theme.getTheme(), 'arctic');
  assert.equal(styles['--bg'], '#f0f4f8');
  assert.equal(styles['--text'], '#1a2332');
  assert.equal(element.style.colorScheme, 'light');
  assert.equal(element.dataset.theme, 'arctic');
  assert.deepEqual(writes, [], 'initial loading does not overwrite another page’s preference');
});
test('selecting a theme persists for scanner and ticker navigation and updates CSS-only charts', () => {
  const {theme, styles, element, storage} = load('arctic');
  const changes = []; theme.onChange(id => changes.push(id));
  theme.setTheme('forest');
  assert.equal(storage.get('ms-theme'), 'forest');
  assert.equal(styles['--buy'], '#81c784');
  assert.equal(styles['--accent'], '#4caf50');
  assert.equal(element.style.colorScheme, 'dark');
  assert.deepEqual(changes, ['forest']);
  theme.setTheme('unsupported');
  assert.equal(theme.getTheme(), 'forest');
});
test('theme changes from another page update this tab without writing a feedback loop', () => {
  const {theme, styles, events, writes} = load('midnight');
  events.get('storage')({key: 'ms-theme', newValue: 'lavender'});
  assert.equal(theme.getTheme(), 'lavender');
  assert.equal(styles['--bg'], '#f7f6ff');
  assert.deepEqual(writes, []);
  events.get('storage')({key: 'unrelated', newValue: 'sunset'});
  assert.equal(theme.getTheme(), 'lavender');
});
test('legacy preferences and denied storage retain a usable default and local selection', () => {
  for (const saved of ['dark', 'powerbi', 'bloomberg', 'ocean', 'stata', 'unknown']) assert.equal(load(saved).theme.getTheme(), 'midnight');
  const {theme, styles} = load('arctic', true);
  assert.equal(theme.getTheme(), 'midnight');
  assert.doesNotThrow(() => theme.setTheme('tableau'));
  assert.equal(styles['--surface'], '#ffffff');
});
