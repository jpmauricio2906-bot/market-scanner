import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLongTrendPanel as transform, LONG_TREND_RULE } from '../tools/long-trend-signals.mjs';

const buildLongTrendPanel = (input, options = {}) => transform(input, {
  calendarDates: [...new Set(input.series.flatMap(s => s.bars.map(b => b.date)))].sort(),
  ...options
});

function panel(closes, v3 = 'HOLD') {
  const bars = closes.map((close, i) => ({ date: new Date(Date.UTC(2010, 0, i + 1)).toISOString().slice(0, 10),
    open: close, high: close, low: close, close, vol: 100, is_final: true }));
  return { series: [{ ticker: 'TEST', bars, signals: bars.map(bar => ({ date: bar.date,
    oldSignal: 'WAIT', newSignal: v3, trendScore: 50, entryScore: 60, exitScore: 70 })) }] };
}
const falling = count => Array.from({ length: count }, (_, i) => 400 - i);

test('200 and 201 bars cannot exit; bar 202 has three contemporaneous SMA200 breaches', () => {
  const result = buildLongTrendPanel(panel(falling(202)));
  const signals = result.series[0].signals;
  assert.equal(LONG_TREND_RULE.earliestExitBarCount, 202);
  assert.equal(signals[198].longTrendSma200, null);
  assert.equal(signals[199].longTrendSma200, 300.5);
  assert.equal(signals[199].longTrendBelowStreak, 1);
  assert.equal(signals[200].longTrendBelowStreak, 2);
  assert.equal(signals[199].newSignal, 'HOLD');
  assert.equal(signals[200].newSignal, 'HOLD');
  assert.equal(signals[201].newSignal, 'SELL');
  assert.equal(signals[201].longTrendSma200, 298.5);
  assert.equal(result.quality.longTrend.longTrendExitSignals, 1);
});

test('each historical close uses its own SMA, not the later moving average', () => {
  const result = buildLongTrendPanel(panel([...Array(199).fill(100), 99.9, 1, 1]));
  const rows = result.series[0].signals;
  assert.equal(rows[199].longTrendBelowStreak, 1);
  assert.ok(99.9 > rows[201].longTrendSma200, 'today SMA applied to old close would incorrectly erase first breach');
  assert.equal(rows[201].longTrendBelowStreak, 3);
  assert.equal(rows[201].newSignal, 'SELL');
});

test('equal and above-SMA closes reset the strictly-below streak', () => {
  const equal = buildLongTrendPanel(panel(Array(205).fill(100))).series[0].signals;
  assert.ok(equal.every(row => row.newSignal === 'HOLD'));
  assert.equal(equal.at(-1).longTrendBelowStreak, 0);
  const reset = buildLongTrendPanel(panel([...Array(199).fill(100), 90, 90, 110, 90, 90, 90])).series[0].signals;
  assert.equal(reset[201].longTrendBelowStreak, 0);
  assert.equal(reset[203].newSignal, 'HOLD');
  assert.equal(reset[204].newSignal, 'SELL');
});

test('constant decimal closes never create false below-SMA streaks or exits', () => {
  for (const close of [0.1, 123.45]) {
    const rows = buildLongTrendPanel(panel(Array(205).fill(close))).series[0].signals;
    assert.ok(rows.every(row => row.newSignal === 'HOLD'));
    for (const row of rows.slice(199)) {
      assert.equal(row.longTrendSma200, close);
      assert.equal(row.longTrendSmaMinusClose, 0);
      assert.equal(row.longTrendBelowSma200, false);
      assert.equal(row.longTrendBelowStreak, 0);
    }
  }
});

test('small real decimal differences still trigger strict below-SMA exits without tolerance', () => {
  for (const close of [0.1, 123.45]) {
    const rows = buildLongTrendPanel(panel([...Array(199).fill(close),
      close - 1e-10, close - 1e-10, close - 1e-10])).series[0].signals;
    assert.equal(rows[199].longTrendBelowStreak, 1);
    assert.equal(rows[200].newSignal, 'HOLD');
    assert.equal(rows[201].longTrendBelowStreak, 3);
    assert.equal(rows[201].newSignal, 'SELL');
    assert.ok(rows[201].longTrendSmaMinusClose > 0);
  }
});

test('future close and signal changes cannot change earlier transformed history', () => {
  const initial = panel(falling(230));
  const early = buildLongTrendPanel({ series: initial.series.map(s => ({ ...s, bars: s.bars.slice(0, 211), signals: s.signals.slice(0, 211) })) });
  const later = structuredClone(initial);
  later.series[0].bars.slice(211).forEach(b => { b.close = 100000; });
  later.series[0].signals.slice(211).forEach(row => { row.newSignal = 'STRONG_BUY'; });
  const full = buildLongTrendPanel(later);
  assert.deepEqual(full.series[0].signals.slice(0, 211), early.series[0].signals);
});

test('a missing expected exchange session resets the streak but SMA uses observed closes', () => {
  const initial = panel(falling(205));
  const calendarDates = initial.series[0].bars.map(b => b.date);
  initial.series[0].bars.splice(200, 1);
  initial.series[0].signals.splice(200, 1);
  const rows = buildLongTrendPanel(initial, { calendarDates }).series[0].signals;
  assert.equal(rows[199].longTrendBelowStreak, 1);
  assert.equal(rows[200].longTrendContiguousPreviousSession, false);
  assert.equal(rows[200].longTrendBelowStreak, 1);
  assert.equal(rows[201].newSignal, 'HOLD');
  assert.equal(rows[202].longTrendBelowStreak, 3);
  assert.equal(rows[202].newSignal, 'SELL');
  assert.equal(rows[202].longTrendSma200,
    initial.series[0].bars.slice(3, 203).reduce((sum, b) => sum + b.close, 0) / 200);
});

test('exchange-calendar adjacency accepts weekends between consecutive trading sessions', () => {
  const initial = panel(falling(202));
  // Replace only the last dates with Friday and Monday; the declared exchange
  // calendar has no intervening Saturday/Sunday sessions.
  const dates = initial.series[0].bars.map(b => b.date);
  dates[200] = '2010-07-23'; dates[201] = '2010-07-26';
  initial.series[0].bars.forEach((bar, i) => { bar.date = dates[i]; });
  initial.series[0].signals.forEach((row, i) => { row.date = dates[i]; });
  const last = buildLongTrendPanel(initial).series[0].signals.at(-1);
  assert.equal(last.longTrendContiguousPreviousSession, true);
  assert.equal(last.newSignal, 'SELL');
});

test('v3 buys are retained during LT warmup and its short-term sells become HOLD', () => {
  const initial = panel(Array(200).fill(100), 'BUY');
  initial.series[0].signals[50].newSignal = 'STRONG_BUY';
  initial.series[0].signals[51].newSignal = 'SELL';
  initial.series[0].signals[52].newSignal = 'STRONG_SELL';
  initial.series[0].signals[20].newSignal = 'WAIT';
  const before = structuredClone(initial);
  const output = buildLongTrendPanel(initial);
  const rows = output.series[0].signals;
  assert.equal(rows[49].newSignal, 'BUY');
  assert.equal(rows[50].newSignal, 'STRONG_BUY');
  assert.equal(rows[51].newSignal, 'HOLD');
  assert.equal(rows[52].newSignal, 'HOLD');
  assert.equal(rows[20].newSignal, 'WAIT');
  assert.equal(rows[51].oldSignal, 'SELL');
  assert.equal(rows[52].oldSignal, 'STRONG_SELL');
  assert.equal(rows[50].oldEntryScore, 60);
  assert.equal(output.quality.longTrend.suppressedV3SellSignals, 2);
  assert.deepEqual(initial, before, 'pure transform must not mutate input');
});

test('LT exit overrides either buy family and records every conflict', () => {
  const initial = panel(falling(203), 'BUY');
  initial.series[0].signals[202].newSignal = 'STRONG_BUY';
  const output = buildLongTrendPanel(initial);
  assert.equal(output.series[0].signals[200].newSignal, 'BUY');
  for (const i of [201, 202]) {
    assert.equal(output.series[0].signals[i].newSignal, 'SELL');
    assert.equal(output.series[0].signals[i].longTrendBuySellConflict, true);
  }
  assert.equal(output.quality.longTrend.buySellConflicts, 2);
});

test('long-term exit requires final candles; explicit provisional overrides normalized opt-in', () => {
  const initial = panel(falling(202));
  initial.series[0].bars.forEach(bar => { delete bar.is_final; });
  assert.equal(buildLongTrendPanel(initial).series[0].signals.at(-1).newSignal, 'HOLD');
  assert.equal(buildLongTrendPanel(initial, { normalizedBarsAreFinal: true }).series[0].signals.at(-1).newSignal, 'SELL');
  for (const marker of [{ is_final: false }, { status: 'PROVISIONAL' }]) {
    const copy = structuredClone(initial);
    Object.assign(copy.series[0].bars.at(-1), marker);
    assert.equal(buildLongTrendPanel(copy, { normalizedBarsAreFinal: true }).series[0].signals.at(-1).newSignal, 'HOLD');
  }
});

test('a provisional close anywhere in the SMA window cannot certify a long-term exit', () => {
  const initial = panel(falling(405).map(close => close + 500));
  initial.series[0].bars[201].is_final = false;
  const rows = buildLongTrendPanel(initial).series[0].signals;
  assert.equal(rows[400].longTrendSmaConfirmed, false);
  assert.equal(rows[401].longTrendBelowStreak, 1);
  assert.equal(rows[402].newSignal, 'HOLD');
  assert.equal(rows[403].newSignal, 'SELL');
});

test('WAIT preserves upstream data guards even after a confirmed long-term breakdown', () => {
  const initial = panel(falling(202), 'WAIT');
  const output = buildLongTrendPanel(initial);
  assert.equal(output.series[0].signals.at(-1).longTrendBelowStreak, 3);
  assert.equal(output.series[0].signals.at(-1).longTrendExitConfirmed, false);
  assert.equal(output.series[0].signals.at(-1).newSignal, 'WAIT');
  assert.equal(output.quality.longTrend.waitGuards, 1);
});

test('thresholds use only closes and ignore volatility, volume and SMA50 diagnostics', () => {
  const initial = panel(falling(202));
  const altered = structuredClone(initial);
  altered.series[0].bars.forEach(bar => { bar.open *= 2; bar.high *= 10; bar.low /= 5; bar.vol = 0; });
  altered.series[0].signals.forEach(row => { row.exitScore = 0; row.exitEmergency = false; row.exitPersistent = false; });
  const a = buildLongTrendPanel(initial).series[0].signals.at(-1);
  const b = buildLongTrendPanel(altered).series[0].signals.at(-1);
  assert.equal(a.newSignal, 'SELL');
  assert.equal(b.newSignal, 'SELL');
  assert.equal(a.longTrendSma200, b.longTrendSma200);
});

test('explicit empty sleeves remain empty, while ambiguous inputs fail', () => {
  const initial = panel([100]);
  initial.series.push({ ticker: 'NOT_LISTED', bars: [], signals: [] });
  assert.deepEqual(buildLongTrendPanel(initial).series[1], initial.series[1]);
  const badDate = panel([100, 100]); badDate.series[0].bars[1].date = badDate.series[0].bars[0].date;
  assert.throws(() => buildLongTrendPanel(badDate), /ascending/);
  const badClose = panel([100]); badClose.series[0].bars[0].close = NaN;
  assert.throws(() => buildLongTrendPanel(badClose), /Invalid close/);
  const badSignal = panel([100]); badSignal.series[0].signals[0].newSignal = 'DOWNTREND';
  assert.throws(() => buildLongTrendPanel(badSignal), /Invalid or misaligned/);
  const misaligned = panel([100]); misaligned.series[0].signals[0].date = '2010-01-02';
  assert.throws(() => buildLongTrendPanel(misaligned), /Invalid or misaligned/);
  assert.throws(() => buildLongTrendPanel({ series: [initial.series[0], initial.series[0]] }), /unique/);
  assert.throws(() => buildLongTrendPanel(initial, { normalizedBarsAreFinal: 'yes' }), /boolean/);
  assert.throws(() => transform(initial), /calendarDates/);
  assert.throws(() => transform(initial, { calendarDates: ['2010-01-02'] }), /outside.*calendar/);
  assert.throws(() => transform(initial, { calendarDates: ['2010-01-01', '2010-01-01'] }), /calendarDates/);
});
