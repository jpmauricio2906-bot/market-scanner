import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, validateWeights, normalizeWeights, equalWeights, readPortfolios, savePortfolio, deletePortfolio, toCsv } from '../js/backtest/storage.mjs';
const memory = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; };
const base = { id: 'base', name: 'Principal', weights: { VLO: .7, SPY: .3 }, parentId: null };

test('portfolio weights are explicit, finite and normalized', () => {
  assert.deepEqual(validateWeights(base.weights), base.weights);
  for (const value of [{}, { VLO: 0 }, { VLO: NaN }, { VLO: .5 }, { VLO: 1.1 }, { '<script>': 1 }]) assert.throws(() => validateWeights(value));
  assert.deepEqual(normalizeWeights({ VLO: 70, SPY: 30 }), base.weights);
  assert.deepEqual(equalWeights(['VLO', 'SPY', 'VLO']), { VLO: .5, SPY: .5 });
  assert.throws(() => normalizeWeights({ VLO: 0, SPY: 1 }));
  assert.throws(() => validateWeights({ VLO: .33333333, SPY: .33333333, AAPL: .33333333 }), /sumar 100/);
  assert.deepEqual(normalizeWeights({ VLO: .33333333, SPY: .33333333, AAPL: .33333333 }), { VLO: 1 / 3, SPY: 1 / 3, AAPL: 1 / 3 });
});
test('round-trip local portfolios and proper subset subportfolio', () => {
  const storage = memory();
  let saved = savePortfolio(storage, [], base);
  saved = savePortfolio(storage, saved, { id: 'child', name: 'Energía', parentId: 'base', weights: { VLO: 1 } });
  assert.deepEqual(readPortfolios(storage), saved);
  assert.throws(() => savePortfolio(storage, saved, { id: 'invalid', name: 'Fuera', parentId: 'base', weights: { AAPL: 1 } }), /solo puede/);
  assert.throws(() => savePortfolio(storage, saved, { id: 'grandchild', name: 'Nivel 3', parentId: 'child', weights: { VLO: 1 } }), /principal válida/);
  assert.throws(() => savePortfolio(storage, saved, { ...base, weights: { SPY: 1 } }), /solo puede/);
  assert.throws(() => deletePortfolio(storage, saved, 'base'), /primero/);
  saved = deletePortfolio(storage, saved, 'child');
  assert.equal(deletePortfolio(storage, saved, 'base').length, 0);
});
test('corrupt or future storage never silently overwrites portfolios', () => {
  const storage = memory();
  for (const raw of ['broken', JSON.stringify({ schemaVersion: 5 }), JSON.stringify({ schemaVersion: 1, portfolios: [base, base] })]) {
    storage.setItem(STORAGE_KEY, raw);
    assert.throws(() => readPortfolios(storage));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
});
test('CSV quotes commas, quotes, line breaks and neutralizes text formulas without damaging negative numbers', () => {
  const csv = toCsv([{ ticker: '=CMD()', note: 'a,"b"\nc', return: -.12 }], ['ticker', 'note', 'return']);
  assert.equal(csv, '\uFEFF"ticker","note","return"\r\n"\'=CMD()","a,""b""\nc","-0.12"');
});
