import { staticTranslations } from './static-translations.mjs';
import { dynamicTranslations } from './dynamic-translations.mjs';
import { localizeMessage } from './message-translations.mjs';

export const LANGUAGE_KEY = 'market-scanner.backtesting.language.v1';
const translations = { ...staticTranslations, ...dynamicTranslations };
const supported = value => value === 'es' || value === 'en';

export function resolveLanguage(search = '', saved = null) {
  const requested = new URLSearchParams(search).get('lang');
  return supported(requested) ? requested : supported(saved) ? saved : 'es';
}

function savedLanguage() {
  try { return globalThis.localStorage?.getItem(LANGUAGE_KEY); } catch { return null; }
}
let language = resolveLanguage(globalThis.location?.search, savedLanguage());
export const getLanguage = () => language;

export function setLanguage(value) {
  if (!supported(value)) return language;
  language = value;
  try { globalThis.localStorage?.setItem(LANGUAGE_KEY, language); } catch { /* The selector also works without browser storage. */ }
  try {
    if (globalThis.location?.href && globalThis.history?.replaceState) {
      const url = new URL(globalThis.location.href);
      url.searchParams.set('lang', language);
      globalThis.history.replaceState(globalThis.history.state, '', url);
    }
  } catch { /* A restricted embedding can disallow URL updates. */ }
  return language;
}

export function t(source, params = {}) {
  const template = language === 'en' ? translations[source] ?? source : source;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) =>
    Object.hasOwn(params, key) ? String(params[key]) : match);
}

export const translateMessage = text => localizeMessage(String(text ?? ''), language);
export const formatNumber = (value, digits = 2) => Number.isFinite(value)
  ? value.toLocaleString(language === 'en' ? 'en-US' : 'es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';

export function applyTranslations(root = document) {
  if (root.documentElement) root.documentElement.lang = language;
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.getAttribute('data-i18n'));
  }
  for (const attribute of ['placeholder', 'aria-label', 'title']) {
    const key = 'data-i18n-' + attribute;
    for (const element of root.querySelectorAll('[' + key + ']')) {
      element.setAttribute(attribute, t(element.getAttribute(key)));
    }
  }
}
