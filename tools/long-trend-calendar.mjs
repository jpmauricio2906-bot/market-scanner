// NYSE daily sessions for the preregistered 2008–2015 long-trend experiment.
// Warm-up starts in 2006. Early-close sessions remain tradable daily bars.
const iso = d => d.toISOString().slice(0, 10);
const date = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12));
function nth(y, m, weekday, n) {
  const d = date(y, m, 1);
  d.setUTCDate(1 + (weekday - d.getUTCDay() + 7) % 7 + 7 * (n - 1));
  return iso(d);
}
function lastMonday(y, m) {
  const d = date(y, m + 1, 0);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return iso(d);
}
function observed(y, m, day) {
  const d = date(y, m, day);
  if (d.getUTCDay() === 6) d.setUTCDate(day - 1);
  if (d.getUTCDay() === 0) d.setUTCDate(day + 1);
  return iso(d);
}
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4),
    e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return date(y, Math.floor((h + l - 7 * m + 114) / 31), (h + l - 7 * m + 114) % 31 + 1);
}

export function longTrendCalendar() {
  const holidays = new Set(['2007-01-02', '2012-10-29', '2012-10-30']);
  for (let y = 2006; y <= 2015; y++) {
    // NYSE does not observe Saturday New Year's Day on the preceding Dec 31.
    if (date(y, 1, 1).getUTCDay() !== 6) holidays.add(observed(y, 1, 1));
    for (const holiday of [
      nth(y, 1, 1, 3), nth(y, 2, 1, 3), lastMonday(y, 5), observed(y, 7, 4),
      nth(y, 9, 1, 1), nth(y, 11, 4, 4), observed(y, 12, 25),
    ]) holidays.add(holiday);
    const goodFriday = easter(y);
    goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
    holidays.add(iso(goodFriday));
  }
  return {
    firstYear: 2006, lastYear: 2015, holidays: [...holidays].sort(),
    sources: [
      'https://www.nyse.com/markets/hours-calendars',
      // NYSE Information Memo 06-88, December 29, 2006, confirms Ford closure.
      'https://www.nyse.com/publicdocs/nyse/regulation/nyse/NYSE_Rules.pdf',
      // SEC Release 34-69077 records both Hurricane Sandy closure dates.
      'https://www.sec.gov/file/proposed-rule-release-no-34-69077',
    ],
  };
}
