import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LANGUAGE_KEY, resolveLanguage, getLanguage, setLanguage, t, formatNumber, applyTranslations } from '../js/backtest/i18n.mjs';
import { staticTranslations } from '../js/backtest/static-translations.mjs';
import { dynamicTranslations } from '../js/backtest/dynamic-translations.mjs';

test('explicit language links override the saved preference, with a Spanish fallback', () => {
  assert.equal(resolveLanguage('?ticker=VLO&lang=en', 'es'), 'en');
  assert.equal(resolveLanguage('?lang=es', 'en'), 'es');
  assert.equal(resolveLanguage('?lang=invalid', 'en'), 'en');
  assert.equal(resolveLanguage('', 'fr'), 'es');
});

test('language preference preserves other URL parameters and browser state', () => {
  const keys = ['localStorage', 'location', 'history'];
  const original = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const saved = new Map();
  let replaced;
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem: (key, value) => saved.set(key, value) } });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://example.test/backtest.html?ticker=VLO#results' } });
    Object.defineProperty(globalThis, 'history', { configurable: true, value: { state: { existing: true }, replaceState: (state, unused, url) => { replaced = { state, url }; } } });
    setLanguage('en');
    assert.equal(getLanguage(), 'en');
    assert.equal(saved.get(LANGUAGE_KEY), 'en');
    assert.equal(replaced.url.searchParams.get('ticker'), 'VLO');
    assert.equal(replaced.url.searchParams.get('lang'), 'en');
    assert.equal(replaced.url.hash, '#results');
    assert.deepEqual(replaced.state, { existing: true });
    setLanguage('unsupported');
    assert.equal(getLanguage(), 'en');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage disabled'); } });
    assert.doesNotThrow(() => setLanguage('es'));
    assert.equal(getLanguage(), 'es');
  } finally {
    for (const key of keys) original[key] ? Object.defineProperty(globalThis, key, original[key]) : delete globalThis[key];
    setLanguage('es');
  }
});

test('all marked static strings have English translations and placeholders are preserved', () => {
  const html = fs.readFileSync(new URL('../backtest.html', import.meta.url), 'utf8');
  const decode = value => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
  const keys = [...html.matchAll(/data-i18n(?:-placeholder|-aria-label|-title)?="([^"]+)"/g)].map(match => decode(match[1]));
  assert.ok(keys.length > 60, 'the complete form is marked for translation');
  for (const key of keys) assert.ok(staticTranslations[key], 'missing static translation: ' + key);
  const slots = value => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();
  for (const [source, english] of Object.entries({ ...staticTranslations, ...dynamicTranslations })) {
    assert.deepEqual(slots(english), slots(source), 'placeholders differ: ' + source);
  }
});

test('locale changes presentation and substitutes parameters without treating data as a template', () => {
  try {
    setLanguage('en');
    assert.equal(formatNumber(1234.5), '1,234.50');
    assert.equal(t('{ticker}: {value}', { ticker: 'AAPL{value}', value: 42 }), 'AAPL{value}: 42');
    assert.equal(t('Unregistered message'), 'Unregistered message');
    setLanguage('es');
    assert.equal(formatNumber(12345.5), '12.345,50');
    assert.equal(formatNumber(NaN), '—');
  } finally { setLanguage('es'); }
});

test('static translation uses text content and translates accessibility attributes', () => {
  const source = Object.keys(staticTranslations)[0];
  const element = { textContent: '', attributes: { 'data-i18n': source, 'data-i18n-aria-label': source }, getAttribute(key) { return this.attributes[key]; }, setAttribute(key, value) { this.attributes[key] = value; } };
  const root = { documentElement: {}, querySelectorAll(selector) { return selector === '[data-i18n]' || selector === '[data-i18n-aria-label]' ? [element] : []; } };
  try {
    setLanguage('en'); applyTranslations(root);
    assert.equal(root.documentElement.lang, 'en');
    assert.equal(element.textContent, staticTranslations[source]);
    assert.equal(element.attributes['aria-label'], staticTranslations[source]);
    setLanguage('es'); applyTranslations(root);
    assert.equal(element.textContent, source);
  } finally { setLanguage('es'); }
});
