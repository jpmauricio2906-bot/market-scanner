import test from 'node:test';
import assert from 'node:assert/strict';
import {validationCalendar} from '../tools/validation-calendar.mjs';
import {marketDates} from '../tools/backtest.mjs';
test('locked calendar retains open Dec31, adopts Juneteenth in2022, and includes national mourning',()=>{
  const dates=marketDates(validationCalendar(),'2016-01-01','2023-12-31');
  assert.equal(dates.length,2012);
  assert.ok(dates.includes('2021-12-31'));assert.ok(dates.includes('2021-06-18'));
  for(const d of ['2018-12-05','2022-06-20','2023-06-19','2020-04-10'])assert.ok(!dates.includes(d),d);
  assert.deepEqual([2018,2019,2020,2021,2022,2023].map(y=>dates.filter(d=>d.startsWith(String(y))).length),[251,252,253,252,251,250]);
});
