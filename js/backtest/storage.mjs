// Browser-local portfolios only. No account state or remote writes.
export const STORAGE_KEY = 'market-scanner.backtesting.portfolios.v1';
const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;

export function validateWeights(weights) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) throw new Error('Selecciona al menos un activo.');
  const entries = Object.entries(weights);
  if (!entries.length || entries.length > 250) throw new Error('Selecciona entre 1 y 250 activos.');
  if (entries.some(([ticker, weight]) => !TICKER.test(ticker) || !Number.isFinite(weight) || weight <= 0 || weight > 1)) {
    throw new Error('Cada activo debe tener un peso mayor que 0% y no superior a 100%.');
  }
  if (Math.abs(entries.reduce((total, [, weight]) => total + weight, 0) - 1) > 1e-9) {
    throw new Error('Los pesos deben sumar 100%. Utiliza Normalizar o Igualar.');
  }
  return Object.fromEntries(entries);
}

export function normalizeWeights(weights) {
  const entries = Object.entries(weights);
  if (!entries.length || entries.some(([ticker, value]) => !TICKER.test(ticker) || !Number.isFinite(value) || value <= 0)) {
    throw new Error('Introduce pesos positivos antes de normalizar, o utiliza Igualar.');
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return validateWeights(Object.fromEntries(entries.map(([ticker, value]) => [ticker, value / total])));
}

export function equalWeights(tickers) {
  return validateWeights(Object.fromEntries([...new Set(tickers)].map(ticker => [ticker, 1 / new Set(tickers).size])));
}

function validatePortfolio(portfolio) {
  if (!portfolio || typeof portfolio !== 'object' || typeof portfolio.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(portfolio.id) ||
      typeof portfolio.name !== 'string' || !portfolio.name.trim() || portfolio.name.trim().length > 80 ||
      (portfolio.parentId != null && typeof portfolio.parentId !== 'string')) throw new Error('La cartera guardada no es válida.');
  return { id: portfolio.id, name: portfolio.name.trim(), parentId: portfolio.parentId || null,
    weights: validateWeights(portfolio.weights), createdAt: String(portfolio.createdAt || '') };
}

export function validatePortfolios(portfolios) {
  if (!Array.isArray(portfolios) || portfolios.length > 100) throw new Error('El archivo local de carteras no es válido.');
  const clean = portfolios.map(validatePortfolio);
  const byId = new Map(clean.map(portfolio => [portfolio.id, portfolio]));
  if (byId.size !== clean.length) throw new Error('Hay carteras duplicadas en el archivo local.');
  for (const portfolio of clean) {
    if (!portfolio.parentId) continue;
    const parent = byId.get(portfolio.parentId);
    if (!parent || parent.parentId || parent.id === portfolio.id) throw new Error('La subcartera debe tener una cartera principal válida.');
    if (Object.keys(portfolio.weights).some(ticker => !Object.hasOwn(parent.weights, ticker))) {
      throw new Error('Una subcartera solo puede contener activos de su cartera principal.');
    }
  }
  return clean;
}

export function readPortfolios(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return [];
  let document;
  try { document = JSON.parse(raw); } catch { throw new Error('No se pueden leer las carteras locales. Sus datos se conservaron.'); }
  if (document?.schemaVersion !== 1) throw new Error('Versión de carteras locales no compatible. Sus datos se conservaron.');
  return validatePortfolios(document.portfolios);
}

export function savePortfolio(storage, portfolios, portfolio) {
  const next = validatePortfolios([...portfolios.filter(item => item.id !== portfolio.id), portfolio]);
  storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, portfolios: next }));
  return next;
}

export function deletePortfolio(storage, portfolios, id) {
  if (portfolios.some(item => item.parentId === id)) throw new Error('Elimina primero las subcarteras de esta cartera.');
  const next = validatePortfolios(portfolios.filter(item => item.id !== id));
  storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, portfolios: next }));
  return next;
}

// Quote every field, preserve numeric negatives, neutralize spreadsheet formulas in text.
export function toCsv(rows, columns) {
  const cell = value => {
    if (value == null) return '""';
    let text = String(value);
    if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [columns.map(cell).join(','), ...rows.map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n');
}
