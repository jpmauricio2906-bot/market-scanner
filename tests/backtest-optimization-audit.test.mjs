// Independent adversarial checks: selection must not consume final-test prices.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionDates} from '../js/backtest/lab.mjs';
import {strategyWarmup} from '../js/backtest/strategies.mjs';
import {runOptimization} from '../js/backtest/optimization.mjs';

const dates = sessionDates('2015-01-02', '2020-12-31').slice(0, 1100);
function asset(ticker, shift = 0) {
  return dates.map((date, index) => {
    const close = 100 + index * (.04 + shift * .01) + 12 * Math.sin((index + shift * 9) / 24) + 4 * Math.sin(index / 7);
    const open = close + .25 * Math.cos(index / 5);
    return [date, ticker, open, Math.max(open, close) + .5, Math.min(open, close) - .5, close, 10000 + index % 17 * 100];
  });
}
const rows = [...asset('AAA'), ...asset('BBB', 2)];
const config = {
  weights: {AAA: .6, BBB: .4}, initialCapital: 100000, commissionBps: 0, slippageBps: 5,
  startDate: dates[270], endDate: dates[1069],
  strategy: {preset: 'custom', entryScore: 0, trendScore: 0, momentum: 0,
    relativeVolume: 0, maxEntryExtensionAtr: 20, minEntryDistanceAtr: -20,
    strongOnly: false, exitMode: 'long_trend', exitPeriod: 100, exitConfirmations: 3, exitScore: 60}
};
const optimization = {
  trainEndDate: dates[749], validationEndDate: dates[909], candidateCount: 8, seed: 7301,
  shortlistSize: 3, objective: 'return_drawdown', drawdownPenalty: 1,
  optimizeParameters: true, optimizeEntryWeights: true, optimizeWeights: true,
  minWeight: .15, maxWeight: .85,
  searchSpace: {entryScore: [0, 40], trendScore: [0], momentum: [0], relativeVolume: [0],
    maxEntryExtensionAtr: [20], minEntryDistanceAtr: [-20], exitPeriod: [20, 250],
    exitConfirmations: [1, 10], exitScore: [60], momentumWeight: [.3, .5], positionWeight: [.2, .4]}
};
const source = {confirmedOnly: true, kind: 'backtest_history'};
const run = (changes = {}) => runOptimization({rows, config, source, optimization, ...changes});
let baselinePromise;
const baseline = () => baselinePromise ??= run();
function multiplyBarsAfter(firstDate, lastDate = config.endDate) {
  return rows.map(row => {
    if (row[0] < firstDate || row[0] > lastDate) return [...row];
    const index = dates.indexOf(row[0]);
    const multiplier = row[1] === 'AAA' ? 3 + index / 50 : .05 + (index % 5) * .01;
    return [row[0], row[1], ...row.slice(2, 6).map(value => value * multiplier), row[6] * 3];
  });
}

test('adversarial final-test prices cannot influence candidates, ranking, winner or selection hash', async () => {
  const original = await baseline();
  const changed = await run({rows: multiplyBarsAfter(dates[910])});
  assert.deepEqual(changed.trials, original.trials);
  assert.deepEqual(changed.selection, original.selection);
  assert.equal(changed.selectionHash, original.selectionHash);
  assert.notEqual(changed.configurationHash, original.configurationHash);
  assert.notEqual(changed.test.referenceBenchmark.metrics.finalEquity,
    original.test.referenceBenchmark.metrics.finalEquity);
});

test('validation mutation cannot influence the training candidate pool or training scores', async () => {
  const original = await baseline();
  const changed = await run({rows: multiplyBarsAfter(dates[750], dates[909])});
  const training = result => result.trials.map(({id, weights, strategy, train}) => ({id, weights, strategy, train}));
  assert.deepEqual(training(changed), training(original));
});

test('all final comparators use common warmup, dates, cash and both-side cost assumptions', async () => {
  const result = await baseline();
  const outputs = Object.values(result.test);
  const warmup = Math.max(...result.trials.map(candidate => strategyWarmup(candidate.strategy)));
  for (const output of outputs) {
    assert.ok(output.options.warmupBars >= warmup);
    assert.equal(output.options.warmupBars, outputs[0].options.warmupBars);
    assert.equal(output.options.initialCapital, config.initialCapital);
    assert.equal(output.options.commissionBps, config.commissionBps);
    assert.equal(output.options.slippageBps, config.slippageBps);
    assert.equal(output.options.initialPosition, 'cash');
    assert.equal(output.period.startDate, dates[910]);
    assert.equal(output.period.endDate, config.endDate);
    assert.ok(output.executions.every(event => event.date >= dates[910] && event.date <= config.endDate));
  }
  assert.deepEqual(result.test.referenceBenchmark.options.weights, config.weights);
  assert.deepEqual(result.test.selectedBenchmark.options.weights, result.selection.weights);
  assert.deepEqual(result.test.selectedStrategy.options.weights, result.selection.weights);
  assert.ok(result.test.selectedBenchmark.metrics.totalCost > 0);
  assert.ok(result.test.selectedBenchmark.executions.some(event => event.reason === 'terminal' && event.totalCost > 0));
});

test('candidate allocations remain within requested bounds and the original stays in the experiment', async () => {
  const result = await baseline();
  assert.ok(result.trials.some(candidate => candidate.id === 'original'));
  assert.ok(result.trials.length <= optimization.candidateCount);
  for (const candidate of result.trials) {
    assert.deepEqual(Object.keys(candidate.weights).sort(), ['AAA', 'BBB']);
    assert.ok(Math.abs(Object.values(candidate.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.ok(Object.values(candidate.weights).every(weight => weight >= optimization.minWeight - 1e-12 && weight <= optimization.maxWeight + 1e-12));
  }
});

test('unknown search parameters and invalid test boundaries fail before optimization', async () => {
  await assert.rejects(run({optimization: {...optimization, searchSpace: {...optimization.searchSpace, futureProfit: [100]}}}));
  await assert.rejects(run({optimization: {...optimization, validationEndDate: optimization.trainEndDate}}));
  await assert.rejects(run({optimization: {...optimization, validationEndDate: dates[1060]}}));
});

test('an asset without training warmup cannot receive weights optimized from later information', async () => {
  const missingEarlyHistory = rows.filter(row => row[1] !== 'BBB' || row[0] >= dates[500]);
  await assert.rejects(run({rows: missingEarlyHistory}));
});
