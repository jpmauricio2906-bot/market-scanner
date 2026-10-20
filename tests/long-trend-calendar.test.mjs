import test from 'node:test';
import assert from 'node:assert/strict';
import { longTrendCalendar } from '../tools/long-trend-calendar.mjs';
import { marketDates } from '../tools/backtest.mjs';

test('long-trend calendar covers 2006–2015 including Ford and Sandy closures', () => {
  const dates = marketDates(longTrendCalendar(), '2006-01-01', '2015-12-31');
  assert.equal(dates.length, 2517);
  assert.deepEqual(
    Array.from({ length: 10 }, (_, i) => dates.filter(d => d.startsWith(String(2006 + i))).length),
    [251, 251, 253, 252, 252, 252, 250, 252, 252, 252],
  );
  for (const day of ['2007-01-02', '2012-10-29', '2012-10-30', '2008-03-21', '2015-07-03']) {
    assert.ok(!dates.includes(day), day);
  }
  for (const day of ['2007-01-03', '2012-10-26', '2012-10-31', '2010-12-31', '2015-06-19', '2015-11-27']) {
    assert.ok(dates.includes(day), day);
  }
  assert.equal(dates.filter(day => day >= '2008-01-02').length, 2015);
});
