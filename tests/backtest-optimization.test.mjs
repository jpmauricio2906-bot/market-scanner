import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionDates,validateConfig,PRESET_STRATEGIES} from '../js/backtest/lab.mjs';
import {buildStrategyFeatures,buildStrategySignals,validateStrategy} from '../js/backtest/strategies.mjs';
import {runOptimization,validateOptimization,generateOptimizationCandidates,partitionOptimizationDates,OPTIMIZATION_DEFAULTS} from '../js/backtest/optimization.mjs';

const dates=sessionDates('2017-01-03','2021-12-31');
const rows=ticker=>dates.slice(0,920).map((date,index)=>{
  const close=100+index*.09+12*Math.sin(index/36)+(ticker==='BBB'?8*Math.sin(index/11):0),open=close+.15*Math.cos(index/7);
  return [date,ticker,open,Math.max(open,close)+.7,Math.min(open,close)-.7,close,1200+Math.round(450*Math.sin(index/13))];
});
const data=[...rows('AAA'),...rows('BBB')],source={confirmedOnly:true,kind:'backtest_history',priceBasis:'price_only'};
const configuration=overrides=>validateConfig({weights:{AAA:.6,BBB:.4},strategy:PRESET_STRATEGIES.sma200,
  startDate:dates[260],endDate:dates[919],initialCapital:10000,commissionBps:0,slippageBps:5,...overrides});
const settings=overrides=>({trainEndDate:dates[599],validationEndDate:dates[759],candidateCount:7,
  seed:42,shortlistSize:3,optimizeWeights:true,minWeight:.2,maxWeight:.8,optimizeEntryWeights:true,...overrides});
const payload=()=>({rows:data,config:configuration(),source,optimization:settings()});

test('optimization partitions are chronological, disjoint and enforce phase minimums',()=>{
  const phases=partitionOptimizationDates(configuration(),settings());
  assert.deepEqual(Object.values(phases).map(phase=>phase.sessions),[340,160,160]);
  assert.equal(phases.validation.startDate,dates[600]);
  assert.equal(phases.test.startDate,dates[760]);
  assert.throws(()=>partitionOptimizationDates(configuration(),settings({trainEndDate:dates[400]})),/252 sesiones/);
  assert.throws(()=>partitionOptimizationDates(configuration(),settings({validationEndDate:dates[900]})),/126 sesiones/);
  assert.throws(()=>partitionOptimizationDates(configuration(),settings({trainEndDate:dates[800]})),/ordena/);
});

test('candidate generation is seeded, bounded, unique and includes the exact original',()=>{
  const config=configuration(),options=validateOptimization(settings({candidateCount:40}),config);
  const candidates=generateOptimizationCandidates(config,options);
  assert.deepEqual(candidates,generateOptimizationCandidates(config,options));
  assert.equal(candidates.length,40);
  assert.equal(candidates[0].id,'original');
  assert.deepEqual(candidates[0].strategy,config.strategy);
  assert.deepEqual(candidates[0].weights,config.weights);
  assert.equal(new Set(candidates.map(candidate=>JSON.stringify([candidate.weights,candidate.strategy]))).size,candidates.length);
  for(const candidate of candidates) {
    assert.ok(Object.values(candidate.weights).every(weight=>weight>=.2-1e-12&&weight<=.8+1e-12));
    assert.ok(Math.abs(Object.values(candidate.weights).reduce((a,b)=>a+b)-1)<1e-12);
    const strategy=candidate.strategy;
    assert.ok(strategy.volumeWeight>=0);
    assert.ok(Math.abs(strategy.momentumWeight+strategy.positionWeight+strategy.volumeWeight-1)<1e-12);
    assert.equal(strategy.exitMode,'long_trend');
  }
  assert.notDeepEqual(candidates,generateOptimizationCandidates(config,{...options,seed:43}));
});

test('weight and parameter flags are independent and inactive ranges cannot change preset behavior',()=>{
  const config=configuration({strategy:PRESET_STRATEGIES.v3});
  const options=validateOptimization(settings({optimizeParameters:false,optimizeEntryWeights:false,
    searchSpace:{entryScore:[-999],exitPeriod:[NaN]}}),config);
  assert.deepEqual(options.searchSpace,{});
  const candidates=generateOptimizationCandidates(config,options);
  assert.ok(candidates.every(candidate=>JSON.stringify(candidate.strategy)===JSON.stringify(config.strategy)));
  const parameters=validateOptimization(settings({optimizeWeights:false,optimizeEntryWeights:false}),config);
  assert.equal(Object.hasOwn(parameters.searchSpace,'exitPeriod'),false);
  assert.equal(Object.hasOwn(parameters.searchSpace,'exitScore'),true);
  assert.ok(generateOptimizationCandidates(config,parameters).every(candidate=>candidate.strategy.exitMode==='v3'));
});

test('invalid concentration, malformed spaces, nonfinite costs and impossible entry weights fail before work',async()=>{
  const config=configuration();
  for(const optimization of [settings({minWeight:.6}),settings({maxWeight:.55}),settings({candidateCount:101}),
    settings({seed:1.5}),settings({searchSpace:{commissionBps:[0]}}),settings({searchSpace:{entryScore:[]}}),
    settings({searchSpace:{momentumWeight:[.8],positionWeight:[.4]}}),settings({searchSpace:{minEntryDistanceAtr:[5],maxEntryExtensionAtr:[2]}})]) {
    assert.throws(()=>validateOptimization(optimization,config));
  }
  await assert.rejects(runOptimization({...payload(),config:{...config,slippageBps:NaN}}),/Comisión/);
  await assert.rejects(runOptimization({...payload(),source:{confirmedOnly:false}}),/confirmados/);
  assert.equal(OPTIMIZATION_DEFAULTS.minWeight,.001);
});

test('cached features preserve every fixed signal and custom component weights affect raw scores',()=>{
  const bars=rows('AAA').slice(0,300).map(([date,ticker,open,high,low,close,vol])=>({date,open,high,low,close,vol,is_final:true}));
  const features=buildStrategyFeatures(bars,{calendarDates:dates});
  for(const strategy of [PRESET_STRATEGIES.v3,PRESET_STRATEGIES.sma200]) {
    assert.deepEqual(buildStrategySignals(bars,strategy,{calendarDates:dates,features}),buildStrategySignals(bars,strategy,{calendarDates:dates}));
    assert.deepEqual(buildStrategySignals(bars.slice(0,220),strategy,{calendarDates:dates,features}),buildStrategySignals(bars,strategy,{calendarDates:dates,features}).slice(0,220));
  }
  const custom={preset:'custom',momentumWeight:1,positionWeight:0,volumeWeight:0};
  const signals=buildStrategySignals(bars,custom,{calendarDates:dates,features});
  assert.ok(signals.slice(50).every(row=>row.rawEntryScore===row.momentum));
  assert.throws(()=>validateStrategy({...custom,volumeWeight:.1}),/sum to 1/);
});

test('optimization scores once per bar, freezes selection then reports four fair costed test comparisons',async()=>{
  let calls=0;const analyze=globalThis.MarketScoring.analyze,progress=[];
  globalThis.MarketScoring.analyze=(...args)=>{calls++;return analyze(...args);};
  let report;
  try { report=await runOptimization(payload(),entry=>progress.push(entry)); }
  finally { globalThis.MarketScoring.analyze=analyze; }
  assert.equal(calls,data.length,'causal indicators calculated once, independent of candidate count');
  assert.equal(report.trials.length,7);
  assert.equal(report.protocol.shortlistIds.length,3);
  assert.equal(report.trials.filter(trial=>trial.validation).length,3);
  assert.equal(report.protocol.commonWarmupBars,254);
  for(const trial of report.trials) assert.equal(trial.train.score,trial.train.metrics.cagr-Math.abs(trial.train.metrics.maxDrawdown));
  assert.equal(report.selection.candidateId,report.protocol.validationRanking[0]);
  const testResults=Object.values(report.test);
  for(const result of testResults) {
    assert.equal(result.period.startDate,dates[760]);
    assert.equal(result.period.endDate,dates[919]);
    assert.equal(result.options.initialCapital,10000);
    assert.equal(result.options.commissionBps,0);
    assert.equal(result.options.slippageBps,5);
    assert.equal(result.options.warmupBars,254);
    assert.equal(result.equityCurve.at(-1).investedValue,0);
    assert.equal(result.metrics.commissionCost,0);
    assert.ok(result.executions.every(execution=>execution.date>=dates[760]&&execution.date<=dates[919]));
  }
  assert.deepEqual(report.test.selectedStrategy.options.weights,report.test.selectedBenchmark.options.weights);
  assert.deepEqual(report.test.referenceStrategy.options.weights,report.test.referenceBenchmark.options.weights);
  assert.deepEqual(report.test.referenceStrategy.options.weights,configuration().weights);
  assert.ok(report.test.selectedBenchmark.metrics.totalCost>0);
  assert.equal(report.test.selectedBenchmark.executions[0].date,dates[760]);
  assert.ok(report.trials.every(trial=>!Object.hasOwn(trial,'test')),'losing candidates never receive test returns');
  assert.match(report.selectionHash,/^[a-f0-9]{64}$/);
  assert.equal(progress.filter(entry=>entry.stage==='test').length,4);
  assert.equal(progress.at(-1).stage,'test');
});

test('export replays all exact data, candidates, selection commitment and OOS execution',async()=>{
  const original=await runOptimization({...payload(),optimization:settings({candidateCount:3,shortlistSize:2})});
  const restored=await runOptimization({rows:original.snapshot.rows,config:original.config,optimization:original.optimization,source:original.snapshot});
  assert.equal(restored.configurationHash,original.configurationHash);
  assert.equal(restored.selectionHash,original.selectionHash);
  assert.deepEqual(restored.trials,original.trials);
  assert.deepEqual(restored.test,original.test);
});

test('optimization blocks insufficient IPO warmup, gaps and incomplete final coverage',async()=>{
  const input=payload();
  await assert.rejects(runOptimization({...input,rows:data.filter(row=>row[1]!=='BBB'||row[0]>=dates[50])}),/BBB necesita 254 cierres/);
  await assert.rejects(runOptimization({...input,rows:data.filter(row=>!(row[1]==='AAA'&&row[0]===dates[630]))}),/faltan sesiones/);
  await assert.rejects(runOptimization({...input,rows:data.filter(row=>!(row[1]==='AAA'&&row[0]===dates[919]))}),/último cierre/);
});
