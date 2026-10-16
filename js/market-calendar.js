// Mirrors the reviewed Supabase calendar; the server owns confirmation decisions.
// Extend supabase/calendar.json and this calendar together after exchange review.
const MARKET_CALENDAR = Object.freeze({
  firstYear: 2024, lastYear: 2028,
  holidays: new Set([
  "2024-01-01",
  "2024-01-15",
  "2024-02-19",
  "2024-03-29",
  "2024-05-27",
  "2024-06-19",
  "2024-07-04",
  "2024-09-02",
  "2024-11-28",
  "2024-12-25",
  "2025-01-01",
  "2025-01-09",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
  "2028-01-01",
  "2028-01-17",
  "2028-02-21",
  "2028-04-14",
  "2028-05-29",
  "2028-06-19",
  "2028-07-04",
  "2028-09-04",
  "2028-11-23",
  "2028-12-25"
]),
  earlyCloses: new Set([
  "2024-07-03",
  "2024-11-29",
  "2024-12-24",
  "2025-07-03",
  "2025-11-28",
  "2025-12-24",
  "2026-11-27",
  "2026-12-24",
  "2027-11-26",
  "2028-07-03",
  "2028-11-24"
]),
  confirmationDelayMinutes: 60
});

function isMarketSession(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + "T12:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  const year = parsed.getUTCFullYear();
  return year >= MARKET_CALENDAR.firstYear && year <= MARKET_CALENDAR.lastYear &&
    parsed.getUTCDay() !== 0 && parsed.getUTCDay() !== 6 && !MARKET_CALENDAR.holidays.has(date);
}

function marketSessionTiming(date) {
  if (!isMarketSession(date)) return null;
  const close = MARKET_CALENDAR.earlyCloses.has(date) ? 13 * 60 : 16 * 60;
  return { opens: 9 * 60 + 30, closes: close, confirms: close + MARKET_CALENDAR.confirmationDelayMinutes };
}

function lastCompletedMarketSession(clock) {
  const year = Number(clock.today.slice(0, 4));
  if (year < MARKET_CALENDAR.firstYear || year > MARKET_CALENDAR.lastYear) throw new Error("Review the exchange calendar: it is outside its supported range.");
  const parsed = new Date(clock.today + "T12:00:00Z");
  const timing = marketSessionTiming(clock.today);
  if (!timing || clock.hour * 60 + (clock.minute || 0) < timing.confirms) parsed.setUTCDate(parsed.getUTCDate() - 1);
  for (let i = 0; i < 15; i++) {
    const date = parsed.toISOString().slice(0, 10);
    if (isMarketSession(date)) return date;
    parsed.setUTCDate(parsed.getUTCDate() - 1);
  }
  throw new Error("Review the exchange calendar: it is outside its supported range.");
}
