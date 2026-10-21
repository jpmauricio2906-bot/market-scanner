import { sessionDates } from './lab.mjs?v=3';
import { strategyWarmup } from './strategies.mjs?v=2';
import { OPTIMIZATION_DEFAULTS, DEFAULT_SEARCH_SPACE, partitionOptimizationDates } from './optimization.mjs?v=1';
import { t, translateMessage, applyTranslations, formatNumber } from './i18n.mjs?v=4';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const num = formatNumber;
const pct = value => Number.isFinite(value) ? num(value * 100) + '%' : '—';
const cash = value => Number.isFinite(value) ? '$' + num(value) : '—';
export const EXPLORATION_STORAGE_KEY = 'ms-backtest-exploration-v1';
const MAX_VIEWS = 500;
export const searchFields = {
  entryScore:'Entry Timing mínimo', trendScore:'Trend Score mínimo', momentum:'Momentum mínimo',
  relativeVolume:'Volumen relativo mínimo', minEntryDistanceAtr:'Distancia mínima / ATR', maxEntryExtensionAtr:'Extensión máxima / ATR',
  exitPeriod:'Media de salida · sesiones', exitConfirmations:'Cierres de confirmación', exitScore:'Exit Pressure mínimo · v3',
};
const weightFields = {momentumWeight:'Peso de momentum',positionWeight:'Peso de posición'};
const phaseNames = {train:'Entrenamiento',validation:'Validación',test:'Prueba final'};
const objectiveNames = {return_drawdown:'CAGR menos penalización por caída',sharpe:'Sharpe neto',cagr:'CAGR neto'};

export function parseDiscreteValues(value) {
  const parts = String(value).split(',').map(part => part.trim());
  if (!parts.length || parts.length > 12 || parts.some(part => !part || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(part))) {
    throw new Error('Introduce entre 1 y 12 números separados por comas; usa punto decimal.');
  }
  const values = parts.map(Number);
  if (values.some(value => !Number.isFinite(value))) throw new Error('Introduce entre 1 y 12 números separados por comas; usa punto decimal.');
  return [...new Set(values)];
}
export function suggestedSplit(startDate, endDate) {
  const dates = sessionDates(startDate, endDate);
  if (dates.length < 5) return null;
  return {trainEndDate:dates[Math.max(0, Math.floor(dates.length * .6) - 1)],
    validationEndDate:dates[Math.min(dates.length - 2, Math.floor(dates.length * .8) - 1)]};
}
export function optimizationEarliestStart(rows, config, optimization) {
  let warmup = strategyWarmup(config.strategy);
  if (optimization.optimizeParameters && config.strategy.exitMode === 'long_trend') {
    const space = {...DEFAULT_SEARCH_SPACE,...optimization.searchSpace};
    warmup = Math.max(warmup,strategyWarmup({...config.strategy,preset:'custom',exitPeriod:Math.max(...space.exitPeriod),exitConfirmations:Math.max(...space.exitConfirmations)}));
  }
  const tickers = Object.keys(config.weights || {});
  if (!tickers.length || !rows?.length) return null;
  const grouped = new Map(tickers.map(ticker=>[ticker,[]]));
  for (const row of rows) grouped.get(row[1])?.push(row[0]);
  const dates = tickers.map(ticker => grouped.get(ticker).sort()[warmup]);
  return dates.every(Boolean) ? {date:dates.sort().at(-1),warmupBars:warmup} : null;
}
export function readExplorationHistory(storage) {
  try {
    const raw = storage.getItem(EXPLORATION_STORAGE_KEY);
    if (raw === null) return {available:true,entries:[],totalViews:0,truncated:false};
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.entries) || !Number.isSafeInteger(value.totalViews) || value.totalViews < value.entries.length ||
      value.entries.some(row => !/^\d{4}-\d{2}-\d{2}$/.test(row.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(row.endDate) || row.startDate > row.endDate)) throw new Error('invalid ledger');
    return {available:true,...value};
  } catch { return {available:false,entries:[],totalViews:0,truncated:false}; }
}
export function explorationOverlap(history, startDate, endDate) {
  return history.entries.filter(row => row.startDate <= endDate && row.endDate >= startDate).length;
}
export function recordExploration(storage, entry, countedRange = entry) {
  const history = readExplorationHistory(storage);
  if (!history.available) return {recorded:false,previousOverlappingViews:null,limited:true};
  const previousOverlappingViews = explorationOverlap(history, countedRange.startDate, countedRange.endDate);
  try {
    const entries = [...history.entries, {...entry,viewedAt:new Date().toISOString()}];
    storage.setItem(EXPLORATION_STORAGE_KEY, JSON.stringify({version:1,entries:entries.slice(-MAX_VIEWS),
      totalViews:history.totalViews + 1,truncated:history.truncated || entries.length > MAX_VIEWS}));
    return {recorded:true,previousOverlappingViews,limited:history.truncated,
      scope:'this-browser-only; previous studies and other browsers are not tracked'};
  } catch { return {recorded:false,previousOverlappingViews,limited:true}; }
}
const label = source => `<span data-i18n="${escape(source)}">${escape(t(source))}</span>`;
const field = (id,source,type,value,attributes='') => `<div><label for="${id}" data-i18n="${escape(source)}">${escape(t(source))}</label><input id="${id}" type="${type}" value="${escape(value)}" ${attributes}></div>`;
const check = (id,source,checked=false) => `<label class="check-label" for="${id}"><input id="${id}" type="checkbox" ${checked?'checked':''}>${label(source)}</label>`;
const paragraph = source => `<p class="hint" data-i18n="${escape(source)}">${escape(t(source))}</p>`;
const ranges = fields => Object.entries(fields).map(([key,source]) => field('opt-values-'+key,source,'text',(DEFAULT_SEARCH_SPACE[key] || []).join(', '),'inputmode="decimal" maxlength="180" data-search-key="'+key+'"')).join('');

export function mountOptimizationUI({getContext,onChange}) {
  let userEditedDates = false, startAdjustment = null;
  const mode = document.createElement('section'); mode.className = 'panel experiment-mode';
  mode.innerHTML = `<label for="experiment-mode" data-i18n="Tipo de experimento">${escape(t('Tipo de experimento'))}</label><select id="experiment-mode"><option value="backtest" data-i18n="Backtest con reglas fijas">${escape(t('Backtest con reglas fijas'))}</option><option value="optimization" data-i18n="Optimización con prueba temporal">${escape(t('Optimización con prueba temporal'))}</option></select>`;
  $('setup').prepend(mode);
  const options = document.createElement('section'); options.id = 'optimization-options'; options.className = 'optimization-options'; options.hidden = true;
  options.innerHTML = `<h3 data-i18n="Búsqueda y validación">${escape(t('Búsqueda y validación'))}</h3><div class="field-grid">${field('opt-train-end','Fin del entrenamiento','date','')}${field('opt-validation-end','Fin de la validación','date','')}</div><button id="opt-suggest-dates" type="button">${label('Sugerir división 60 / 20 / 20')}</button><label for="opt-objective" data-i18n="Objetivo de selección">${escape(t('Objetivo de selección'))}</label><select id="opt-objective"><option value="return_drawdown" data-i18n="CAGR menos penalización por caída">${escape(t('CAGR menos penalización por caída'))}</option><option value="sharpe" data-i18n="Sharpe neto">${escape(t('Sharpe neto'))}</option><option value="cagr" data-i18n="CAGR neto">${escape(t('CAGR neto'))}</option></select><div class="field-grid">${field('opt-penalty','Penalización por caída','number',1,'min="0" max="10" step="0.1" required')}${field('opt-candidates','Máximo de candidatos','number',40,'min="2" max="100" step="1" required')}${field('opt-shortlist','Finalistas de entrenamiento','number',5,'min="1" max="5" step="1" required')}${field('opt-seed','Semilla reproducible','number',20261020,'min="0" max="4294967295" step="1" required')}</div>
  ${check('opt-parameters','Optimizar parámetros de señales',true)}<fieldset id="opt-parameter-fields"><legend>${label('Parámetros de la estrategia')}</legend>${paragraph('Valores candidatos, separados por comas. Un único valor mantiene ese criterio fijo.')}<div class="field-grid">${ranges(searchFields)}</div>${paragraph('La regla de venta y “solo compras fuertes” se conservan del modelo elegido. Los candidatos editados usan la estrategia personalizada.')}</fieldset>
  ${check('opt-entry-weights','Optimizar pesos de Entry Timing')}${paragraph('Modificar parámetros o pesos de Entry Timing usa reglas personalizadas: el volumen mínimo se exige en todas las compras, incluso partiendo de v3. El modelo original se conserva como comparador.')}<fieldset id="opt-entry-fields"><legend>${label('Optimizar pesos de Entry Timing')}</legend><div class="field-grid">${ranges(weightFields)}</div>${paragraph('Son fracciones no negativas: 0.5 equivale a 50%. El peso de volumen es 1 menos momentum y posición; la suma no puede superar 1. No cambia el scanner.')}</fieldset>
  ${check('opt-asset-weights','Optimizar distribución entre activos')}<fieldset id="opt-asset-fields"><legend>${label('Pesos seleccionados')}</legend><div class="field-grid">${field('opt-min-weight','Peso mínimo por activo · %','number',0.1,'min="0.001" max="100" step="any" required')}${field('opt-max-weight','Peso máximo por activo · %','number',100,'min="0.001" max="100" step="any" required')}</div>${paragraph('Los límites se aplican a todos los activos, también a los pesos originales. No se excluyen activos ni se rebalancea.')}</fieldset>
  <section class="protocol-preview"><h4>${label('Protocolo antes de ejecutar')}</h4><div id="opt-protocol-dates"></div><p id="opt-protocol-budget" class="hint"></p><p id="opt-protocol-costs" class="hint"></p>${paragraph('Entrenamiento ordena candidatos; validación elige entre los finalistas. La prueba final no interviene en ninguna selección de esta ejecución.')}${paragraph('Cada fase comienza con el mismo capital en efectivo y liquida al final. La preparación usa solo sesiones anteriores.')}${paragraph('La prueba está reservada dentro de esta búsqueda. Estas fechas pueden haberse consultado antes; repetir ajustes después de verlas convierte el ejercicio en exploración.')}<p id="opt-history-warning" class="hint"></p></section>`;
  document.querySelector('.run-controls').before(options);
  const results = document.createElement('section'); results.id = 'optimization-results'; results.hidden = true; $('results').prepend(results);
  const enabled = () => $('experiment-mode').value === 'optimization';
  function suggest(force=false) {
    try {
      if (enabled() && force) {
        const context = getContext(), minimum = optimizationEarliestStart(context.rows,context,read());
        if (minimum && $('start-date').value < minimum.date) {
          $('start-date').value = minimum.date; startAdjustment = minimum.date;
        }
      }
      const split = suggestedSplit($('start-date').value,$('end-date').value);
      if (!split) return;
      if (force || !$('opt-train-end').value) $('opt-train-end').value = split.trainEndDate;
      if (force || !$('opt-validation-end').value) $('opt-validation-end').value = split.validationEndDate;
    } catch { /* Incomplete dates are explained in the protocol preview. */ }
  }
  function read() {
    const optimizeParameters = $('opt-parameters').checked, optimizeEntryWeights = $('opt-entry-weights').checked;
    const searchSpace = {};
    const longTrend = getContext().strategy?.exitMode === 'long_trend';
    for (const [key,source] of Object.entries({...(optimizeParameters?searchFields:{}),...(optimizeEntryWeights?weightFields:{})})) {
      if ((longTrend && key === 'exitScore') || (!longTrend && ['exitPeriod','exitConfirmations'].includes(key))) continue;
      try { searchSpace[key] = parseDiscreteValues($('opt-values-'+key).value); }
      catch { throw new Error(t('Revisa los valores de búsqueda: {field}.',{field:t(source)})+' '+t('Introduce entre 1 y 12 números separados por comas; usa punto decimal.')); }
    }
    return {...OPTIMIZATION_DEFAULTS,trainEndDate:$('opt-train-end').value,validationEndDate:$('opt-validation-end').value,
      candidateCount:Number($('opt-candidates').value),shortlistSize:Number($('opt-shortlist').value),seed:Number($('opt-seed').value),
      objective:$('opt-objective').value,drawdownPenalty:Number($('opt-penalty').value),optimizeParameters,optimizeEntryWeights,
      optimizeWeights:$('opt-asset-weights').checked,minWeight:Number($('opt-min-weight').value)/100,maxWeight:Number($('opt-max-weight').value)/100,searchSpace};
  }
  function refresh(busy=false) {
    const active = enabled(); options.hidden = !active;
    // Hidden optimization inputs cannot invalidate an ordinary backtest.
    options.querySelectorAll('input,select,button').forEach(element => {element.disabled = busy || !active;});
    $('opt-parameter-fields').disabled = busy || !active || !$('opt-parameters').checked;
    $('opt-entry-fields').disabled = busy || !active || !$('opt-entry-weights').checked;
    $('opt-asset-fields').disabled = busy || !active || !$('opt-asset-weights').checked;
    $('opt-penalty').disabled = busy || !active || $('opt-objective').value !== 'return_drawdown';
    const context = getContext();
    const longTrend = context.strategy?.exitMode === 'long_trend';
    for (const key of ['exitPeriod','exitConfirmations']) $('opt-values-'+key).disabled = busy || !active || !$('opt-parameters').checked || !longTrend;
    $('opt-values-exitScore').disabled = busy || !active || !$('opt-parameters').checked || longTrend;
    const runLabel = active?'Optimizar y evaluar':'Ejecutar backtest';
    const runSpan = $('run').querySelector('[data-i18n]'); runSpan.dataset.i18n = runLabel; runSpan.textContent = t(runLabel);
    if (!active) return;
    suggest();
    try {
      const optimization = read();
      const minimum = optimizationEarliestStart(context.rows,context,optimization);
      if (minimum && context.startDate < minimum.date) throw new Error(t('La búsqueda necesita {warmup} cierres previos en todos los activos. El primer inicio elegible es {date}. Usa Sugerir división para actualizar las fechas.',{warmup:minimum.warmupBars,date:minimum.date}));
      const phases = partitionOptimizationDates(context,optimization);
      $('opt-protocol-dates').innerHTML = (startAdjustment?`<p class="hint">${escape(t('Inicio ajustado a {date} para preparar todos los candidatos y activos.',{date:startAdjustment}))}</p>`:'') + Object.entries(phases).map(([key,phase]) => `<p class="hint">${escape(t('{phase}: {start} → {end} · {sessions} sesiones',{phase:t(phaseNames[key]),start:phase.startDate,end:phase.endDate,sessions:num(phase.sessions,0)}))}</p>`).join('');
      let history; try {history=readExplorationHistory(localStorage);} catch {history={available:false,entries:[]};}
      const count = explorationOverlap(history,phases.test.startDate,phases.test.endDate);
      $('opt-history-warning').textContent = t(!history.available?'No se puede consultar el registro local; no es posible contar las visualizaciones anteriores.':count?'{count} visualizaciones locales anteriores se solapan con la prueba. El registro no incluye otros navegadores ni estudios previos.':'Sin visualizaciones locales registradas para estas fechas. Esto no certifica que sean datos nunca vistos.',{count:num(count,0)}) + (history.truncated?' '+t('Solo se conservan las últimas 500 visualizaciones; puede haber consultas anteriores.'): '');
    } catch (error) {
      $('opt-protocol-dates').textContent = context.startDate && context.endDate ? translateMessage(error.message) : t('Completa las fechas para revisar la división temporal.');
      $('opt-history-warning').textContent = '';
    }
    $('opt-protocol-budget').textContent = t('Presupuesto: hasta {candidates} candidatos · {shortlist} finalistas · Semilla {seed}',{candidates:$('opt-candidates').value,shortlist:$('opt-shortlist').value,seed:$('opt-seed').value});
    $('opt-protocol-costs').textContent = t('Costes por lado: comisión {commission}% + deslizamiento {slippage}%, para todos los comparadores.',{commission:num(context.commissionBps/100),slippage:num(context.slippageBps/100)});
  }
  mode.addEventListener('change',() => {if (!userEditedDates) suggest(true);onChange();refresh();});
  for (const id of ['start-date','end-date']) $(id).addEventListener('change',()=>{userEditedDates=true;startAdjustment=null;refresh();});
  options.addEventListener('change',() => {onChange();refresh();});
  $('opt-suggest-dates').addEventListener('click',() => {suggest(true);onChange();refresh();});
  applyTranslations(mode); applyTranslations(options); refresh();
  return {enabled,read,refresh,suggest};
}

export function selectedOptimizationResult(report) {
  return {...report,config:{...report.config,strategy:report.selection.strategy,weights:report.selection.weights,
    startDate:report.phases.test.startDate,endDate:report.phases.test.endDate},
    strategy:report.test.selectedStrategy,benchmark:report.test.selectedBenchmark};
}
export function renderOptimizationResult(report) {
  const target = $('optimization-results'); target.hidden = !report;
  if (!report) return;
  const chosen = report.selection;
  const table = (headers,rows) => `<div class="table-scroll"><table><thead><tr>${headers.map(key=>`<th>${escape(t(key))}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(value=>`<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const weights = Object.entries(chosen.weights).map(([ticker,weight]) => [escape(ticker),pct(weight)]);
  const valueLabel = (key,value) => key==='preset' ? t({v3:'Scanner v3',sma200:'Tendencia larga · SMA200',custom:'Estrategia personalizada'}[value]||value) : key==='exitMode' ? t(value==='long_trend'?'Pérdida de tendencia de largo plazo':'v3 · ruptura y presión de salida') : typeof value==='boolean' ? t(value?'Sí':'No') : typeof value==='number'?num(value):value;
  const params = Object.entries(chosen.strategy).map(([key,value]) => [escape(t(searchFields[key] || weightFields[key] || {preset:'Modelo',volumeWeight:'Peso de volumen',exitMode:'Regla de venta',strongOnly:'Solo compras fuertes confirmadas'}[key] || key)),escape(valueLabel(key,value))]);
  const rows = [...report.trials].sort((a,b) => (b.train?.score ?? -Infinity) - (a.train?.score ?? -Infinity) || a.id.localeCompare(b.id)).map(trial=>[
    `${escape(trial.id==='original'?t('Original'):trial.id)}${trial.id===chosen.candidateId?` <span class="badge">${escape(t('Seleccionado'))}</span>`:''}`,
    num(trial.train?.score,4),num(trial.validation?.score,4),pct(trial.train?.metrics?.cagr),pct(trial.validation?.metrics?.cagr)]);
  const comparison = [
    ['Estrategia seleccionada · pesos seleccionados',report.test.selectedStrategy],['Mantener · pesos seleccionados',report.test.selectedBenchmark],
    ['Estrategia original · pesos originales',report.test.referenceStrategy],['Mantener · pesos originales',report.test.referenceBenchmark],
  ].map(([name,result]) => [escape(t(name)),pct(result.metrics.totalReturn),pct(result.metrics.cagr),pct(result.metrics.maxDrawdown),num(result.metrics.sharpeRatio),cash(result.metrics.totalCost),cash(result.metrics.finalEquity)]);
  const phases = Object.entries(report.phases).map(([key,phase])=>`<p class="hint">${escape(t('{phase}: {start} → {end} · {sessions} sesiones',{phase:t(phaseNames[key]),start:phase.startDate,end:phase.endDate,sessions:num(phase.sessions,0)}))}</p>`).join('');
  const viewed = report.exploration?.previousOverlappingViews;
  const frozenProtocol = `<p class="config-summary">${escape(t('Criterio registrado: {objective} · Penalización {penalty} · Semilla {seed} · Presupuesto {budget} · Preparación común {warmup} cierres',{objective:t(objectiveNames[report.optimization.objective]),penalty:num(report.optimization.drawdownPenalty),seed:report.optimization.seed,budget:report.optimization.candidateCount,warmup:report.data.warmupBars}))}</p>`;
  target.innerHTML = `<section class="panel optimization-summary"><p class="eyebrow">${escape(t('Selección sin usar la prueba final'))}</p><h3>${escape(t('Candidato seleccionado: {id}',{id:chosen.candidateId}))}</h3><p class="hint">${escape(t('{count} candidatos evaluados en entrenamiento; la validación decide entre {shortlist} finalistas.',{count:report.trials.length,shortlist:report.trials.filter(item=>item.validation).length}))}</p>${frozenProtocol}${phases}<p class="hint">${escape(t('La prueba está reservada dentro de esta búsqueda. Estas fechas pueden haberse consultado antes; repetir ajustes después de verlas convierte el ejercicio en exploración.'))}</p><p class="hint">${escape(t(viewed===null||viewed===undefined?'No se puede consultar el registro local; no es posible contar las visualizaciones anteriores.':viewed?'{count} visualizaciones locales anteriores se solapan con la prueba. El registro no incluye otros navegadores ni estudios previos.':'Sin visualizaciones locales registradas para estas fechas. Esto no certifica que sean datos nunca vistos.',{count:num(viewed,0)}))}</p><div class="optimization-winner"><div><h4>${escape(t('Pesos seleccionados'))}</h4>${table(['Activo','Peso'],weights)}</div><div><h4>${escape(t('Parámetros seleccionados'))}</h4>${table(['Parámetro','Valor'],params)}</div></div></section><section class="panel"><h3>${escape(t('Clasificación de entrenamiento y validación'))}</h3><p class="hint">${escape(t('Solo los finalistas reciben una puntuación de validación. La tabla no contiene resultados de prueba de candidatos descartados.'))}</p><div class="optimization-leaderboard">${table(['Candidato','Objetivo entrenamiento','Objetivo validación','CAGR entrenamiento','CAGR validación'],rows)}</div></section><section class="panel"><h3>${escape(t('Prueba final · cuatro comparadores'))}</h3><p class="hint">${escape(t('Los cuatro empiezan con el mismo capital, fechas, preparación y costes. Comparar con los pesos originales separa el efecto de redistribuir la cartera.'))}</p>${table(['Comparador','Rentabilidad neta','Rentabilidad anualizada','Caída máxima','Sharpe (tipo libre de riesgo 0)','Costes totales','Capital final'],comparison)}<p class="hint">${escape(t('Los gráficos, operaciones y CSV inferiores muestran únicamente la prueba final del candidato seleccionado y mantener con sus mismos pesos. El JSON incluye el experimento completo y los cuatro comparadores.'))}</p></section>`;
}
