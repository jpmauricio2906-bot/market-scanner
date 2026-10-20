// One fixed candidate, a previously unused historical holdout, and explicit
// disclosure that this is NOT prospective or chronologically independent OOS.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildValidationPanel} from './validation-panel.mjs';
import {runPortfolio} from './backtest-execution.mjs';
import {marketDates,blockBootstrapDifference,csv} from './backtest.mjs';
import {validationCalendar} from './validation-calendar.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const hash=x=>createHash('sha256').update(x).digest('hex');
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2;};
const buys=new Set(['BUY','STRONG_BUY']),sells=new Set(['SELL','STRONG_SELL']);

export function noSignalExits(panel){return {...panel,series:panel.series.map(s=>({...s,signals:s.signals.map(row=>({...row,oldSignal:sells.has(row.oldSignal)?'HOLD':row.oldSignal}))}))};}

// Production indicators consume quote OHLC. Dividend-adjusted bars are only a
// synthetic valuation/execution proxy; they must never silently change signals.
export function executionBarsWithSignals(returnPanel,signalPanel){
  if(!Array.isArray(returnPanel?.series)||!Array.isArray(signalPanel?.series)||returnPanel.series.length!==signalPanel.series.length)throw Error('Signal and return universes must match.');
  const lookup=new Map(signalPanel.series.map(s=>[s.ticker,s]));
  if(lookup.size!==signalPanel.series.length||new Set(returnPanel.series.map(s=>s.ticker)).size!==returnPanel.series.length)throw Error('Duplicate ticker in aligned panels.');
  const series=returnPanel.series.map(returns=>{
    const signals=lookup.get(returns.ticker);
    if(!signals||!Array.isArray(returns.bars)||!Array.isArray(signals.bars)||!Array.isArray(signals.signals)||returns.bars.length!==signals.bars.length||signals.signals.length!==signals.bars.length)throw Error('Misaligned signal and return history: '+returns.ticker);
    returns.bars.forEach((bar,i)=>{if(bar.date!==signals.bars[i].date||signals.signals[i].date!==bar.date)throw Error('Misaligned signal and return date: '+returns.ticker);});
    return {...returns,signals:signals.signals};
  });
  return {...returnPanel,series,metadata:{...returnPanel.metadata,kind:'quote-signals-with-adjusted-return-bars',
    signalSource:{priceBasis:'provider-quote',inputSha256:signalPanel.metadata?.inputSha256,cacheKey:signalPanel.metadata?.cacheKey},
    returnSource:{priceBasis:'adjclose-ratio',inputSha256:returnPanel.metadata?.inputSha256,cacheKey:returnPanel.metadata?.cacheKey},
    priceBasisNote:'Signals are reconstructed from production quote OHLC; only execution and valuation use synthetic adjusted OHLC.'}};
}

export function exclusiveEvents(panel,{startDate,endDate,calendarDates,commissionBps=0,slippageBps=5,horizons=[5,10,20]}){
  if(!Array.isArray(horizons)||!horizons.length||horizons.some(h=>!Number.isSafeInteger(h)||h<1)||new Set(horizons).size!==horizons.length)throw Error('Invalid event horizons.');
  if([commissionBps,slippageBps].some(x=>!Number.isFinite(x)||x<0||x>=10000))throw Error('Invalid event costs.');
  const index=new Map(calendarDates.map((d,i)=>[d,i])),fee=commissionBps/10000,slip=slippageBps/10000;
  const factor=(1-slip)*(1-fee)/((1+slip)*(1+fee));
  const summaries=[],events=[];
  for(const model of ['old','new'])for(const direction of ['buy','sell'])for(const category of ['all','ordinary','confirmed'])for(const horizon of horizons){
    const selected=[],base=direction==='buy'?'BUY':'SELL';
    const qualifies=s=>category==='all'?(s===base||s==='STRONG_'+base):s===(category==='ordinary'?base:'STRONG_'+base);
    for(const {ticker,bars,signals} of panel.series){
      let nextAllowed=-1;
      for(let i=49;i+1+horizon<bars.length;i++){
        const entryIndex=i+1,exitIndex=entryIndex+horizon,entry=bars[entryIndex],exit=bars[exitIndex];
        if(entry.date<startDate||exit.date>endDate||entryIndex<nextAllowed||!qualifies(signals[i][model+'Signal']))continue;
        if(i>0&&qualifies(signals[i-1][model+'Signal'])&&entry.date!==startDate)continue;
        if(!index.has(entry.date)||!index.has(exit.date)||index.get(entry.date)!==index.get(bars[i].date)+1||index.get(exit.date)!==index.get(entry.date)+horizon)continue;
        const ratio=exit.open/entry.open;
        const event={model,direction,category,horizon,ticker,signalDate:bars[i].date,entryDate:entry.date,exitDate:exit.date,
          assetReturn:ratio-1,outcome:direction==='buy'?ratio*factor-1:factor-ratio};
        selected.push(event);events.push(event);nextAllowed=exitIndex;
      }
    }
    const outcomes=selected.map(x=>x.outcome),tickers=new Set(selected.map(x=>x.ticker)).size;
    summaries.push({model,direction,category,horizon,count:selected.length,tickers,meanOutcome:mean(outcomes),medianOutcome:median(outcomes),
      positiveFraction:outcomes.length?outcomes.filter(x=>x>0).length/outcomes.length:null,
      insufficientConfirmedSample:category==='confirmed'&&(selected.length<50||tickers<10)});
  }
  return {summaries,events,interpretation:'Ordinary and confirmed categories are exclusive labels, but their windows can overlap across categories and tickers. ALL includes both. SELL = sell/cash/rebuy advantage versus holding in initial-value units; not short return. Descriptive correlated events, not independent trials.'};
}

function annotate(run,basis){run.assumptions={...run.assumptions,priceReturnOnly:basis!=='provider-adjusted',dividendsIncluded:basis==='provider-adjusted',priceBasis:basis,
  adjustment:basis==='provider-adjusted'?'Synthetic OHLC multiplied by provider adjclose/close; total-return proxy, not literal historical execution prices.':'Quoted OHLC without cash dividends.'};return run;}
function threeRuns(panel,options,basis){return Object.fromEntries(['old','new','buy_hold'].map(strategy=>[strategy,annotate(runPortfolio(panel,{...options,strategy}),basis)]));}
function compact(id,runs){return Object.entries(runs).map(([strategy,run])=>({scenario:id,strategy,...run.period,...run.options,...run.metrics,inactiveTickers:run.dataQuality.inactiveTickers.join('|')}));}

export function evaluateCandidate(panel,{protocol,universe,calendar=validationCalendar(),pricePanel=null,developmentPanel=null,developmentCalendar=null}={}){
  if(pricePanel)panel=executionBarsWithSignals(panel,pricePanel);
  const calendarDates=marketDates(calendar,protocol.historicalHoldout.warmupStart,protocol.historicalHoldout.end);
  const spy=panel.series.find(x=>x.ticker==='SPY');
  if(!spy||JSON.stringify(spy.bars.map(b=>b.date))!==JSON.stringify(calendarDates))throw Error('SPY provider dates do not match the complete expected holdout/warmup exchange calendar.');
  const common={startDate:protocol.historicalHoldout.start,endDate:protocol.historicalHoldout.end,calendarDates,
    initialCapital:protocol.execution.initialCapital,commissionBps:protocol.execution.commissionBpsPerSide,slippageBps:protocol.execution.primarySlippageBpsPerSide};
  const main=threeRuns(panel,common,'provider-adjusted');
  main.v2_buy_no_exit=annotate(runPortfolio(noSignalExits(panel),{...common,strategy:'old'}),'provider-adjusted');
  const scenarios=[];
  const compare=(id,selected=panel,overrides={},basis='provider-adjusted')=>{const runs=threeRuns(selected,{...common,...overrides},basis);scenarios.push(...compact(id,runs));return runs;};
  for(const slip of protocol.execution.sensitivitySlippageBpsPerSide)compare('slippage_'+slip+'bps',panel,{slippageBps:slip});
  compare('forced_initial_buy',panel,{initialPosition:'long'});
  for(const period of protocol.fixedSubperiods)compare(period.id,panel,{startDate:period.start,endDate:period.end});
  const metadata=new Map(universe.instruments.map(x=>[x.ticker,x]));
  for(const [id,predicate] of [['stocks',x=>x.type==='STOCK'],['etf_1x',x=>x.type==='ETF'&&x.dailyLeverage===1],
    ['leveraged_inverse_etf',x=>x.type==='ETF'&&x.dailyLeverage!==1],['SPY',x=>x.ticker==='SPY']]){
    const subset={...panel,series:panel.series.filter(s=>predicate(metadata.get(s.ticker)))};
    if(subset.series.some(s=>s.bars.length))compare(id,subset);
  }
  if(pricePanel)compare('quoted_prices_no_dividends',pricePanel,{},'quote');
  let development=null;
  if(developmentPanel){
    const {start,end}=protocol.knownDevelopmentPeriod;
    development=compare('known_development_NOT_OOS',developmentPanel,{startDate:start,endDate:end,
      calendarDates:marketDates(developmentCalendar,developmentPanel.metadata.firstBarDate??'2024-10-18',end)},'quote');
  }
  const events=exclusiveEvents(panel,common),oldByTicker=new Map(main.old.perTicker.map(x=>[x.ticker,x])),holdByTicker=new Map(main.buy_hold.perTicker.map(x=>[x.ticker,x]));
  const perTicker=main.new.perTicker.map(row=>({ticker:row.ticker,inactive:row.inactive,v2Return:oldByTicker.get(row.ticker).totalReturn,
    v3Return:row.totalReturn,buyHoldReturn:holdByTicker.get(row.ticker).totalReturn,
    differenceVsV2:row.totalReturn-oldByTicker.get(row.ticker).totalReturn,differenceVsBuyHold:row.totalReturn-holdByTicker.get(row.ticker).totalReturn,
    v2Trades:oldByTicker.get(row.ticker).tradeCount,v3Trades:row.tradeCount,v3Drawdown:row.maxDrawdown,v3Costs:row.totalCost}));
  const distribution={old:{},new:{}};let conflictingV2BuyWithV3Sell=0;
  for(const {signals} of panel.series)for(const row of signals){if(row.date<common.startDate||row.date>common.endDate)continue;
    for(const model of ['old','new'])distribution[model][row[model+'Signal']]=(distribution[model][row[model+'Signal']]??0)+1;
    if(buys.has(row.oldSignal)&&sells.has(row.newSignal))conflictingV2BuyWithV3Sell++;
  }
  const scenarioBeatsHold=id=>{const rows=scenarios.filter(x=>x.scenario===id);return rows.find(x=>x.strategy==='new').totalReturn>rows.find(x=>x.strategy==='buy_hold').totalReturn;};
  return {schemaVersion:1,kind:'locked-historical-holdout-NOT-prospective-OOS',protocol,input:panel.metadata,quality:panel.quality,signalsUseQuotedPrices:Boolean(pricePanel),
    settings:common,main,scenarios,perTicker,eventStudy:events,signalDistribution:distribution,conflictingV2BuyWithV3Sell,
    development,criterion:{primaryNetReturnBeatsBuyHold:main.new.metrics.totalReturn>main.buy_hold.metrics.totalReturn,
      bothFixedSubperiodsBeatBuyHold:protocol.fixedSubperiods.every(p=>scenarioBeatsHold(p.id)),at10bpsBeatsBuyHold:scenarioBeatsHold('slippage_10bps'),
      prospectiveValidated:false},
    pairedTickers:{count:perTicker.length,active:perTicker.filter(x=>!x.inactive).length,newBeatsV2:perTicker.filter(x=>x.differenceVsV2>1e-10).length,
      newBeatsBuyHold:perTicker.filter(x=>x.differenceVsBuyHold>1e-10).length,medianDifferenceVsV2:median(perTicker.map(x=>x.differenceVsV2)),medianDifferenceVsBuyHold:median(perTicker.map(x=>x.differenceVsBuyHold))},
    uncertainty:{newVsV2:blockBootstrapDifference(main.new.equityCurve,main.old.equityCurve),newVsBuyHold:blockBootstrapDifference(main.new.equityCurve,main.buy_hold.equityCurve)}};
}

export async function main(args=process.argv.slice(2)){
  const options={};for(let i=0;i<args.length;i+=2){if(!['--input','--price-input','--development-input','--output'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('Usage: --input adjusted.json --price-input quote.json --development-input known.json --output DIRECTORY');options[args[i]]=args[i+1];}
  for(const key of ['--input','--price-input','--development-input','--output'])if(!options[key])throw Error('Missing '+key);
  const output=path.resolve(options['--output']);await fs.mkdir(output,{recursive:true});
  const inputPaths=[options['--input'],options['--price-input'],options['--development-input']].map(x=>path.resolve(x));
  const names=['historical-panel.json','quote-panel.json','development-panel.json','freeze.json','results.json','trades.csv','executions.csv','equity.csv','events.csv','scenarios.csv','per-ticker.csv'];
  if(names.some(n=>inputPaths.some(p=>path.join(output,n).toLowerCase()===p.toLowerCase())))throw Error('Output would overwrite an input.');
  const rawInputs=await Promise.all(inputPaths.map(p=>fs.readFile(p)));
  const documents=rawInputs.map(x=>JSON.parse(x.toString('utf8').replace(/^\uFEFF/,'')));
  const protocol=JSON.parse(await fs.readFile(path.join(root,'data/validation/exit-v3-protocol.json'),'utf8'));
  const universe=JSON.parse(await fs.readFile(path.join(root,'data/universe.json'),'utf8'));
  const sourceFiles=['js/scoring.js','tools/baselines/scoring-v2.cjs','tools/validation-panel.mjs','tools/backtest-execution.mjs','tools/audit-scoring.mjs','tools/backtest.mjs','tools/validation-calendar.mjs','tools/validate-exits.mjs','tools/fetch-validation-history.mjs','data/validation/exit-v3-protocol.json','data/universe.json','supabase/calendar.json'];
  const sources=Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,hash(await fs.readFile(path.join(root,f)))])));
  const fingerprint={sources,inputHashes:rawInputs.map(hash),protocolVersion:protocol.candidateVersion};
  const fingerprintHash=hash(JSON.stringify(fingerprint)),freezePath=path.join(output,'freeze.json');
  let freeze;try{freeze=JSON.parse(await fs.readFile(freezePath,'utf8'));if(freeze.fingerprintHash!==fingerprintHash)throw Error('Frozen inputs or source changed. Preserve prior experiment and use a new output directory with an explanation.');}
  catch(error){if(error.code!=='ENOENT')throw error;freeze={createdAt:new Date().toISOString(),beforeComputingHoldoutReturns:true,fingerprintHash,...fingerprint};await fs.writeFile(freezePath,JSON.stringify(freeze,null,2)+'\n',{flag:'wx'});}
  const expectedTickers=universe.instruments.map(x=>x.ticker);
  async function panelAt(i){
    const filename=path.join(output,names[i]);const signature=hash(JSON.stringify({input:fingerprint.inputHashes[i],sources:{engine:sources['js/scoring.js'],baseline:sources['tools/baselines/scoring-v2.cjs'],panel:sources['tools/validation-panel.mjs'],normalizer:sources['tools/audit-scoring.mjs']},expectedTickers,historyDays:500,minSignalDays:50}));
    try{const cached=JSON.parse(await fs.readFile(filename,'utf8'));if(cached.metadata?.rootCacheSignature!==signature)throw Error('Incompatible signal cache: '+filename);return cached;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const panel=await buildValidationPanel(documents[i],{inputSha256:fingerprint.inputHashes[i],expectedTickers,workers:4,onProgress:p=>{if(p.completedTickers%25===0)process.stderr.write(`${names[i]} ${p.completedTickers}/${p.totalTickers}\n`);}});
    panel.metadata.rootCacheSignature=signature;await fs.writeFile(filename,JSON.stringify(panel));return panel;
  }
  const panel=await panelAt(0),pricePanel=await panelAt(1),developmentPanel=await panelAt(2);
  const developmentCalendar=JSON.parse(await fs.readFile(path.join(root,'supabase/calendar.json'),'utf8'));
  const result=evaluateCandidate(panel,{protocol,universe,pricePanel,developmentPanel,developmentCalendar});result.freeze=freeze;
  const runs=Object.entries(result.main);
  const trades=runs.flatMap(([model,run])=>run.trades.map(row=>({model,...row})));
  const executions=runs.flatMap(([model,run])=>run.executions.map(row=>({model,...row})));
  const curves=runs.flatMap(([model,run])=>run.equityCurve.map(row=>({model,...row})));
  await Promise.all([['results.json',JSON.stringify({...result,eventStudy:{...result.eventStudy,events:undefined}},null,2)+'\n'],
    ['trades.csv',csv(trades)],['executions.csv',csv(executions)],['equity.csv',csv(curves)],['events.csv',csv(result.eventStudy.events)],
    ['scenarios.csv',csv(result.scenarios)],['per-ticker.csv',csv(result.perTicker)]].map(([f,body])=>fs.writeFile(path.join(output,f),body)));
  process.stdout.write(JSON.stringify({period:result.main.new.period,main:Object.fromEntries(runs.map(([k,r])=>[k,r.metrics])),criterion:result.criterion,pairedTickers:result.pairedTickers,uncertainty:result.uncertainty})+'\n');return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
