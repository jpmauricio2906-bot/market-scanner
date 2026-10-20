(function (root) {
  'use strict';
  const LANGUAGE_KEY = 'market-scanner.language.v1';
  const LEGACY_LANGUAGE_KEY = 'market-scanner.backtesting.language.v1';
  const supported = value => value === 'es' || value === 'en';
  const translations = new Map(), englishMessages = new Map(), patterns = [], listeners = new Set();

  function resolveLanguage(search = '', saved = null, legacy = null) {
    const requested = new URLSearchParams(search).get('lang');
    return supported(requested) ? requested : supported(saved) ? saved : supported(legacy) ? legacy : 'es';
  }
  function readPreference(key) {
    try { return root.localStorage?.getItem(key); } catch (_) { return null; }
  }
  function persist(value) {
    try {
      root.localStorage?.setItem(LANGUAGE_KEY, value);
      // Keep already-open or cached versions of Backtesting compatible.
      root.localStorage?.setItem(LEGACY_LANGUAGE_KEY, value);
    } catch (_) { /* Language switching still works when storage is unavailable. */ }
  }
  let language = resolveLanguage(root.location?.search, readPreference(LANGUAGE_KEY), readPreference(LEGACY_LANGUAGE_KEY));
  if (root.location) persist(language);
  const getLanguage = () => language;
  const locale = () => language === 'es' ? 'es-ES' : 'en-US';

  function setLanguage(value, options = {}) {
    if (!supported(value)) return language;
    const changed = language !== value;
    language = value;
    if (options.persist !== false) persist(language);
    try {
      if (root.location?.href && root.history?.replaceState) {
        const url = new URL(root.location.href);
        url.searchParams.set('lang', language);
        root.history.replaceState(root.history.state, '', url);
      }
    } catch (_) { /* Some embedded browsers restrict history updates. */ }
    if (root.document?.documentElement) root.document.documentElement.lang = language;
    if (changed) for (const listener of listeners) listener(language);
    return language;
  }
  function register(dictionary) {
    for (const [source, translated] of Object.entries(dictionary)) {
      if (typeof translated === 'string') {
        const previous = translations.get(source);
        if (englishMessages.get(previous) === source) englishMessages.delete(previous);
        translations.set(source, translated);
        englishMessages.set(translated, source);
      }
    }
  }
  function registerMessages(entries) { patterns.push(...entries); }
  function t(source, params = {}) {
    const text = String(source ?? '');
    const template = language === 'es' ? translations.get(text) ?? text : text;
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) => Object.hasOwn(params, key) ? String(params[key]) : match);
  }
  function message(source) {
    const text = String(source ?? '');
    if (language === 'en') return englishMessages.get(text) ?? text;
    if (translations.has(text)) return translations.get(text);
    for (const entry of patterns) {
      entry.pattern.lastIndex = 0;
      if (entry.pattern.test(text)) {
        entry.pattern.lastIndex = 0;
        return text.replace(entry.pattern, entry.replace);
      }
    }
    return text;
  }
  function number(value, digits = 2) {
    return Number.isFinite(value) ? value.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
  }
  function link(href) {
    if (!href || href.startsWith('#')) return href;
    try {
      const base = root.location?.href || 'https://local.invalid/';
      const url = new URL(href, base);
      if (url.origin !== new URL(base).origin || !/(?:^|\/)(?:index|ticker|backtest)\.html$/.test(url.pathname)) return href;
      url.searchParams.set('lang', language);
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return url.href;
      return href.split(/[?#]/)[0] + url.search + url.hash;
    } catch (_) { return href; }
  }
  function apply(documentRoot = root.document, translate = t) {
    if (!documentRoot) return;
    if (documentRoot.documentElement) documentRoot.documentElement.lang = language;
    for (const element of documentRoot.querySelectorAll('[data-i18n]')) element.textContent = translate(element.getAttribute('data-i18n'));
    for (const attribute of ['placeholder', 'aria-label', 'title']) {
      const key = 'data-i18n-' + attribute;
      for (const element of documentRoot.querySelectorAll('[' + key + ']')) element.setAttribute(attribute, translate(element.getAttribute(key)));
    }
    for (const anchor of documentRoot.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href'), localized = link(href);
      if (localized !== href) anchor.setAttribute('href', localized);
    }
  }
  function onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  root.addEventListener?.('storage', event => {
    if ((event.key === LANGUAGE_KEY || event.key === LEGACY_LANGUAGE_KEY) && supported(event.newValue)) setLanguage(event.newValue, { persist: false });
  });
  root.MarketI18n = { LANGUAGE_KEY, LEGACY_LANGUAGE_KEY, resolveLanguage, getLanguage, setLanguage, locale, register, registerMessages, t, message, number, link, apply, onChange };
})(globalThis);
