// Predeclared chronological search. Training ranks candidates, validation selects
// one frozen finalist, and only that finalist plus the reference see test returns.
import {runPortfolio} from './execution.mjs';
import {validateConfig,validateWeights,validDate,sessionDates,normalizeRows,coverageFor,ensureComplete,sha256} from './lab.mjs?v=3';
import {validateStrategy,strategyWarmup,buildStrategyFeatures,buildStrategySignals} from './strategies.mjs?v=2';

export const OPTIMIZATION_VERSION='backtest-optimization-1.0.0';
export const MAX_OPTIMIZATION_WORK=40000000;
export const OPTIMIZATION_DEFAULTS=Object.freeze({candidateCount:40,seed:20261020,shortlistSize:5,
  objective:'return_drawdown',drawdownPenalty:1,optimizeParameters:true,optimizeEntryWeights:false,
  optimizeWeights:false,minWeight:.001,maxWeight:1});
export const DEFAULT_SEARCH_SPACE=Object.freeze(Object.fromEntries(Object.entries({
  entryScore:[55,60,65],trendScore:[50,55,60],momentum:[50,55,60],relativeVolume:[1,1.2,1.5],
  minEntryDistanceAtr:[-1.5],maxEntryExtensionAtr:[2,3,4],exitScore:[55,60,65],
  exitPeriod:[150,200,250],exitConfirmations:[2,3,5],momentumWeight:[.4,.5,.6],positionWeight:[.2,.3,.4]
}).map(([key,values])=>[key,Object.freeze(values)])));
const numericBounds={entryScore:[0,100],trendScore:[0,100],momentum:[0,100],relativeVolume:[0,10],
  minEntryDistanceAtr:[-20,20],maxEntryExtensionAtr:[-20,20],exitScore:[0,100],exitPeriod:[20,250],
  exitConfirmations:[1,10],momentumWeight:[0,1],positionWeight:[0,1]};
const parameterKeys=['entryScore','trendScore','momentum','relativeVolume','minEntryDistanceAtr','maxEntryExtensionAtr'];
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const total=values=>values.reduce((sum,value)=>sum+value,0);
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));

export function partitionOptimizationDates(config,optimization) {
  const {startDate,endDate}=config??{}, {trainEndDate,validationEndDate}=optimization??{};
  if (![startDate,endDate,trainEndDate,validationEndDate].every(validDate)||
      !(startDate<=trainEndDate&&trainEndDate<validationEndDate&&validationEndDate<endDate)) {
    throw new Error('Optimización: ordena las fechas de inicio, fin de entrenamiento, fin de validación y fin de prueba.');
  }
  const dates=sessionDates(startDate,endDate),groups={train:[],validation:[],test:[]};
  for(const date of dates) groups[date<=trainEndDate?'train':date<=validationEndDate?'validation':'test'].push(date);
  const minimum={train:252,validation:126,test:126};
  const phases={};
  for(const [name,values] of Object.entries(groups)) {
    if(values.length<minimum[name]) throw new Error(`Optimización: ${name} necesita al menos ${minimum[name]} sesiones; hay ${values.length}.`);
    phases[name]={startDate:values[0],endDate:values.at(-1),sessions:values.length};
  }
  return phases;
}

export function validateOptimization(requested,config) {
  if(!plain(requested)) throw new Error('Configuración de optimización inválida.');
  const allowed=new Set([...Object.keys(OPTIMIZATION_DEFAULTS),'trainEndDate','validationEndDate','searchSpace']);
  if(Object.keys(requested).some(key=>!allowed.has(key))) throw new Error('Parámetro de optimización desconocido.');
  const options={...OPTIMIZATION_DEFAULTS,...requested};
  for(const [key,low,high] of [['candidateCount',1,100],['shortlistSize',1,10],['seed',0,4294967295]]) {
    if(!Number.isSafeInteger(options[key])||options[key]<low||options[key]>high) throw new Error(`Optimización: ${key} debe ser un entero entre ${low} y ${high}.`);
  }
  for(const key of ['optimizeParameters','optimizeEntryWeights','optimizeWeights']) if(typeof options[key]!=='boolean') throw new Error(`Optimización: ${key} debe ser booleano.`);
  if(!['return_drawdown','sharpe','cagr'].includes(options.objective)) throw new Error('Objetivo de optimización desconocido.');
  if(!Number.isFinite(options.drawdownPenalty)||options.drawdownPenalty<0||options.drawdownPenalty>10) throw new Error('La penalización de caída debe estar entre 0 y 10.');
  if(!Number.isFinite(options.minWeight)||!Number.isFinite(options.maxWeight)||options.minWeight<=0||options.maxWeight>1||options.minWeight>options.maxWeight) throw new Error('Los límites de peso deben cumplir 0 < mínimo ≤ máximo ≤ 100%.');
  const n=Object.keys(config.weights).length;
  if(options.optimizeWeights&&(n*options.minWeight>1+1e-9||n*options.maxWeight<1-1e-9)) throw new Error('Los límites de peso son incompatibles con el número de activos.');
  if(options.optimizeWeights&&Object.values(config.weights).some(weight=>weight<options.minWeight-1e-9||weight>options.maxWeight+1e-9)) throw new Error('Los pesos originales también deben cumplir los límites; ajusta los límites o los pesos antes de optimizar.');
  if(requested.searchSpace!==undefined&&!plain(requested.searchSpace)) throw new Error('El espacio de búsqueda debe ser un objeto de listas numéricas.');
  if(Object.keys(requested.searchSpace??{}).some(key=>!Object.hasOwn(DEFAULT_SEARCH_SPACE,key))) throw new Error('Criterio de búsqueda desconocido; los costes y las fechas no se optimizan.');
  const raw={...DEFAULT_SEARCH_SPACE,...requested.searchSpace};
  const keys=[...(options.optimizeParameters?[...parameterKeys,...(config.strategy.exitMode==='long_trend'?['exitPeriod','exitConfirmations']:['exitScore'])]:[]),
    ...(options.optimizeEntryWeights?['momentumWeight','positionWeight']:[])];
  const searchSpace={};
  for(const key of keys) {
    const values=raw[key], [low,high]=numericBounds[key];
    if(!Array.isArray(values)||values.length<1||values.length>20||values.some(value=>!Number.isFinite(value)||value<low||value>high||(['exitPeriod','exitConfirmations'].includes(key)&&!Number.isSafeInteger(value)))) {
      throw new Error(`Optimización: ${key} requiere entre 1 y 20 valores dentro de [${low}, ${high}].`);
    }
    searchSpace[key]=[...new Set(values)].sort((a,b)=>a-b);
  }
  if(options.optimizeParameters&&Math.min(...searchSpace.minEntryDistanceAtr)>Math.max(...searchSpace.maxEntryExtensionAtr)) throw new Error('El espacio de búsqueda no contiene una distancia de entrada válida.');
  if(options.optimizeEntryWeights&&Math.min(...searchSpace.momentumWeight)+Math.min(...searchSpace.positionWeight)>1+1e-12) throw new Error('Los pesos de momentum y posición no dejan un peso válido para volumen.');
  options.searchSpace=searchSpace;
  partitionOptimizationDates(config,options);
  return options;
}

function seededRandom(seed) {
  let state=seed>>>0;
  return ()=>{ state=(state+0x6D2B79F5)>>>0; let value=state; value=Math.imul(value^(value>>>15),value|1);
    value^=value+Math.imul(value^(value>>>7),value|61); return ((value^(value>>>14))>>>0)/4294967296; };
}

function sampleWeights(tickers,options,random) {
  const order=[...tickers];
  for(let i=order.length-1;i>0;i--) { const j=Math.floor(random()*(i+1)); [order[i],order[j]]=[order[j],order[i]]; }
  const assigned={}, {minWeight:minimum,maxWeight:maximum}=options;
  let remaining=1;
  order.forEach((ticker,index)=>{
    const later=order.length-index-1,low=Math.max(minimum,remaining-later*maximum),high=Math.min(maximum,remaining-later*minimum);
    const weight=later===0?remaining:low+random()*Math.max(0,high-low);
    assigned[ticker]=weight; remaining-=weight;
  });
  return validateWeights(Object.fromEntries(tickers.map(ticker=>[ticker,assigned[ticker]])));
}

export function generateOptimizationCandidates(config,options) {
  const random=seededRandom(options.seed),tickers=Object.keys(config.weights);
  const candidates=[{id:'original',weights:config.weights,strategy:config.strategy}];
  const seen=new Set([JSON.stringify([config.weights,config.strategy])]);
  const seenDraws=new Set();
  if(!Object.keys(options.searchSpace).length&&(!options.optimizeWeights||tickers.length===1)) return candidates;
  const combinations=Object.values(options.searchSpace).reduce((product,list)=>product*list.length,1);
  const attempts=Math.min(100000,Math.max(1000,options.candidateCount*1000));
  for(let attempt=0;candidates.length<options.candidateCount&&attempt<attempts;attempt++) {
    const strategy={...config.strategy};
    if(options.optimizeParameters||options.optimizeEntryWeights) strategy.preset='custom';
    for(const [key,list] of Object.entries(options.searchSpace)) strategy[key]=list[Math.floor(random()*list.length)];
    if(!options.optimizeWeights) {
      const draw=JSON.stringify(Object.keys(options.searchSpace).map(key=>strategy[key]));
      if(seenDraws.has(draw)) { if(seenDraws.size>=combinations) break; continue; }
      seenDraws.add(draw);
    }
    if(options.optimizeEntryWeights) {
      const remainder=1-strategy.momentumWeight-strategy.positionWeight;
      if(remainder < -1e-12) continue;
      strategy.volumeWeight=Math.max(0,remainder);
    }
    if(strategy.minEntryDistanceAtr>strategy.maxEntryExtensionAtr) continue;
    const effective=validateStrategy(strategy),weights=options.optimizeWeights?sampleWeights(tickers,options,random):config.weights;
    const key=JSON.stringify([weights,effective]);
    if(seen.has(key)) {
      if(!options.optimizeWeights&&seen.size>=combinations+1) break;
      continue;
    }
    seen.add(key);
    candidates.push({id:`candidate-${String(candidates.length).padStart(4,'0')}`,weights,strategy:effective});
  }
  return candidates;
}

function objectiveScore(metrics,options) {
  const value=options.objective==='sharpe'?metrics.sharpeRatio:options.objective==='cagr'?metrics.cagr:
    metrics.cagr-options.drawdownPenalty*Math.abs(metrics.maxDrawdown);
  return Number.isFinite(value)?value:null;
}
const rank=(trials,phase)=>[...trials].sort((a,b)=>{
  const left=a[phase]?.score,right=b[phase]?.score;
  if(left===null&&right!==null) return 1;
  if(right===null&&left!==null) return -1;
  return (right??0)-(left??0)||a.ordinal-b.ordinal;
});
function assertExecutionQuality(result) {
  if(result.dataQuality.staleMarkSessions||result.dataQuality.staleSignalSkips||result.dataQuality.staleTerminalTickers.length) throw new Error('La optimización requiere sesiones completas para ejecutar y valorar cada fase.');
}

export async function runOptimization({rows,config:requested,source,optimization:requestedOptimization},onProgress=null) {
  if(source?.confirmedOnly!==true) throw new Error('La optimización requiere cierres confirmados.');
  if(onProgress!==null&&typeof onProgress!=='function') throw new Error('Callback de progreso inválido.');
  const config=validateConfig(requested),optimization=validateOptimization(requestedOptimization,config);
  const phases=partitionOptimizationDates(config,optimization),series=normalizeRows(rows,config.weights,config.endDate);
  const selectedBars=total(series.map(item=>item.bars.length));
  if(selectedBars*optimization.candidateCount>MAX_OPTIMIZATION_WORK) throw new Error(`Optimización: el límite es ${MAX_OPTIMIZATION_WORK.toLocaleString('en-US')} barras × candidatos. Reduce candidatos, fechas o activos.`);
  const firstDate=series.flatMap(item=>item.bars[0]?.date??[]).sort()[0];
  if(!firstDate) throw new Error('No hay historial confirmado para optimizar.');
  const calendarDates=sessionDates(firstDate,phases.test.endDate);
  const worstStrategy=optimization.optimizeParameters&&config.strategy.exitMode==='long_trend'?{
    ...config.strategy,preset:'custom',exitPeriod:Math.max(...optimization.searchSpace.exitPeriod),exitConfirmations:Math.max(...optimization.searchSpace.exitConfirmations)}:config.strategy;
  const warmupBars=Math.max(strategyWarmup(config.strategy),strategyWarmup(worstStrategy));
  ensureComplete(series,calendarDates,phases.train.startDate,phases.test.endDate,warmupBars);
  const coverage=coverageFor(series,warmupBars);
  for(const item of coverage) if(!item.firstEligibleDate||item.firstEligibleDate>phases.train.startDate) {
    throw new Error(`Optimización: ${item.ticker} necesita ${warmupBars} cierres anteriores al entrenamiento. Primera apertura elegible: ${item.firstEligibleDate??'sin cobertura'}. Retrasa el inicio o excluye el activo.`);
  }
  const candidates=generateOptimizationCandidates(config,optimization),features=new Map();
  for(let index=0;index<series.length;index++) {
    const item=series[index]; features.set(item.ticker,buildStrategyFeatures(item.bars,{calendarDates}));
    onProgress?.({stage:'features',completed:index+1,total:series.length,ticker:item.ticker});
    await pause();
  }
  const phaseSeries={};
  for(const [name,phase] of Object.entries(phases)) {
    phaseSeries[name]=series.map(item=>({ticker:item.ticker,bars:item.bars.filter(bar=>bar.date<=phase.endDate)}));
    phase.dataHash=await sha256(phaseSeries[name]);
  }
  const execute=(candidate,phaseName,benchmark=false)=>{
    const phase=phases[phaseName];
    const panel={series:phaseSeries[phaseName].map(item=>({...item,...(benchmark?{}:{signals:buildStrategySignals(item.bars,candidate.strategy,{calendarDates,features:features.get(item.ticker)})})}))};
    const result=runPortfolio(panel,{startDate:phase.startDate,endDate:phase.endDate,initialCapital:config.initialCapital,
      commissionBps:config.commissionBps,slippageBps:config.slippageBps,warmupBars,calendarDates,weights:candidate.weights,strategy:benchmark?'buy_hold':'new'});
    assertExecutionQuality(result); return result;
  };
  const trials=[];
  for(let index=0;index<candidates.length;index++) {
    const candidate=candidates[index],result=execute(candidate,'train');
    trials.push({...candidate,ordinal:index,train:{metrics:result.metrics,score:objectiveScore(result.metrics,optimization)}});
    onProgress?.({stage:'train',completed:index+1,total:candidates.length}); await pause();
  }
  const trainingRanking=rank(trials,'train');
  trainingRanking.forEach((trial,index)=>trial.train.rank=index+1);
  const shortlist=trainingRanking.filter(trial=>trial.train.score!==null).slice(0,optimization.shortlistSize);
  if(!shortlist.length) throw new Error('Ningún candidato tiene un objetivo definido en entrenamiento; revisa el objetivo o el espacio de búsqueda.');
  for(let index=0;index<shortlist.length;index++) {
    const trial=shortlist[index],result=execute(trial,'validation');
    trial.validation={metrics:result.metrics,score:objectiveScore(result.metrics,optimization)};
    onProgress?.({stage:'validation',completed:index+1,total:shortlist.length}); await pause();
  }
  const validationRanking=rank(shortlist,'validation');
  validationRanking.forEach((trial,index)=>trial.validation.rank=index+1);
  const selected=validationRanking.find(trial=>trial.validation.score!==null);
  if(!selected) throw new Error('Ningún finalista tiene un objetivo definido en validación; la prueba final no se ha ejecutado.');
  const selection={candidateId:selected.id,weights:selected.weights,strategy:selected.strategy,
    trainMetrics:selected.train.metrics,validationMetrics:selected.validation.metrics};
  const protocol={method:'chronological_train_validation_test',candidateGenerator:'mulberry32-bounded-simplex-v1',
    objective:optimization.objective,objectiveFormula:optimization.objective==='return_drawdown'?'CAGR - drawdownPenalty * abs(maxDrawdown)':optimization.objective==='sharpe'?'net daily Sharpe, risk-free rate 0':'net CAGR',
    requestedCandidateCount:optimization.candidateCount,actualCandidateCount:candidates.length,shortlistIds:shortlist.map(trial=>trial.id),
    trainingRanking:trainingRanking.map(trial=>trial.id),validationRanking:validationRanking.map(trial=>trial.id),
    selectionRule:'Rank training, shortlist, select highest validation score; exact ties favor earlier generated candidate, original first.',
    minimumSessions:{train:252,validation:126,test:126},commonWarmupBars:warmupBars,
    phaseCapital:'Each phase starts independently in cash and liquidates at its final close with full costs. No chained return.',
    testPolicy:'Only the selected strategy and predeclared original configuration are evaluated on final test, each with its matching buy-and-hold weights.',
    weightsPolicy:'Positive initial capital sleeves; no rebalancing or redistribution.',costsOptimized:false};
  // This commitment deliberately excludes all test prices, test metrics, full
  // snapshot hashes, provider timestamps and source IDs. It is made BEFORE test.
  const selectionHash=await sha256({engineVersion:OPTIMIZATION_VERSION,config,optimization,
    train:phases.train,validation:phases.validation,trials,selection,protocol});
  const original=candidates[0],test={};
  for(const [index,[name,candidate,benchmark]] of [['selectedStrategy',selected,false],['selectedBenchmark',selected,true],
    ['referenceStrategy',original,false],['referenceBenchmark',original,true]].entries()) {
    test[name]=execute(candidate,'test',benchmark);
    onProgress?.({stage:'test',completed:index+1,total:4}); await pause();
  }
  const warnings=[
    'Solo la prueba final corresponde al período reservado. Repetir la búsqueda tras verla convierte ese período en parte de la selección.',
    'La optimización puede sobreajustar; el resultado final puede quedar por debajo de comprar y mantener.',
    'Rentabilidad de precios, sin dividendos, impuestos ni interés del efectivo. Universo actual: posible sesgo de supervivencia.',
    'Cada fase comienza en efectivo y liquida al cierre final con costes; las rentabilidades de las fases no se encadenan.'
  ];
  if(candidates.length<optimization.candidateCount) warnings.push(`Se evaluaron ${candidates.length} candidatos únicos; el presupuesto solicitado era ${optimization.candidateCount}.`);
  if(selected.train.metrics.tradeCount===0||selected.validation.metrics.tradeCount===0) warnings.push('El candidato elegido no operó en al menos una fase de selección; interpreta también su exposición y número de operaciones.');
  for(const item of source.coverage??[]) if(Object.hasOwn(config.weights,item.ticker)&&item.last_error) warnings.push(`${item.ticker}: la última actualización falló; se conserva el historial confirmado hasta ${item.last_date}.`);
  const dataHash=await sha256(series),configurationHash=await sha256({engineVersion:OPTIMIZATION_VERSION,config,optimization,dataHash,selectionHash});
  return {kind:'optimization',schemaVersion:1,createdAt:new Date().toISOString(),engineVersion:OPTIMIZATION_VERSION,configurationHash,selectionHash,
    config,optimization,protocol,phases,selection,trials,test,
    data:{hash:dataHash,firstDate,lastDate:phases.test.endDate,coverage,warmupBars,warnings,
      source:source.kind==='backtest_history'?'confirmed_backtest_history':'confirmed_market_history',loadedAt:typeof source.loadedAt==='string'?source.loadedAt:null,
      priceBasis:source.priceBasis??'price_only',...(Array.isArray(source.coverage)?{provider:source.provider,sourceSnapshots:source.coverage.filter(item=>Object.hasOwn(config.weights,item.ticker))}:{})},
    snapshot:{format:'finalizedData-v1',confirmedOnly:true,rows:series.flatMap(({ticker,bars})=>bars.map(bar=>[bar.date,ticker,bar.open,bar.high,bar.low,bar.close,bar.vol]))}};
}
