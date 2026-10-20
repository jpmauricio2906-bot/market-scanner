const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const coreSource = read('js/i18n.js');
const catalogSource = read('js/market-translations.js');
const clientSource = read('js/data.js');
const scoring = require('../js/scoring.js');
const LANGUAGE_KEY = 'market-scanner.language.v1';
const LEGACY_KEY = 'market-scanner.backtesting.language.v1';

function page({ url = 'https://example.com/market-scanner/index.html', saved = {}, blockedStorage = false } = {}) {
  const values = new Map(Object.entries(saved)), events = new Map(), updates = [];
  const parsed = new URL(url), location = { href: parsed.href, search: parsed.search };
  const context = vm.createContext({ URL, URLSearchParams, Intl, location,
    localStorage: {
      getItem(key) { if (blockedStorage) throw new Error('Storage disabled'); return values.get(key) ?? null; },
      setItem(key, value) { if (blockedStorage) throw new Error('Storage disabled'); values.set(key, value); }
    },
    history: { state: { retained: true }, replaceState(state, _, value) { const next = new URL(value); updates.push({ state, href: next.href }); location.href = next.href; location.search = next.search; } },
    addEventListener(name, listener) { events.set(name, listener); },
    MARKET_SETTINGS: { historyDays: 500 },
    document: { documentElement: {}, querySelectorAll: () => [] }
  });
  vm.runInContext(coreSource + '\n' + clientSource + '\n' + catalogSource, context);
  return { context, i18n: context.MarketI18n, presentation: context.MarketPresentation, values, events, updates };
}

test('shared language resolves URL, saved preference and legacy backtesting preference in order', () => {
  const { i18n } = page();
  assert.equal(i18n.resolveLanguage('?ticker=VLO&lang=en', 'es', 'es'), 'en');
  assert.equal(i18n.resolveLanguage('?lang=invalid', 'en', 'es'), 'en');
  assert.equal(i18n.resolveLanguage('', 'invalid', 'en'), 'en');
  assert.equal(i18n.resolveLanguage('', null, null), 'es');
  assert.equal(i18n.resolveLanguage('?lang=EN', 'es'), 'es');
});

test('a legacy backtesting choice migrates and a URL choice is remembered across all pages', () => {
  const migrated = page({ saved: { [LEGACY_KEY]: 'en', unrelated: 'keep me' } });
  assert.equal(migrated.i18n.getLanguage(), 'en');
  assert.equal(migrated.values.get(LANGUAGE_KEY), 'en');
  assert.equal(migrated.values.get('unrelated'), 'keep me');
  const linked = page({ url: 'https://example.com/market-scanner/ticker.html?ticker=VLO&lang=es', saved: Object.fromEntries(migrated.values) });
  assert.equal(linked.i18n.getLanguage(), 'es');
  assert.equal(linked.values.get(LANGUAGE_KEY), 'es');
  assert.equal(linked.values.get(LEGACY_KEY), 'es');
  for (const name of ['index', 'ticker', 'backtest']) {
    assert.equal(page({ url: `https://example.com/market-scanner/${name}.html`, saved: Object.fromEntries(linked.values) }).i18n.getLanguage(), 'es');
  }
});

test('switching language persists once, preserves URL context and notifies subscribers without reloading', () => {
  const p = page({ url: 'https://example.com/market-scanner/ticker.html?ticker=BRK-B&compare=SPY#volume' });
  const seen = [], stop = p.i18n.onChange(language => seen.push(language));
  p.i18n.setLanguage('en');
  const next = new URL(p.context.location.href);
  assert.equal(next.searchParams.get('ticker'), 'BRK-B');
  assert.equal(next.searchParams.get('compare'), 'SPY');
  assert.equal(next.searchParams.get('lang'), 'en');
  assert.equal(next.hash, '#volume');
  assert.equal(p.context.document.documentElement.lang, 'en');
  assert.equal(p.values.get(LANGUAGE_KEY), 'en');
  assert.equal(p.values.get(LEGACY_KEY), 'en');
  p.i18n.setLanguage('en');
  p.i18n.setLanguage('fr');
  assert.deepEqual(seen, ['en']);
  assert.equal(p.updates.at(-1).state.retained, true);
  stop(); p.i18n.setLanguage('es');
  assert.deepEqual(seen, ['en']);
});

test('language selection still works with blocked storage and synchronizes other open tabs', () => {
  const blocked = page({ blockedStorage: true });
  assert.doesNotThrow(() => blocked.i18n.setLanguage('en'));
  assert.equal(blocked.i18n.getLanguage(), 'en');
  const p = page(), seen = [];
  p.i18n.onChange(language => seen.push(language));
  p.events.get('storage')({ key: LANGUAGE_KEY, newValue: 'en' });
  assert.equal(p.i18n.getLanguage(), 'en');
  p.events.get('storage')({ key: 'unrelated', newValue: 'es' });
  p.events.get('storage')({ key: LEGACY_KEY, newValue: 'unsupported' });
  assert.equal(p.i18n.getLanguage(), 'en');
  p.events.get('storage')({ key: LEGACY_KEY, newValue: 'es' });
  assert.deepEqual(seen, ['en', 'es']);
});

test('localized navigation preserves ticker and anchors and never changes external destinations', () => {
  const { i18n } = page(); i18n.setLanguage('en');
  assert.equal(i18n.link('ticker.html?ticker=VLO#rsi'), 'ticker.html?ticker=VLO&lang=en#rsi');
  assert.equal(i18n.link('backtest.html?lang=es&ticker=SPY'), 'backtest.html?lang=en&ticker=SPY');
  assert.equal(i18n.link('../market-scanner/index.html'), '../market-scanner/index.html?lang=en');
  assert.equal(i18n.link('https://example.com/market-scanner/ticker.html?ticker=AAPL'), 'https://example.com/market-scanner/ticker.html?ticker=AAPL&lang=en');
  for (const href of ['https://issuer.example/ticker.html', 'https://github.com/user/repo', 'data/universe.json', '#details', 'mailto:person@example.com']) {
    assert.equal(i18n.link(href), href);
  }
});

test('translation rendering uses text and attributes, preserving interpolation as literal content', () => {
  const { i18n } = page();
  i18n.register({ 'Hello {name}': 'Hola {name}', 'Search': 'Buscar' });
  const element = { textContent: '', getAttribute: () => 'Hello {name}' };
  const placeholder = { value: '', getAttribute: () => 'Search', setAttribute: (_, value) => { placeholder.value = value; } };
  const document = { documentElement: {}, querySelectorAll: query => query === '[data-i18n]' ? [element] : query === '[data-i18n-placeholder]' ? [placeholder] : [] };
  i18n.apply(document, text => i18n.t(text, { name: '<img src=x onerror=alert(1)>' }));
  assert.equal(element.textContent, 'Hola <img src=x onerror=alert(1)>');
  assert.equal(placeholder.value, 'Buscar');
  assert.equal(document.documentElement.lang, 'es');
  assert.equal(i18n.t('Hello {name}'), 'Hola {name}');
  assert.equal(i18n.message('Unrecognized technical detail <x>'), 'Unrecognized technical detail <x>');
});

test('every scoring diagnostic translates while raw decisions and values remain identical', () => {
  const { i18n } = page();
  const source = read('js/scoring.js');
  const reasonSource = source.slice(source.indexOf('analysis.reasons.push('), source.indexOf('return analysis;'));
  const reasons = [...reasonSource.matchAll(/"([^"\n]+)"/g)].map(match => match[1]).filter(value => value !== 'BULLISH' && value !== 'BEARISH');
  reasons.push('Invalid OHLC data; no signal calculated.', 'At least 50 valid daily sessions are required.');
  for (const reason of reasons) assert.notEqual(i18n.message(reason), reason, reason);
  const bars = Array.from({ length: 90 }, (_, i) => ({ open: 100 + i, close: 100.4 + i, high: 101 + i, low: 99 + i, vol: 1000 }));
  const before = JSON.stringify(scoring.analyze(bars));
  const shown = scoring.analyze(bars).reasons.map(i18n.message);
  assert.ok(shown.some(reason => reason.startsWith('Tendencia alcista')));
  i18n.setLanguage('en');
  for (const reason of reasons) assert.equal(i18n.message(reason), reason);
  assert.equal(JSON.stringify(scoring.analyze(bars)), before);
  for (const signal of ['WAIT', 'HOLD', 'BUY', 'SELL', 'CONFIRMED BUY', 'CONFIRMED SELL', 'BULLISH', 'BEARISH']) {
    i18n.setLanguage('es'); assert.notEqual(i18n.t(signal), signal);
    i18n.setLanguage('en'); assert.equal(i18n.t(signal), signal);
  }
});

test('all data quality messages localize without changing source diagnostics', () => {
  const { context, i18n } = page();
  const result = { quality: { missingTickers: ['A'], shortHistories: ['B'], insufficientSignals: ['C'], laggingTickers: ['D'],
    expectedDate: '2026-10-19', invalidRows: 2, provisionalRows: 3, provisionalTickers: ['E'], staleRecentTickers: ['F'],
    invalidRecentTickers: ['G'], incompatibleRecentTickers: ['H'], missingRecentTickers: ['I'], recentError: 'Network detail',
    duplicateRows: 4, oldLatestDate: true } };
  const original = context.marketQualityMessages(result), before = JSON.stringify(result);
  assert.equal(original.length, 14);
  for (const message of original) assert.notEqual(i18n.message(message), message, message);
  assert.equal(i18n.message('1 histories await the expected close of 2026-10-19'), '1 historial espera el cierre previsto del 2026-10-19');
  assert.equal(i18n.message('2 instruments await historical data'), '2 activos esperan datos históricos');
  i18n.setLanguage('en');
  for (const message of original) assert.equal(i18n.message(message), message);
  assert.equal(JSON.stringify(result), before);
});

test('quote provenance translates source time, stale marker and each supported delay form', () => {
  const { context, i18n } = page();
  assert.equal(i18n.message(context.marketQuoteLabel(null)), 'Cierre diario confirmado');
  for (const overrides of [
    { source: 'googlefinance', is_final: false, outdated: true, datadelay_minutes: 15 },
    { source: 'yahoo', is_final: false, datadelay_minutes: null },
    { source: 'yahoo', is_final: true, datadelay_minutes: 0 }
  ]) {
    const raw = context.marketQuoteLabel({ source_quote_at: '2026-10-19T20:00:00Z', ...overrides });
    const translated = i18n.message(raw);
    assert.match(translated, /16:00:00 Nueva York/);
    assert.doesNotMatch(translated, /daily|OUTDATED|New York|source delay|quotes may/);
    if (overrides.outdated) assert.match(translated, /DESACTUALIZADA/);
    i18n.setLanguage('en'); assert.equal(i18n.message(raw), raw); i18n.setLanguage('es');
  }
});

test('instrument metadata translates both ways without altering company names, tickers or issuers', () => {
  const { i18n, presentation } = page();
  const instrument = { ticker: 'SOXS', name: 'Stock HOLD Broad market: S&P 500 Trust', type: 'ETF', dailyLeverage: -3,
    inverse: true, issuer: 'Stock Asset Management', category: 'Semiconductores inverso apalancado', exchange: 'NYSE Arca' };
  const before = JSON.stringify(instrument);
  assert.equal(presentation.instrumentDescription(instrument), `${instrument.name} · ETF · −3× diario · inverso · ${instrument.issuer} · ${instrument.category} · NYSE Arca`);
  i18n.setLanguage('en');
  assert.equal(presentation.instrumentDescription(instrument), `${instrument.name} · ETF · −3× daily · inverse · ${instrument.issuer} · Inverse leveraged semiconductors · NYSE Arca`);
  assert.equal(JSON.stringify(instrument), before);
  const universe = JSON.parse(read('data/universe.json'));
  for (const category of new Set(universe.etfs.map(etf => etf.category))) {
    if (category !== 'Nasdaq-100') assert.notEqual(i18n.message(category), category, category);
  }
});

test('all data client and calendar errors have translations, including variable diagnostics', () => {
  const { i18n } = page();
  const fixedErrors = [...(clientSource + read('js/market-calendar.js')).matchAll(/throw new Error\("([^"\n]+)"\)/g)].map(match => match[1]);
  const errors = fixedErrors.concat(['Data request failed (HTTP 503).', 'The company universe must contain 200 companies.',
    'The ETF universe must contain 50 ETFs.', 'The market universe must contain 250 instruments.', 'Invalid ETF metadata for SOXS.']);
  for (const error of errors) assert.notEqual(i18n.message(error), error, error);
  i18n.setLanguage('en');
  for (const error of errors) assert.equal(i18n.message(error), error);
});

test('locale formats presentation numbers without coercing the underlying values', () => {
  const { i18n } = page();
  assert.equal(i18n.locale(), 'es-ES');
  assert.equal(i18n.number(12345.67), '12.345,67');
  assert.equal(i18n.number(0.1, 3), '0,100');
  i18n.setLanguage('en');
  assert.equal(i18n.locale(), 'en-US');
  assert.equal(i18n.number(12345.67), '12,345.67');
  assert.equal(i18n.number(0.1, 3), '0.100');
  assert.equal(i18n.number(null), '—');
  assert.equal(i18n.number(NaN), '—');
});

test('scanner and ticker labels have catalog entries and translations preserve every placeholder', () => {
  const { context, i18n } = page(), catalog = new Map();
  const register = i18n.register;
  i18n.register = dictionary => { Object.entries(dictionary).forEach(([key, value]) => catalog.set(key, value)); register(dictionary); };
  vm.runInContext(catalogSource, context);
  for (const name of ['scanner', 'ticker']) vm.runInContext(read(`js/${name}-translations.js`), context);
  const decode = text => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(x[0-9a-f]+|\d+);/gi,
    (_, code) => String.fromCodePoint(code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code))).replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // Moving-average acronyms and their periods use the same notation in both languages.
  const unchanged = new Set(['SMA 20', 'SMA 50', 'SMA 200', 'EMA 12', 'EMA 26']);
  for (const file of ['index.html', 'ticker.html']) {
    const labels = [...read(file).matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)].map(match => decode(match[1]));
    assert.ok(labels.length > 20, file);
    assert.deepEqual(labels.filter(label => !catalog.has(label) && !unchanged.has(label)), [], file);
  }
  const placeholders = text => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();
  for (const [source, translation] of catalog) assert.deepEqual(placeholders(translation), placeholders(source), source);
});
