// ============================================================
// config.js — data source configuration
//
// Priority:
//   1. Supabase (fast — 50–200ms, global edge)
//   2. Apps Script WebApp (fallback)
//
// After setting up Supabase, fill in SUPABASE_URL + SUPABASE_KEY.
// Leave SUPABASE_URL as "" to keep using Apps Script.
// ============================================================

const SUPABASE_URL   = "https://wpenzrjybvysvfaefkxh.supabase.co/rest/v1/";  // e.g. "https://abcxyz.supabase.co"
const SUPABASE_KEY   = "sb_publishable_5RX4B4l-IM9rgARaPJObEA_P_lr-uz_";  // anon/public key (Settings → API)
const SUPABASE_TABLE = "market_history";

const API_URL = "https://script.google.com/macros/s/AKfycbzVBbR6zZn4dMSATDe4KZ76VHIvuKr6n8ttlzT8LtdmRpOOdamE7oklZxh989pOJbAb/exec";

// Unified fetch — used by index.html and ticker.html
// Returns { data: [[fecha,ticker,open,high,low,close,vol],...], total, source }
async function fetchMarketData(ticker = null) {
  if (SUPABASE_URL && SUPABASE_KEY) {
    return _fromSupabase(ticker);
  }
  return _fromAppsScript(ticker);
}

async function _fromSupabase(ticker) {
  let url = SUPABASE_URL + "/rest/v1/" + SUPABASE_TABLE
    + "?select=fecha,ticker,open,high,low,close,volumen&order=fecha.asc";
  if (ticker) url += "&ticker=eq." + encodeURIComponent(ticker);
  const res = await fetch(url, {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
  });
  if (!res.ok) throw new Error("Supabase HTTP " + res.status);
  const rows = await res.json();
  const data = rows.map(r => [r.fecha, r.ticker, r.open||0, r.high||0, r.low||0, r.close, r.volumen||0]);
  return { data, total: data.length, source: "supabase" };
}

async function _fromAppsScript(ticker) {
  let url = API_URL + (ticker ? "?ticker=" + encodeURIComponent(ticker) : "");
  const res  = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return { data: json.data, total: json.total, source: "apps-script" };
}
