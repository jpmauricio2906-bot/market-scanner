const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const clientSource = fs.readFileSync(path.join(root, "js/data.js"), "utf8");
const calendarSource = fs.readFileSync(path.join(root, "js/market-calendar.js"), "utf8");
const calendar = vm.createContext({});
vm.runInContext(calendarSource + "\nglobalThis.calendarSession = isMarketSession;", calendar);

function etf(ticker, overrides = {}) {
  return { ticker, name: ticker + " Fund", type: "ETF", exchange: "NASDAQ", issuer: "Test issuer", category: "US equity",
    dailyLeverage: 1, inverse: false, resetPeriod: null, sourceUrl: "https://example.com/" + ticker, ...overrides };
}

function companies(tickers, etfs = []) {
  const stocks = tickers.map(ticker => ({ ticker, name: ticker + " Company", exchange: "NYSE" }));
  return { asOf: "2026-10-15", companies: stocks, etfs, instruments: [...stocks.map(stock => ({ ...stock, type: "STOCK" })), ...etfs] };
}

function makeClient({ tickers = ["AAPL", "BRK-B", "JPM"], etfs = [], fetch, key = "sb_publishable_test", maxPages = 2000 } = {}) {
  const context = vm.createContext({
    fetch, URLSearchParams, AbortController, setTimeout, clearTimeout, Intl, atob,
    SUPABASE_URL: "https://example.supabase.co", SUPABASE_KEY: key, SUPABASE_TABLE: "market_history",
    MARKET_SETTINGS: { universeUrl: "data/universe.json", expectedCompanies: tickers.length, expectedETFs: etfs.length,
      expectedInstruments: tickers.length + etfs.length, historyDays: 500, minSignalDays: 50, pageSize: 1000, maxPages }
  });
  vm.runInContext(calendarSource + "\n" + clientSource + "\nglobalThis.client = { fetchMarketData, loadMarketUniverse, normalizeMarketRows, marketQualityMessages, tickerBars, normalizeTicker, escapeHtml, instrumentTypeLabel, instrumentDescription, _publicReadHeaders, _newYorkClock };", context);
  return context.client;
}

function universe(tickers = ["AAPL", "BRK-B", "JPM"], etfs = []) {
  const source = companies(tickers, etfs);
  return { ...source, byTicker: new Map(source.instruments.map(instrument => [instrument.ticker, instrument])) };
}

function bar(ticker = "AAPL", fecha = "2026-10-14", overrides = {}) {
  return { ticker, fecha, open: 100, high: 105, low: 98, close: 103, volumen: 1000000, ...overrides };
}

function sessionDates(count) {
  const result = [];
  const date = new Date("2026-10-14T12:00:00Z");
  while (result.length < count) {
    if (calendar.calendarSession(date.toISOString().slice(0, 10))) result.unshift(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return result;
}

function pagedFetch(tickers, rows, cap = 1000, etfs = []) {
  const requests = [];
  const request = async (url, options) => {
    if (url === "data/universe.json") return { ok: true, json: async () => companies(tickers, etfs) };
    const parsed = new URL(url);
    requests.push({ parsed, headers: options.headers });
    let selected = rows;
    const symbolFilter = parsed.searchParams.get("ticker");
    if (symbolFilter.startsWith("eq.")) selected = selected.filter(row => row.ticker === symbolFilter.slice(3));
    const afterDate = parsed.searchParams.get("fecha");
    if (afterDate) selected = selected.filter(row => row.fecha > afterDate.slice(3));
    const cursor = parsed.searchParams.get("or");
    if (cursor) {
      const match = cursor.match(/^\(ticker\.gt\.([^,]+),and\(ticker\.eq\.([^,]+),fecha\.gt\.([^\)]+)\)\)$/);
      assert.ok(match, "valid composite PostgREST cursor");
      assert.equal(match[1], match[2]);
      selected = selected.filter(row => row.ticker > match[1] || (row.ticker === match[1] && row.fecha > match[3]));
    }
    return { ok: true, json: async () => selected.slice(0, Math.min(cap, Number(parsed.searchParams.get("limit")))) };
  };
  return { request, requests };
}

test("all 200 companies and 50 ETFs retain 125,000 sessions when Supabase caps pages below the requested limit", async () => {
  const tickers = Array.from({ length: 200 }, (_, i) => "T" + String(i).padStart(3, "0"));
  const etfs = [...Array.from({ length: 46 }, (_, i) => etf("E" + String(i).padStart(3, "0"))),
    etf("USD", { dailyLeverage: 2, resetPeriod: "daily" }), etf("MAGS"),
    etf("TQQQ", { dailyLeverage: 3, resetPeriod: "daily" }), etf("SOXS", { dailyLeverage: -3, inverse: true, resetPeriod: "daily" })];
  const allTickers = [...tickers, ...etfs.map(item => item.ticker)].sort();
  const dates = sessionDates(500);
  const rows = allTickers.flatMap(ticker => dates.map(date => bar(ticker, date)));
  const api = pagedFetch(tickers, rows, 700, etfs);
  const client = makeClient({ tickers, etfs, fetch: api.request });
  const progress = [];
  const result = await client.fetchMarketData(null, count => progress.push(count));
  assert.equal(result.data.length, 125000);
  assert.equal(result.coverage.length, 250);
  assert.ok(result.coverage.every(item => item.days === 500));
  assert.equal(result.quality.missingTickers.length, 0);
  assert.equal(result.quality.shortHistories.length, 0);
  assert.equal(progress.at(-1), 125000);
  assert.equal(api.requests.length, Math.ceil(125000 / 700) + 1);
  assert.equal(result.universe.byTicker.get("USD").type, "ETF");
  assert.equal(client.tickerBars(result, "USD").length, 500);
  assert.equal(api.requests[0].headers.apikey, "sb_publishable_test");
  assert.equal(api.requests[0].headers.Authorization, undefined);
  assert.equal(api.requests[0].parsed.searchParams.get("order"), "ticker.asc,fecha.asc");
  assert.ok(api.requests.every(request => request.parsed.searchParams.get("is_final") === "eq.true"));
  assert.ok(api.requests[0].parsed.searchParams.get("ticker").includes("USD"));
  assert.ok(api.requests[0].parsed.searchParams.get("ticker").includes("MAGS"));
});

test("ETF tickers support detail and comparison with signed daily exposure metadata", async () => {
  const etfs = [etf("USD", { dailyLeverage: 2, resetPeriod: "daily" }), etf("MAGS"),
    etf("SOXS", { dailyLeverage: -3, inverse: true, resetPeriod: "daily" })];
  const api = pagedFetch(["AAPL"], sessionDates(60).map(date => bar("USD", date)), 40, etfs);
  const client = makeClient({ tickers: ["AAPL"], etfs, fetch: api.request });
  const result = await client.fetchMarketData(" usd ");
  assert.equal(client.tickerBars(result, "USD").length, 60);
  assert.ok(api.requests.every(request => request.parsed.searchParams.get("ticker") === "eq.USD"));
  assert.equal(client.instrumentTypeLabel(result.universe.byTicker.get("AAPL")), "Stock");
  assert.equal(client.instrumentTypeLabel(result.universe.byTicker.get("MAGS")), "ETF");
  assert.equal(client.instrumentTypeLabel(result.universe.byTicker.get("USD")), "ETF · +2× daily");
  assert.equal(client.instrumentTypeLabel(result.universe.byTicker.get("SOXS")), "ETF · −3× daily · inverse");
  assert.ok(client.instrumentDescription(etfs[0]).includes("Test issuer · US equity"));
});

test("universe rejects missing instruments, mismatched types, overlapping tickers and incorrect ETF exposure", async () => {
  const etfs = [etf("USD", { dailyLeverage: 2, resetPeriod: "daily" })];
  for (const mutate of [
    roster => roster.instruments.pop(),
    roster => { roster.instruments[0].type = "ETF"; },
    roster => { roster.etfs[0].ticker = "AAPL"; },
    roster => { roster.instruments[1].dailyLeverage = -2; },
    roster => { roster.instruments[1].resetPeriod = null; },
    roster => { delete roster.instruments[1].sourceUrl; }
  ]) {
    const roster = companies(["AAPL"], etfs.map(item => ({ ...item })));
    mutate(roster);
    const client = makeClient({ tickers: ["AAPL"], etfs, fetch: async () => ({ ok: true, json: async () => roster }) });
    await assert.rejects(() => client.loadMarketUniverse(), /must contain|Invalid|Duplicate/);
  }
});

test("the shipped universe loads all 200 companies and 50 verified ETFs through the production client contract", async () => {
  const roster = JSON.parse(fs.readFileSync(path.join(root, "data/universe.json"), "utf8"));
  const settings = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, "js/config.js"), "utf8") + "\nglobalThis.settings = MARKET_SETTINGS;", settings);
  assert.equal(settings.settings.expectedCompanies, 200);
  assert.equal(settings.settings.expectedETFs, 50);
  assert.equal(settings.settings.expectedInstruments, 250);
  const client = makeClient({ tickers: roster.companies.map(item => item.ticker), etfs: roster.etfs,
    fetch: async () => ({ ok: true, json: async () => roster }) });
  const loaded = await client.loadMarketUniverse();
  assert.equal(loaded.byTicker.size, 250);
  assert.equal(loaded.byTicker.get("USD").type, "ETF");
  assert.equal(client.instrumentTypeLabel(loaded.byTicker.get("USD")), "ETF · +2× daily");
  assert.equal(loaded.byTicker.get("MAGS").type, "ETF");
  for (const stock of roster.companies) {
    assert.equal(loaded.byTicker.get(stock.ticker).type, "STOCK");
    assert.equal(loaded.byTicker.get(stock.ticker).name, stock.name);
    assert.equal(loaded.byTicker.get(stock.ticker).marketCap, stock.marketCap);
  }
});

test("ticker detail and comparison receive the latest 500 complete sessions, including hyphenated tickers", async () => {
  const tickers = ["AAPL", "BRK-B", "JPM"];
  const dates = sessionDates(520);
  const rows = tickers.flatMap(ticker => dates.map(date => bar(ticker, date)));
  const api = pagedFetch(tickers, rows, 150);
  const client = makeClient({ tickers, fetch: api.request });
  const result = await client.fetchMarketData(" brk-b ");
  assert.equal(result.data.length, 500);
  assert.equal(result.data[0][0], dates[20]);
  assert.equal(result.data.at(-1)[0], dates.at(-1));
  assert.ok(result.data.every(row => row[1] === "BRK-B"));
  const chartBars = client.tickerBars(result, "BRK-B");
  assert.equal(chartBars.length, 500);
  assert.equal(chartBars[0].open, 100);
  assert.ok(api.requests.every(request => request.parsed.searchParams.get("ticker") === "eq.BRK-B"));
  await assert.rejects(() => client.fetchMarketData("UNKNOWN"), /outside the selected/);
});

test("invalid OHLCV, impossible dates, weekends and provisional closes are excluded, without fabricating prices", () => {
  const client = makeClient();
  const rows = [
    bar(), bar("AAPL", "2026-10-14", { close: 104 }),
    bar("AAPL", "2026-10-13", { open: 0 }),
    bar("AAPL", "2026-10-12", { low: 104 }),
    bar("JPM", "2026-02-30"), bar("JPM", "2026-10-11"),
    bar("JPM", "2026-10-13", { volumen: null }),
    bar("JPM", "2026-10-12", { volumen: -1 }),
    bar("JPM", "2026-10-09", { close: Infinity }),
    bar("AAPL", "2026-10-15"), bar("AAPL", "2026-10-16"), bar("UNKNOWN")
  ];
  const result = client.normalizeMarketRows(rows, universe(), null, new Date("2026-10-15T20:59:00Z"));
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0][5], 104);
  assert.equal(result.quality.invalidRows, 8);
  assert.equal(result.quality.provisionalRows, 1);
  assert.equal(result.quality.outsideUniverseRows, 1);
  assert.equal(result.quality.duplicateRows, 1);
  assert.equal(result.quality.missingTickers.length, 2);
  assert.ok(client.marketQualityMessages(result).some(message => message.includes("invalid OHLCV")));
  const afterClose = client.normalizeMarketRows([bar("AAPL", "2026-10-15")], universe(), null, new Date("2026-10-15T21:00:00Z"));
  assert.equal(afterClose.data.length, 1);
});

test("freshness uses the New York trading date and flags lagging and incomplete histories", () => {
  const client = makeClient();
  const clock = client._newYorkClock(new Date("2026-01-01T01:00:00Z"));
  assert.equal(clock.today, "2025-12-31");
  assert.equal(clock.hour, 20);
  const result = client.normalizeMarketRows([bar("AAPL", "2026-10-14"), bar("JPM", "2026-10-13")], universe(), null, new Date("2026-10-21T21:00:00Z"));
  assert.equal(result.latestDate, "2026-10-14");
  assert.ok(result.quality.laggingTickers.includes("JPM"));
  assert.equal(result.quality.shortHistories.length, 2);
  assert.equal(result.quality.insufficientSignals.length, 2);
  assert.equal(result.quality.oldLatestDate, true);
});

test("non-advancing pagination fails visibly instead of reporting a truncated success", async () => {
  const client = makeClient({ fetch: async url => ({ ok: true, json: async () => url === "data/universe.json" ? companies(["AAPL", "BRK-B", "JPM"]) : [bar()] }) });
  await assert.rejects(() => client.fetchMarketData(), /pagination did not advance/);
});

test("failed HTTP requests and missing universe are surfaced, and privileged keys never reach fetch", async () => {
  const client = makeClient({ fetch: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(() => client.fetchMarketData(), /HTTP 401/);
  const invalidUniverse = makeClient({ fetch: async () => ({ ok: true, json: async () => companies(["AAPL"]) }) });
  await assert.rejects(() => invalidUniverse.fetchMarketData(), /must contain 3/);
  const privileged = makeClient({ key: "sb_secret_private", fetch: async () => { throw new Error("must not fetch"); } });
  assert.throws(() => privileged._publicReadHeaders(), /publishable key/);
  assert.equal(privileged.escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("unmigrated Supabase schema gives an actionable error and never silently trusts legacy rows", async () => {
  const client = makeClient({ fetch: async url => url === "data/universe.json" ?
    { ok: true, json: async () => companies(["AAPL", "BRK-B", "JPM"]) } :
    { ok: false, status: 400, json: async () => ({ code: "42703", message: "column market_history.is_final does not exist" }) }
  });
  await assert.rejects(() => client.fetchMarketData(), /Run the Supabase migration/);
});

test("the frontend and ingestion calendars agree on every date in 2024–2030", () => {
  const backend = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, "apps-script/Yahoo.gs"), "utf8") + "\nglobalThis.backendSession = msIsSession_;", backend);
  const date = new Date("2024-01-01T12:00:00Z");
  while (date.getUTCFullYear() <= 2030) {
    const iso = date.toISOString().slice(0, 10);
    assert.equal(calendar.calendarSession(iso), backend.backendSession(iso), iso);
    date.setUTCDate(date.getUTCDate() + 1);
  }
  assert.equal(calendar.calendarSession("2025-01-09"), false);
  assert.equal(calendar.calendarSession("2026-07-03"), false);
});

test("the dashboard renders all 250 instruments, preserves 0% days, combines type and WAIT filters, and escapes names", async () => {
  const tickers = Array.from({ length: 200 }, (_, i) => "T" + String(i).padStart(3, "0"));
  const etfs = [...Array.from({ length: 47 }, (_, i) => etf("E" + String(i).padStart(3, "0"))),
    etf("USD", { dailyLeverage: 2, resetPeriod: "daily" }), etf("MAGS"),
    etf("SOXS", { dailyLeverage: -3, inverse: true, resetPeriod: "daily" })];
  const roster = universe(tickers, etfs);
  roster.byTicker.get("T000").name = 'Alpha <img src=x onerror="alert(1)"> Group';
  const client = makeClient({ tickers, etfs });
  const rows = sessionDates(60).map(date => bar("T000", date));
  rows.push(...sessionDates(60).map(date => bar("USD", date)));
  rows.push(bar("T001"));
  const result = client.normalizeMarketRows(rows, roster, null, new Date("2026-10-15T20:00:00Z"));
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: "", textContent: "", value: id === "instrumentType" ? "ALL" : "", hidden: false, dataset: {},
      style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} },
      querySelectorAll: () => [], addEventListener() {}
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [], documentElement: element("root") },
    localStorage: { getItem: () => null }, window: { location: {} },
    MARKET_SETTINGS: { historyDays: 500, minSignalDays: 50, expectedCompanies: 200, expectedETFs: 50, expectedInstruments: 250 },
    fetchMarketData: async (_, progress) => { progress(result.data.length); return result; },
    escapeHtml: client.escapeHtml, marketQualityMessages: client.marketQualityMessages,
    instrumentTypeLabel: client.instrumentTypeLabel, instrumentDescription: client.instrumentDescription,
    setTimeout, clearTimeout, console
  });
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  vm.runInContext(inline.replace(/loadData\(\);\s*$/, "globalThis.initialLoad = loadData();"), context);
  await context.initialLoad;
  assert.equal(element("cTotal").textContent, 250);
  assert.equal((element("tbody").innerHTML.match(/<tr\b/g) || []).length, 250);
  assert.ok(element("tsCount").textContent.startsWith("3 / 250 instruments"));
  assert.ok(element("footer").textContent.includes("200 companies + 50 ETFs"));
  assert.ok(element("tsUpdate").textContent.includes("2026-10-14"));
  assert.ok(element("tbody").innerHTML.includes("&lt;img"));
  assert.ok(!element("tbody").innerHTML.includes("<img"));
  assert.equal(context.results.find(row => row.ticker === "T000").chg1d, 0);
  context.setFilter("WAIT", element("waitFilter"));
  assert.equal((element("tbody").innerHTML.match(/<tr\b/g) || []).length, 248);
  assert.equal(context.results.find(row => row.ticker === "MAGS").signal, "WAIT");
  assert.equal(context.results.find(row => row.ticker === "MAGS").close, null);
  assert.equal(context.results.find(row => row.ticker === "USD").score, context.results.find(row => row.ticker === "T000").score);
  element("instrumentType").value = "ETF";
  context.renderTable();
  assert.equal((element("tbody").innerHTML.match(/<tr\b/g) || []).length, 49);
  assert.ok(element("tbody").innerHTML.includes("ETF · −3× daily · inverse"));
  assert.ok(!element("tbody").innerHTML.includes('>Stock</span>'));
  context.setFilter("ALL", element("allFilter"));
  assert.equal((element("tbody").innerHTML.match(/<tr\b/g) || []).length, 50);
  assert.ok(element("tbody").innerHTML.includes("ETF · +2× daily"));
  context.setFilter("WAIT", element("waitFilter"));
  element("instrumentType").value = "STOCK";
  context.renderTable();
  assert.equal((element("tbody").innerHTML.match(/<tr\b/g) || []).length, 199);
  assert.ok(!element("tbody").innerHTML.includes("ETF ·"));
  element("instrumentType").value = "ALL";
  context.recalc();
  assert.equal(context.results.find(row => row.ticker === "T001").score, null);
  element("search").value = "ALPHA";
  context.setFilter("ALL", element("allFilter"));
  assert.equal((element("tbody").innerHTML.match(/<tr\b/g) || []).length, 1);
  assert.ok(element("tbody").innerHTML.includes("T000"));
});

test("both pages use the same data client and all inline scripts compile", () => {
  for (const filename of ["index.html", "ticker.html"]) {
    const html = fs.readFileSync(path.join(root, filename), "utf8");
    assert.ok(html.includes('<script src="js/config.js"></script>'));
    assert.ok(html.includes('<script src="js/data.js"></script>'));
    assert.ok(!html.includes("const SUPABASE_KEY") && !html.includes("var SUPABASE_KEY"));
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1], { filename });
  }
});
