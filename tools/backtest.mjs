// Reproducible retrospective comparison. Never fits or changes scoring thresholds.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildSignalPanel} from './backtest-signals.mjs';
import {runPortfolio} from './backtest-execution.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
function quantile(a,p){if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),i=(b.length-1)*p,j=Math.floor(i);return b[j]+(b[Math.ceil(i)]-b[j])*(i-j);}
const side=(signal,direction)=>direction==='buy'?['BUY','STRONG_BUY'].includes(signal):['SELL','STRONG_SELL'].includes(signal);
const validDate=date=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&
  Number.isFinite(Date.parse(date+'T12:00:00Z'))&&new Date(date+'T12:00:00Z').toISOString().slice(0,10)===date;

export function marketDates(calendar,first,last){
  if(first.slice(0,4)<String(calendar.firstYear)||last.slice(0,4)>String(calendar.lastYear))throw new Error('Calendar does not cover the requested period.');
  const holidays=new Set(calendar.holidays),result=[];
  for(let date=new Date(first+'T12:00:00Z');date.toISOString().slice(0,10)<=last;date.setUTCDate(date.getUTCDate()+1)){
    const iso=date.toISOString().slice(0,10);if(date.getUTCDay()!==0&&date.getUTCDay()!==6&&!holidays.has(iso))result.push(iso);
  }return result;
}

// Events are signal-family onsets, not every day of the same signal. For each
// ticker/family/horizon, overlapping holding windows are excluded. Cross-ticker
// market correlation remains: event counts are NOT independent observations.
export function eventStudy(panel,{startDate,endDate,calendarDates,commissionBps=0,slippageBps=5,horizons=[5,10,20]}={}){
  if(!Array.isArray(horizons)||!horizons.length||horizons.some(h=>!Number.isSafeInteger(h)||h<1)||new Set(horizons).size!==horizons.length){
    throw new Error('horizons must be a nonempty array of unique positive integer session counts.');
  }
  for(const [name,value] of Object.entries({commissionBps,slippageBps})){
    if(!Number.isFinite(value)||value<0||value>=10000)throw new Error(`${name} must be finite and at least 0 but below 10000 bps.`);
  }
  const indexes=new Map(calendarDates.map((d,i)=>[d,i]));
  const fee=commissionBps/10000,slip=slippageBps/10000;
  const roundTripFactor=(1-slip)*(1-fee)/((1+slip)*(1+fee));
  const summaries=[],events=[];
  for(const model of ['old','new'])for(const direction of ['buy','sell'])for(const strongOnly of (model==='new'?[false,true]:[false]))for(const horizon of horizons){
    const selected=[];
    for(const {ticker,bars,signals} of panel.series){
      let nextAllowedEntry=-1;
      const qualifies=s=>strongOnly?s===(direction==='buy'?'STRONG_BUY':'STRONG_SELL'):side(s,direction);
      for(let i=49;i+1+horizon<bars.length;i++){
        const entryIndex=i+1,exitIndex=entryIndex+horizon,entry=bars[entryIndex],exit=bars[exitIndex];
        if(entry.date<startDate||exit.date>endDate||entryIndex<nextAllowedEntry)continue;
        if(!qualifies(signals[i][model+'Signal']))continue;
        if(i>0&&qualifies(signals[i-1][model+'Signal'])&&entry.date!==startDate)continue;
        if(indexes.get(entry.date)!==indexes.get(bars[i].date)+1||indexes.get(exit.date)!==indexes.get(entry.date)+horizon)continue;
        const assetReturn=exit.open/entry.open-1;
        const event={ticker,model,direction,strongOnly,horizon,signalDate:bars[i].date,entryDate:entry.date,exitDate:exit.date,
          entryOpen:entry.open,exitOpen:exit.open,assetReturn,
          netLongReturn:(1+assetReturn)*roundTripFactor-1,
          // Sell at first open, sit in cash, repurchase at horizon open. The
          // advantage vs holding is in units of initial position value.
          exitAdvantage:roundTripFactor-(1+assetReturn)};
        selected.push(event);events.push(event);nextAllowedEntry=exitIndex;
      }
    }
    const outcomes=selected.map(e=>direction==='buy'?e.netLongReturn:e.exitAdvantage);
    summaries.push({model,direction,strongOnly,horizon,count:selected.length,tickers:new Set(selected.map(e=>e.ticker)).size,
      meanAssetReturn:mean(selected.map(e=>e.assetReturn)),meanOutcome:mean(outcomes),medianOutcome:quantile(outcomes,.5),
      positiveFraction:outcomes.length?outcomes.filter(r=>r>0).length/outcomes.length:null});
  }return {summaries,events,interpretation:'BUY outcome = net long price return. SELL outcome = sell-to-cash then rebuy advantage vs holding, net of both trades, in units of initial position value. Windows overlap across instruments and across model groups; not independent observations.'};
}

// Paired circular moving-block bootstrap preserves synchronous cross-asset
// effects by resampling aggregate portfolio return DIFFERENCES by date.
export function blockBootstrapDifference(first,second,{blockLength=20,iterations=2000,seed=20261019}={}){
  if(!Array.isArray(first)||!Array.isArray(second)||!first.length||first.length!==second.length){
    throw new Error('Bootstrap curves must be nonempty arrays with the same length and aligned dates.');
  }
  if(!Number.isSafeInteger(blockLength)||blockLength<1||!Number.isSafeInteger(iterations)||iterations<1)throw new Error('Invalid bootstrap inputs.');
  for(const [name,curve] of [['first',first],['second',second]]){
    for(let index=0;index<curve.length;index++){
      const row=curve[index];
      if(!row||!validDate(row.date)||(index>0&&row.date<=curve[index-1].date)){
        throw new Error(`Bootstrap ${name} curve must have valid unique ascending ISO dates.`);
      }
      if(!Number.isFinite(row.dailyReturn))throw new Error(`Bootstrap ${name} curve dailyReturn must be finite.`);
    }
  }
  // Dropping unmatched dates would compress time and manufacture adjacency for
  // moving blocks. Require the same complete observation sequence instead.
  if(first.some((row,index)=>row.date!==second[index].date))throw new Error('Bootstrap curves must have aligned dates.');
  const differences=first.map((row,index)=>row.dailyReturn-second[index].dailyReturn);
  if(differences.some(value=>!Number.isFinite(value)))throw new Error('Bootstrap paired return differences must be finite.');
  let state=seed>>>0;const random=()=>{state=(1664525*state+1013904223)>>>0;return state/4294967296;};
  const samples=[];
  for(let iteration=0;iteration<iterations;iteration++){
    let total=0,count=0;while(count<differences.length){const start=Math.floor(random()*differences.length);
      for(let j=0;j<blockLength&&count<differences.length;j++,count++)total+=differences[(start+j)%differences.length];}
    samples.push(total/differences.length);
  }
  return {sessions:differences.length,blockLength,iterations,seed,meanDailyDifference:mean(differences),
    lower95:quantile(samples,.025),upper95:quantile(samples,.975),
    interpretation:'Exploratory 95% interval for the mean paired daily return difference; not a confidence interval for cumulative return, and not proof against universe selection or model-selection bias.'};
}
export function csv(rows){
  if(!rows.length)return '';
  const keys=[...new Set(rows.flatMap(Object.keys))];
  const cell=value=>{const s=value==null?'':String(value);return /[",\n\r]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
  return keys.map(cell).join(',')+'\n'+rows.map(row=>keys.map(k=>cell(row[k])).join(',')).join('\n')+'\n';
}

export async function runBacktest(panel,{universe,calendar,startDate='2025-01-02',endDate='2026-10-16',commissionBps=0,slippageBps=5,initialCapital=100000}={}){
  const excludedNoUsableHistoryTickers=panel.series.filter(s=>!s.bars.length).map(s=>s.ticker);
  panel={...panel,series:panel.series.filter(s=>s.bars.length)};
  const instruments=new Map(universe.instruments.map(x=>[x.ticker,x]));
  if(panel.series.some(s=>!instruments.has(s.ticker)))throw new Error('Snapshot contains instruments outside the metadata universe.');
  const calendarDates=marketDates(calendar,panel.metadata.firstBarDate,endDate);
  const common={startDate,endDate,commissionBps,slippageBps,initialCapital,calendarDates};
  const main=Object.fromEntries(['old','new','buy_hold'].map(strategy=>[strategy,runPortfolio(panel,{...common,strategy})]));
  const scenarios=[];
  function compare(id,selected=panel,overrides={}){
    for(const strategy of ['old','new','buy_hold']){
      const run=runPortfolio(selected,{...common,...overrides,strategy});
      scenarios.push({scenario:id,strategy,tickers:selected.series.length,...run.period,...run.options,...run.metrics});
    }
  }
  for(const slip of [...new Set([0,5,10,25,slippageBps])])compare('slippage_'+slip+'bps',panel,{slippageBps:slip});
  compare('commission_5bps_plus_slippage_5bps',panel,{commissionBps:5,slippageBps:5});
  for(const [id,predicate] of [
    ['stocks',i=>i.type==='STOCK'],['etf_1x',i=>i.type==='ETF'&&i.dailyLeverage===1],
    ['leveraged_inverse_etf',i=>i.type==='ETF'&&i.dailyLeverage!==1],['without_MRNA',i=>i.ticker!=='MRNA'],
    ['without_SNDK',i=>i.ticker!=='SNDK'],
    ['SPY',i=>i.ticker==='SPY']]){
    const subset={...panel,series:panel.series.filter(s=>predicate(instruments.get(s.ticker)))};
    if(subset.series.length)compare(id,subset);
  }
  compare('start_invested',panel,{initialPosition:'long'});
  const warmupStart=panel.series.filter(s=>s.bars.length>=499).map(s=>s.bars[200]?.date).filter(Boolean).sort().at(-1);
  if(warmupStart&&warmupStart<=endDate)compare('warmup_200',panel,{startDate:warmupStart,warmupBars:200});
  for(const year of [...new Set(calendarDates.filter(d=>d>=startDate&&d<=endDate).map(d=>d.slice(0,4)))]){
    const first=startDate>year+'-01-01'?startDate:year+'-01-01',last=endDate<year+'-12-31'?endDate:year+'-12-31';
    compare('year_'+year,panel,{startDate:first,endDate:last});
  }
  const eventResults=eventStudy(panel,common);
  const oldTicker=new Map(main.old.perTicker.map(x=>[x.ticker,x]));
  const holdTicker=new Map(main.buy_hold.perTicker.map(x=>[x.ticker,x]));
  const perTicker=main.new.perTicker.map(row=>({ticker:row.ticker,type:instruments.get(row.ticker).type,
    dailyLeverage:instruments.get(row.ticker).dailyLeverage??1,
    oldReturn:oldTicker.get(row.ticker).totalReturn,newReturn:row.totalReturn,buyHoldReturn:holdTicker.get(row.ticker).totalReturn,
    differenceVsOld:row.totalReturn-oldTicker.get(row.ticker).totalReturn,differenceVsBuyHold:row.totalReturn-holdTicker.get(row.ticker).totalReturn,
    oldTrades:oldTicker.get(row.ticker).tradeCount,newTrades:row.tradeCount,newExposure:row.investedSessionFraction,
    newCosts:row.totalCost,oldCosts:oldTicker.get(row.ticker).totalCost,newMaxDrawdown:row.maxDrawdown}));
  const terminalDateCoverage=panel.series.map(s=>({ticker:s.ticker,lastDate:s.bars.filter(b=>b.date<=endDate).at(-1)?.date??null}));
  const signalDistribution={old:{},new:{}};
  for(const series of panel.series)for(const row of series.signals){
    if(row.date<startDate||row.date>endDate)continue;
    for(const model of ['old','new']){const signal=row[model+'Signal'];signalDistribution[model][signal]=(signalDistribution[model][signal]??0)+1;}
  }
  // This is a concentration diagnostic selected AFTER observing returns, not a
  // predeclared investable exclusion rule or another out-of-sample strategy.
  const largestContributors=main.new.perTicker.toSorted((a,b)=>b.totalReturn-a.totalReturn).slice(0,5).map(row=>row.ticker);
  compare('without_top5_new_contributors_diagnostic',{
    ...panel,series:panel.series.filter(s=>!largestContributors.includes(s.ticker))
  });
  return {schemaVersion:1,kind:'retrospective-price-return-backtest',input:panel.metadata,quality:panel.quality,
    settings:common,excludedNoUsableHistoryTickers,terminalDateCoverage,
    main,scenarios,perTicker,eventStudy:eventResults,signalDistribution,
    concentrationDiagnostic:{excludedTickers:largestContributors,selection:'Largest five new-strategy sleeve returns, selected retrospectively solely to disclose concentration.'},
    uncertainty:{newVsOld:blockBootstrapDifference(main.new.equityCurve,main.old.equityCurve),
      newVsBuyHold:blockBootstrapDifference(main.new.equityCurve,main.buy_hold.equityCurve)},
    pairedTickers:{count:perTicker.length,newBeatsOld:perTicker.filter(x=>x.differenceVsOld>1e-10).length,
      newBeatsBuyHold:perTicker.filter(x=>x.differenceVsBuyHold>1e-10).length,
      medianDifferenceVsOld:quantile(perTicker.map(x=>x.differenceVsOld),.5),medianDifferenceVsBuyHold:quantile(perTicker.map(x=>x.differenceVsBuyHold),.5)},
    limitations:[
      'Current selected universe, not point-in-time historical membership; survivorship and selection bias.',
      'Captured revised OHLC prices. No dividends, interest on cash, taxes, regulatory charges or measured spreads. ETF internal expenses are already reflected in quoted prices.',
      'Hypothetical execution at next session open with modeled slippage; no liquidity/capacity constraints. Fractional shares assumed.',
      'Equal initial independent sleeves; not a top-N ranking portfolio. Cash is never reallocated among instruments.',
      'Rules were designed after historical data existed. Annual slices and later start are sensitivity checks, not prospective out-of-sample validation.',
      'No thresholds were fitted or changed based on returns in this analysis.',
      'Terminal close liquidation is predetermined and charged costs; final-day signals do not execute at that close.',
      'Win rate includes executable terminal liquidations; signalExits and terminalExits are reported separately.',
      'Event study counts are correlated across instruments and model categories; event averages are descriptive.'
    ]};
}

export async function main(args=process.argv.slice(2)){
  const options={};
  for(let i=0;i<args.length;i+=2){if(!['--input','--output','--panel-cache','--commission-bps','--slippage-bps','--start','--end'].includes(args[i])||!args[i+1]||options[args[i]])throw new Error('Usage: --input PATH --output DIRECTORY [--panel-cache PATH] [--commission-bps 0] [--slippage-bps 5] [--start YYYY-MM-DD] [--end YYYY-MM-DD]');options[args[i]]=args[i+1];}
  if(!options['--input']||!options['--output'])throw new Error('--input and --output are required.');
  const inputPath=path.resolve(options['--input']),output=path.resolve(options['--output']);
  const artifactNames=['signal-panel.json','trades.csv','executions.csv','equity.csv','per-ticker.csv','scenarios.csv','events.csv','results.json'];
  if(artifactNames.some(name=>path.join(output,name).toLowerCase()===inputPath.toLowerCase()))throw new Error('Output must not overwrite the input snapshot.');
  await fs.mkdir(output,{recursive:true});
  const raw=await fs.readFile(inputPath),inputHash=hash(raw),input=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));
  const engineHash=hash(await fs.readFile(path.join(root,'tools/baselines/scoring-v2.cjs'))),auditHash=hash(await fs.readFile(path.join(root,'tools/audit-scoring.mjs'))),panelHash=hash(await fs.readFile(path.join(root,'tools/backtest-signals.mjs')));
  const cachePath=options['--panel-cache']?path.resolve(options['--panel-cache']):path.join(output,'signal-panel.json');
  if(cachePath.toLowerCase()===inputPath.toLowerCase()||artifactNames.filter(name=>name!=='signal-panel.json').some(name=>path.join(output,name).toLowerCase()===cachePath.toLowerCase()))throw new Error('Panel cache must not overwrite input or result artifacts.');
  let panel;
  try{panel=JSON.parse(await fs.readFile(cachePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(panel&&(panel.metadata?.schemaVersion!==1||panel.metadata?.kind!=='offline-historical-signal-panel'||panel.metadata?.settings?.historyDays!==500||panel.metadata?.settings?.minSignalDays!==50||panel.metadata.inputSha256!==inputHash||panel.metadata.currentEngine.sourceSha256!==engineHash||panel.metadata.baseline.implementationSha256!==auditHash||panel.metadata.panelSourceSha256!==panelHash))throw new Error('Cached signal panel does not match default settings, this input and scoring source. Choose a new cache path.');
  if(!panel){panel=await buildSignalPanel(input,{inputSha256:inputHash,onProgress:p=>{if(p.completedTickers%25===0)process.stderr.write(`Signals ${p.completedTickers}/${p.totalTickers}\n`);}});await fs.mkdir(path.dirname(cachePath),{recursive:true});await fs.writeFile(cachePath,JSON.stringify(panel));}
  const universe=JSON.parse(await fs.readFile(path.join(root,'data/universe.json'),'utf8')),calendar=JSON.parse(await fs.readFile(path.join(root,'supabase/calendar.json'),'utf8'));
  const result=await runBacktest(panel,{universe,calendar,startDate:options['--start'],endDate:options['--end'],
    commissionBps:options['--commission-bps']===undefined?0:Number(options['--commission-bps']),slippageBps:options['--slippage-bps']===undefined?5:Number(options['--slippage-bps'])});
  result.sourceHashes={scoring:engineHash,baseline:auditHash,panel:panelHash,execution:hash(await fs.readFile(path.join(root,'tools/backtest-execution.mjs'))),report:hash(await fs.readFile(fileURLToPath(import.meta.url))),universe:hash(JSON.stringify(universe)),calendar:hash(JSON.stringify(calendar))};
  const ledger=Object.entries(result.main).flatMap(([strategy,run])=>run.trades.map(t=>({strategy,...t})));
  const executions=Object.entries(result.main).flatMap(([strategy,run])=>run.executions.map(t=>({strategy,...t})));
  const curves=Object.entries(result.main).flatMap(([strategy,run])=>run.equityCurve.map(t=>({strategy,...t})));
  await Promise.all([['trades.csv',csv(ledger)],['executions.csv',csv(executions)],['equity.csv',csv(curves)],
    ['per-ticker.csv',csv(result.perTicker)],['scenarios.csv',csv(result.scenarios)],['events.csv',csv(result.eventStudy.events)],
    ['results.json',JSON.stringify({...result,eventStudy:{...result.eventStudy,events:undefined}},null,2)+'\n']].map(([file,body])=>fs.writeFile(path.join(output,file),body,'utf8')));
  process.stdout.write(JSON.stringify({output,period:result.main.new.period,main:Object.fromEntries(Object.entries(result.main).map(([k,v])=>[k,v.metrics])),pairedTickers:result.pairedTickers,uncertainty:result.uncertainty})+'\n');
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
