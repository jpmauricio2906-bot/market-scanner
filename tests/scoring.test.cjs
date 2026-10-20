const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const scoring = require("../js/scoring.js");

function bars(prices, volume = 1000) {
  return prices.map((close, i) => {
    const open = prices[Math.max(0, i - 1)];
    return { date: i, open, high: Math.max(open, close) + 0.6, low: Math.min(open, close) - 0.6, close, vol: volume };
  });
}
function cycle(length = 95, bearish = false, confirmedVolume = false) {
  const prices = Array.from({ length }, (_, i) => 100 + i * 0.15 + 1.5 * Math.sin(i / 3));
  const data = bars(bearish ? prices.map(price => 220 - price) : prices);
  if (confirmedVolume) data.at(-1).vol = 2000;
  return data;
}

test("Composite retains the weighted 0–100 calculation and disabled weights", () => {
  assert.equal(scoring.computeScore({ a: 1, b: -1 }, [{ id: "a", weight: 2 }, { id: "b", weight: 1 }]), 67);
  assert.equal(scoring.computeScore({ a: 1, b: -1 }, [{ id: "a", weight: 0 }, { id: "b", weight: 3 }]), 0);
  assert.equal(scoring.computeScore({ a: 1 }, [{ id: "a", weight: 0 }]), 50);
  assert.equal(scoring.DEFAULT_INDICATORS.reduce((sum, item) => sum + item.weight, 0), 22);
});

test("flat prices are neutral, including RSI, equal averages and MACD", () => {
  const data = bars(Array(100).fill(100));
  const signals = scoring.computeSignals(data), analysis = scoring.analyze(data);
  assert.equal(scoring.rsiCalc(data.map(bar => bar.close)), 50);
  assert.ok(Object.values(signals).every(signal => signal === 0));
  assert.equal(scoring.computeScore(signals), 50);
  assert.equal(analysis.trendScore, 50);
  assert.equal(analysis.signal, "HOLD");
  assert.ok(analysis.entryScore < 50);
});

test("an oversold pullback can retain a bullish trend without a buy or automatic sell", () => {
  const data = cycle(87), signals = scoring.computeSignals(data), analysis = scoring.analyze(data);
  assert.ok(analysis.metrics.stochRsi < 20);
  assert.equal(signals.stoch_rsi, 0, "oversold and still falling must not earn +1");
  assert.ok(analysis.trendScore > 70);
  assert.ok(analysis.entryScore < 50);
  assert.equal(analysis.signal, "HOLD");
  assert.ok(analysis.exitScore < 60, "poor entry quality is not an exit signal");
});

test("oversold recovery receives credit only after price and momentum turn upward", () => {
  const data = cycle(93), signals = scoring.computeSignals(data), analysis = scoring.analyze(data);
  assert.equal(signals.stoch_rsi, 1);
  assert.ok(data.at(-1).close > data.at(-2).close);
  assert.ok(analysis.entryScore >= 60);
  assert.equal(analysis.signal, "BUY", "normal volume cannot produce a strong signal");
});

test("one high-volume candle alone no longer produces either strong signal class", () => {
  const buy = scoring.analyze(cycle(95, false, true));
  const sell = scoring.analyze(cycle(95, true, true));
  assert.equal(buy.signal, "BUY");
  assert.equal(sell.signal, "SELL");
  assert.ok(buy.metrics.bullVolumeConfirmed);
  assert.ok(sell.metrics.bearVolumeConfirmed);
});

test("ordinary and unavailable volume cannot claim strong confirmation", () => {
  const ordinary = cycle(95), missing = ordinary.map(bar => ({ ...bar, vol: 0 }));
  const buy = scoring.analyze(ordinary), unavailable = scoring.analyze(missing);
  assert.equal(buy.signal, "BUY");
  assert.equal(unavailable.metrics.relativeVolume, null);
  assert.equal(unavailable.metrics.bullVolumeConfirmed, false);
  assert.notEqual(unavailable.signal, "STRONG_BUY");
  assert.ok(unavailable.reasons.some(reason => reason.includes("unavailable")));
});

test("provisional candles can never publish strong signals or exits", () => {
  assert.equal(scoring.analyze(cycle(95, false, true), { provisional: true }).signal, "BUY");
  assert.equal(scoring.analyze(cycle(95, true, true), { provisional: true }).signal, "HOLD");
});

test("an extended bullish move is a poor entry but not a sell by itself", () => {
  const prices = cycle(95).map(bar => bar.close);
  prices[prices.length - 1] += 15;
  const analysis = scoring.analyze(bars(prices));
  assert.ok(analysis.metrics.distanceAtr > 3);
  assert.ok(analysis.trendScore > 70);
  assert.ok(analysis.entryScore < 50);
  assert.equal(analysis.signal, "HOLD");
});

test("a bounce inside a bearish trend does not become a falling-knife buy", () => {
  const analysis = scoring.analyze(cycle(87, true, true));
  assert.ok(analysis.trendScore < 30);
  assert.equal(analysis.metrics.priceDirection, 1);
  assert.ok(analysis.entryScore < 50);
  assert.equal(analysis.signal, "SELL", "a small bounce does not cancel an established structural exit");
});

test("stale data reports WAIT while preserving scores for inspection", () => {
  const data = cycle(95, false, true);
  const current = scoring.analyze(data), stale = scoring.analyze(data, { stale: true });
  assert.equal(stale.signal, "WAIT");
  assert.equal(stale.entryScore, current.entryScore);
  assert.equal(stale.trendScore, current.trendScore);
  assert.ok(stale.reasons.some(reason => reason.includes("out of date")));
});

test("short, invalid and explicitly insufficient histories cannot emit actionable signals", () => {
  assert.equal(scoring.analyze(cycle(49)).signal, "WAIT");
  assert.equal(scoring.analyze(cycle(95), { minSignalDays: 100 }).signal, "WAIT");
  assert.equal(scoring.analyze(null).signal, "WAIT");
  assert.equal(scoring.analyze([null]).signal, "WAIT");
  assert.equal(scoring.analyze(new Array(50)).signal, "WAIT");
  const sparse = cycle(95);
  delete sparse[30];
  assert.equal(scoring.analyze(sparse).signal, "WAIT");
  const invalid = cycle(95);
  invalid.at(-1).close = NaN;
  assert.equal(scoring.analyze(invalid).signal, "WAIT");
  assert.equal(scoring.analyze(invalid).entryScore, null);
});

test("OBV confirmation depends on recent signed volume, not an arbitrary history origin", () => {
  const recent = cycle(95);
  const oldPrefix = bars(Array.from({ length: 120 }, (_, i) => 200 - i * 0.6), 1000000);
  const longer = [...oldPrefix, ...recent];
  assert.equal(scoring.volumeBalance(longer), scoring.volumeBalance(recent));
  assert.equal(scoring.computeSignals(longer).obv, scoring.computeSignals(recent).obv);
  assert.ok(Math.abs(scoring.volumeBalance(longer)) <= 1);
});

test("ranking is invariant to price denomination and volume units; ATR casts no directional vote", () => {
  const data = cycle(95, false, true);
  const scaled = data.map(bar => ({ ...bar, open: bar.open * 10, high: bar.high * 10, low: bar.low * 10, close: bar.close * 10, vol: bar.vol * 7 }));
  const original = scoring.analyze(data), changed = scoring.analyze(scaled);
  assert.equal(changed.signal, original.signal);
  assert.equal(changed.trendScore, original.trendScore);
  assert.equal(changed.entryScore, original.entryScore);
  assert.equal(changed.exitScore, original.exitScore);
  assert.equal(scoring.computeSignals(data).atr, 0);
  assert.equal(scoring.computeSignals(scaled).atr, 0);
});

test("indicator charts use causal warmups and never change their past when new bars arrive", () => {
  const data = cycle(95), dates = data.map(bar => bar.date), prices = data.map(bar => bar.close);
  const shortMacd = scoring.macdSeries(prices.slice(0, 70), dates.slice(0, 70));
  const longMacd = scoring.macdSeries(prices, dates);
  assert.equal(longMacd.hist[0].time, 33, "MACD signal requires nine valid MACD observations");
  assert.deepEqual(longMacd.hist.slice(0, shortMacd.hist.length), shortMacd.hist);
  assert.equal(scoring.stochRsiSeries(prices, dates)[0].time, 27);
  assert.equal(scoring.atrSeries(data, dates)[0].time, 14);
  const atr = scoring.atrSeries(data, dates).at(-1).value;
  assert.ok(Math.abs(atr - scoring.analyze(data).metrics.atrPct) < 1e-10);
});

test("all scores remain finite and bounded across zero-range, rising and falling histories", () => {
  const histories = [cycle(95), cycle(95, true), bars(Array.from({ length: 100 }, (_, i) => 100 + i)),
    bars(Array.from({ length: 100 }, (_, i) => 200 - i)), Array.from({ length: 100 }, (_, i) => ({ date: i, open: 100, high: 100, low: 100, close: 100, vol: 0 }))];
  for (const history of histories) {
    const before = JSON.stringify(history), analysis = scoring.analyze(history);
    for (const value of [analysis.entryScore, analysis.exitScore, analysis.trendScore, ...Object.values(analysis.components)]) {
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 100);
    }
    assert.equal(JSON.stringify(history), before, "scoring must not mutate source prices");
  }
});

test("the browser global and CommonJS consumers run the same scoring engine", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/scoring.js"), "utf8"), context);
  const data = cycle(95, false, true);
  assert.equal(JSON.stringify(context.MarketScoring.analyze(data)), JSON.stringify(scoring.analyze(data)));
  assert.equal(context.MarketScoring.computeScore(scoring.computeSignals(data)), scoring.computeScore(scoring.computeSignals(data)));
});
