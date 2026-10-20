import test from 'node:test';
import assert from 'node:assert/strict';
import { runPortfolio } from '../js/backtest/execution.mjs';
import { runPortfolio as historicalRun } from '../tools/backtest-execution.mjs';

const date = index => new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function series(ticker, end = 55) {
  return { ticker, bars: Array.from({ length: end }, (_, i) => ({ date: date(i), open: 100, close: 100 })),
    signals: Array.from({ length: end }, (_, i) => ({ date: date(i), newSignal: i === 49 ? 'BUY' : i === 51 ? 'SELL' : i === 52 ? 'STRONG_BUY' : 'HOLD', oldSignal: i === 49 ? 'BUY' : 'HOLD' })) };
}
const options = extra => ({ initialCapital: 1000, commissionBps: 13, slippageBps: 7,
  startDate: date(50), endDate: date(54), calendarDates: Array.from({ length: 55 }, (_, i) => date(i)), ...extra });

test('the browser engine exactly preserves frozen execution without custom weights', () => {
  const a = series('AAA'), b = series('BBB'), empty = { ticker: 'EMPTY', bars: [], signals: [] };
  a.bars[53].open = 120; a.bars[54].close = 130; b.bars[52].open = 80;
  for (const strategy of ['old', 'new', 'buy_hold']) for (const initialPosition of ['cash', 'long']) {
    const panel = { series: [a, b, empty] }, selected = options({ strategy, initialPosition });
    assert.deepEqual(runPortfolio(panel, selected), historicalRun(panel, selected));
  }
});

test('explicit equal fractions give exactly the original books, including repeating fractions', () => {
  const panel = { series: [series('AAA'), series('BBB'), series('CCC')] };
  for (const strategy of ['new', 'buy_hold']) {
    const original = historicalRun(panel, options({ strategy }));
    const result = runPortfolio(panel, options({ strategy, weights: { AAA: 1 / 3, BBB: 1 / 3, CCC: 1 / 3 } }));
    for (const field of ['metrics', 'equityCurve', 'trades', 'executions', 'perTicker', 'period']) assert.deepEqual(result[field], original[field]);
  }
});

test('asymmetric weights reconcile every daily value with independent subbooks and identical benchmark costs', () => {
  const a = series('AAA'), b = series('BBB');
  a.bars[51].close = 120; a.bars[52].open = 120; a.bars[54].close = 150;
  b.bars[51].close = 80; b.bars[52].open = 80; b.bars[54].close = 60;
  const panel = { series: [a, b] }, original = structuredClone(panel);
  for (const strategy of ['new', 'buy_hold']) {
    const result = runPortfolio(panel, options({ strategy, weights: { AAA: 0.8, BBB: 0.2 } }));
    const sub = [historicalRun({ series: [a] }, options({ strategy, initialCapital: 800 })),
      historicalRun({ series: [b] }, options({ strategy, initialCapital: 200 }))];
    for (const field of ['finalEquity', 'netProfit', 'commissionCost', 'slippageCost', 'totalCost']) near(result.metrics[field], sub[0].metrics[field] + sub[1].metrics[field]);
    result.equityCurve.forEach((row, index) => {
      for (const field of ['equity', 'cash', 'investedValue', 'commissionCost', 'slippageCost']) near(row[field], sub[0].equityCurve[index][field] + sub[1].equityCurve[index][field]);
    });
    assert.deepEqual(result.perTicker, sub.flatMap(run => run.perTicker));
    near(result.metrics.totalReturn, 0.8 * sub[0].metrics.totalReturn + 0.2 * sub[1].metrics.totalReturn);
    const peak = Math.max(1000, ...result.equityCurve.map(row => row.equity));
    assert.ok(peak >= 1000);
  }
  assert.deepEqual(panel, original);
});

test('weighted benchmark return follows buy-and-hold rather than daily rebalancing', () => {
  const a = series('AAA'), b = series('BBB');
  a.bars[50].close = 200; a.bars[54].close = 200;
  b.bars[50].close = 50; b.bars[54].close = 50;
  const result = runPortfolio({ series: [a, b] }, options({ strategy: 'buy_hold', weights: { AAA: 0.75, BBB: 0.25 }, commissionBps: 0, slippageBps: 0 }));
  near(result.metrics.finalEquity, 1625);
  near(result.metrics.totalReturn, 0.625);
  assert.equal(result.executions.length, 4);
  assert.deepEqual(result.perTicker.map(row => row.initialCapital), [750, 250]);
});

test('weighted inactive allocation stays in cash and pays no costs', () => {
  const result = runPortfolio({ series: [series('AAA'), { ticker: 'MISSING', bars: [], signals: [] }] }, options({ weights: { AAA: 0.2, MISSING: 0.8 } }));
  assert.equal(result.perTicker[1].initialCapital, 800);
  assert.equal(result.perTicker[1].finalEquity, 800);
  assert.equal(result.perTicker[1].netProfit, 0);
  assert.equal(result.perTicker[1].totalCost, 0);
  assert.ok(result.equityCurve.every(row => row.cash >= 800));
  assert.match(result.dataQuality.warnings[0], /custom initial allocations/);
});

test('explicit weights reject omissions, extra keys, zero, negatives, nonfinite and wrong totals', () => {
  const panel = { series: [series('AAA'), series('BBB')] };
  for (const weights of [null, [], {}, { AAA: 1 }, { AAA: .5, BBB: .5, CCC: .1 },
    { AAA: 0, BBB: 1 }, { AAA: -.1, BBB: 1.1 }, { AAA: NaN, BBB: .5 },
    { AAA: Infinity, BBB: .5 }, { AAA: '0.5', BBB: .5 }, { AAA: .4, BBB: .5 }]) {
    assert.throws(() => runPortfolio(panel, options({ weights })), /weights/);
  }
  const weights = { AAA: .8, BBB: .2 };
  runPortfolio(panel, options({ weights })); assert.deepEqual(weights, { AAA: .8, BBB: .2 });
});

test('a missing session never executes a stale buy; stale terminal marks remain identified', () => {
  const a = series('AAA'), b = series('BBB');
  a.bars.splice(50, 1); a.signals.splice(50, 1);
  const result = runPortfolio({ series: [a, b] }, options({ weights: { AAA: .7, BBB: .3 } }));
  assert.equal(result.dataQuality.staleSignalSkips, 1);
  assert.equal(result.executions.some(row => row.ticker === 'AAA' && row.date === date(51)), false);
  const lastMissing = series('AAA'); lastMissing.bars.pop(); lastMissing.signals.pop();
  const stale = runPortfolio({ series: [lastMissing, b] }, options({ weights: { AAA: .7, BBB: .3 } }));
  assert.deepEqual(stale.dataQuality.staleTerminalTickers, ['AAA']);
  assert.equal(stale.metrics.syntheticTerminalExits, 1);
  assert.equal(stale.trades.at(-2).exitIsExecutable, false);
});

test('calendar, dates, execution prices and costs are validated before weighted execution', () => {
  const panel = { series: [series('AAA')] };
  assert.throws(() => runPortfolio(panel, options({ calendarDates: [date(50), date(50)] })), /calendarDates/);
  assert.throws(() => runPortfolio(panel, options({ calendarDates: options().calendarDates.slice(1) })), /outside/);
  assert.throws(() => runPortfolio(panel, options({ commissionBps: -1 })), /commissionBps/);
  assert.throws(() => runPortfolio(panel, options({ slippageBps: 10000 })), /slippageBps/);
  assert.throws(() => runPortfolio(panel, options({ initialCapital: 0 })), /initialCapital/);
  assert.throws(() => runPortfolio(panel, options({ startDate: date(54), endDate: date(50) })), /date range/);
});
