const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const scoring = require("../js/scoring.js");
const baseline = require("../tools/baselines/scoring-v2.cjs");

function bars(prices, volume = 1000) {
  return prices.map((close, i) => {
    const open = prices[Math.max(0, i - 1)];
    return { date: i, open, high: Math.max(open, close) + 0.6, low: Math.min(open, close) - 0.6, close, vol: volume };
  });
}
function cycle(length = 95, bearish = false) {
  const prices = Array.from({ length }, (_, i) => 100 + i * 0.15 + 1.5 * Math.sin(i / 3));
  return bars(bearish ? prices.map(price => 220 - price) : prices);
}
function confirmedBreakout(bearish = false) {
  const prices = cycle().map(bar => bar.close);
  prices[prices.length - 2] = 114.3;
  prices[prices.length - 1] = 114.5;
  const data = bars(bearish ? prices.map(price => 220 - price) : prices);
  data.at(-2).vol = 1400;
  data.at(-1).vol = 2000;
  return data;
}
function emergency(length = 80) {
  const prices = Array(length).fill(100);
  prices[prices.length - 1] = 85;
  const data = bars(prices);
  data.at(-1).vol = 2000;
  return data;
}

test("v2 baseline is frozen byte for byte and v3 identifies its changed rule set", () => {
  const bytes = fs.readFileSync(path.join(__dirname, "../tools/baselines/scoring-v2.cjs"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), "4780c5aec98a969c77d597972c0034f89b40cd6418e56ad61d26a2646ab83794");
  assert.equal(baseline.VERSION, "2.0.0");
  assert.equal(scoring.VERSION, "3.0.0");
});

test("three closes below a still-rising SMA50 tolerate a normal-volume pullback", () => {
  const data = bars([...Array.from({ length: 80 }, (_, i) => 100 + i * 0.4), 120, 119, 118]);
  const analysis = scoring.analyze(data);
  assert.equal(analysis.metrics.supportBreakStreak, 3);
  assert.ok(analysis.metrics.sma50 > analysis.metrics.priorSma50);
  assert.equal(analysis.metrics.exitPersistent, false);
  assert.equal(analysis.metrics.exitEmergency, false);
  assert.equal(analysis.signal, "HOLD");
  assert.ok(analysis.exitScore < 60);
});

test("a persistent break exits despite a rebound and without requiring high volume", () => {
  const data = cycle(87, true);
  const analysis = scoring.analyze(data);
  assert.ok(data.at(-1).close > data.at(-2).close);
  assert.equal(analysis.metrics.relativeVolume, 1);
  assert.equal(analysis.metrics.exitPersistent, true);
  assert.equal(analysis.metrics.exitConfirmed, true);
  assert.equal(analysis.signal, "SELL");
  assert.ok(analysis.exitScore >= 60);
  assert.ok(analysis.metrics.distance50Atr < -1);
});

test("a one-day high-volume emergency breakdown can exit but cannot be strong", () => {
  const data = emergency(), analysis = scoring.analyze(data);
  assert.equal(analysis.metrics.supportBreakStreak, 1);
  assert.equal(analysis.metrics.exitPersistent, false);
  assert.equal(analysis.metrics.exitEmergency, true);
  assert.equal(analysis.signal, "SELL");
  assert.equal(analysis.technicalConfirmation, null);
  assert.ok(analysis.exitScore >= 80);
  assert.ok(analysis.metrics.atr > analysis.metrics.priorAtr, "current-bar gap expands ATR but not the emergency hurdle");
  const quiet = data.map(bar => ({ ...bar, vol: 1000 }));
  assert.equal(scoring.analyze(quiet).signal, "HOLD");
});

test("provisional candles block persistent and emergency exits; stale confirmed bars wait", () => {
  for (const data of [cycle(95, true), emergency(), confirmedBreakout(true)]) {
    const analysis = scoring.analyze(data, { provisional: true });
    assert.equal(analysis.metrics.exitPersistent, false);
    assert.equal(analysis.metrics.exitEmergency, false);
    assert.equal(analysis.metrics.exitConfirmed, false);
    assert.ok(analysis.exitScore < 60);
    assert.equal(analysis.signal, "HOLD");
    assert.equal(scoring.analyze(data, { stale: true }).signal, "WAIT");
  }
});

test("50–54 bars remain analyzable while only the persistent exit waits for 55", () => {
  for (let length = 50; length < 55; length++) {
    const declining = bars(Array.from({ length }, (_, i) => 200 - i * 0.4));
    const analysis = scoring.analyze(declining);
    assert.notEqual(analysis.signal, "WAIT");
    assert.equal(analysis.metrics.priorSma50, null);
    assert.equal(analysis.metrics.exitPersistent, false);
    assert.ok(analysis.exitScore < 60);
    assert.equal(scoring.analyze(emergency(length)).signal, "SELL");
  }
  assert.equal(scoring.analyze(bars(Array.from({ length: 55 }, (_, i) => 200 - i * 0.4))).metrics.exitPersistent, true);
});

test("persistent streak compares each close with its contemporaneous SMA50", () => {
  const data = cycle(95, true), analysis = scoring.analyze(data);
  let expected = 0;
  for (let offset = 0; offset < 3; offset++) {
    const prefix = data.slice(0, data.length - offset);
    const average = prefix.slice(-50).reduce((sum, bar) => sum + bar.close, 0) / 50;
    if (prefix.at(-1).close >= average) break;
    expected++;
  }
  assert.equal(analysis.metrics.supportBreakStreak, expected);
  assert.equal(analysis.metrics.priorSma50, data.slice(-55, -5).reduce((sum, bar) => sum + bar.close, 0) / 50);
});

test("strong categories require two closes through the same frozen level and two volume confirmations", () => {
  for (const bearish of [false, true]) {
    const data = confirmedBreakout(bearish), analysis = scoring.analyze(data);
    assert.equal(analysis.signal, bearish ? "STRONG_SELL" : "STRONG_BUY");
    assert.equal(analysis.technicalConfirmation, bearish ? "BREAKDOWN_HELD_TWO_CLOSES" : "BREAKOUT_HELD_TWO_CLOSES");
    const level = bearish ? Math.min(...data.slice(-22, -2).map(bar => bar.low)) : Math.max(...data.slice(-22, -2).map(bar => bar.high));
    assert.equal(bearish ? analysis.metrics.frozenLow20 : analysis.metrics.frozenHigh20, level);
    assert.equal(analysis.metrics.previousRelativeVolume, 1.4);
    assert.ok(Math.abs(analysis.metrics.relativeVolume - 2000 / 1020) < 1e-12);
    const singleVolume = data.map(bar => ({ ...bar }));
    singleVolume.at(-2).vol = 1000;
    assert.equal(scoring.analyze(singleVolume).signal, bearish ? "SELL" : "BUY");
    const noVolume = data.map(bar => ({ ...bar, vol: 0 }));
    assert.notEqual(scoring.analyze(noVolume).signal, bearish ? "STRONG_SELL" : "STRONG_BUY");
  }
});

test("single-bar recovery and a failed breakout retain ordinary labels", () => {
  const data = cycle(), formerStrong = data.map(bar => ({ ...bar }));
  formerStrong.at(-1).vol = 2000;
  assert.equal(baseline.analyze(formerStrong).signal, "STRONG_BUY");
  assert.equal(scoring.analyze(formerStrong).signal, "BUY");
  const failed = confirmedBreakout();
  failed.at(-1).close = 114;
  failed.at(-1).low = Math.min(failed.at(-1).low, 113.9);
  assert.equal(scoring.analyze(failed).metrics.buyBreakoutConfirmed, false);
  assert.notEqual(scoring.analyze(failed).signal, "STRONG_BUY");
});

test("no volume cannot trigger an emergency exit but structural exits remain available", () => {
  const missing = data => data.map(({ vol, ...bar }) => bar);
  assert.equal(scoring.analyze(missing(emergency())).signal, "HOLD");
  const analysis = scoring.analyze(missing(cycle(95, true)));
  assert.equal(analysis.signal, "SELL");
  assert.equal(analysis.metrics.relativeVolume, null);
  assert.equal(analysis.metrics.previousRelativeVolume, null);
});

test("BUY family and Composite are unchanged from v2 except structural-exit precedence", () => {
  let buys = 0;
  for (const bearish of [false, true]) {
    for (let length = 50; length <= 130; length++) {
      const data = cycle(length, bearish), old = baseline.analyze(data), updated = scoring.analyze(data);
      assert.equal(updated.entryScore, old.entryScore);
      assert.equal(updated.trendScore, old.trendScore);
      assert.deepEqual(scoring.computeSignals(data), baseline.computeSignals(data));
      assert.equal(scoring.computeScore(scoring.computeSignals(data)), baseline.computeScore(baseline.computeSignals(data)));
      if (old.signal.includes("BUY")) {
        buys++;
        assert.ok(updated.signal.includes("BUY") || updated.metrics.exitConfirmed);
      } else assert.ok(!updated.signal.includes("BUY"));
    }
  }
  assert.ok(buys > 10, "fixture exercises many independent entry states");
  const collision = scoring.analyze(confirmedBreakout());
  collision.metrics.exitPersistent = true;
  collision.exitScore = 80;
  assert.equal(scoring.classify(collision), "SELL", "structural exit wins even when entry gates also pass");
});

test("future changes cannot change an earlier prefix signal or frozen confirmation level", () => {
  const history = confirmedBreakout();
  const original = scoring.analyze(history);
  const longer = [...history, ...bars([300, 20, 250]).map((bar, i) => ({ ...bar, date: 95 + i, vol: 1000000 }))];
  assert.deepEqual(scoring.analyze(longer.slice(0, history.length)), original);
  const changedToday = history.map(bar => ({ ...bar }));
  changedToday.at(-1).high += 20;
  changedToday.at(-1).low -= 20;
  const updated = scoring.analyze(changedToday);
  assert.equal(updated.metrics.frozenHigh20, original.metrics.frozenHigh20);
  assert.equal(updated.metrics.frozenLow20, original.metrics.frozenLow20);
  assert.equal(updated.metrics.priorLow20, original.metrics.priorLow20);
  assert.equal(updated.metrics.priorAtr, original.metrics.priorAtr);
});

test("new structural exits and confirmation remain invariant to price and volume units", () => {
  for (const data of [cycle(87, true), emergency(), confirmedBreakout(), confirmedBreakout(true)]) {
    const analysis = scoring.analyze(data);
    const changed = scoring.analyze(data.map(bar => ({ ...bar, open: bar.open * 10, high: bar.high * 10, low: bar.low * 10, close: bar.close * 10, vol: bar.vol * 7 })));
    assert.equal(changed.signal, analysis.signal);
    assert.equal(changed.exitScore, analysis.exitScore);
    assert.equal(changed.metrics.exitPersistent, analysis.metrics.exitPersistent);
    assert.equal(changed.metrics.exitEmergency, analysis.metrics.exitEmergency);
    assert.equal(changed.technicalConfirmation, analysis.technicalConfirmation);
    assert.ok(Math.abs(changed.metrics.distance50Atr - analysis.metrics.distance50Atr) < 1e-10);
  }
});
