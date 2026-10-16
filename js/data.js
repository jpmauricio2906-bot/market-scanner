// Shared, read-only data client for the scanner and ticker charts.
// The database contract is one finalized OHLCV row per (ticker, fecha).
"use strict";

let _universePromise;

function normalizeTicker(value) {
  const ticker = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker)) throw new Error("Invalid ticker.");
  return ticker;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

async function _requestJson(url, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        const detail = typeof response.json === "function" ? await response.json().catch(() => null) : null;
        if (detail && /is_final/.test(String(detail.message || "") + String(detail.details || ""))) {
          throw new Error("Run the Supabase migration (supabase/001_market_history.sql) before loading finalized data.");
        }
        throw new Error("Data request failed (HTTP " + response.status + ").");
      }
      return await response.json();
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Data request timed out. Please retry.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function loadMarketUniverse() {
  if (!_universePromise) {
    _universePromise = (async () => {
      const universe = await _requestJson(MARKET_SETTINGS.universeUrl, { cache: "no-cache" });
      if (!Array.isArray(universe.companies) || universe.companies.length !== MARKET_SETTINGS.expectedCompanies) {
        throw new Error("The company universe must contain " + MARKET_SETTINGS.expectedCompanies + " companies.");
      }
      if (!Array.isArray(universe.etfs) || universe.etfs.length !== MARKET_SETTINGS.expectedETFs) {
        throw new Error("The ETF universe must contain " + MARKET_SETTINGS.expectedETFs + " ETFs.");
      }
      if (!Array.isArray(universe.instruments) || universe.instruments.length !== MARKET_SETTINGS.expectedInstruments) {
        throw new Error("The market universe must contain " + MARKET_SETTINGS.expectedInstruments + " instruments.");
      }
      const stockTickers = new Set(universe.companies.map(company => normalizeTicker(company.ticker)));
      const etfTickers = new Set(universe.etfs.map(etf => normalizeTicker(etf.ticker)));
      if (stockTickers.size !== universe.companies.length || etfTickers.size !== universe.etfs.length ||
          [...stockTickers].some(ticker => etfTickers.has(ticker))) throw new Error("Duplicate ticker in market universe.");
      const byTicker = new Map();
      universe.instruments.forEach(instrument => {
        const ticker = normalizeTicker(instrument.ticker);
        if (byTicker.has(ticker) || !instrument.name ||
            !(instrument.type === "STOCK" && stockTickers.has(ticker) || instrument.type === "ETF" && etfTickers.has(ticker))) {
          throw new Error("Invalid or duplicate instrument in universe.");
        }
        if (instrument.type === "ETF" && (
            !instrument.category || !instrument.issuer || !/^https:\/\//.test(instrument.sourceUrl || "") ||
            !Number.isFinite(instrument.dailyLeverage) || instrument.dailyLeverage === 0 ||
            typeof instrument.inverse !== "boolean" || instrument.inverse !== (instrument.dailyLeverage < 0) ||
            (instrument.dailyLeverage !== 1 ? instrument.resetPeriod !== "daily" : instrument.resetPeriod !== null))) {
          throw new Error("Invalid ETF metadata for " + ticker + ".");
        }
        byTicker.set(ticker, { ...instrument, ticker });
      });
      return { ...universe, byTicker };
    })().catch(error => { _universePromise = null; throw error; });
  }
  return _universePromise;
}

function instrumentTypeLabel(instrument) {
  if (instrument.type !== "ETF") return "Stock";
  if (instrument.dailyLeverage === 1) return "ETF";
  const leverage = instrument.dailyLeverage;
  return "ETF · " + (leverage > 0 ? "+" : "−") + Math.abs(leverage) + "× daily" + (instrument.inverse ? " · inverse" : "");
}

function instrumentDescription(instrument) {
  return [instrument.name, instrumentTypeLabel(instrument), instrument.issuer, instrument.category, instrument.exchange]
    .filter(Boolean).join(" · ");
}

function _publicReadHeaders() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Configure Supabase in js/config.js.");
  if (!/^https:\/\//.test(SUPABASE_URL)) throw new Error("The Supabase URL must use HTTPS.");
  if (SUPABASE_KEY.startsWith("sb_publishable_")) return { apikey: SUPABASE_KEY };
  // Legacy JWT anon keys are supported during migration. Elevated keys are refused.
  try {
    const segment = SUPABASE_KEY.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    if (JSON.parse(atob(segment)).role === "anon") {
      return { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY };
    }
  } catch (_) { /* Report a safe error below, without exposing the key. */ }
  throw new Error("The browser requires a Supabase publishable key (or legacy anon key).");
}

function _newYorkClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { today: values.year + "-" + values.month + "-" + values.day, hour: Number(values.hour) };
}

function _validSessionDate(value) {
  return isMarketSession(value);
}

function _number(value) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim()) || typeof value === "boolean") return NaN;
  return Number(value);
}

function _normalizeBar(row, allowedTickers, clock) {
  if (!row || typeof row !== "object" || !_validSessionDate(row.fecha)) return { reason: "invalid" };
  let ticker;
  try { ticker = normalizeTicker(row.ticker); } catch (_) { return { reason: "invalid" }; }
  if (!allowedTickers.has(ticker)) return { reason: "outsideUniverse" };
  if (row.fecha > clock.today) return { reason: "invalid" };
  // The original pipeline stored intraday snapshots in market_history. Do not
  // label today's legacy snapshot a finalized close before the closing buffer.
  if (row.fecha === clock.today && clock.hour < 17) return { reason: "provisional" };
  const values = [row.open, row.high, row.low, row.close, row.volumen].map(_number);
  const [open, high, low, close, volume] = values;
  if (!values.every(Number.isFinite) || Math.min(open, high, low, close) <= 0 ||
      high < Math.max(open, close) || low > Math.min(open, close) || high < low ||
      !Number.isSafeInteger(volume) || volume < 0) return { reason: "invalid" };
  return { bar: [row.fecha, ticker, open, high, low, close, volume] };
}

function normalizeMarketRows(rows, universe, ticker = null, now = new Date()) {
  const allowed = ticker ? new Set([ticker]) : new Set(universe.byTicker.keys());
  const clock = _newYorkClock(now);
  const expectedDate = lastCompletedMarketSession(clock);
  const byKey = new Map();
  const quality = { invalidRows: 0, provisionalRows: 0, outsideUniverseRows: 0, duplicateRows: 0 };
  rows.forEach(row => {
    const normalized = _normalizeBar(row, allowed, clock);
    if (!normalized.bar) {
      quality[normalized.reason === "provisional" ? "provisionalRows" :
        normalized.reason === "outsideUniverse" ? "outsideUniverseRows" : "invalidRows"]++;
      return;
    }
    const bar = normalized.bar;
    const key = bar[1] + "|" + bar[0];
    if (byKey.has(key)) quality.duplicateRows++;
    byKey.set(key, bar);
  });
  const byTicker = new Map();
  [...byKey.values()].forEach(bar => {
    if (!byTicker.has(bar[1])) byTicker.set(bar[1], []);
    byTicker.get(bar[1]).push(bar);
  });
  const data = [];
  const coverage = [];
  allowed.forEach(symbol => {
    const bars = (byTicker.get(symbol) || []).sort((a, b) => a[0].localeCompare(b[0])).slice(-MARKET_SETTINGS.historyDays);
    data.push(...bars);
    coverage.push({ ticker: symbol, days: bars.length, lastDate: bars.length ? bars[bars.length - 1][0] : null });
  });
  const latestDate = coverage.reduce((latest, item) => item.lastDate && item.lastDate > latest ? item.lastDate : latest, "") || null;
  quality.missingTickers = coverage.filter(item => !item.days).map(item => item.ticker);
  quality.shortHistories = coverage.filter(item => item.days && item.days < MARKET_SETTINGS.historyDays).map(item => item.ticker);
  quality.insufficientSignals = coverage.filter(item => item.days && item.days < MARKET_SETTINGS.minSignalDays).map(item => item.ticker);
  quality.expectedDate = expectedDate;
  quality.laggingTickers = coverage.filter(item => item.lastDate && item.lastDate < expectedDate).map(item => item.ticker);
  quality.oldLatestDate = latestDate ? (Date.parse(clock.today) - Date.parse(latestDate)) / 86400000 > 5 : false;
  return { data, total: data.length, source: "supabase", latestDate, coverage, quality, universe };
}

async function fetchMarketData(ticker = null, onProgress = null) {
  const universe = await loadMarketUniverse();
  ticker = ticker ? normalizeTicker(ticker) : null;
  if (ticker && !universe.byTicker.has(ticker)) throw new Error("Ticker is outside the selected market universe.");
  const headers = _publicReadHeaders();
  const rows = [];
  let cursor = null;
  let finished = false;
  for (let page = 0; page < MARKET_SETTINGS.maxPages; page++) {
    const params = new URLSearchParams({
      select: "fecha,ticker,open,high,low,close,volumen",
      order: "ticker.asc,fecha.asc", limit: String(MARKET_SETTINGS.pageSize),
      is_final: "eq.true"
    });
    params.set("ticker", ticker ? "eq." + ticker : "in.(" + [...universe.byTicker.keys()].join(",") + ")");
    if (cursor) {
      if (ticker) params.set("fecha", "gt." + cursor.fecha);
      else params.set("or", "(ticker.gt." + cursor.ticker + ",and(ticker.eq." + cursor.ticker + ",fecha.gt." + cursor.fecha + "))");
    }
    const url = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/" + encodeURIComponent(SUPABASE_TABLE) + "?" + params;
    const batch = await _requestJson(url, { headers, cache: "no-store" });
    if (!Array.isArray(batch)) throw new Error("Invalid response from Supabase.");
    if (!batch.length) { finished = true; break; }
    // Keyset pagination remains correct when the API caps a page below our limit.
    // Always request the next page until it is empty; a short page is not proof
    // that the history is complete.
    const last = batch[batch.length - 1];
    const lastTicker = normalizeTicker(last.ticker);
    if (last.ticker !== lastTicker || !/^\d{4}-\d{2}-\d{2}$/.test(last.fecha) ||
        (cursor && (lastTicker < cursor.ticker || (lastTicker === cursor.ticker && last.fecha <= cursor.fecha)))) {
      throw new Error("Supabase pagination did not advance. Check the ticker/date ordering.");
    }
    rows.push(...batch);
    cursor = { ticker: lastTicker, fecha: last.fecha };
    if (onProgress) onProgress(rows.length);
  }
  if (!finished) throw new Error("History exceeds the pagination safety limit. Check data retention.");
  return normalizeMarketRows(rows, universe, ticker);
}

function marketQualityMessages(result) {
  const quality = result.quality;
  const messages = [];
  if (quality.missingTickers.length) messages.push(quality.missingTickers.length + " instruments await historical data");
  if (quality.shortHistories.length) messages.push(quality.shortHistories.length + " histories have fewer than " + MARKET_SETTINGS.historyDays + " sessions");
  if (quality.insufficientSignals.length) messages.push(quality.insufficientSignals.length + " have too few sessions for signals");
  if (quality.laggingTickers.length) messages.push(quality.laggingTickers.length + " histories await the expected close of " + quality.expectedDate);
  if (quality.invalidRows) messages.push(quality.invalidRows + " invalid OHLCV rows excluded");
  if (quality.provisionalRows) messages.push(quality.provisionalRows + " provisional rows excluded before 17:00 New York");
  if (quality.duplicateRows) messages.push(quality.duplicateRows + " duplicate rows consolidated");
  if (quality.oldLatestDate) messages.push("latest stored close is over 5 calendar days old; check synchronization");
  return messages;
}

function tickerBars(result, ticker) {
  return result.data.filter(row => row[1] === ticker).map(row => ({
    date: row[0], open: row[2], high: row[3], low: row[4], close: row[5], vol: row[6]
  }));
}
