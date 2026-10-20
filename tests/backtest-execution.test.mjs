import test from 'node:test';
import assert from 'node:assert/strict';
import { runPortfolio } from '../tools/backtest-execution.mjs';

const date = index => new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
const near = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) < epsilon,
  `Expected ${actual} approximately ${expected}`);
function series(ticker = 'AAA', count = 55) {
  return { ticker,
    bars: Array.from({ length: count }, (_, index) => ({ date: date(index), open: 100, high: 100, low: 100, close: 100, vol: 1000 })),
    signals: Array.from({ length: count }, (_, index) => ({ date: date(index), oldSignal: 'HOLD', newSignal: 'HOLD', entryScore: 50 }))
  };
}
const opts = (end = 54, overrides = {}) => ({ startDate: date(50), endDate: date(end),
  initialCapital: 1000, commissionBps: 0, slippageBps: 0,
  calendarDates: Array.from({ length: end + 1 }, (_, index) => date(index)), ...overrides });
function signal(item, index, value, strategy = 'new') { item.signals[index][`${strategy}Signal`] = value; }

test('both-side commissions and slippage reconcile exactly with a cash-constrained fractional round trip', () => {
  const item = series(); signal(item, 49, 'BUY'); signal(item, 50, 'SELL');
  const result = runPortfolio({ series: [item] }, opts(51, { commissionBps: 10, slippageBps: 20 }));
  const units = 1000 / (100 * 1.002 * 1.001);
  const proceeds = units * 100 * 0.998 * 0.999;
  near(result.metrics.finalEquity, proceeds);
  near(result.metrics.commissionCost, units * 100 * (1.002 + 0.998) * 0.001);
  near(result.metrics.slippageCost, units * 100 * 0.002 * 2);
  near(result.metrics.netProfit, -result.metrics.totalCost);
  assert.equal(result.metrics.signalExits, 1);
  assert.equal(result.metrics.terminalExits, 0);
  assert.equal(result.trades[0].holdingSessions, 1);
  assert.equal(result.trades[0].holdingCalendarDays, 1);
  assert.equal(result.metrics.winRate, 0);
  assert.equal(result.metrics.profitFactor, 0);
  near(result.equityCurve[0].dailyReturn, units * 100 / 1000 - 1);
});

test('a close signal executes only at the next open, using the next open price', () => {
  const item = series(); signal(item, 50, 'STRONG_BUY'); signal(item, 51, 'STRONG_SELL');
  item.bars[51].open = 120; item.bars[52].open = 90;
  const result = runPortfolio({ series: [item] }, opts(53));
  assert.equal(result.executions[0].date, date(51));
  assert.equal(result.executions[0].signalDate, date(50));
  assert.equal(result.executions[0].referencePrice, 120);
  assert.equal(result.executions[1].date, date(52));
  assert.equal(result.executions[1].referencePrice, 90);
  near(result.metrics.finalEquity, 750);
  near(result.equityCurve[0].equity, 1000);
});

test('the close immediately before the evaluation start can seed the first open', () => {
  const item = series(); signal(item, 49, 'BUY');
  const result = runPortfolio({ series: [item] }, opts(51));
  assert.equal(result.executions[0].date, date(50));
  assert.equal(result.executions[0].signalDate, date(49));
  assert.equal(result.metrics.terminalExits, 1);
});

test('missing expected sessions embargo an old actionable signal instead of buying on stale data', () => {
  const item = series('AAA', 56); signal(item, 49, 'BUY');
  item.bars.splice(50, 1); item.signals.splice(50, 1);
  const result = runPortfolio({ series: [item] }, opts(55));
  assert.equal(result.trades.length, 0);
  assert.equal(result.dataQuality.staleSignalSkips, 1);
  assert.equal(result.metrics.finalEquity, 1000);
});

test('a signal from the new bar after a gap can trade on its following contiguous session', () => {
  const item = series('AAA', 56); signal(item, 49, 'BUY'); signal(item, 51, 'BUY');
  item.bars.splice(50, 1); item.signals.splice(50, 1);
  const result = runPortfolio({ series: [item] }, opts(55));
  assert.equal(result.executions[0].date, date(52));
  assert.equal(result.executions[0].signalDate, date(51));
});

test('repeated BUY does not pyramid and HOLD, WAIT or weak entry scores do not trigger a sale', () => {
  const item = series();
  for (const index of [49, 50, 51]) signal(item, index, 'BUY');
  signal(item, 52, 'WAIT'); item.signals[52].entryScore = 0;
  const result = runPortfolio({ series: [item] }, opts());
  assert.equal(result.executions.filter(event => event.side === 'BUY').length, 1);
  assert.equal(result.metrics.signalExits, 0);
  assert.equal(result.metrics.terminalExits, 1);
  assert.equal(result.trades[0].exitDate, date(54));
});

test('SELL while flat creates no short position or costs', () => {
  const item = series();
  for (const row of item.signals) row.newSignal = 'STRONG_SELL';
  const result = runPortfolio({ series: [item] }, opts(54, { commissionBps: 25, slippageBps: 25 }));
  assert.equal(result.metrics.finalEquity, 1000);
  assert.equal(result.metrics.totalCost, 0);
  assert.equal(result.metrics.averageExposure, 0);
  assert.equal(result.metrics.winRate, null);
  assert.equal(result.metrics.profitFactor, null);
  assert.equal(result.metrics.sharpeRatio, null);
  assert.equal(result.metrics.cagr, 0);
  assert.equal(result.executions.length, 0);
});

test('the final close liquidates held positions with costs, independently of the final close signal', () => {
  const item = series(); signal(item, 49, 'BUY'); signal(item, 54, 'SELL');
  item.bars[54].close = 110;
  const result = runPortfolio({ series: [item] }, opts(54, { slippageBps: 5 }));
  assert.equal(result.trades[0].exitReason, 'terminal');
  assert.equal(result.trades[0].exitSignalDate, null);
  assert.equal(result.trades[0].exitReferencePrice, 110);
  assert.equal(result.trades[0].holdingSessions, 5);
  near(result.metrics.finalEquity, 1000 / 1.0005 * 1.1 * 0.9995);
  assert.equal(result.equityCurve.at(-1).investedValue, 0);
  assert.equal(result.metrics.averageExposure, 1);
  const flat = series(); signal(flat, 54, 'BUY');
  assert.equal(runPortfolio({ series: [flat] }, opts()).executions.length, 0);
});

test('BUY on the prior close may enter the final session, then exit its predeclared close', () => {
  const item = series(); signal(item, 53, 'BUY');
  const result = runPortfolio({ series: [item] }, opts());
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryDate, date(54));
  assert.equal(result.trades[0].exitDate, date(54));
  assert.equal(result.trades[0].holdingSessions, 1);
});

test('buy and hold waits for 50 completed bars, then ignores all signals', () => {
  const item = series(); for (const row of item.signals) row.newSignal = 'SELL';
  const result = runPortfolio({ series: [item] }, opts(54, { strategy: 'buy_hold', startDate: date(45) }));
  assert.equal(result.executions[0].date, date(50));
  assert.equal(result.executions[0].reason, 'benchmark');
  assert.equal(result.metrics.signalExits, 0);
  assert.equal(result.metrics.terminalExits, 1);
  assert.equal(result.metrics.averageExposure, 0.5);
});

test('old and new use their own aligned signal column', () => {
  const item = series(); signal(item, 49, 'BUY', 'old');
  assert.equal(runPortfolio({ series: [item] }, opts(54, { strategy: 'old' })).trades.length, 1);
  assert.equal(runPortfolio({ series: [item] }, opts(54, { strategy: 'new' })).trades.length, 0);
});

test('equal initial sleeves retain separate cash and holdings without rebalancing', () => {
  const a = series('AAA'), b = series('BBB'); signal(a, 49, 'BUY');
  a.bars[54].close = 200;
  const result = runPortfolio({ series: [a, b] }, opts());
  near(result.metrics.finalEquity, 1500);
  near(result.perTicker[0].finalEquity, 1000);
  near(result.perTicker[1].finalEquity, 500);
  near(result.trades[0].capitalInvested, 500);
});

test('missing held marks carry forward and are flagged, including synthetic terminal valuation', () => {
  const item = series(); signal(item, 49, 'BUY');
  item.bars.splice(53, 2); item.signals.splice(53, 2);
  const result = runPortfolio({ series: [item] }, opts());
  assert.equal(result.dataQuality.staleMarkSessions, 2);
  assert.deepEqual(result.dataQuality.staleTerminalTickers, ['AAA']);
  assert.equal(result.trades[0].exitMarkDate, date(52));
  assert.equal(result.trades[0].exitIsExecutable, false);
  assert.equal(result.metrics.closedTrades, 0);
  assert.equal(result.metrics.syntheticTerminalExits, 1);
  assert.equal(result.metrics.winRate, null);
  assert.equal(result.metrics.finalEquity, 1000);
});

test('changing later prices and signals does not change earlier execution or daily equity', () => {
  const original = series(); signal(original, 49, 'BUY');
  const altered = structuredClone(original); altered.bars[53].open = 500; altered.bars[53].close = 500;
  signal(altered, 53, 'SELL');
  const a = runPortfolio({ series: [original] }, opts());
  const b = runPortfolio({ series: [altered] }, opts());
  assert.deepEqual(a.equityCurve.slice(0, 3), b.equityCurve.slice(0, 3));
  assert.deepEqual(a.executions.filter(row => row.date < date(53)), b.executions.filter(row => row.date < date(53)));
});

test('drawdown is measured on daily closes against initial capital and previous peaks', () => {
  const item = series(); signal(item, 49, 'BUY');
  item.bars[50].close = 120; item.bars[51].close = 80; item.bars[52].close = 130;
  const result = runPortfolio({ series: [item] }, opts(52));
  near(result.metrics.maxDrawdown, 80 / 120 - 1);
  near(result.metrics.totalReturn, 0.3);
  near(result.metrics.cagr, 1.3 ** (365.25 / 2) - 1, 1e12);
  assert.equal(result.assumptions.riskFreeAnnualRate, 0);
  assert.equal(result.assumptions.volatilitySessionsPerYear, 252);
});

test('initial long scenario buys first eligible open, follows exits and permits later reentry', () => {
  const item = series(); signal(item, 50, 'SELL'); signal(item, 51, 'BUY');
  const result = runPortfolio({ series: [item] }, opts(54, { initialPosition: 'long' }));
  assert.deepEqual(result.executions.map(row => [row.date, row.side, row.reason]), [
    [date(50), 'BUY', 'initial_position'], [date(51), 'SELL', 'signal'],
    [date(52), 'BUY', 'signal'], [date(54), 'SELL', 'terminal']
  ]);
  assert.equal(result.executions[0].signalDate, null);
});

test('validates ambiguous bars, misaligned signals, negative costs and dates before execution', () => {
  const item = series();
  assert.throws(() => runPortfolio({ series: [item] }, opts(54, { commissionBps: -1 })), /commissionBps/);
  assert.throws(() => runPortfolio({ series: [item] }, opts(54, { startDate: '2020-02-31' })), /date range/);
  assert.throws(() => runPortfolio({ series: [item, item] }, opts()), /unique/);
  const bad = structuredClone(item); bad.signals[50].date = date(49);
  assert.throws(() => runPortfolio({ series: [bad] }, opts()), /misaligned/);
  const duplicate = structuredClone(item); duplicate.bars[50].date = date(49);
  assert.throws(() => runPortfolio({ series: [duplicate] }, opts()), /ascending/);
});

test('input is not mutated and omitted calendar is disclosed as an observed-date union', () => {
  const panel = { series: [series()] }, original = structuredClone(panel);
  const result = runPortfolio(panel, { strategy: 'buy_hold' });
  assert.deepEqual(panel, original);
  assert.equal(result.period.startDate, date(50));
  assert.equal(result.dataQuality.calendarIsObservedUnion, true);
  assert.equal(result.dataQuality.warnings.length, 1);
});
