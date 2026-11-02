const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The DOM stub models the adapter's controls; chart APIs reject any attempt to
// replace data or ranges so presentation changes cannot silently reset them.
function host() {
  let html = '', nodes = new Map();
  return {
    className: '',
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      nodes = new Map([['details', { open: /<details[^>]*\sopen[\s>]/.test(value) }]]);
      for (const selector of ['color', 'width', 'dash']) {
        nodes.set('[data-appearance="' + selector + '"]', { value: '', disabled: false });
      }
      nodes.set('.appearance-preview', { style: {} });
      nodes.set('.appearance-note', { textContent: '' });
      nodes.set('.appearance-status', { textContent: '' });
    },
    querySelector(selector) { return nodes.get(selector) || null; }
  };
}
function harness(saved) {
  const values = new Map(saved ? [['marketScanner.chartAppearance.v1', JSON.stringify(saved)]] : []);
  const main = host(), cards = new Map(), canvases = new Map();
  const context = vm.createContext({
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    MarketI18n: { t: key => key, number: (value, digits) => Number(value).toFixed(digits) },
    document: {
      getElementById: id => id === 'mainAppearance' ? main : canvases.get(id),
      createElement: () => host()
    }
  });
  for (const file of ['chart-appearance.js', 'ticker-appearance.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context);
  }
  const api = vm.runInContext('TickerAppearance', context);
  function addChart(id, datasets) {
    const legend = [{ style: {} }, { style: {} }], dot = { style: {} }, inner = {};
    const card = {
      host: null,
      querySelector(selector) {
        return ({ '.chart-appearance-host': this.host, '.subchart-inner': inner, '.chart-title .dot': dot })[selector] || null;
      },
      querySelectorAll: () => legend,
      insertBefore(value) { this.host = value; }
    };
    cards.set(id, card);
    canvases.set(id, { closest: () => card });
    const chart = {
      data: { datasets, labels: Object.freeze(['2026-10-01', '2026-10-02']) },
      options: { scales: { x: { min: 7, max: 19 }, y: { min: -10, max: 100 } } },
      updates: [],
      update(mode) { this.updates.push(mode); },
      destroy() { assert.fail('Style changes must not destroy charts'); }
    };
    api.registerChart(id, chart);
    return { chart, card, host: card.host, legend, dot };
  }
  return { api, main, addChart, values, context };
}
function change(host, field, value) { host.onchange({ target: { dataset: { appearance: field }, value } }); }
function reset(host, scope = 'series') { host.onclick({ target: { dataset: { reset: scope } } }); }
function series(options) {
  const current = { lineStyle: 0, ...options }, applied = [];
  const data = Object.freeze([{ time: '2026-10-01', value: 100 }, { time: '2026-10-02', value: 103 }]);
  return {
    data, applied,
    options: () => ({ ...current }),
    applyOptions(patch) { applied.push(patch); Object.assign(current, patch); },
    setData() { assert.fail('Appearance must not replace series data'); }
  };
}
function state(mainSeries, extra = {}) {
  return {
    chartType: 'line', mainSeries, compareTickers: [], overlaySeries: {}, compareSeries: {},
    raw: Object.freeze([{ date: '2026-10-01', close: 100 }]),
    chart: {
      remove() { assert.fail('Appearance must not recreate the main chart'); },
      timeScale() { assert.fail('Appearance must not change the visible range'); }
    },
    ...extra
  };
}

test('direct main-line edits preserve data and ranges, and resetting restores original options', () => {
  const h = harness(), main = series({ color: '#00d4ff', lineWidth: 2 }), chartState = state(main);
  const raw = chartState.raw, data = main.data;
  let changed = 0;
  h.api.syncMain(chartState, 'AAPL', () => changed++);
  change(h.main, 'color', '#123456');
  change(h.main, 'width', '4');
  change(h.main, 'dash', 'dotted');
  assert.equal(main.options().color, '#123456');
  assert.equal(main.options().lineWidth, 4);
  assert.equal(main.options().lineStyle, 1);
  assert.equal(chartState.raw, raw);
  assert.equal(main.data, data);
  assert.equal(changed, 4);
  reset(h.main);
  assert.equal(main.options().color, '#00d4ff');
  assert.equal(main.options().lineWidth, 2);
  assert.equal(main.options().lineStyle, 0);
  assert.deepEqual(JSON.parse(h.values.get('marketScanner.chartAppearance.v1')).styles, {});
});

test('area and Bollinger styling retain fill opacity and reset each independent line', () => {
  const h = harness(), area = series({ lineColor: '#00d4ff', lineWidth: 2 });
  const bb = [series({ color: 'rgba(0,212,255,.55)', lineWidth: 1, lineStyle: 2 }),
    series({ color: 'rgba(0,212,255,.2)', lineWidth: 1 }),
    series({ color: 'rgba(0,212,255,.55)', lineWidth: 1, lineStyle: 2 })];
  h.api.syncMain(state(area, { chartType: 'area', overlaySeries: { bb } }), 'AAPL', () => {});
  change(h.main, 'color', '#112233');
  assert.equal(area.options().lineColor, '#112233');
  assert.equal(area.options().topColor, 'rgba(17, 34, 51, 0.25)');
  assert.equal(area.options().bottomColor, 'rgba(17, 34, 51, 0.02)');
  change(h.main, 'series', 'bb.middle');
  change(h.main, 'color', '#abcdef');
  assert.equal(bb[1].options().color, 'rgba(171, 205, 239, 0.2)');
  assert.equal(bb[0].options().color, 'rgba(0, 212, 255, 0.55)');
  reset(h.main, 'panel');
  assert.equal(area.options().lineColor, '#00d4ff');
  assert.equal(bb[1].options().color, 'rgba(0, 212, 255, 0.2)');
});

test('comparison styles follow the ticker through reordered comparisons and a fresh page', () => {
  const h = harness(), main = series({ color: '#00d4ff', lineWidth: 2 });
  const spy = series({ color: '#e84393', lineWidth: 1.5 }), qqq = series({ color: '#ff7675', lineWidth: 1.5 });
  h.api.syncMain(state(main, { compareTickers: [{ ticker: 'SPY' }, { ticker: 'QQQ' }], compareSeries: { SPY: spy, QQQ: qqq } }), 'AAPL', () => {});
  change(h.main, 'series', 'compare:SPY');
  change(h.main, 'color', '#102030');
  change(h.main, 'dash', 'long-dashed');
  assert.equal(h.api.compareColor('SPY', 0), '#102030');
  const saved = JSON.parse(h.values.get('marketScanner.chartAppearance.v1'));
  const reload = harness(saved), replacement = series({ color: '#ff7675', lineWidth: 1.5 });
  reload.api.syncMain(state(series({ color: '#00d4ff', lineWidth: 2 }), {
    compareTickers: [{ ticker: 'QQQ' }, { ticker: 'SPY' }],
    compareSeries: { QQQ: series({ color: '#e84393', lineWidth: 1.5 }), SPY: replacement }
  }), 'MSFT', () => {});
  assert.equal(replacement.options().color, '#102030');
  assert.equal(replacement.options().lineStyle, 3);
  assert.equal(reload.api.compareColor('SPY', 1), '#102030');
  assert.equal(reload.api.compareColor('QQQ', 0), '#e84393');
});

test('RSI edits leave its transparent fill dataset and numeric data untouched and update the legend', () => {
  const h = harness(), values = Object.freeze([22, 74]);
  const fillOnly = Object.freeze({ label: 'RSI', data: values, borderColor: 'transparent', pointRadius: 0,
    fill: Object.freeze({ target: Object.freeze({ value: 30 }), above: 'transparent', below: 'rgba(0,230,118,.12)' }) });
  const primary = { label: 'RSI', data: values, borderColor: '#ffc107', borderWidth: 1.5, pointRadius: 0,
    fill: { target: { value: 70 }, above: 'rgba(255,61,87,.12)', below: 'transparent' } };
  const c = h.addChart('rsiChart', [primary, fillOnly]), scales = JSON.stringify(c.chart.options.scales);
  const primaryFill = JSON.stringify(primary.fill);
  change(c.host, 'color', '#445566');
  change(c.host, 'width', '3');
  change(c.host, 'dash', 'dashed');
  assert.equal(primary.data, values);
  assert.equal(c.chart.data.datasets[1], fillOnly);
  assert.equal(fillOnly.borderColor, 'transparent');
  assert.equal(JSON.stringify(primary.fill), primaryFill);
  assert.equal(JSON.stringify(c.chart.options.scales), scales);
  assert.equal(c.legend[0].style.borderTop, '3px dashed #445566');
  assert.equal(c.dot.style.background, '#445566');
  assert.ok(c.chart.updates.every(mode => mode === 'none'));
  reset(c.host);
  assert.equal(primary.borderColor, '#ffc107');
  assert.equal(primary.borderWidth, 1.5);
  assert.equal(primary.borderDash.length, 0);
});

test('MACD edits isolate line and bar styles, retaining positive/negative membership and opacity', () => {
  const h = harness(), histogram = Object.freeze([1, -2, 0]);
  const datasets = [
    { data: histogram, backgroundColor: ['rgba(0,230,118,.65)', 'rgba(255,61,87,.65)', 'rgba(0,230,118,.65)'], borderWidth: 0 },
    { data: Object.freeze([1, 2, 3]), type: 'line', borderColor: '#00d4ff', borderWidth: 1.5 },
    { data: Object.freeze([null, 1, 2]), type: 'line', borderColor: '#ff3d57', borderWidth: 1.5 }
  ];
  const c = h.addChart('macdChart', datasets);
  change(c.host, 'series', 'macd.histogram.up');
  assert.equal(c.host.querySelector('[data-appearance="width"]').disabled, true);
  assert.equal(c.host.querySelector('[data-appearance="dash"]').disabled, true);
  change(c.host, 'color', '#223344');
  assert.equal(datasets[0].backgroundColor[0], 'rgba(34, 51, 68, 0.65)');
  assert.equal(datasets[0].backgroundColor[1], 'rgba(255, 61, 87, 0.65)');
  assert.equal(datasets[0].backgroundColor[2], 'rgba(34, 51, 68, 0.65)');
  assert.equal(datasets[0].data, histogram);
  change(c.host, 'series', 'macd.signal');
  change(c.host, 'dash', 'dotted');
  assert.equal(c.legend[1].style.borderTop, '1.5px dotted #ff3d57');
  assert.equal(datasets[1].borderDash.length, 0);
  reset(c.host, 'panel');
  assert.equal(datasets[0].backgroundColor[0], 'rgba(0, 230, 118, 0.65)');
  assert.equal(datasets[2].borderDash.length, 0);
});

test('OBV line and area colors change together while retaining the existing fill opacity', () => {
  const h = harness(), values = Object.freeze([10, 20]);
  const dataset = { data: values, borderColor: '#00b894', borderWidth: 1.5, fill: true, backgroundColor: 'rgba(0,184,148,.08)' };
  const c = h.addChart('obvChart', [dataset]);
  change(c.host, 'color', '#112233');
  assert.equal(dataset.backgroundColor, 'rgba(17, 34, 51, 0.08)');
  assert.equal(dataset.data, values);
  reset(c.host);
  assert.equal(dataset.backgroundColor, 'rgba(0, 184, 148, 0.08)');
});

test('a customization panel closed after chart reconstruction stays closed when language refreshes', () => {
  const h = harness();
  const build = () => h.api.syncMain(state(series({ color: '#00d4ff', lineWidth: 2 })), 'AAPL', () => {});
  build();
  h.main.querySelector('details').open = true;
  build();
  assert.equal(h.main.querySelector('details').open, true);
  h.main.querySelector('details').open = false;
  h.api.refreshLanguage();
  assert.equal(h.main.querySelector('details').open, false);
});
