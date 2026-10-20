import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {EXCHANGE_CALENDAR} from '../js/backtest/calendar.mjs';
import {inspectHistory,runExperiment,sessionDates,validateConfig,validateWeights,PRESET_STRATEGIES} from '../js/backtest/lab.mjs';

const dates=sessionDates('2024-01-02','2025-12-31');
function rows(ticker='AAA',count=300,offset=0) {
  return dates.slice(offset,offset+count).map((date,index)=>{
    const close=100+index*.12+3*Math.sin(index/7),open=close-.2;
    return [date,ticker,open,close+.5,open-.5,close,1000+(index%13)*100];
  });
}
const source={confirmedOnly:true,kind:'market_history'};
function configuration(overrides={}) { return {weights:{AAA:.75,BBB:.25},strategy:PRESET_STRATEGIES.sma200,
  initialCapital:10000,commissionBps:0,slippageBps:5,startDate:dates[202],endDate:dates[280],...overrides}; }
const data=[...rows(),...rows('BBB')];

test('lab calendar matches reviewed source including extraordinary closure',async()=>{
  const original=JSON.parse(await fs.readFile(new URL('../supabase/calendar.json',import.meta.url),'utf8'));
  assert.deepEqual(EXCHANGE_CALENDAR,{firstYear:original.firstYear,lastYear:original.lastYear,holidays:original.holidays});
  assert.ok(!sessionDates('2025-01-06','2025-01-10').includes('2025-01-09'));
  assert.throws(()=>sessionDates('2023-12-29','2024-01-03'),/calendario/);
});
test('coverage exposes real eligibility and common final date',()=>{
  const result=inspectHistory([...rows(),...rows('BBB',80,180)],{weights:{AAA:.75,BBB:.25},strategy:PRESET_STRATEGIES.sma200});
  assert.equal(result.warmupBars,202);
  assert.equal(result.coverage[0].firstEligibleDate,dates[202]);
  assert.equal(result.coverage[1].firstEligibleDate,null);
  assert.equal(result.startDate,dates[202]);
  assert.equal(result.endDate,dates[259]);
  assert.ok(result.warnings.some(text=>text.includes('BBB')));
});
test('weights and cost inputs fail explicitly instead of silently optimizing',()=>{
  for (const weights of [{},{AAA:0,BBB:1},{AAA:.6,BBB:.6},{AAA:NaN},{AAA:1,BBB:-.1}]) assert.throws(()=>validateWeights(weights));
  assert.throws(()=>validateConfig(configuration({commissionBps:-1})),/Comisión/);
  assert.throws(()=>validateConfig(configuration({slippageBps:Infinity})),/Comisión/);
  assert.throws(()=>validateConfig(configuration({startDate:'2025-02-30'})),/fechas/);
});
test('experiment applies identical weights, costs, eligible dates and fixed terminal to benchmark',async()=>{
  const progress=[];
  const result=await runExperiment({rows:data,config:configuration(),source},entry=>progress.push(entry));
  assert.deepEqual(result.strategy.options.weights,result.benchmark.options.weights);
  assert.equal(result.strategy.options.warmupBars,202);
  assert.deepEqual(result.strategy.period,result.benchmark.period);
  assert.deepEqual(result.benchmark.perTicker.map(item=>item.initialCapital),[7500,2500]);
  assert.equal(result.benchmark.executions[0].date,dates[202]);
  assert.equal(result.benchmark.executions.at(-1).date,dates[280]);
  assert.ok(result.benchmark.metrics.totalCost>0);
  assert.equal(result.benchmark.metrics.commissionCost,0);
  assert.equal(result.data.coverage[0].bars,281,'cut future bars before signal generation');
  assert.equal(progress.length,2);
  assert.match(result.data.hash,/^[a-f0-9]{64}$/);
  assert.equal(result.config.strategy.preset,'sma200');
});
test('future appended rows cannot change results, fingerprint or signal history',async()=>{
  const first=await runExperiment({rows:data,config:configuration(),source});
  const future=rows('AAA',20,300).map(row=>[row[0],row[1],900,1000,800,950,2000]);
  const second=await runExperiment({rows:[...data,...future],config:configuration(),source});
  assert.deepEqual(second.strategy,first.strategy);
  assert.deepEqual(second.benchmark,first.benchmark);
  assert.equal(second.data.hash,first.data.hash);
  assert.equal(second.configurationHash,first.configurationHash);
});
test('no provisional, duplicate or malformed selected bars can enter lab',async()=>{
  await assert.rejects(runExperiment({rows:data,config:configuration(),source:{confirmedOnly:false}}),/confirmados/);
  await assert.rejects(runExperiment({rows:[...data,data[10]],config:configuration(),source}),/duplicada/);
  const provisional=data.map((row,i)=>i===50?[...row,false]:row);
  await assert.rejects(runExperiment({rows:provisional,config:configuration(),source}),/no confirmada/);
  const malformed=data.map((row,i)=>i===50?[row[0],row[1],1,2,3,4,100]:row);
  await assert.rejects(runExperiment({rows:malformed,config:configuration(),source}),/inválida/);
});
test('missing ticker, internal session and terminal close block publication',async()=>{
  await assert.rejects(runExperiment({rows:rows(),config:configuration(),source}),/BBB: no hay historial/);
  await assert.rejects(runExperiment({rows:data.filter(row=>!(row[1]==='AAA'&&row[0]===dates[230])),config:configuration(),source}),/faltan sesiones/);
  await assert.rejects(runExperiment({rows:data.filter(row=>!(row[1]==='BBB'&&row[0]>=dates[280])),config:configuration(),source}),/último cierre/);
});
test('short IPO keeps allocated money in cash without renormalizing other ticker',async()=>{
  const result=await runExperiment({rows:[...rows(),...rows('BBB',41,240)],config:configuration(),source});
  const cash=result.benchmark.perTicker.find(item=>item.ticker==='BBB');
  assert.equal(cash.initialCapital,2500);
  assert.equal(cash.finalEquity,2500);
  assert.equal(cash.tradeCount,0);
  assert.equal(result.strategy.perTicker.find(item=>item.ticker==='BBB').finalEquity,2500);
  assert.ok(result.data.warnings.some(text=>text.includes('BBB')&&text.includes('efectivo')));
});
test('identical single-ticker input produces exactly identical experiments',async()=>{
  const config=configuration({weights:{AAA:1},strategy:PRESET_STRATEGIES.v3});
  const first=await runExperiment({rows:rows(),config,source});
  const second=await runExperiment({rows:rows(),config,source});
  assert.deepEqual(first.strategy,second.strategy);
  assert.deepEqual(first.benchmark,second.benchmark);
  assert.equal(first.configurationHash,second.configurationHash);
  const restored=await runExperiment({rows:first.snapshot.rows,config:first.config,source:first.snapshot});
  assert.equal(restored.configurationHash,first.configurationHash);
  assert.deepEqual(restored.strategy,first.strategy);
});
test('no eligible trade and dates before coverage reject rather than present flat success',async()=>{
  await assert.rejects(runExperiment({rows:rows('AAA',80),config:configuration({weights:{AAA:1},startDate:dates[55],endDate:dates[79]}),source}),/aperturas elegibles/);
  await assert.rejects(runExperiment({rows:data,config:configuration({startDate:'2024-01-01'}),source}),/historial disponible/);
});
