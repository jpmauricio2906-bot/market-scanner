import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { adjustedPanel, evaluateLongTrend, verifyCacheProvenance } from '../tools/validate-long-trend.mjs';
import { marketDates } from '../tools/backtest.mjs';
import { longTrendCalendar } from '../tools/long-trend-calendar.mjs';

const calendar = longTrendCalendar();
const dates = marketDates(calendar, '2006-01-01', '2007-12-31');
const bars = dates.map((date, i) => ({ date, open: i < 250 ? 100 + i / 10 : 125 - (i - 250) / 5,
  high: 160, low: 60, close: i < 250 ? 100 + i / 10 : 125 - (i - 250) / 5, volume: 1000 }));
const signals = bars.map(b => ({ date: b.date, newSignal: 'BUY', oldSignal: 'HOLD' }));
const panel = { series: [{ ticker: 'SPY', bars, signals }], metadata: {}, quality: {} };
const adjusted = factor => ({ instruments: [{ ticker: 'SPY', status: 'ok' }], rows: bars.map(b => ({
  ticker: 'SPY', fecha: b.date, open: b.open * factor, high: b.high * factor, low: b.low * factor,
  close: b.close * factor, volumen: 1000, is_final: true })) });

test('cache reuse rejects settings or source provenance drift even if its key is unchanged', () => {
  const expected = { cacheKey: 'fixed', cacheProvenance: { settings: { historyDays: 500, minSignalDays: 50 }, source: 'fixed' } };
  const valid = { metadata: structuredClone(expected) };
  assert.doesNotThrow(() => verifyCacheProvenance(valid, expected));
  valid.metadata.cacheProvenance.settings.historyDays = 200;
  assert.throws(() => verifyCacheProvenance(valid, expected), /Cached signal/);
  const wrong = { metadata: structuredClone(expected) }; wrong.metadata.cacheProvenance.source = 'changed';
  assert.throws(() => verifyCacheProvenance(wrong, expected), /Cached signal/);
});

test('adjusted valuation keeps quoted-price signals and exact dates; mismatches fail', () => {
  const out = adjustedPanel(panel, adjusted(0.5));
  assert.equal(out.series[0].bars[100].close, bars[100].close * 0.5);
  assert.deepEqual(out.series[0].signals, signals);
  const wrong = adjusted(0.5); wrong.rows.splice(20, 1);
  assert.throws(() => adjustedPanel(panel, wrong), /Misaligned/);
  const extra = adjusted(0.5); extra.instruments.push({ ticker: 'EXTRA', status: 'not_listed' });
  assert.throws(() => adjustedPanel(panel, extra), /unexpected ticker/);
});

test('empty adjusted sleeves need explicit not-listed evidence and remain empty', () => {
  const withEmpty = { ...panel, series: [...panel.series, { ticker: 'LATER', bars: [], signals: [] }] };
  assert.throws(() => adjustedPanel(withEmpty, adjusted(1)), /not verified/);
  const doc = adjusted(1); doc.instruments.push({ ticker: 'LATER', status: 'not_listed' });
  assert.deepEqual(adjustedPanel(withEmpty, doc).series[1].bars, []);
});

test('common 202-bar eligibility, next-open exits and baseline preservation are explicit', () => {
  const protocol = JSON.parse(fs.readFileSync(new URL('../data/validation/long-trend-protocol.json', import.meta.url)));
  const period = { id: 'synthetic', start: dates[202], end: dates.at(-1), subperiods: [] };
  const result = evaluateLongTrend(panel, { protocol, period, calendar,
    universe: { instruments: [{ ticker: 'SPY', type: 'ETF', dailyLeverage: 1 }] } });
  for (const run of Object.values(result.main)) {
    assert.equal(run.options.warmupBars, 202);
    assert.equal(run.trades[0].entryDate, dates[202]);
    assert.equal(run.metrics.commissionCost, 0);
  }
  assert.equal(result.main.v3.metrics.signalExits, 0);
  const exit = result.main.long_trend_200.trades.find(t => t.exitReason === 'signal');
  assert.ok(exit);
  assert.equal(dates.indexOf(exit.exitDate), dates.indexOf(exit.exitSignalDate) + 1);
  assert.ok(result.conflictingBuyDays > 0);
  assert.equal(result.criterion.prospectiveValidated, false);
  assert.equal(result.criterion.beatsBothInAllFixedSubperiods, null);
  for (const scenario of result.scenarios.filter(s => s.scenario === 'warmup_50')) assert.equal(scenario.warmupBars, 50);
  assert.equal(result.scenarios.find(s => s.scenario === 'slippage_10bps' && s.strategy === 'v3').slippageBps, 10);
});

test('complete exchange calendar is required independently of observed ticker bars', () => {
  const protocol = JSON.parse(fs.readFileSync(new URL('../data/validation/long-trend-protocol.json', import.meta.url)));
  const missing = { ...panel, series: [{ ticker: 'SPY', bars: bars.filter((_, i) => i !== 10), signals: signals.filter((_, i) => i !== 10) }] };
  assert.throws(() => evaluateLongTrend(missing, { protocol, period: { start: dates[202], end: dates.at(-1), subperiods: [] }, calendar,
    universe: { instruments: [] } }), /SPY dates/);
});

test('known rolling snapshot may start SPY later but cannot use future bars or hide internal gaps', () => {
  const protocol = JSON.parse(fs.readFileSync(new URL('../data/validation/long-trend-protocol.json', import.meta.url)));
  const other = { ticker: 'OTHER', bars, signals };
  const rolling = { ...panel, series: [{ ticker: 'SPY', bars: bars.slice(1), signals: signals.slice(1) }, other] };
  const period = { id: 'known_2025_2026', start: dates[205], end: dates[400], subperiods: [] };
  const universe = { instruments: [{ ticker: 'SPY', type: 'ETF', dailyLeverage: 1 }, { ticker: 'OTHER', type: 'STOCK' }] };
  const a = evaluateLongTrend(rolling, { protocol, period, calendar, universe });
  const changed = structuredClone(rolling);
  for (const s of changed.series) for (const bar of s.bars) if (bar.date > period.end) bar.close *= 100;
  const b = evaluateLongTrend(changed, { protocol, period, calendar, universe });
  for (const key of ['v3', 'long_trend_200', 'buy_hold']) {
    assert.deepEqual(a.main[key].metrics, b.main[key].metrics);
    assert.deepEqual(a.main[key].trades, b.main[key].trades);
    assert.equal(a.main[key].equityCurve.at(-1).date, period.end);
  }
  rolling.series[0].bars.splice(250, 1); rolling.series[0].signals.splice(250, 1);
  assert.throws(() => evaluateLongTrend(rolling, { protocol, period, calendar, universe }), /SPY dates/);
});
