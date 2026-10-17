// Shared, read-only data client for the scanner and ticker charts.
// Confirmed daily history and today's explicitly provisional quote stay separate.
"use strict";

let _universePromise;
const _marketHistoryCache = new Map();
let _recentMarketQuotes = [];
const _marketHistoryCacheMs = 60 * 60 * 1000;

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
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { today: values.year + "-" + values.month + "-" + values.day, hour: Number(values.hour), minute: Number(values.minute) };
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
  // Supabase decides finality, including reduced sessions. A browser clock must
  // never demote an already confirmed close or promote an unconfirmed row.
  if (row.is_final !== true) return { reason: row.is_final === false ? "provisional" : "invalid" };
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

async function _fetchFinalHistory(ticker, universe, onProgress) {
  const headers = _publicReadHeaders();
  const rows = [];
  let cursor = null;
  let finished = false;
  for (let page = 0; page < MARKET_SETTINGS.maxPages; page++) {
    const params = new URLSearchParams({
      select: "fecha,ticker,open,high,low,close,volumen,is_final",
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
  return rows;
}

async function fetchLatestQuotes(ticker = null, universe = null) {
  universe = universe || await loadMarketUniverse();
  const params = new URLSearchParams({
    select: "ticker,fecha,open,high,low,close,volumen,is_final,status,source,source_quote_at,fetched_at,previous_close,datadelay_minutes",
    order: "ticker.asc", limit: String(MARKET_SETTINGS.expectedInstruments)
  });
  params.set("ticker", ticker ? "eq." + normalizeTicker(ticker) : "in.(" + [...universe.byTicker.keys()].join(",") + ")");
  const rows = await _requestJson(SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/market_latest_quotes?" + params,
    { headers: _publicReadHeaders(), cache: "no-store" });
  if (!Array.isArray(rows)) throw new Error("Invalid recent quote response from Supabase.");
  return rows;
}

function _quoteFreshnessReference(now, clock, timing) {
  const minute = clock.hour * 60 + clock.minute;
  if (!timing || minute < timing.closes) return now.getTime();
  // After the session, freshness refers to its actual close. Subtracting New
  // York minutes from the current UTC minute also handles daylight saving time
  // and the calendar's early closes without assuming a fixed UTC offset.
  return Math.floor(now.getTime() / 60000) * 60000 - (minute - timing.closes) * 60000;
}

function mergeRecentMarketQuotes(base, quotes, includeRecent = true, now = new Date()) {
  const clock = _newYorkClock(now), allowed = new Set(base.coverage.map(item => item.ticker));
  const finalByTicker = new Map();
  base.data.forEach(row => { if (!finalByTicker.has(row[1])) finalByTicker.set(row[1], []); finalByTicker.get(row[1]).push(row); });
  const quoteByTicker = new Map(), stale = new Set(), invalid = new Set();
  quotes.forEach(quote => {
    if (!quote || !allowed.has(quote.ticker)) return;
    if (!['FINAL', 'PROVISIONAL'].includes(quote.status) || !['yahoo', 'googlefinance'].includes(quote.source) ||
        typeof quote.is_final !== 'boolean' || (quote.status === 'FINAL') !== quote.is_final ||
        (quote.source === 'googlefinance' && quote.is_final)) { invalid.add(quote.ticker); return; }
    // A previous day's quote is useful provenance, never today's extra candle.
    const normalized = _normalizeBar({ ...quote, is_final: true }, allowed, clock);
    const sourceTime = Date.parse(quote.source_quote_at), fetchedTime = Date.parse(quote.fetched_at);
    const delay = quote.datadelay_minutes === null ? null : _number(quote.datadelay_minutes);
    const validDelay = Number.isInteger(delay) && delay >= 0 && delay <= 20;
    if (!normalized.bar || !Number.isFinite(sourceTime) || !Number.isFinite(fetchedTime) ||
        sourceTime > now.getTime() + 120000 || fetchedTime > now.getTime() + 120000 ||
        !(validDelay || (quote.source === 'yahoo' && delay === null)) ||
        _newYorkClock(new Date(sourceTime)).today !== quote.fecha) { invalid.add(quote.ticker); return; }
    const timing = marketSessionTiming(clock.today), minute = clock.hour * 60 + clock.minute;
    const maxAge = (quote.source === 'googlefinance' ? Math.min(30, delay + 10) : 30) * 60000;
    const freshnessReference = _quoteFreshnessReference(now, clock, timing);
    const outdated = !quote.is_final && (freshnessReference - sourceTime > maxAge || freshnessReference - fetchedTime > maxAge);
    if (quote.fecha !== clock.today || (timing && minute < timing.opens)) {
      if (!quote.is_final) stale.add(quote.ticker);
      return;
    }
    // The server validates freshness at ingestion. Later reads keep today's last
    // approved quote visible and identify its age, rather than reverting prices.
    if(outdated)stale.add(quote.ticker);
    const prior = quoteByTicker.get(quote.ticker);
    if (!prior || sourceTime >= Date.parse(prior.source_quote_at)) quoteByTicker.set(quote.ticker, { ...quote, outdated, bar: normalized.bar });
  });
  const provisionalTickers = [], finalRows = [], data = [], incompatible = [];
  allowed.forEach(ticker => {
    let finals = [...(finalByTicker.get(ticker) || [])];
    let quote = quoteByTicker.get(ticker);
    const last = finals[finals.length - 1];
    const previousFinal = quote ? finals.filter(row => row[0] < quote.fecha).at(-1) : null;
    if (quote && !quote.is_final && previousFinal && (!last || quote.fecha > last[0])) {
      const canonicalPrevious = _number(quote.previous_close);
      if (!Number.isFinite(canonicalPrevious) || canonicalPrevious <= 0 ||
          Math.abs(canonicalPrevious - previousFinal[5]) > Math.max(0.02, Math.abs(canonicalPrevious) * 0.005)) {
        // A split/rebuild may change historical scale while the tab's cache is
        // still valid by age. Never join that cache to a different price scale.
        incompatible.push(ticker); quoteByTicker.delete(ticker); quote = null;
      }
    }
    // Same-day confirmed history always wins, even if a quote was fetched later.
    if (quote && quote.is_final && (!last || quote.fecha > last[0])) finals.push(quote.bar);
    finals = finals.slice(-MARKET_SETTINGS.historyDays);
    finalRows.push(...finals); data.push(...finals);
    const lastFinal = finals[finals.length - 1];
    if (quote && !quote.is_final && lastFinal && quote.fecha <= lastFinal[0]) quoteByTicker.delete(ticker);
    if (includeRecent && quote && !quote.is_final && (!lastFinal || quote.fecha > lastFinal[0])) {
      data.push(quote.bar); provisionalTickers.push(ticker);
    }
  });
  // Coverage and freshness refer to confirmed history, independently of preview.
  const finalResult = normalizeMarketRows(finalRows.map(row => ({fecha:row[0],ticker:row[1],open:row[2],high:row[3],low:row[4],close:row[5],volumen:row[6],is_final:true})), base.universe, base.ticker || null, now);
  const latestBarDate = data.reduce((latest, row) => row[0] > latest ? row[0] : latest, "") || null;
  const timing = marketSessionTiming(clock.today);
  const expectsToday = includeRecent && timing && clock.hour * 60 + clock.minute >= timing.opens;
  const confirmedToday = new Set(finalRows.filter(row => row[0] === clock.today).map(row => row[1]));
  const missingRecentTickers = expectsToday ? [...allowed].filter(ticker => !quoteByTicker.has(ticker) &&
    !confirmedToday.has(ticker)) : [];
  return { ...finalResult, data, total: data.length, finalizedData: finalRows, ticker: base.ticker || null,
    latestBarDate, quoteByTicker, includeRecent, provisionalTickers,
    quoteRows: quotes, quality: { ...finalResult.quality, invalidRows: base.quality.invalidRows,
      provisionalRows: base.quality.provisionalRows, duplicateRows: base.quality.duplicateRows,
      outsideUniverseRows: base.quality.outsideUniverseRows,
      provisionalTickers, staleRecentTickers: [...stale],
      invalidRecentTickers: [...invalid], incompatibleRecentTickers: incompatible,
      missingRecentTickers, acceptedRecentQuotes: quoteByTicker.size }, historyLoadedAt: base.historyLoadedAt };
}

async function fetchMarketData(ticker = null, onProgress = null, options = {}) {
  const universe = await loadMarketUniverse();
  ticker = ticker ? normalizeTicker(ticker) : null;
  if (ticker && !universe.byTicker.has(ticker)) throw new Error("Ticker is outside the selected market universe.");
  const now = options.now || new Date(), key = ticker || '*', expected = lastCompletedMarketSession(_newYorkClock(now));
  let cached = _marketHistoryCache.get(key) || (ticker ? _marketHistoryCache.get('*') : null);
  if (options.forceHistory || !cached || now.getTime() - cached.loadedAt > _marketHistoryCacheMs || cached.expected !== expected) cached = null;
  const historyPromise = cached ? Promise.resolve(cached) : _fetchFinalHistory(ticker, universe, onProgress).then(rows => {
    const value = { rows, loadedAt: now.getTime(), expected, cacheKey: key };
    _marketHistoryCache.set(key, value); return value;
  });
  let recentError = null;
  const quotesPromise = options.refreshQuotes === false ? Promise.resolve(_recentMarketQuotes.filter(row => !ticker || row.ticker === ticker)) :
    fetchLatestQuotes(ticker, universe).then(rows => {
      _recentMarketQuotes = ticker ? _recentMarketQuotes.filter(row => row.ticker !== ticker).concat(rows) : rows;
      return rows;
    }).catch(error => {
      recentError = error.message;
      return _recentMarketQuotes.filter(row => !ticker || row.ticker === ticker);
    });
  let [history, quotes] = await Promise.all([historyPromise, quotesPromise]);
  let rows = ticker ? history.rows.filter(row => row.ticker === ticker) : history.rows;
  let base = { ...normalizeMarketRows(rows, universe, ticker, now), ticker, historyLoadedAt: new Date(history.loadedAt).toISOString() };
  let result = mergeRecentMarketQuotes(base, quotes, options.includeRecent !== false, now);
  if (options.includeRecent !== false && result.quality.incompatibleRecentTickers.length) {
    // Refresh the same scope as the stale cache, once. Clear ticker references
    // too, so another view cannot borrow an older version of the repaired series.
    const reloadTicker = history.cacheKey === '*' ? null : ticker;
    _marketHistoryCache.clear();
    const freshRows = await _fetchFinalHistory(reloadTicker, universe, onProgress);
    history = { rows: freshRows, loadedAt: now.getTime(), expected, cacheKey: reloadTicker || '*' };
    _marketHistoryCache.set(history.cacheKey, history);
    rows = ticker ? freshRows.filter(row => row.ticker === ticker) : freshRows;
    base = { ...normalizeMarketRows(rows, universe, ticker, now), ticker, historyLoadedAt: new Date(history.loadedAt).toISOString() };
    result = mergeRecentMarketQuotes(base, quotes, options.includeRecent !== false, now);
    result.quality.historyReloadedForQuote = true;
  }
  // Keep newly confirmed rows between fast refreshes without reloading all history.
  const knownKeys = new Set(rows.map(row => row.ticker + '|' + row.fecha));
  const newFinals = result.finalizedData.filter(row => !knownKeys.has(row[1] + '|' + row[0]));
  if (newFinals.length) {
    const promoted = newFinals.map(row => ({fecha:row[0],ticker:row[1],open:row[2],high:row[3],low:row[4],close:row[5],volumen:row[6],is_final:true}));
    const changed = new Set(promoted.map(row => row.ticker));
    const retained = new Set(result.finalizedData.map(row => row[1] + '|' + row[0]));
    history.rows = history.rows.filter(row => !changed.has(row.ticker) || retained.has(row.ticker + '|' + row.fecha)).concat(promoted);
  }
  result.quality.recentError = recentError;
  return result;
}

function marketQuoteLabel(quote) {
  if (!quote) return "Confirmed daily close";
  const source = quote.source === 'googlefinance' ? 'Google Finance' : 'Yahoo Finance';
  const time = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(quote.source_quote_at));
  return (quote.is_final ? 'Confirmed daily close' : 'Provisional daily candle') + (quote.outdated&&!quote.is_final?' · OUTDATED':'') + ' · ' + source + ' · ' + time + ' New York' +
    (quote.source === 'googlefinance' ? ' · quotes may be delayed up to 20 min' :
      quote.datadelay_minutes === null ? ' · source delay unavailable' : ' · source delay ' + quote.datadelay_minutes + ' min');
}

function marketQualityMessages(result) {
  const quality = result.quality;
  const messages = [];
  if (quality.missingTickers.length) messages.push(quality.missingTickers.length + " instruments await historical data");
  if (quality.shortHistories.length) messages.push(quality.shortHistories.length + " histories have fewer than " + MARKET_SETTINGS.historyDays + " sessions");
  if (quality.insufficientSignals.length) messages.push(quality.insufficientSignals.length + " have too few sessions for signals");
  if (quality.laggingTickers.length) messages.push(quality.laggingTickers.length + " histories await the expected close of " + quality.expectedDate);
  if (quality.invalidRows) messages.push(quality.invalidRows + " invalid OHLCV rows excluded");
  if (quality.provisionalRows) messages.push(quality.provisionalRows + " unconfirmed historical rows excluded");
  if (quality.provisionalTickers && quality.provisionalTickers.length) messages.push(quality.provisionalTickers.length + " instruments include today's provisional daily candle in prices, charts and signals");
  if (quality.staleRecentTickers && quality.staleRecentTickers.length) messages.push(quality.staleRecentTickers.length + " recent quotes are outdated; today's last approved values keep their source timestamps");
  if (quality.invalidRecentTickers && quality.invalidRecentTickers.length) messages.push(quality.invalidRecentTickers.length + " recent quotes unavailable or rejected; confirmed history retained");
  if (quality.incompatibleRecentTickers && quality.incompatibleRecentTickers.length) messages.push(quality.incompatibleRecentTickers.length + " recent quotes await a compatible historical series; confirmed closes shown");
  if (quality.missingRecentTickers && quality.missingRecentTickers.length) messages.push(quality.missingRecentTickers.length + " instruments await an accepted quote for today; confirmed history retained");
  if (quality.recentError) messages.push("Recent quotes could not be refreshed; last available accepted data shown with its original source time");
  if (quality.duplicateRows) messages.push(quality.duplicateRows + " duplicate rows consolidated");
  if (quality.oldLatestDate) messages.push("latest stored close is over 5 calendar days old; check synchronization");
  return messages;
}

function tickerBars(result, ticker) {
  return result.data.filter(row => row[1] === ticker).map(row => ({
    date: row[0], open: row[2], high: row[3], low: row[4], close: row[5], vol: row[6]
  }));
}
