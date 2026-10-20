const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const clientSource = fs.readFileSync(path.join(root, "js/data.js"), "utf8");
const calendarSource = fs.readFileSync(path.join(root, "js/market-calendar.js"), "utf8");
const scoringSource = fs.readFileSync(path.join(root, "js/scoring.js"), "utf8");
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
  vm.runInContext(calendarSource + "\n" + clientSource + "\nglobalThis.client = { fetchMarketData, fetchLatestQuotes, mergeRecentMarketQuotes, marketQuoteLabel, loadMarketUniverse, normalizeMarketRows, marketQualityMessages, tickerBars, normalizeTicker, escapeHtml, instrumentTypeLabel, instrumentDescription, _publicReadHeaders, _newYorkClock };", context);
  return context.client;
}

function universe(tickers = ["AAPL", "BRK-B", "JPM"], etfs = []) {
  const source = companies(tickers, etfs);
  return { ...source, byTicker: new Map(source.instruments.map(instrument => [instrument.ticker, instrument])) };
}

function bar(ticker = "AAPL", fecha = "2026-10-14", overrides = {}) {
  return { ticker, fecha, open: 100, high: 105, low: 98, close: 103, volumen: 1000000, is_final: true, ...overrides };
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

function recentQuote(ticker = 'AAPL', overrides = {}) {
  return bar(ticker, '2026-10-16', {is_final:false,status:'PROVISIONAL',source:'googlefinance',
    source_quote_at:'2026-10-16T14:00:00Z',fetched_at:'2026-10-16T14:01:00Z',
    previous_close:103,datadelay_minutes:15,...overrides});
}

function pagedFetch(tickers, rows, cap = 1000, etfs = []) {
  const requests = [];
  const request = async (url, options) => {
    if (url === "data/universe.json") return { ok: true, json: async () => companies(tickers, etfs) };
    const parsed = new URL(url);
    if(parsed.pathname.endsWith('/market_latest_quotes'))return {ok:true,json:async()=>[]};
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
    bar("AAPL", "2026-10-15", {is_final:false}), bar("AAPL", "2026-10-16"), bar("UNKNOWN")
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

test("the frontend and server calendar seed agree through the reviewed server horizon", () => {
  const backend = JSON.parse(fs.readFileSync(path.join(root, "supabase/calendar.json"), "utf8"));
  const holidays = new Set(backend.holidays);
  const date = new Date("2024-01-01T12:00:00Z");
  while (date.getUTCFullYear() <= backend.lastYear) {
    const iso = date.toISOString().slice(0, 10);
    assert.equal(calendar.calendarSession(iso), date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !holidays.has(iso), iso);
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
      style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
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
  context.URL=URL;context.URLSearchParams=URLSearchParams;context.Intl=Intl;
  for(const file of ['i18n.js','market-translations.js','scanner-translations.js'])
    vm.runInContext(fs.readFileSync(path.join(root,'js',file),'utf8'),context);
  context.MarketI18n.setLanguage('en');
  vm.runInContext(scoringSource, context);
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
  const oldSignals=JSON.stringify(context.results.find(row=>row.ticker==='T000').signals);
  const quote=recentQuote('T000',{fecha:'2026-10-15',close:104,source_quote_at:'2026-10-15T19:55:00Z',fetched_at:'2026-10-15T19:56:00Z'});
  let activeQuote=quote;
  context.marketQuoteLabel=client.marketQuoteLabel;
  context.fetchMarketData=async(_,progress,options)=>client.mergeRecentMarketQuotes(result,[activeQuote],options.includeRecent,new Date('2026-10-15T20:00:00Z'));
  await context.loadData();
  assert.equal(context.results.find(row=>row.ticker==='T000').close,104);
  assert.notEqual(JSON.stringify(context.results.find(row=>row.ticker==='T000').signals),oldSignals);
  assert.match(element('tbody').innerHTML,/PROVISIONAL/);
  assert.match(element('tbody').innerHTML,/Google · 15:55/);
  assert.match(element('tsUpdate').textContent,/Latest confirmed close: 2026-10-14 · Provisional: 2026-10-15/);
  activeQuote={...quote,source:'yahoo',datadelay_minutes:null};
  await context.loadData();
  assert.equal(context.results.find(row=>row.ticker==='T000').close,104);
  assert.match(element('tbody').innerHTML,/Yahoo · 15:55/);
  assert.match(element('tbody').innerHTML,/source delay unavailable/);
  element('includeIntraday').checked=false;
  await context.loadData(false);
  assert.equal(context.results.find(row=>row.ticker==='T000').close,103);
  assert.equal(JSON.stringify(context.results.find(row=>row.ticker==='T000').signals),oldSignals);
  assert.ok(!element('tbody').innerHTML.includes('PROVISIONAL'));
});

test("both pages use the same data client and all inline scripts compile", () => {
  for (const filename of ["index.html", "ticker.html"]) {
    const html = fs.readFileSync(path.join(root, filename), "utf8");
    assert.ok(html.includes('<script src="js/config.js"></script>'));
    assert.ok(html.includes('<script src="js/market-calendar.js?v=3"></script>'));
    assert.ok(html.includes('<script src="js/data.js?v=3.2"></script>'));
    assert.match(html, /<script src="js\/scoring\.js\?v=[^"]+"><\/script>/);
    assert.ok(!html.includes("const SUPABASE_KEY") && !html.includes("var SUPABASE_KEY"));
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1], { filename });
  }
});

test("today's provisional candle appends to 500 confirmed closes without mutating the history or duplicating its date", () => {
  const client=makeClient(), now=new Date('2026-10-16T14:05:00Z');
  const rows=sessionDates(499).concat('2026-10-15').map(date=>bar('AAPL',date));
  const base=client.normalizeMarketRows(rows,universe(),null,now), original=JSON.stringify(base.data);
  const result=client.mergeRecentMarketQuotes(base,[recentQuote('AAPL',{close:104}),recentQuote('AAPL',{close:105,source_quote_at:'2026-10-16T14:02:00Z'})],true,now);
  assert.equal(result.data.length,501);
  assert.equal(result.finalizedData.length,500);
  assert.equal(result.latestDate,'2026-10-15');
  assert.equal(result.latestBarDate,'2026-10-16');
  assert.equal(result.data.at(-1)[5],105);
  assert.deepEqual(Array.from(result.provisionalTickers),['AAPL']);
  assert.equal(new Set(result.data.map(row=>row[1]+'|'+row[0])).size,501);
  assert.equal(JSON.stringify(base.data),original);
  const closed=client.mergeRecentMarketQuotes(base,[recentQuote()],false,now);
  assert.equal(closed.data.length,500);
  assert.equal(closed.provisionalTickers.length,0);
  assert.ok(client.marketQualityMessages(result).some(text=>text.includes('charts and signals')));
});

test("confirmed history wins over a later provisional quote for the same day", () => {
  const client=makeClient(), now=new Date('2026-10-16T21:05:00Z');
  const base=client.normalizeMarketRows([bar('AAPL','2026-10-16',{close:102})],universe(),null,now);
  const result=client.mergeRecentMarketQuotes(base,[recentQuote('AAPL',{close:104,source_quote_at:'2026-10-16T20:00:00Z',fetched_at:'2026-10-16T21:01:00Z'})],true,now);
  assert.equal(result.data.length,1);
  assert.equal(result.data[0][5],102);
  assert.equal(result.provisionalTickers.length,0);
  assert.equal(result.quoteByTicker.has('AAPL'),false);
});

test("previous-day, pending, malformed and Google-final quotes cannot become a preview candle", () => {
  const client=makeClient(), now=new Date('2026-10-16T14:30:00Z');
  const base=client.normalizeMarketRows([bar()],universe(),null,now);
  for(const bad of [recentQuote('AAPL',{status:'REEMPLAZO_PENDIENTE'}),recentQuote('AAPL',{status:'RECHAZADO'}),
    recentQuote('AAPL',{status:'PENDIENTE_DE_ACTUALIZAR'}),recentQuote('AAPL',{fecha:'2026-10-15',source_quote_at:'2026-10-15T20:00:00Z'}),
    recentQuote('AAPL',{is_final:true}),recentQuote('AAPL',{source:'yahoo',is_final:true,status:'PROVISIONAL'}),
    recentQuote('AAPL',{source:'yahoo',is_final:false,status:'FINAL'}),recentQuote('AAPL',{close:200}),recentQuote('AAPL',{source:'unknown'}),
    recentQuote('AAPL',{source_quote_at:'invalid'}),recentQuote('AAPL',{datadelay_minutes:21})]) {
    const result=client.mergeRecentMarketQuotes(base,[bad],true,now);
    assert.equal(result.data.length,1,JSON.stringify(bad));
    assert.equal(result.provisionalTickers.length,0);
    assert.ok(result.quality.staleRecentTickers.length+result.quality.invalidRecentTickers.length>0);
  }
  const accepted=client.mergeRecentMarketQuotes(base,[recentQuote('AAPL',{datadelay_minutes:20})],true,now);
  assert.equal(accepted.provisionalTickers.length,1,'reported20minute delay allows source quote age30minutes');
  const yahoo=client.mergeRecentMarketQuotes(base,[recentQuote('AAPL',{source:'yahoo',datadelay_minutes:0,source_quote_at:'2026-10-16T13:59:00Z'})],true,now);
  assert.equal(yahoo.provisionalTickers.length,1,'an approved quote remains visible when it later ages');
  assert.equal(yahoo.quoteByTicker.get('AAPL').outdated,true,'Yahoo quote age is clearly marked');
});

test("Yahoo quotes with unknown delay are accepted without inventing a zero-minute delay", () => {
  const client=makeClient(),now=new Date('2026-10-16T14:05:00Z');
  const base=client.normalizeMarketRows([bar('AAPL','2026-10-15')],universe(),null,now);
  const quote=recentQuote('AAPL',{source:'yahoo',datadelay_minutes:null,close:104});
  const result=client.mergeRecentMarketQuotes(base,[quote],true,now);
  assert.equal(result.provisionalTickers.length,1);
  assert.equal(result.data.at(-1)[5],104);
  assert.equal(result.quoteByTicker.get('AAPL').datadelay_minutes,null);
  assert.equal(result.quoteByTicker.get('AAPL').outdated,false);
  assert.match(client.marketQuoteLabel(result.quoteByTicker.get('AAPL')),/Yahoo Finance.*source delay unavailable/);
  assert.doesNotMatch(client.marketQuoteLabel(result.quoteByTicker.get('AAPL')),/source delay 0/);
  const older=client.mergeRecentMarketQuotes(base,[quote],true,new Date('2026-10-16T14:31:00Z'));
  assert.equal(older.provisionalTickers.length,1);
  assert.equal(older.quoteByTicker.get('AAPL').outdated,true,'unknown Yahoo delay uses30minute visual age policy');
  const missingGoogle=client.mergeRecentMarketQuotes(base,[{...quote,source:'googlefinance'}],true,now);
  assert.equal(missingGoogle.provisionalTickers.length,0,'Google delay remains mandatory');
});

test("an approved quote from today stays in prices and charts when it ages, with an outdated badge and original source time", () => {
  const client=makeClient(),now=new Date('2026-10-16T16:30:00Z');
  const base=client.normalizeMarketRows([bar('AAPL','2026-10-15')],universe(),null,now);
  const quote=recentQuote('AAPL',{close:104});
  const result=client.mergeRecentMarketQuotes(base,[quote],true,now);
  assert.equal(result.data.length,2);
  assert.equal(result.data.at(-1)[5],104);
  assert.equal(client.tickerBars(result,'AAPL').at(-1).date,'2026-10-16');
  assert.equal(result.quoteByTicker.get('AAPL').outdated,true);
  assert.equal(result.quoteByTicker.get('AAPL').source_quote_at,'2026-10-16T14:00:00Z');
  assert.match(client.marketQuoteLabel(result.quoteByTicker.get('AAPL')),/PROVISIONAL|Provisional/);
  assert.match(client.marketQuoteLabel(result.quoteByTicker.get('AAPL')),/OUTDATED.*10:00:00 New York/);
  assert.ok(client.marketQualityMessages(result).some(text=>text.includes('last approved values')));
});

test("after hours a quote from today remains explicitly provisional, with source time and delay", () => {
  const client=makeClient(), now=new Date('2026-10-16T22:00:00Z');
  const base=client.normalizeMarketRows([bar()],universe(),null,now);
  const quote=recentQuote('AAPL',{source_quote_at:'2026-10-16T20:00:00Z',fetched_at:'2026-10-16T20:10:00Z'});
  const result=client.mergeRecentMarketQuotes(base,[quote],true,now);
  assert.equal(result.provisionalTickers.length,1);
  assert.equal(result.latestDate,'2026-10-14');
  assert.match(client.marketQuoteLabel(quote),/Provisional daily candle.*Google Finance.*16:00:00 New York.*20 min/);
});

test("closing quotes stay current after regular and early closes in New York summer and winter time", () => {
  const client=makeClient();
  for(const sample of [
    {date:'2026-10-16',prior:'2026-10-15',close:'2026-10-16T20:00:00Z',now:'2026-10-16T23:59:59.999Z'},
    {date:'2026-01-08',prior:'2026-01-07',close:'2026-01-08T21:00:00Z',now:'2026-01-09T01:00:00Z'},
    {date:'2024-07-03',prior:'2024-07-02',close:'2024-07-03T17:00:00Z',now:'2024-07-04T00:00:00Z'},
    {date:'2026-11-27',prior:'2026-11-25',close:'2026-11-27T18:00:00Z',now:'2026-11-28T01:00:00Z'}
  ]) {
    const now=new Date(sample.now),base=client.normalizeMarketRows([bar('AAPL',sample.prior)],universe(),null,now);
    const quote=recentQuote('AAPL',{fecha:sample.date,source_quote_at:sample.close,fetched_at:sample.close,datadelay_minutes:0});
    const result=client.mergeRecentMarketQuotes(base,[quote],true,now);
    const accepted=result.quoteByTicker.get('AAPL');
    assert.equal(accepted.outdated,false,sample.date);
    assert.equal(result.provisionalTickers.length,1,sample.date);
    assert.equal(result.quality.staleRecentTickers.length,0,sample.date);
    assert.doesNotMatch(client.marketQuoteLabel(accepted),/OUTDATED/,sample.date);
    assert.equal(accepted.source_quote_at,sample.close,'the quote timestamp is retained');
    assert.equal(accepted.fetched_at,sample.close,'the capture timestamp is retained');
  }
});

test("after-close freshness retains each provider's tolerance against the session close", () => {
  const client=makeClient(),now=new Date('2026-10-16T22:00:00Z');
  const base=client.normalizeMarketRows([bar('AAPL','2026-10-15')],universe(),null,now);
  for(const sample of [
    {source:'googlefinance',delay:0,age:10},
    {source:'googlefinance',delay:15,age:25},
    {source:'googlefinance',delay:20,age:30},
    {source:'yahoo',delay:null,age:30}
  ]) {
    const time=Date.parse('2026-10-16T20:00:00Z')-sample.age*60000;
    const quote=recentQuote('AAPL',{source:sample.source,datadelay_minutes:sample.delay,source_quote_at:new Date(time).toISOString(),fetched_at:'2026-10-16T21:58:00Z'});
    const current=client.mergeRecentMarketQuotes(base,[quote],true,now);
    assert.equal(current.quoteByTicker.get('AAPL').outdated,false,JSON.stringify(sample));
    const outside=client.mergeRecentMarketQuotes(base,[{...quote,source_quote_at:new Date(time-1).toISOString()}],true,now);
    assert.equal(outside.quoteByTicker.get('AAPL').outdated,true,JSON.stringify(sample));
  }
});

test("a midday source quote or a pre-close stale capture remains outdated after the session", () => {
  const client=makeClient(),now=new Date('2026-10-16T22:00:00Z');
  const base=client.normalizeMarketRows([bar('AAPL','2026-10-15')],universe(),null,now);
  for(const timestamps of [
    {source_quote_at:'2026-10-16T16:00:00Z',fetched_at:'2026-10-16T21:59:00Z'},
    {source_quote_at:'2026-10-16T20:00:00Z',fetched_at:'2026-10-16T16:00:00Z'}
  ]) {
    const result=client.mergeRecentMarketQuotes(base,[recentQuote('AAPL',{...timestamps,datadelay_minutes:0})],true,now);
    assert.equal(result.provisionalTickers.length,1);
    assert.equal(result.quoteByTicker.get('AAPL').outdated,true);
    assert.deepEqual(Array.from(result.quality.staleRecentTickers),['AAPL']);
  }
});

test("open-session freshness still uses actual time with the existing Google and Yahoo limits", () => {
  const client=makeClient(),now=new Date('2026-10-16T19:00:00Z');
  const base=client.normalizeMarketRows([bar('AAPL','2026-10-15')],universe(),null,now);
  for(const sample of [{source:'googlefinance',delay:0,age:10},{source:'googlefinance',delay:15,age:25},{source:'yahoo',delay:null,age:30}]) {
    const time=now.getTime()-sample.age*60000;
    const quote=recentQuote('AAPL',{source:sample.source,datadelay_minutes:sample.delay,source_quote_at:new Date(time).toISOString(),fetched_at:now.toISOString()});
    assert.equal(client.mergeRecentMarketQuotes(base,[quote],true,now).quoteByTicker.get('AAPL').outdated,false);
    assert.equal(client.mergeRecentMarketQuotes(base,[{...quote,source_quote_at:new Date(time-1).toISOString()}],true,now).quoteByTicker.get('AAPL').outdated,true);
  }
});

test("confirmed closes never create an age warning after hours, on weekends, holidays or the next session", () => {
  const client=makeClient();
  for(const sample of [
    {date:'2026-10-16',close:'2026-10-16T20:00:00Z',now:'2026-10-16T23:59:00Z'},
    {date:'2026-10-16',close:'2026-10-16T20:00:00Z',now:'2026-10-17T22:00:00Z'},
    {date:'2026-10-16',close:'2026-10-16T20:00:00Z',now:'2026-10-19T13:00:00Z'},
    {date:'2026-10-16',close:'2026-10-16T20:00:00Z',now:'2026-10-19T14:00:00Z'},
    {date:'2026-11-25',close:'2026-11-25T21:00:00Z',now:'2026-11-26T22:00:00Z'}
  ]) {
    const now=new Date(sample.now),base=client.normalizeMarketRows([bar('AAPL',sample.date)],universe(),null,now);
    const quote=recentQuote('AAPL',{fecha:sample.date,is_final:true,status:'FINAL',source:'yahoo',datadelay_minutes:null,source_quote_at:sample.close,fetched_at:sample.close});
    const result=client.mergeRecentMarketQuotes(base,[quote],true,now);
    assert.equal(result.quality.staleRecentTickers.length,0,sample.now);
    assert.equal(result.provisionalTickers.length,0,sample.now);
    assert.equal(result.data.length,1,sample.now);
    assert.ok(!client.marketQualityMessages(result).some(text=>text.includes('outdated')),sample.now);
    if(result.quoteByTicker.has('AAPL'))assert.equal(result.quoteByTicker.get('AAPL').outdated,false,sample.now);
  }
});

test("a closing provisional quote expires at New York midnight and is never reused in a later session", () => {
  const client=makeClient(),quote=recentQuote('AAPL',{source_quote_at:'2026-10-16T20:00:00Z',fetched_at:'2026-10-16T20:01:00Z',datadelay_minutes:0});
  for(const sample of [
    {now:'2026-10-17T03:59:59.999Z',preview:true},
    {now:'2026-10-17T04:00:00Z',preview:false},
    {now:'2026-10-19T14:00:00Z',preview:false}
  ]) {
    const now=new Date(sample.now),base=client.normalizeMarketRows([bar('AAPL','2026-10-15')],universe(),null,now);
    const result=client.mergeRecentMarketQuotes(base,[quote],true,now);
    assert.equal(result.quoteByTicker.has('AAPL'),sample.preview,sample.now);
    assert.equal(result.provisionalTickers.length,sample.preview?1:0,sample.now);
    assert.equal(result.quality.staleRecentTickers.length,sample.preview?0:1,sample.now);
  }
});

test("session-aware freshness keeps source and capture future-time rejection intact", () => {
  const client=makeClient(),now=new Date('2026-10-16T22:00:00Z');
  const base=client.normalizeMarketRows([bar('AAPL','2026-10-15')],universe(),null,now);
  for(const timestamps of [
    {source_quote_at:'2026-10-16T22:02:00.001Z',fetched_at:'2026-10-16T22:00:00Z'},
    {source_quote_at:'2026-10-16T20:00:00Z',fetched_at:'2026-10-16T22:02:00.001Z'}
  ]) {
    const result=client.mergeRecentMarketQuotes(base,[recentQuote('AAPL',timestamps)],true,now);
    assert.equal(result.provisionalTickers.length,0);
    assert.deepEqual(Array.from(result.quality.invalidRecentTickers),['AAPL']);
  }
});

test("fast quote refresh retains history in memory and a newly confirmed close survives subsequent missing quotes", async () => {
  const rows=sessionDates(499).concat('2026-10-15').map(date=>bar('AAPL',date));
  const api=pagedFetch(['AAPL'],rows), quotesRequests=[];
  let quotes=[recentQuote('AAPL',{source_quote_at:'2026-10-16T20:00:00Z',fetched_at:'2026-10-16T21:00:00Z'})];
  const client=makeClient({tickers:['AAPL'],fetch:async(url,options)=>{
    if(url.includes('/market_latest_quotes?')){quotesRequests.push(options);return {ok:true,json:async()=>quotes};}
    return api.request(url,options);
  }});
  const first=await client.fetchMarketData(null,null,{now:new Date('2026-10-16T21:01:00Z')});
  assert.equal(first.data.length,501);
  const historyRequests=api.requests.length;
  quotes=[recentQuote('AAPL',{is_final:true,status:'FINAL',source:'yahoo',close:104,source_quote_at:'2026-10-16T20:00:00Z',fetched_at:'2026-10-16T21:02:00Z',datadelay_minutes:0})];
  const second=await client.fetchMarketData(null,null,{now:new Date('2026-10-16T21:03:00Z')});
  assert.equal(second.data.length,500);
  assert.equal(second.latestDate,'2026-10-16');
  assert.equal(second.provisionalTickers.length,0);
  quotes=[];
  const third=await client.fetchMarketData(null,null,{now:new Date('2026-10-16T21:04:00Z')});
  assert.equal(third.latestDate,'2026-10-16');
  assert.equal(third.data.at(-1)[5],104);
  assert.equal(api.requests.length,historyRequests,'quote refresh does not download124k history rows again');
  assert.equal(quotesRequests.length,3);
  assert.ok(quotesRequests.every(options=>options.cache==='no-store'));
  await client.fetchMarketData(null,null,{refreshQuotes:false,includeRecent:false,now:new Date('2026-10-16T21:05:00Z')});
  assert.equal(quotesRequests.length,3,'display toggle reads only memory');
});

test("the history cache reloads once the expected confirmed session changes", async () => {
  const api=pagedFetch(['AAPL'],[bar('AAPL','2026-10-15')]);
  const client=makeClient({tickers:['AAPL'],fetch:api.request});
  await client.fetchMarketData(null,null,{now:new Date('2026-10-16T20:59:00Z')});
  const before=api.requests.length;
  await client.fetchMarketData(null,null,{now:new Date('2026-10-16T21:01:00Z')});
  assert.ok(api.requests.length>before);
  const after=api.requests.length;
  await client.fetchMarketData(null,null,{now:new Date('2026-10-16T21:02:00Z')});
  assert.equal(api.requests.length,after);
});

test("a failed recent quote request preserves the last accepted candle and never advances its timestamp", async () => {
  const api=pagedFetch(['AAPL'],[bar('AAPL','2026-10-15')]);
  let unavailable=false;
  const client=makeClient({tickers:['AAPL'],fetch:async(url,options)=>{
    if(url.includes('/market_latest_quotes?')){
      if(unavailable)throw new Error('network unavailable');
      return {ok:true,json:async()=>[recentQuote('AAPL',{close:104})]};
    }
    return api.request(url,options);
  }});
  await client.fetchMarketData(null,null,{now:new Date('2026-10-16T14:05:00Z')});
  unavailable=true;
  const result=await client.fetchMarketData(null,null,{now:new Date('2026-10-16T16:05:00Z')});
  assert.equal(result.data.at(-1)[5],104);
  assert.equal(result.provisionalTickers.length,1);
  assert.equal(result.quoteByTicker.get('AAPL').source_quote_at,'2026-10-16T14:00:00Z');
  assert.equal(result.quoteByTicker.get('AAPL').outdated,true);
  assert.match(result.quality.recentError,/network unavailable/);
  assert.ok(client.marketQualityMessages(result).some(text=>text.includes('original source time')));
});

test("reduced sessions confirm at14 New York and confirmed rows are not discarded by the old17 rule", () => {
  const client=makeClient();
  const rows=[bar('AAPL','2026-11-27')];
  const before=client.normalizeMarketRows([],universe(),null,new Date('2026-11-27T18:59:00Z'));
  assert.equal(before.quality.expectedDate,'2026-11-25');
  const after=client.normalizeMarketRows(rows,universe(),null,new Date('2026-11-27T19:00:00Z'));
  assert.equal(after.data.length,1);
  assert.equal(after.quality.expectedDate,'2026-11-27');
  assert.equal(after.quality.laggingTickers.length,0);
  assert.throws(()=>client.normalizeMarketRows([],universe(),null,new Date('2029-01-02T22:00:00Z')),/outside its supported range/);
});

test("ticker detail sends the provisional candle to every chart and signal and labels the unfinished result", async () => {
  const client=makeClient(), now=new Date('2026-10-16T14:05:00Z');
  const base=client.normalizeMarketRows(sessionDates(499).concat('2026-10-15').map(date=>bar('AAPL',date)),universe(),null,now);
  const quote=recentQuote('AAPL',{close:104}), elements=new Map(), renders=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',style:{},checked:true,className:''});
    return elements.get(id);
  };
  const context=vm.createContext({
    document:{getElementById:element},ticker:'AAPL',_mc:{compareTickers:[]},
    fetchMarketData:async(_,__,options)=>client.mergeRecentMarketQuotes({...base,ticker:'AAPL'},[quote],options.includeRecent,now),
    tickerBars:client.tickerBars, marketQuoteLabel:client.marketQuoteLabel, marketQualityMessages:client.marketQualityMessages,
    instrumentDescription:client.instrumentDescription,instrumentTypeLabel:client.instrumentTypeLabel,escapeHtml:client.escapeHtml,
    MARKET_SETTINGS:{minSignalDays:50},INDICATORS:[],computeSignals:raw=>{renders.set('signals',raw);return {};},computeScore:()=>80,
    restoreCompositeWeights(){},renderTiming:analysis=>renders.set('timing',analysis),
    buildThemeSwitcher_t(){},_renderCompareTags(){},console
  });
  for(const name of ['renderMainChart','renderRSI','renderMACD','renderStochRSI','renderWilliams','renderVolume','renderOBV','renderROC','renderATR','renderGauge','renderStats','renderHeatmap'])
    context[name]=(...args)=>renders.set(name,args);
  const html=fs.readFileSync(path.join(root,'ticker.html'),'utf8');
  const start=html.indexOf('let tickerLoading=false;'),end=html.indexOf('// ── Main candlestick + Bollinger',start);
  context.URL=URL;context.URLSearchParams=URLSearchParams;context.Intl=Intl;
  for(const file of ['i18n.js','market-translations.js','ticker-translations.js'])
    vm.runInContext(fs.readFileSync(path.join(root,'js',file),'utf8'),context);
  context.MarketI18n.setLanguage('en');
  context.T=context.MarketI18n.t;context.N=context.MarketI18n.number;context.M=context.MarketI18n.message;
  vm.runInContext(scoringSource,context);
  vm.runInContext(html.slice(start,end),context);
  await context.init();
  assert.equal(renders.get('signals').length,501);
  assert.equal(renders.get('signals').at(-1).close,104);
  for(const name of ['renderMainChart','renderRSI','renderMACD','renderStochRSI','renderWilliams','renderVolume','renderOBV','renderROC','renderATR'])
    assert.equal(renders.get(name)[0].length,501,name);
  assert.equal(element('priceVal').textContent,'$104.00');
  assert.equal(element('sigBadge').textContent,'BUY · PROVISIONAL');
  assert.match(element('quoteStatus').textContent,/Provisional daily candle.*Google Finance.*unfinished/);
  assert.match(element('footer').textContent,/500 confirmed daily closes \+ today's provisional candle/);
  element('includeIntraday').checked=false;
  await context.init(false);
  assert.equal(renders.get('signals').length,500);
  assert.equal(element('priceVal').textContent,'$103.00');
  assert.equal(element('sigBadge').textContent,'HOLD');
  assert.equal(renders.get('timing').trendScore,50,'flat closes remain neutral regardless of Composite');
  assert.match(element('quoteStatus').textContent,/confirmed closes/);
});

test("a repaired price scale refreshes the shared history cache once and invalidates older ticker references", async () => {
  const tickers=['AAPL','JPM'],oldRows=[bar('AAPL','2026-10-15',{close:100}),bar('JPM','2026-10-15',{open:200,high:205,low:198,close:200})];
  const newRows=[bar('AAPL','2026-10-15',{open:50,high:55,low:48,close:50}),bar('JPM','2026-10-15',{open:200,high:205,low:198,close:201})];
  const before=pagedFetch(tickers,oldRows),after=pagedFetch(tickers,newRows),now=new Date('2026-10-16T14:05:00Z');
  let repaired=false;
  const oldQuote=recentQuote('AAPL',{close:101,previous_close:100});
  const newQuote=recentQuote('AAPL',{open:50,high:55,low:48,close:51,previous_close:50});
  const client=makeClient({tickers,fetch:async(url,options)=>{
    if(url.includes('/market_latest_quotes?')){
      const filter=new URL(url).searchParams.get('ticker'),quote=repaired?newQuote:oldQuote;
      return {ok:true,json:async()=>filter==='eq.JPM'?[]:[quote]};
    }
    return (repaired?after:before).request(url,options);
  }});
  const directBase=client.normalizeMarketRows(oldRows,universe(tickers),null,now);
  const direct=client.mergeRecentMarketQuotes(directBase,[newQuote],true,now);
  assert.equal(direct.provisionalTickers.length,0,'the standalone merge also refuses mixed historical scales');
  assert.deepEqual(Array.from(direct.quality.incompatibleRecentTickers),['AAPL']);
  assert.equal(direct.quoteByTicker.has('AAPL'),false);
  await client.fetchMarketData('JPM',null,{now});
  await client.fetchMarketData(null,null,{now});
  repaired=true;
  const result=await client.fetchMarketData('AAPL',null,{now});
  assert.equal(result.quality.historyReloadedForQuote,true);
  assert.equal(result.quality.incompatibleRecentTickers.length,0);
  assert.equal(result.data.length,2);
  assert.equal(result.data[0][5],50);
  assert.equal(result.data[1][5],51);
  assert.equal(result.provisionalTickers.length,1);
  assert.equal(after.requests.length,2,'one full-history reload, including its empty cursor page');
  assert.ok(after.requests.every(request=>request.parsed.searchParams.get('ticker').startsWith('in.(')),'refreshes the all-ticker scope that supplied the stale cache');
  const jpm=await client.fetchMarketData('JPM',null,{now});
  assert.equal(jpm.data[0][5],201,'the old per-ticker cache was removed');
  assert.equal(after.requests.length,2,'the refreshed shared history is reused');
});

test("an incompatible quote stays blocked after one reload and historical-only mode never refetches for that quote", async () => {
  const now=new Date('2026-10-16T14:05:00Z'),rows=[bar('AAPL','2026-10-15',{close:100})],api=pagedFetch(['AAPL'],rows);
  let badBaseline=false,quoteRequests=0;
  const client=makeClient({tickers:['AAPL'],fetch:async(url,options)=>{
    if(url.includes('/market_latest_quotes?')){
      quoteRequests++;
      return {ok:true,json:async()=>[recentQuote('AAPL',{close:101,previous_close:badBaseline?50:100})]};
    }
    return api.request(url,options);
  }});
  await client.fetchMarketData(null,null,{now});
  const before=api.requests.length;
  badBaseline=true;
  const result=await client.fetchMarketData(null,null,{now});
  assert.equal(api.requests.length-before,2,'reloads once; never loops on a persistent mismatch');
  assert.equal(result.quality.historyReloadedForQuote,true);
  assert.deepEqual(Array.from(result.quality.incompatibleRecentTickers),['AAPL']);
  assert.equal(result.provisionalTickers.length,0);
  assert.equal(result.data.length,1);
  assert.equal(result.data[0][5],100);
  assert.ok(client.marketQualityMessages(result).some(text=>text.includes('compatible historical series')));
  const requestCount=api.requests.length,quoteCount=quoteRequests;
  const closed=await client.fetchMarketData(null,null,{includeRecent:false,refreshQuotes:false,now});
  assert.equal(api.requests.length,requestCount,'historical-only mode does not reload due to a provisional baseline');
  assert.equal(quoteRequests,quoteCount,'the display toggle makes no quote request');
  assert.equal(closed.data.length,1);
  const finalBase=client.normalizeMarketRows([rows[0],bar('AAPL','2026-10-16',{close:102})],universe(['AAPL']),null,now);
  const alreadyFinal=client.mergeRecentMarketQuotes(finalBase,[recentQuote('AAPL',{previous_close:50})],true,now);
  assert.equal(alreadyFinal.quality.incompatibleRecentTickers.length,0,'an already confirmed day ignores the provisional quote before the baseline guard');
  assert.equal(alreadyFinal.provisionalTickers.length,0);
  assert.equal(alreadyFinal.data.at(-1)[5],102);
});
