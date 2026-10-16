// Browser configuration. Only the public, read-only key belongs here.
// Database RLS must allow SELECT and deny client INSERT/UPDATE/DELETE.
const SUPABASE_URL = "https://wpenzrjybvysvfaefkxh.supabase.co";
const SUPABASE_KEY = "sb_publishable_5RX4B4l-IM9rgARaPJObEA_P_lr-uz_";
const SUPABASE_TABLE = "market_history";

const MARKET_SETTINGS = Object.freeze({
  universeUrl: "data/universe.json",
  expectedCompanies: 200,
  expectedETFs: 50,
  expectedInstruments: 250,
  historyDays: 500,
  minSignalDays: 50,
  pageSize: 5000,
  maxPages: 2000
});
