// Browser/Node orchestration for the interactive lab. Published research files
// and production scoring remain immutable; this is a separate experiment API.
import {runPortfolio} from './execution.mjs';
import {validateStrategy, strategyWarmup, buildStrategySignals} from './strategies.mjs';
import {EXCHANGE_CALENDAR} from './calendar.mjs';

export const ENGINE_VERSION = 'backtest-lab-1.0.0';
const baseStrategy = {preset:'custom', entryScore:60, trendScore:55, momentum:55,
  maxEntryExtensionAtr:3, minEntryDistanceAtr:-1.5, relativeVolume:1.2,
  strongOnly:false, exitMode:'long_trend', exitPeriod:200, exitConfirmations:3, exitScore:60};
export const PRESET_STRATEGIES = Object.freeze({
  v3:Object.freeze({...baseStrategy, preset:'v3', exitMode:'v3', exitPeriod:50}),
  sma200:Object.freeze({...baseStrategy, preset:'sma200'}),
  custom:Object.freeze({...baseStrategy})
});
export const DEFAULT_CONFIG = Object.freeze({initialCapital:100000, commissionBps:0,
  slippageBps:5, startDate:'', endDate:'', weights:Object.freeze({}), strategy:PRESET_STRATEGIES.v3});
const DAY_MS = 86400000;
const holidays = new Set(EXCHANGE_CALENDAR.holidays);
const tickerPattern = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const sum = values => values.reduce((total,value)=>total+value,0);
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;
}
export function isSession(date) {
  if (!validDate(date)) return false;
  const parsed = new Date(date+'T12:00:00Z'), year = parsed.getUTCFullYear();
  return year >= EXCHANGE_CALENDAR.firstYear && year <= EXCHANGE_CALENDAR.lastYear &&
    parsed.getUTCDay() !== 0 && parsed.getUTCDay() !== 6 && !holidays.has(date);
}
export function sessionDates(first,last) {
  if (!validDate(first) || !validDate(last) || first > last || Number(first.slice(0,4)) < EXCHANGE_CALENDAR.firstYear || Number(last.slice(0,4)) > EXCHANGE_CALENDAR.lastYear) {
    throw new Error(`Fechas fuera del calendario revisado (${EXCHANGE_CALENDAR.firstYear}–${EXCHANGE_CALENDAR.lastYear}).`);
  }
  const dates = [];
  for (let time=Date.parse(first+'T12:00:00Z');time<=Date.parse(last+'T12:00:00Z');time+=DAY_MS) {
    const date = new Date(time).toISOString().slice(0,10);
    if (isSession(date)) dates.push(date);
  }
  return dates;
}
export function validateWeights(weights) {
  if (!plainObject(weights)) throw new Error('Selecciona activos y asigna sus pesos.');
  const entries = Object.entries(weights).sort(([a],[b])=>a.localeCompare(b));
  if (!entries.length || entries.length > 250) throw new Error('Selecciona entre 1 y 250 activos.');
  if (entries.some(([ticker,weight])=>!tickerPattern.test(ticker) || !Number.isFinite(weight) || weight<=0 || weight>1)) {
    throw new Error('Cada activo necesita un ticker válido y un peso mayor que 0% y como máximo 100%.');
  }
  if (Math.abs(sum(entries.map(([,weight])=>weight))-1)>1e-9) throw new Error('Los pesos deben sumar 100%. Usa Normalizar pesos o corrígelos.');
  const total = sum(entries.map(([,weight])=>weight));
  return Object.fromEntries(entries.map(([ticker,weight])=>[ticker,weight/total]));
}
export function validateConfig(config) {
  if (!plainObject(config)) throw new Error('Configuración de backtest inválida.');
  const result = {...DEFAULT_CONFIG,...config,weights:validateWeights(config.weights),strategy:validateStrategy(config.strategy ?? DEFAULT_CONFIG.strategy)};
  if (!validDate(result.startDate) || !validDate(result.endDate) || result.startDate > result.endDate) throw new Error('Selecciona fechas válidas: inicio anterior o igual al final.');
  if (!Number.isFinite(result.initialCapital) || result.initialCapital<=0 || result.initialCapital>1e12) throw new Error('El capital debe ser mayor que 0 y no superar un billón.');
  for (const key of ['commissionBps','slippageBps']) {
    if (!Number.isFinite(result[key]) || result[key]<0 || result[key]>1000) throw new Error('Comisión y deslizamiento deben estar entre 0% y 10% por lado.');
  }
  // Keep only effective, reproducible settings in the saved result.
  return {weights:result.weights, strategy:result.strategy, startDate:result.startDate,endDate:result.endDate,
    initialCapital:result.initialCapital,commissionBps:result.commissionBps,slippageBps:result.slippageBps};
}

// Ingress is finalizedData from the existing read-only data client. Arrays have
// no intrinsic finality field; runExperiment requires an explicit source claim.
// There is no upload path that treats arbitrary OHLC arrays as confirmed data.
function normalizeRows(rows,weights,endDate=null) {
  if (!Array.isArray(rows) || rows.length>250000) throw new Error('El historial debe contener como máximo 250.000 barras.');
  const grouped = new Map(Object.keys(weights).map(ticker=>[ticker,[]]));
  const seen = new Set();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length<7) throw new Error('Formato de historial inválido: se requieren cierres confirmados.');
    const [date,ticker,open,high,low,close,vol] = row;
    if (!grouped.has(ticker)) continue;
    // Future observations must not change a historical run or its fingerprint.
    if (endDate && typeof date==='string' && validDate(date) && date>endDate) continue;
    if (!isSession(date) || ![open,high,low,close,vol].every(Number.isFinite) ||
        Math.min(open,high,low,close)<=0 || high<Math.max(open,close) || low>Math.min(open,close) ||
        !Number.isSafeInteger(vol) || vol<0 || (row.length>7 && row[7]!==true)) {
      throw new Error(`Barra inválida o no confirmada: ${ticker} ${date}.`);
    }
    const key=ticker+'|'+date;
    if (seen.has(key)) throw new Error(`Barra duplicada: ${ticker} ${date}. Actualiza el historial.`);
    seen.add(key);
    grouped.get(ticker).push({date,open,high,low,close,vol,is_final:true});
  }
  return [...grouped].map(([ticker,bars])=>({ticker,bars:bars.sort((a,b)=>a.date.localeCompare(b.date))}));
}
function coverageFor(series,warmupBars) {
  return series.map(({ticker,bars})=>({ticker,bars:bars.length,firstDate:bars[0]?.date??null,
    lastDate:bars.at(-1)?.date??null,firstEligibleDate:bars[warmupBars]?.date??null}));
}
export function inspectHistory(rows,{weights,strategy=DEFAULT_CONFIG.strategy}) {
  const selected=validateWeights(weights), effective=validateStrategy(strategy);
  const series=normalizeRows(rows,selected), warmupBars=strategyWarmup(effective),coverage=coverageFor(series,warmupBars);
  const eligible=coverage.map(item=>item.firstEligibleDate).filter(Boolean).sort();
  const lastDates=coverage.map(item=>item.lastDate).filter(Boolean).sort();
  const warnings=coverage.flatMap(item=>!item.bars?[`${item.ticker}: no hay cierres disponibles; la ejecución se bloqueará.`]:
    !item.firstEligibleDate?[`${item.ticker}: ${item.bars} barras; necesita ${warmupBars+1} para ejecutar. Su asignación permanece en efectivo.`]:[]);
  return {coverage,startDate:eligible[0]??null,endDate:lastDates[0]??null,warmupBars,warnings};
}
function ensureComplete(series,calendarDates,startDate,endDate,warmupBars) {
  const calendarIndex=new Map(calendarDates.map((date,index)=>[date,index]));
  for (const {ticker,bars} of series) {
    if (!bars.length) throw new Error(`${ticker}: no hay historial confirmado en el período. No se sustituye una descarga ausente por efectivo.`);
    if (bars.at(-1).date<endDate) throw new Error(`${ticker}: último cierre ${bars.at(-1).date}, anterior al final ${endDate}. Actualiza datos o reduce la fecha final.`);
    for (let index=1;index<bars.length;index++) {
      if (calendarIndex.get(bars[index].date)!==calendarIndex.get(bars[index-1].date)+1) {
        throw new Error(`${ticker}: faltan sesiones entre ${bars[index-1].date} y ${bars[index].date}. Actualiza o repara el historial antes de ejecutar.`);
      }
    }
  }
  if (!series.some(({bars})=>bars.some((bar,index)=>index>=warmupBars && bar.date>=startDate && bar.date<=endDate))) {
    throw new Error(`No hay aperturas elegibles: se necesitan ${warmupBars} cierres anteriores más una sesión de ejecución.`);
  }
}
export async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error('Se necesita HTTPS o localhost para registrar la huella del experimento.');
  const bytes=new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value));
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}

export async function runExperiment({rows,config:requested,source},onProgress=null) {
  if (source?.confirmedOnly!==true) throw new Error('El backtest requiere un historial de cierres confirmados; las velas provisionales no son válidas.');
  if (onProgress!==null && typeof onProgress!=='function') throw new Error('Callback de progreso inválido.');
  const config=validateConfig(requested);
  const series=normalizeRows(rows,config.weights,config.endDate);
  const firstDates=series.map(item=>item.bars[0]?.date).filter(Boolean).sort();
  if (!firstDates.length) throw new Error('No hay barras confirmadas en las fechas solicitadas.');
  const firstDate=firstDates[0];
  if (config.startDate<firstDate) throw new Error(`El historial disponible comienza el ${firstDate}; selecciona un inicio dentro de su cobertura.`);
  const calendarDates=sessionDates(firstDate,config.endDate);
  const evaluationDates=calendarDates.filter(date=>date>=config.startDate);
  if (evaluationDates.length<2) throw new Error('El período debe incluir al menos dos sesiones bursátiles.');
  const startDate=evaluationDates[0],endDate=evaluationDates.at(-1),warmupBars=strategyWarmup(config.strategy);
  ensureComplete(series,calendarDates,startDate,endDate,warmupBars);
  const coverage=coverageFor(series,warmupBars);
  const warnings=[
    'Exploración histórica: cambiar parámetros tras observar resultados no constituye validación fuera de muestra.',
    'Rentabilidad de precios, sin dividendos, impuestos ni interés del efectivo. Universo actual: posible sesgo de supervivencia.',
    'Pesos iniciales con efectivo reservado por activo; sin rebalanceo ni redistribución. Liquidación contable al cierre final con costes.'
  ];
  for (const item of coverage) {
    if (!item.firstEligibleDate || item.firstEligibleDate>endDate) warnings.push(`${item.ticker}: no alcanza ${warmupBars} cierres previos; su asignación queda en efectivo en ambas estrategias.`);
    else if (item.firstEligibleDate>startDate) warnings.push(`${item.ticker}: primera apertura elegible ${item.firstEligibleDate}; mantiene efectivo hasta disponer de historial.`);
  }
  if (evaluationDates.length<252) warnings.push('Muestra menor de un año bursátil: la rentabilidad anualizada y el Sharpe pueden ser poco representativos.');
  if (source.quality?.invalidRows || source.quality?.duplicateRows) warnings.push('El proveedor filtró filas inválidas o duplicadas; se comprobó la continuidad de los activos seleccionados.');
  const panel={series:[]};
  for (let index=0;index<series.length;index++) {
    const item=series[index];
    panel.series.push({...item,signals:buildStrategySignals(item.bars,config.strategy,{calendarDates})});
    if (onProgress) onProgress({completed:index+1,total:series.length,ticker:item.ticker});
    // UI remains responsive in a worker; yield lets Node callers observe progress.
    if (index%8===7) await new Promise(resolve=>setTimeout(resolve,0));
  }
  const common={startDate:config.startDate,endDate:config.endDate,initialCapital:config.initialCapital,
    commissionBps:config.commissionBps,slippageBps:config.slippageBps,warmupBars,calendarDates,weights:config.weights};
  const strategy=runPortfolio(panel,{...common,strategy:'new'});
  const benchmark=runPortfolio(panel,{...common,strategy:'buy_hold'});
  if (strategy.dataQuality.staleMarkSessions || benchmark.dataQuality.staleMarkSessions ||
      strategy.dataQuality.staleTerminalTickers.length || benchmark.dataQuality.staleTerminalTickers.length) throw new Error('La valoración requiere sesiones ausentes. El resultado no se publica.');
  const dataHash=await sha256(series);
  const configurationHash=await sha256({engineVersion:ENGINE_VERSION,config,dataHash});
  return {schemaVersion:1,createdAt:new Date().toISOString(),engineVersion:ENGINE_VERSION,configurationHash,config,
    data:{hash:dataHash,firstDate,lastDate:endDate,coverage,warmupBars,warnings,
      source:'confirmed_market_history',loadedAt:typeof source.loadedAt==='string'?source.loadedAt:null,
      priceBasis:'price_only',calendarYears:[EXCHANGE_CALENDAR.firstYear,EXCHANGE_CALENDAR.lastYear]},
    snapshot:{format:'finalizedData-v1',confirmedOnly:true,rows:series.flatMap(({ticker,bars})=>
      bars.map(bar=>[bar.date,ticker,bar.open,bar.high,bar.low,bar.close,bar.vol]))},
    strategy,benchmark};
}
