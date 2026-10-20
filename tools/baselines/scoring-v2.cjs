(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MarketScoring = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Fixed, inspectable rules, not probabilities or a fitted trading model.
  const VERSION = "2.0.0";
  const DEFAULT_INDICATORS = Object.freeze([
    ["sma_cross", 2], ["ema_cross", 2], ["sma50", 1], ["macd", 2],
    ["rsi", 3], ["stoch_rsi", 2], ["roc", 1], ["williams", 1],
    ["bb", 2], ["atr", 1], ["obv", 1], ["vol_avg", 1], ["candle", 2], ["gap", 1]
  ].map(([id, weight]) => Object.freeze({ id, weight })));
  const THRESHOLDS = Object.freeze({ buy: 60, strongBuy: 75, sell: 60, strongSell: 75,
    bullishTrend: 55, bearishTrend: 45, strongBullishTrend: 65, strongBearishTrend: 35,
    momentum: 55, strongMomentum: 65, confirmedRelativeVolume: 1.2,
    maxEntryExtensionAtr: 3, minEntryDistanceAtr: -1.5 });

  const clamp = (value, low = -1, high = 1) => Math.max(low, Math.min(high, value));
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const score = value => Math.round(clamp(value, 0, 100));
  const last = values => values[values.length - 1];
  const direction = value => Math.abs(value) < 1e-10 ? 0 : Math.sign(value);
  const volumeOf = bar => Number.isFinite(bar.vol) ? Math.max(0, bar.vol) : Number.isFinite(bar.volumen) ? Math.max(0, bar.volumen) : 0;
  const dated = (dates, index, value) => ({ time: dates ? dates[index] : index, value });

  function sma(values, period) {
    if (values.length < period) return null;
    return mean(values.slice(-period));
  }
  function emaValues(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    out[period - 1] = mean(values.slice(0, period));
    const alpha = 2 / (period + 1);
    for (let i = period; i < values.length; i++) out[i] = values[i] * alpha + out[i - 1] * (1 - alpha);
    return out;
  }
  function ema(values, period) { return values.length < period ? null : last(emaValues(values, period)); }
  function rsiValues(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const delta = values[i] - values[i - 1];
      gain += Math.max(0, delta); loss += Math.max(0, -delta);
    }
    gain /= period; loss /= period;
    const value = () => gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    out[period] = value();
    for (let i = period + 1; i < values.length; i++) {
      const delta = values[i] - values[i - 1];
      gain = (gain * (period - 1) + Math.max(0, delta)) / period;
      loss = (loss * (period - 1) + Math.max(0, -delta)) / period;
      out[i] = value();
    }
    return out;
  }
  function rsiCalc(values, period = 14) { return last(rsiValues(values, period)) ?? 50; }
  function rsiSeries(values, dates, period = 14) {
    return rsiValues(values, period).flatMap((value, i) => value === null ? [] : [dated(dates, i, value)]);
  }
  function macdSeries(values, dates) {
    const fast = emaValues(values, 12), slow = emaValues(values, 26);
    const macd = [], signal = [], hist = [], raw = [];
    for (let i = 25; i < values.length; i++) raw.push(fast[i] - slow[i]);
    const smooth = emaValues(raw, 9);
    raw.forEach((value, j) => {
      macd.push(dated(dates, j + 25, value));
      if (smooth[j] !== null) {
        signal.push(dated(dates, j + 25, smooth[j]));
        hist.push(dated(dates, j + 25, value - smooth[j]));
      }
    });
    return { macd, signal, hist };
  }
  function stochValues(values, period = 14) {
    const rsi = rsiValues(values, period), out = new Array(values.length).fill(null);
    for (let i = period * 2 - 1; i < values.length; i++) {
      const window = rsi.slice(i - period + 1, i + 1);
      const low = Math.min(...window), high = Math.max(...window);
      out[i] = high === low ? 50 : (rsi[i] - low) / (high - low) * 100;
    }
    return out;
  }
  function stochRsiSeries(values, dates, period = 14) {
    return stochValues(values, period).flatMap((value, i) => value === null ? [] : [dated(dates, i, value)]);
  }
  function bollingerSeries(values, dates, period = 20, multiplier = 2) {
    const upper = [], mid = [], lower = [];
    for (let i = period - 1; i < values.length; i++) {
      const window = values.slice(i - period + 1, i + 1), center = mean(window);
      const deviation = Math.sqrt(mean(window.map(value => (value - center) ** 2)));
      upper.push(dated(dates, i, center + multiplier * deviation));
      mid.push(dated(dates, i, center));
      lower.push(dated(dates, i, center - multiplier * deviation));
    }
    return { upper, mid, lower };
  }
  function bbPct(values) {
    if (values.length < 20) return 0.5;
    const window = values.slice(-20), center = mean(window);
    const deviation = Math.sqrt(mean(window.map(value => (value - center) ** 2)));
    return deviation === 0 ? 0.5 : (last(values) - center + 2 * deviation) / (4 * deviation);
  }
  function williamsRSeries(data, dates, period = 14) {
    const out = [];
    for (let i = period - 1; i < data.length; i++) {
      const window = data.slice(i - period + 1, i + 1);
      const high = Math.max(...window.map(bar => bar.high)), low = Math.min(...window.map(bar => bar.low));
      out.push(dated(dates, i, high === low ? -50 : -100 * (high - data[i].close) / (high - low)));
    }
    return out;
  }
  function atrValues(data, period = 14) {
    const out = new Array(data.length).fill(null);
    if (data.length <= period) return out;
    const ranges = data.slice(1).map((bar, index) => Math.max(bar.high - bar.low,
      Math.abs(bar.high - data[index].close), Math.abs(bar.low - data[index].close)));
    out[period] = mean(ranges.slice(0, period));
    for (let i = period + 1; i < data.length; i++) out[i] = (out[i - 1] * (period - 1) + ranges[i - 1]) / period;
    return out;
  }
  // Chart API retains the existing normalized ATR (%) convention.
  function atrSeries(data, dates, period = 14) {
    return atrValues(data, period).flatMap((value, i) => value === null ? [] : [dated(dates, i, value / data[i].close * 100)]);
  }
  function obvSeries(data, dates) {
    let value = 0;
    return data.slice(1).map((bar, index) => {
      value += direction(bar.close - data[index].close) * volumeOf(bar);
      return dated(dates, index + 1, value);
    });
  }
  function volumeBalance(data, period = 20) {
    let signed = 0, total = 0;
    for (let i = Math.max(1, data.length - period); i < data.length; i++) {
      const volume = volumeOf(data[i]);
      signed += direction(data[i].close - data[i - 1].close) * volume;
      total += volume;
    }
    return total > 0 ? signed / total : 0;
  }
  function rocSeries(values, dates, period = 10) {
    return values.slice(period).map((value, index) => dated(dates, index + period, (value / values[index] - 1) * 100));
  }
  function candleSignal(data) {
    if (data.length < 2) return 0;
    const bar = last(data), previous = data[data.length - 2], body = Math.abs(bar.close - bar.open), range = bar.high - bar.low;
    if (range <= 0 || body / range < 0.1) return 0;
    const lower = Math.min(bar.close, bar.open) - bar.low, upper = bar.high - Math.max(bar.close, bar.open);
    const bullish = bar.close > bar.open;
    if (lower > body * 2 && upper < body * 0.3 && previous.close < previous.open) return 0.8;
    if (upper > body * 2 && lower < body * 0.3 && previous.close > previous.open) return -0.8;
    if (bullish && previous.close < previous.open && bar.open < previous.close && bar.close > previous.open) return 1;
    if (!bullish && previous.close > previous.open && bar.open > previous.close && bar.close < previous.open) return -1;
    return body / range > 0.6 ? bullish ? 0.4 : -0.4 : 0;
  }
  function crossSignal(current, previous) {
    if (current === null || previous === null) return 0;
    const currentDirection = direction(current), previousDirection = direction(previous);
    return currentDirection === 0 ? 0 : previousDirection !== currentDirection ? currentDirection : currentDirection * 0.3;
  }
  // An extreme is a setup, not a reversal. Require both oscillator recovery and
  // a matching price move; a fresh exit from the extreme receives full weight.
  function recoverySignal(values, low, high, priceDirection) {
    if (values.length < 2) return 0;
    const current = last(values), previous = values[values.length - 2];
    const recent = values.slice(-4, -1).filter(Number.isFinite);
    if (!Number.isFinite(current) || !Number.isFinite(previous) || !recent.length) return 0;
    if (priceDirection > 0 && current > previous && Math.min(...recent) < low) return previous < low && current >= low ? 1 : current < low + (high - low) * 0.25 ? 0.5 : 0;
    if (priceDirection < 0 && current < previous && Math.max(...recent) > high) return previous > high && current <= high ? -1 : current > high - (high - low) * 0.25 ? -0.5 : 0;
    return 0;
  }
  function computeSignals(data) {
    const values = data.map(bar => bar.close), previousValues = values.slice(0, -1), signals = {};
    const priceDirection = values.length > 1 ? direction(last(values) - last(previousValues)) : 0;
    const averageDifference = (first, second, source) => {
      const a = first(source), b = second(source); return a === null || b === null ? null : a - b;
    };
    signals.sma_cross = crossSignal(averageDifference(a => sma(a, 5), a => sma(a, 20), values), averageDifference(a => sma(a, 5), a => sma(a, 20), previousValues));
    signals.ema_cross = crossSignal(averageDifference(a => ema(a, 12), a => ema(a, 26), values), averageDifference(a => ema(a, 12), a => ema(a, 26), previousValues));
    const average50 = sma(values, 50), distance50 = average50 ? last(values) / average50 - 1 : 0;
    signals.sma50 = Math.abs(distance50) > 0.05 ? direction(distance50) * 0.8 : direction(distance50) * 0.3;
    const hist = macdSeries(values).hist.map(point => point.value);
    signals.macd = hist.length < 2 ? 0 : crossSignal(last(hist), hist[hist.length - 2]);
    signals.rsi = recoverySignal(rsiValues(values), 30, 70, priceDirection);
    signals.stoch_rsi = recoverySignal(stochValues(values), 20, 80, priceDirection);
    const roc = values.length > 10 ? (last(values) / values[values.length - 11] - 1) * 100 : 0;
    signals.roc = direction(roc) * (Math.abs(roc) > 10 ? 1 : Math.abs(roc) > 5 ? 0.5 : Math.abs(roc) > 2 ? 0.2 : 0);
    signals.williams = recoverySignal(williamsRSeries(data).map(point => point.value), -80, -20, priceDirection);
    const bands = Array.from({ length: Math.min(4, values.length) }, (_, i) => bbPct(values.slice(0, values.length - Math.min(4, values.length) + i + 1)));
    signals.bb = recoverySignal(bands, 0.15, 0.85, priceDirection);
    // Volatility measures risk, not a bullish/bearish vote. Keep the legacy id.
    signals.atr = 0;
    const balance = volumeBalance(data);
    signals.obv = direction(balance) * (Math.abs(balance) > 0.2 ? 0.7 : Math.abs(balance) > 0.05 ? 0.3 : 0);
    const averageVolume = data.length >= 21 ? mean(data.slice(-21, -1).map(volumeOf)) : 0;
    const ratio = averageVolume > 0 ? volumeOf(last(data)) / averageVolume : 0;
    signals.vol_avg = priceDirection * (ratio > 1.5 ? 1 : ratio > 1.2 ? 0.5 : 0);
    signals.candle = candleSignal(data);
    const gap = data.length > 1 ? (last(data).open / data[data.length - 2].close - 1) * 100 : 0;
    signals.gap = direction(gap) * (Math.abs(gap) > 2 ? 0.8 : Math.abs(gap) > 0.5 ? 0.3 : 0);
    return signals;
  }
  function computeScore(signals, indicators = DEFAULT_INDICATORS) {
    let weighted = 0, total = 0;
    indicators.forEach(indicator => {
      if (!Number.isFinite(indicator.weight) || indicator.weight <= 0) return;
      weighted += (Number.isFinite(signals[indicator.id]) ? signals[indicator.id] : 0) * indicator.weight;
      total += indicator.weight;
    });
    return total === 0 ? 50 : score((weighted / total + 1) / 2 * 100);
  }

  function classify(analysis) {
    if (analysis.stale) return "WAIT";
    if (!Number.isFinite(analysis.trendScore) || !Number.isFinite(analysis.entryScore) || !Number.isFinite(analysis.exitScore)) return "WAIT";
    const { trendScore, entryScore, exitScore, components, metrics } = analysis;
    const bullish = trendScore >= THRESHOLDS.bullishTrend && components.momentum >= THRESHOLDS.momentum && metrics.priceDirection > 0;
    const bearish = trendScore <= THRESHOLDS.bearishTrend && components.exitMomentum >= THRESHOLDS.momentum && metrics.priceDirection < 0;
    const acceptableEntry = metrics.distanceAtr <= THRESHOLDS.maxEntryExtensionAtr && metrics.distanceAtr >= THRESHOLDS.minEntryDistanceAtr;
    if (bullish && acceptableEntry && entryScore >= THRESHOLDS.buy) {
      return !analysis.provisional && trendScore >= THRESHOLDS.strongBullishTrend && entryScore >= THRESHOLDS.strongBuy &&
        components.momentum >= THRESHOLDS.strongMomentum && metrics.bullVolumeConfirmed ? "STRONG_BUY" : "BUY";
    }
    if (bearish && exitScore >= THRESHOLDS.sell) {
      return !analysis.provisional && trendScore <= THRESHOLDS.strongBearishTrend && exitScore >= THRESHOLDS.strongSell &&
        components.exitMomentum >= THRESHOLDS.strongMomentum && metrics.bearVolumeConfirmed ? "STRONG_SELL" : "SELL";
    }
    return "HOLD";
  }

  function analyze(data, options = {}) {
    const minimum = Math.max(50, Number.isFinite(options.minSignalDays) ? Math.floor(options.minSignalDays) : 50);
    const provisional = Boolean(options.provisional), stale = Boolean(options.stale);
    const valid = Array.isArray(data) && Array.from(data).every(bar => bar && [bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0) &&
      bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close));
    if (!valid || data.length < minimum) return { version: VERSION, trendScore: null, trendLabel: "WAIT", entryScore: null, exitScore: null,
      signal: "WAIT", components: {}, metrics: {}, provisional, stale, reasons: [valid ? "At least " + minimum + " valid daily sessions are required." : "Invalid OHLC data; no signal calculated."] };

    const values = data.map(bar => bar.close), current = last(values), previous = values[values.length - 2];
    const atr = last(atrValues(data)), unit = Math.max(atr, current * 0.001);
    const sma5 = sma(values, 5), sma20 = sma(values, 20), sma50 = sma(values, 50), ema20 = ema(values, 20);
    // Correlated moving averages form ONE structure component. No vote count
    // or confidence claim treats them as independent confirmations.
    const structure = mean([direction(sma5 - sma20), direction(ema(values, 12) - ema(values, 26)), direction(current - sma50)]);
    const slope = clamp((sma20 - sma(values.slice(0, -5), 20)) / (unit * 1.5));
    const trendScore = score(50 + 50 * (structure * 0.7 + slope * 0.3));
    const rsi = rsiValues(values), hist = macdSeries(values).hist.map(point => point.value);
    const momentum = clamp(0.35 * clamp((last(rsi) - rsi[rsi.length - 4]) / 10) +
      0.35 * clamp((last(hist) - hist[hist.length - 4]) / (unit * 0.2)) +
      0.3 * clamp((current - values[values.length - 4]) / (unit * 1.5)));
    const distanceAtr = (current - ema20) / unit;
    const position = score(100 - Math.abs(distanceAtr - 0.25) * 25);
    // Exit position measures deterioration below support; it is not the inverse
    // of entry quality (an extended bullish stock is not automatically a sell).
    const exitPosition = score(50 - distanceAtr * 25);
    const averageVolume = mean(data.slice(-21, -1).map(volumeOf));
    const relativeVolume = averageVolume > 0 ? volumeOf(last(data)) / averageVolume : null;
    const priceDirection = direction(current - previous), balance = volumeBalance(data);
    const volumeDirection = relativeVolume === null ? 0 : 0.5 * balance + 0.5 * priceDirection * clamp((relativeVolume - 0.6) / 0.9, 0, 1);
    const components = { momentum: score(50 + 50 * momentum), position, volume: score(50 + 50 * volumeDirection),
      exitMomentum: score(50 - 50 * momentum), exitPosition, exitVolume: score(50 - 50 * volumeDirection) };
    let entryScore = score(components.momentum * 0.5 + position * 0.3 + components.volume * 0.2);
    let exitScore = score(components.exitMomentum * 0.5 + exitPosition * 0.3 + components.exitVolume * 0.2);
    // Missing momentum confirmation cannot be offset by an attractive location.
    if (components.momentum < THRESHOLDS.momentum || priceDirection <= 0 || trendScore < THRESHOLDS.bullishTrend) entryScore = Math.min(49, entryScore);
    if (distanceAtr > THRESHOLDS.maxEntryExtensionAtr || distanceAtr < THRESHOLDS.minEntryDistanceAtr) entryScore = Math.min(49, entryScore);
    if (components.exitMomentum < THRESHOLDS.momentum || priceDirection >= 0 || trendScore > THRESHOLDS.bearishTrend) exitScore = Math.min(49, exitScore);
    const bullVolumeConfirmed = priceDirection > 0 && relativeVolume >= THRESHOLDS.confirmedRelativeVolume && components.volume >= 65;
    const bearVolumeConfirmed = priceDirection < 0 && relativeVolume >= THRESHOLDS.confirmedRelativeVolume && components.exitVolume >= 65;
    const analysis = { version: VERSION, trendScore, trendLabel: trendScore >= 55 ? "BULLISH" : trendScore <= 45 ? "BEARISH" : "NEUTRAL",
      entryScore, exitScore, components, metrics: { rsi: last(rsi), stochRsi: last(stochValues(values)), atr, atrPct: atr / current * 100,
        relativeVolume, distanceAtr, priceDirection, volumeBalance: balance, bullVolumeConfirmed, bearVolumeConfirmed }, provisional, stale, reasons: [] };
    analysis.signal = classify(analysis);
    analysis.reasons.push(analysis.trendLabel === "BULLISH" ? "Bullish trend; moving averages are evaluated as one group." :
      analysis.trendLabel === "BEARISH" ? "Bearish trend; oversold readings alone do not confirm an entry." : "Mixed or flat trend.");
    analysis.reasons.push(components.momentum >= 55 && priceDirection > 0 ? "Price and momentum support an entry." : "Entry awaits price and momentum recovery.");
    if (distanceAtr > 3) analysis.reasons.push("Price is more than 3 ATR above EMA20; entry is extended.");
    else if (distanceAtr < -1.5) analysis.reasons.push("Price is more than 1.5 ATR below EMA20; entry lacks support.");
    if (bullVolumeConfirmed) analysis.reasons.push("Above-average volume confirms the upward move.");
    else if (bearVolumeConfirmed) analysis.reasons.push("Above-average volume confirms the downward move.");
    else analysis.reasons.push(relativeVolume === null ? "Volume confirmation is unavailable." : "No strong directional volume confirmation.");
    if (analysis.signal.includes("SELL")) analysis.reasons.push("Weak trend, falling price and deteriorating momentum support an exit signal.");
    if (provisional) analysis.reasons.push("Unfinished session: strong signals require a confirmed daily candle.");
    if (stale) analysis.reasons.push("Last confirmed close is out of date; wait for current data.");
    return analysis;
  }

  return { VERSION, DEFAULT_INDICATORS, THRESHOLDS, computeSignals, computeScore, analyze, classify,
    sma, ema, rsiCalc, rsiSeries, macdSeries, stochRsiSeries, bollingerSeries, bbPct, williamsRSeries,
    atrSeries, obvSeries, rocSeries, volumeBalance };
});
