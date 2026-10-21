import { staticTranslations } from './static-translations.mjs?v=3';
import { dynamicTranslations } from './dynamic-translations.mjs?v=2';
import { localizeMessage } from './message-translations.mjs?v=3';
import { localizeOptimizationMessage } from './optimization-translations.mjs';
import '../i18n.js';

const shared = globalThis.MarketI18n;
export const LANGUAGE_KEY = shared.LANGUAGE_KEY;
const translations = { ...staticTranslations, ...dynamicTranslations };
export const resolveLanguage = shared.resolveLanguage;
export const getLanguage = shared.getLanguage;
export const setLanguage = shared.setLanguage;
export const onLanguageChange = shared.onChange;
export const languageLink = shared.link;

export function t(source, params = {}) {
  const template = getLanguage() === 'en' ? translations[source] ?? source : source;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) =>
    Object.hasOwn(params, key) ? String(params[key]) : match);
}

export const translateMessage = text => localizeOptimizationMessage(localizeMessage(String(text ?? ''), getLanguage()), getLanguage());
export const formatNumber = shared.number;

export function applyTranslations(root = document) {
  shared.apply(root, t);
}
