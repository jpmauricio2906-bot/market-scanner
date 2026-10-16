// Generated from apps-script/Yahoo.gs msHolidays_ for 2024–2030.
// tests/frontend.test.cjs checks every calendar date against the backend.
// Review extraordinary exchange closures and extend both calendars annually.
const MARKET_CALENDAR = Object.freeze({
  firstYear: 2024,
  lastYear: 2030,
  holidays: new Set(Object.values({
  "2024": [
    "2024-01-01",
    "2024-01-15",
    "2024-02-19",
    "2024-03-29",
    "2024-05-27",
    "2024-06-19",
    "2024-07-04",
    "2024-09-02",
    "2024-11-28",
    "2024-12-25"
  ],
  "2025": [
    "2025-01-01",
    "2025-01-20",
    "2025-02-17",
    "2025-04-18",
    "2025-05-26",
    "2025-06-19",
    "2025-07-04",
    "2025-09-01",
    "2025-11-27",
    "2025-12-25",
    "2025-01-09"
  ],
  "2026": [
    "2026-01-01",
    "2026-01-19",
    "2026-02-16",
    "2026-04-03",
    "2026-05-25",
    "2026-06-19",
    "2026-07-03",
    "2026-09-07",
    "2026-11-26",
    "2026-12-25"
  ],
  "2027": [
    "2027-01-01",
    "2027-01-18",
    "2027-02-15",
    "2027-03-26",
    "2027-05-31",
    "2027-06-18",
    "2027-07-05",
    "2027-09-06",
    "2027-11-25",
    "2027-12-24"
  ],
  "2028": [
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
  ],
  "2029": [
    "2029-01-01",
    "2029-01-15",
    "2029-02-19",
    "2029-03-30",
    "2029-05-28",
    "2029-06-19",
    "2029-07-04",
    "2029-09-03",
    "2029-11-22",
    "2029-12-25"
  ],
  "2030": [
    "2030-01-01",
    "2030-01-21",
    "2030-02-18",
    "2030-04-19",
    "2030-05-27",
    "2030-06-19",
    "2030-07-04",
    "2030-09-02",
    "2030-11-28",
    "2030-12-25"
  ]
}).flat())
});

function isMarketSession(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + "T12:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  const year = parsed.getUTCFullYear();
  return year >= MARKET_CALENDAR.firstYear && year <= MARKET_CALENDAR.lastYear &&
    parsed.getUTCDay() !== 0 && parsed.getUTCDay() !== 6 && !MARKET_CALENDAR.holidays.has(date);
}

function lastCompletedMarketSession(clock) {
  let parsed = new Date(clock.today + "T12:00:00Z");
  if (clock.hour < 17) parsed.setUTCDate(parsed.getUTCDate() - 1);
  for (let i = 0; i < 15; i++) {
    const date = parsed.toISOString().slice(0, 10);
    if (isMarketSession(date)) return date;
    parsed.setUTCDate(parsed.getUTCDate() - 1);
  }
  throw new Error("Review the exchange calendar: it is outside its supported range.");
}
