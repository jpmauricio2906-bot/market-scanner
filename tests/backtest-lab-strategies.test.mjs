import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_DEFAULTS, validateStrategy, strategyWarmup, buildStrategySignals } from '../js/backtest/strategies.mjs';
import { buildLongTrendPanel } from '../tools/long-trend-signals.mjs';

const date = index => new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
const calendar = count => Array.from({ length: count }, (_, index) => date(index));
function bars(count = 260, price = index => 100 + index * .04 + 8 * Math.sin(index / 14) + 2 * Math.sin(index / 3)) {
  return Array.from({ length: count }, (_, index) => { const close = price(index); return { date: date(index),
    open: close - .05, high: close + .15, low: close - .15, close, vol: 1000 + 500 * (1 + Math.sin(index / 5)), is_final: true }; });
}
const build = (data, config = {}, dates = calendar(data.length)) => buildStrategySignals(data, config, { calendarDates: dates });
const permissive = { preset: 'custom', entryScore: 0, trendScore: 0, momentum: 0,
  relativeVolume: 0, maxEntryExtensionAtr: 20, minEntryDistanceAtr: -20, exitMode: 'v3', exitScore: 100 };
const buys = rows => rows.filter(row => ['BUY', 'STRONG_BUY'].includes(row.newSignal));

test('fixed presets canonicalize parameters and determine shared eligibility correctly', () => {
  assert.equal(Object.isFrozen(STRATEGY_DEFAULTS), true);
  assert.equal(validateStrategy({ preset: 'v3', entryScore: 99, exitMode: 'long_trend' }).entryScore, 60);
  assert.equal(validateStrategy({ preset: 'v3' }).exitMode, 'v3');
  assert.equal(validateStrategy({ preset: 'v3' }).exitPeriod, 50, 'v3 metadata names its SMA50 structural rule');
  assert.equal(validateStrategy({ preset: 'sma200', exitPeriod: 20 }).exitPeriod, 200);
  assert.equal(strategyWarmup({ preset: 'v3' }), 50);
  assert.equal(strategyWarmup({ preset: 'sma200' }), 202);
  assert.equal(strategyWarmup({ preset: 'custom', exitPeriod: 100, exitConfirmations: 5 }), 104);
  assert.equal(strategyWarmup({ preset: 'custom', exitPeriod: 20, exitConfirmations: 1 }), 50);
});

test('v3 is identical to production analysis on each causal prefix, including the 500-bar limit', () => {
  const data = bars(610), before = structuredClone(data);
  const signals = build(data, { preset: 'v3' });
  signals.forEach((row, index) => {
    const actual = globalThis.MarketScoring.analyze(data.slice(Math.max(0, index + 1 - 500), index + 1), { minSignalDays: 50, provisional: false, stale: false });
    assert.equal(row.newSignal, actual.signal);
    assert.equal(row.entryScore, actual.entryScore);
    assert.equal(row.exitScore, actual.exitScore);
    assert.equal(row.trendScore, actual.trendScore);
  });
  assert.deepEqual(data, before);
});

test('SMA200 preset exactly matches the frozen historical long-trend transform', () => {
  const data = bars(420), dates = calendar(data.length), v3 = build(data, { preset: 'v3' });
  const frozen = buildLongTrendPanel({ series: [{ ticker: 'AAA', bars: data, signals: v3 }] }, { calendarDates: dates });
  const signals = build(data, { preset: 'sma200' });
  assert.deepEqual(signals.map(row => row.newSignal), frozen.series[0].signals.map(row => row.newSignal));
  assert.deepEqual(signals.map(row => row.longTrendBelowStreak), frozen.series[0].signals.map(row => row.longTrendBelowStreak));
  assert.deepEqual(signals.map(row => row.longTrendSma), frozen.series[0].signals.map(row => row.longTrendSma200));
});

test('future bars cannot change prior signals for fixed and configurable strategies', () => {
  const data = bars(650), truncated = data.slice(0, 530);
  for (const selected of [{ preset: 'v3' }, { preset: 'sma200' }, { ...permissive, exitMode: 'long_trend', exitPeriod: 100, exitConfirmations: 4 }]) {
    assert.deepEqual(build(data, selected).slice(0, 530), build(truncated, selected, calendar(650)));
  }
});

test('custom period and confirmation values change actual sell dates, with no shorter fallback', () => {
  const data = bars(240, index => index < 205 ? 100 : 90);
  const one = build(data, { preset: 'custom', exitPeriod: 20, exitConfirmations: 1 });
  const three = build(data, { preset: 'custom', exitPeriod: 20, exitConfirmations: 3 });
  assert.equal(one.find(row => row.newSignal === 'SELL').date, date(205));
  assert.equal(three.find(row => row.newSignal === 'SELL').date, date(207));
  const long = build(data, { preset: 'custom', exitPeriod: 250, exitConfirmations: 3 });
  assert.equal(long.some(row => row.newSignal === 'SELL'), false);
});

test('calendar gaps reset below-average streak, equality resets it, flat decimals never sell', () => {
  const data = bars(211, index => index < 205 ? 100 : 90);
  data.splice(206, 1);
  const result = build(data, { preset: 'sma200' }, calendar(211));
  assert.equal(result.find(row => row.date === date(207)).longTrendBelowStreak, 1);
  assert.equal(result.find(row => row.date === date(208)).newSignal === 'SELL', false);
  assert.equal(result.find(row => row.date === date(209)).newSignal, 'SELL');
  const flat = bars(240, () => .1).map(row => ({ ...row, open: .1, high: .1, low: .1 }));
  assert.ok(build(flat, { preset: 'sma200' }).every(row => row.longTrendBelowStreak === 0 && row.newSignal !== 'SELL'));
});

test('provisional observations force WAIT and cannot confirm a long-term exit', () => {
  const data = bars(230, index => index < 205 ? 100 : 90);
  data[205].is_final = false;
  for (const selected of [{ preset: 'v3' }, { preset: 'sma200' }, { ...permissive }]) {
    const result = build(data, selected);
    assert.ok(result.slice(205).every(row => row.newSignal === 'WAIT'));
  }
});

test('a close exactly equal to its contemporaneous SMA resets confirmation', () => {
  const data = bars(64, index => index < 60 ? 100 : [81, 99, 80, 79][index - 60]);
  const result = build(data, { preset: 'custom', exitPeriod: 20, exitConfirmations: 2 });
  assert.equal(result[60].longTrendBelowStreak, 1);
  assert.equal(result[61].longTrendSmaMinusClose, 0);
  assert.equal(result[61].longTrendBelowStreak, 0);
  assert.equal(result[62].longTrendBelowStreak, 1);
  assert.notEqual(result[62].newSignal, 'SELL');
  assert.equal(result[63].newSignal, 'SELL');
});

test('custom entry thresholds are effective and raw score is not silently capped by v3 gates', () => {
  const data = bars(220, index => 100 + .2 * index);
  const result = build(data, { ...permissive, entryScore: 50 });
  assert.ok(buys(result).length > 0);
  assert.ok(buys(result).some(row => row.v3EntryScore === 49 && row.entryScore >= 50 && row.distanceAtr > 3));
  const restricted = build(data, { ...permissive, entryScore: 50, maxEntryExtensionAtr: 3 });
  assert.equal(buys(restricted).length, 0);
});

test('all exposed custom entry gates change eligibility while strongOnly restricts only buys', () => {
  const data = bars(300), base = build(data, permissive), baseBuys = buys(base);
  assert.ok(baseBuys.length > 20);
  for (const [name, value] of [['entryScore', 100], ['trendScore', 100], ['momentum', 100],
    ['relativeVolume', 10], ['minEntryDistanceAtr', 20], ['maxEntryExtensionAtr', -20], ['strongOnly', true]]) {
    const candidate = build(data, { ...permissive, [name]: value });
    assert.ok(buys(candidate).length < baseBuys.length, `${name} must affect actual entries`);
    if (name === 'strongOnly') assert.ok(buys(candidate).every(row => row.newSignal === 'STRONG_BUY'));
  }
});

test('custom v3 exitScore filters structural exits, never invents an exit from a low threshold alone', () => {
  const data = bars(300), permissiveExits = build(data, { ...permissive, exitScore: 0 });
  const strictExits = build(data, { ...permissive, exitScore: 100 });
  const sells = rows => rows.filter(row => ['SELL', 'STRONG_SELL'].includes(row.newSignal));
  assert.ok(sells(permissiveExits).length > sells(strictExits).length);
  const flat = bars(80, () => 100);
  assert.equal(sells(build(flat, { ...permissive, exitScore: 0 })).length, 0);
});

test('custom strong buys require a held breakout and both configured volume confirmations', () => {
  const prices = Array.from({ length: 95 }, (_, index) => 100 + index * .15 + 1.5 * Math.sin(index / 3));
  prices[93] = 114.3; prices[94] = 114.5;
  const data = prices.map((close, index) => {
    const open = prices[Math.max(0, index - 1)];
    return { date: date(index), open, close, high: Math.max(open, close) + .6,
      low: Math.min(open, close) - .6, vol: index === 93 ? 1400 : index === 94 ? 2000 : 1000, is_final: true };
  });
  const selected = { preset: 'custom', strongOnly: true, exitMode: 'v3', relativeVolume: 1.2 };
  assert.equal(build(data, selected).at(-1).newSignal, 'STRONG_BUY');
  assert.equal(build(data, { ...selected, relativeVolume: 1.5 }).at(-1).newSignal, 'HOLD');
  data[93].vol = 1000;
  assert.equal(build(data, selected).at(-1).newSignal, 'HOLD');
});

test('long-term exits take priority over otherwise-valid custom entries', () => {
  const data = bars(400), options = { ...permissive, exitMode: 'long_trend', exitPeriod: 100, exitConfirmations: 3 };
  const result = build(data, options), conflicts = result.filter(row => row.longTrendBuySellConflict);
  assert.ok(conflicts.length > 0);
  assert.ok(conflicts.every(row => row.newSignal === 'SELL'));
});

test('rejects invalid custom parameters, unsorted data and missing/invalid calendars', () => {
  for (const config of [null, [], { preset: 'other' }, { unknown: 1 },
    { preset: 'custom', entryScore: 101 }, { preset: 'custom', trendScore: NaN },
    { preset: 'custom', momentum: -1 }, { preset: 'custom', exitScore: Infinity },
    { preset: 'custom', relativeVolume: -1 }, { preset: 'custom', strongOnly: 1 },
    { preset: 'custom', exitPeriod: 19 }, { preset: 'custom', exitPeriod: 251 },
    { preset: 'custom', exitConfirmations: 1.5 }, { preset: 'custom', exitConfirmations: 11 },
    { preset: 'custom', minEntryDistanceAtr: 4, maxEntryExtensionAtr: 3 }, { preset: 'custom', exitMode: 'other' }]) {
    assert.throws(() => validateStrategy(config));
  }
  assert.throws(() => buildStrategySignals(bars()), /calendarDates/);
  assert.throws(() => build(bars(), {}, [date(0), date(0)]), /calendarDates/);
  assert.throws(() => build(bars(), {}, calendar(200)), /outside/);
  assert.throws(() => build(bars().reverse()), /ascending/);
  const invalid = bars(); invalid[100].close = NaN;
  assert.throws(() => build(invalid), /OHLC/);
  assert.deepEqual(build([], {}), []);
});
