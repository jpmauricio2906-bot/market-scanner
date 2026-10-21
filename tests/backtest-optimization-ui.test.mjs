import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseDiscreteValues,suggestedSplit,optimizationEarliestStart,readExplorationHistory,explorationOverlap,recordExploration,selectedOptimizationResult,EXPLORATION_STORAGE_KEY} from '../js/backtest/optimization-ui.mjs';
import {PRESET_STRATEGIES,sessionDates} from '../js/backtest/lab.mjs';
import {OPTIMIZATION_DEFAULTS,partitionOptimizationDates} from '../js/backtest/optimization.mjs';
import {optimizationTranslations,localizeOptimizationMessage} from '../js/backtest/optimization-translations.mjs';
import {localizeMessage} from '../js/backtest/message-translations.mjs';
const storage = () => {const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};};

test('discrete search inputs reject empty fields, decimal commas and nonnumeric code',()=>{
  assert.deepEqual(parseDiscreteValues('55, 60, 65, 60'),[55,60,65]);
  assert.deepEqual(parseDiscreteValues('-1.5, 0, .5'),[-1.5,0,.5]);
  for(const value of ['', '1,,2','1,','Infinity','0x20','1e3','Math.random()','1;2',Array(13).fill('1').join(',')]) assert.throws(()=>parseDiscreteValues(value));
});

test('default split uses chronological exchange sessions and retains an independent final block',()=>{
  const config={startDate:'2016-10-20',endDate:'2026-10-20'};
  const split=suggestedSplit(config.startDate,config.endDate),phases=partitionOptimizationDates(config,split);
  const dates=sessionDates(config.startDate,config.endDate);
  assert.equal(phases.train.sessions,Math.floor(dates.length*.6));
  assert.equal(phases.validation.sessions,Math.floor(dates.length*.8)-Math.floor(dates.length*.6));
  assert.equal(phases.test.sessions,dates.length-Math.floor(dates.length*.8));
  assert.ok(phases.train.endDate<phases.validation.startDate && phases.validation.endDate<phases.test.startDate);
});

test('suggested eligibility respects the largest searched warmup and the latest listing',()=>{
  const dates=sessionDates('2015-01-02','2018-12-31');
  const rows=[...dates.map(date=>[date,'A']),...dates.slice(30).map(date=>[date,'B'])];
  const config={weights:{A:.5,B:.5},strategy:PRESET_STRATEGIES.sma200};
  assert.deepEqual(optimizationEarliestStart(rows,config,OPTIMIZATION_DEFAULTS),{date:dates[284],warmupBars:254});
  assert.deepEqual(optimizationEarliestStart(rows,config,{...OPTIMIZATION_DEFAULTS,optimizeParameters:false}),{date:dates[232],warmupBars:202});
  assert.equal(optimizationEarliestStart(rows.slice(0,20),config,OPTIMIZATION_DEFAULTS),null);
});

test('exposure ledger tracks changed holdouts, earlier training views and ordinary backtests',()=>{
  const saved=storage();
  const first=recordExploration(saved,{startDate:'2016-01-01',endDate:'2026-01-01',mode:'optimization'},{startDate:'2024-01-01',endDate:'2026-01-01'});
  assert.equal(first.previousOverlappingViews,0);
  // A later test moved into the old training block was still already viewed.
  const second=recordExploration(saved,{startDate:'2015-01-01',endDate:'2020-01-01',mode:'optimization'},{startDate:'2018-01-01',endDate:'2020-01-01'});
  assert.equal(second.previousOverlappingViews,1);
  recordExploration(saved,{startDate:'2019-01-01',endDate:'2022-01-01',mode:'backtest'});
  assert.equal(explorationOverlap(readExplorationHistory(saved),'2019-06-01','2019-07-01'),3);
  assert.equal(explorationOverlap(readExplorationHistory(saved),'2030-01-01','2031-01-01'),0);
  assert.equal(readExplorationHistory(saved).totalViews,3);
});

test('missing or corrupt browser storage never certifies an unviewed test period',()=>{
  const broken={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
  assert.equal(readExplorationHistory(broken).available,false);
  assert.equal(recordExploration(broken,{startDate:'2020-01-01',endDate:'2021-01-01'}).previousOverlappingViews,null);
  const saved=storage();saved.setItem(EXPLORATION_STORAGE_KEY,'{}');
  assert.equal(readExplorationHistory(saved).available,false);
  assert.equal(recordExploration(saved,{startDate:'2020-01-01',endDate:'2021-01-01'}).recorded,false);
});

test('selected test display preserves the full original report and maps exact selected comparators',()=>{
  const report={config:{weights:{A:1},strategy:{preset:'v3'},startDate:'2016-01-01',endDate:'2026-01-01'},
    phases:{test:{startDate:'2024-01-01',endDate:'2026-01-01'}},selection:{weights:{A:1},strategy:{preset:'custom',entryScore:65}},
    test:{selectedStrategy:{metrics:{cagr:.1}},selectedBenchmark:{metrics:{cagr:.2}},referenceStrategy:{},referenceBenchmark:{}}};
  const before=JSON.stringify(report),view=selectedOptimizationResult(report);
  assert.equal(JSON.stringify(report),before);
  assert.equal(view.config.startDate,'2024-01-01');
  assert.equal(view.strategy,report.test.selectedStrategy);assert.equal(view.benchmark,report.test.selectedBenchmark);
  assert.equal(view.config.strategy,report.selection.strategy);
  assert.equal(report.config.strategy.preset,'v3');
});

test('optimization localization covers marked controls and keeps variable placeholders intact',()=>{
  const source=readFileSync(new URL('../js/backtest/optimization-ui.mjs',import.meta.url),'utf8');
  for(const match of source.matchAll(/data-i18n="([^"$]+)"/g)) assert.ok(optimizationTranslations[match[1]],'missing translation: '+match[1]);
  for(const [spanish,english] of Object.entries(optimizationTranslations)) assert.deepEqual([...spanish.matchAll(/\{\w+\}/g)].map(m=>m[0]).sort(),[...english.matchAll(/\{\w+\}/g)].map(m=>m[0]).sort());
  assert.equal(localizeOptimizationMessage('Optimización: test necesita al menos 126 sesiones; hay 100.','en'),'Optimization: test requires at least 126 sessions; found 100.');
  assert.match(localizeOptimizationMessage('Optimización: VLO necesita 254 cierres anteriores al entrenamiento. Primera apertura elegible: 2016-10-21. Retrasa el inicio o excluye el activo.','en'),/First eligible open: 2016-10-21/);
});

test('every literal optimization diagnostic has an English translation',()=>{
  const source=readFileSync(new URL('../js/backtest/optimization.mjs',import.meta.url),'utf8');
  for (const match of source.matchAll(/throw new Error\((?:'([^']*)'|"([^"]*)")\)/g)) {
    const message=match[1]??match[2];
    assert.notEqual(localizeOptimizationMessage(localizeMessage(message,'en'),'en'),message,'untranslated: '+message);
  }
});
