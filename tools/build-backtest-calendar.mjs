/** Reviewable union of existing calendars; never rewrites frozen experiments. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { longTrendCalendar } from './long-trend-calendar.mjs';
import { validationCalendar } from './validation-calendar.mjs';

export async function buildBacktestCalendar() {
  const current = JSON.parse(await fs.readFile(new URL('../supabase/calendar.json', import.meta.url), 'utf8'));
  const historical = validationCalendar();
  return {
    ...current, firstYear: 2015, schemaVersion: 1,
    holidays: [...new Set([
      ...longTrendCalendar().holidays.filter(day => day.startsWith('2015-')),
      ...historical.holidays, ...current.holidays,
    ])].sort(),
    // Historical early closes are explicit exchange announcements. They remain
    // daily sessions and are not removed from the history coverage audit.
    earlyCloses: [
      '2015-11-27', '2015-12-24', '2016-11-25', '2017-07-03', '2017-11-24',
      '2018-07-03', '2018-11-23', '2018-12-24', '2019-07-03', '2019-11-29',
      '2019-12-24', '2020-11-27', '2020-12-24', '2021-11-26', '2022-11-25',
      '2023-07-03', '2023-11-24', ...current.earlyCloses,
    ].sort(),
    sources: [...new Set([
      'https://ir.theice.com/press/news-details/2014/NYSE-Group-2016-Holiday-Calendar-and-Early-Closings/default.aspx',
      'https://ir.theice.com/press/news-details/2016/NYSE-Group-announces-2018-and-2019-holiday-and-early-closings-calendar/default.aspx',
      'https://ir.theice.com/press/news-details/2017/NYSE-Group-Announces-2018-2019-and-2020-Holiday-and-Early-Closings-Calendar/default.aspx',
      'https://ir.theice.com/press/news-details/2020/NYSE-Group-Announces-2021-2022-and-2023-Holiday-and-Early-Closings-Calendar/default.aspx',
      ...historical.sources, ...current.sources,
    ])],
    provenance: [
      '2015 holidays: tools/long-trend-calendar.mjs (unchanged frozen experiment).',
      '2016–2023 holidays: tools/validation-calendar.mjs (includes 2018-12-05 mourning and Juneteenth from 2022).',
      '2015–2023 early closes: NYSE/ICE historical announcements listed in sources.',
      '2024–2028 holidays and early closes: supabase/calendar.json, unchanged scanner calendar.',
    ],
    review: 'Daily US equity sessions, 2015–2028. Re-review extraordinary closures before extending the published horizon; early closes count as sessions.',
  };
}

export function backtestCalendarSeed(calendar) {
  if (!Number.isSafeInteger(calendar.firstYear) || !Number.isSafeInteger(calendar.lastYear)
    || calendar.holidays.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day))) throw new Error('Invalid calendar seed');
  const holidays = calendar.holidays.map(day => `'${day}'`).join(',');
  return '-- BEGIN BACKTEST CALENDAR SEED\n'
    + '-- Generated from data/backtest-calendar.json; early closes remain sessions.\n'
    + 'insert into market_scanner.backtest_sessions(session_date)\n'
    + 'select d::date from generate_series('
    + `'${calendar.firstYear}-01-01'::date,'${calendar.lastYear}-12-31'::date,interval '1 day') d\n`
    + 'where extract(isodow from d) between 1 and 5\n'
    + ` and d::date<>all(array[${holidays}]::date[])\n`
    + 'on conflict(session_date) do nothing;\n'
    + '-- END BACKTEST CALENDAR SEED';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = new URL('../data/backtest-calendar.json', import.meta.url);
  const calendar = await buildBacktestCalendar();
  const serialized = JSON.stringify(calendar, null, 2) + '\n';
  const sqlFile = new URL('../supabase/backtest_history.sql', import.meta.url);
  const sql = await fs.readFile(sqlFile, 'utf8');
  const marker = /-- BEGIN BACKTEST CALENDAR SEED[\s\S]*?-- END BACKTEST CALENDAR SEED/;
  if (!marker.test(sql)) throw new Error('Missing backtest calendar SQL markers');
  const seededSql = sql.replace(marker, backtestCalendarSeed(calendar));
  if (process.argv.includes('--check')) {
    if (await fs.readFile(output, 'utf8') !== serialized) throw new Error('Regenerate data/backtest-calendar.json');
    if (sql.replace(/\r\n/g, '\n') !== seededSql.replace(/\r\n/g, '\n')) throw new Error('Regenerate SQL backtest calendar seed');
  } else {
    await fs.writeFile(output, serialized);
    await fs.writeFile(sqlFile, seededSql);
  }
  console.log('Backtest calendar: reviewed daily sessions 2015–2028.');
}
