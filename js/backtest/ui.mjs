import { inspectHistory, DEFAULT_CONFIG, PRESET_STRATEGIES } from './lab.mjs?v=2';
import { fetchBacktestHistory, defaultHistoryStart } from './history.mjs';
import { validateWeights, normalizeWeights, equalWeights, readPortfolios, savePortfolio, deletePortfolio, toCsv } from './storage.mjs';
import { t, translateMessage, getLanguage, setLanguage, onLanguageChange, languageLink, applyTranslations, formatNumber } from './i18n.mjs?v=3';

const $ = id => document.getElementById(id);
const state = { universe: null, weights: {}, portfolios: [], storageReady: true, rows: [], scope: new Set(), source: null, download: null,
  worker: null, busy: false, request: 0, revision: 0, resultRevision: null, result: null, tradePage: 0, inspection: null,
  message: null, statuses: new Map(), universeFailed: false };
const PAGE_SIZE = 25;
const strategyNames = { v3: 'Scanner v3', sma200: 'Tendencia larga · SMA200', custom: 'Estrategia personalizada' };
const strategyFields = { entryScore: 'entry-score', trendScore: 'trend-score', momentum: 'momentum-score',
  maxEntryExtensionAtr: 'max-extension', minEntryDistanceAtr: 'min-distance', relativeVolume: 'relative-volume',
  exitPeriod: 'exit-period', exitConfirmations: 'exit-confirmations', exitScore: 'exit-score' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = formatNumber;
const percent = value => Number.isFinite(value) ? number(value * 100) + '%' : '—';
const money = value => Number.isFinite(value) ? '$' + number(value) : '—';
const signClass = value => value > 0 ? 'positive' : value < 0 ? 'negative' : '';
const uuid = () => globalThis.crypto?.randomUUID?.() ?? 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2);
const selectedTickers = () => Object.keys(state.weights);
const themeNames = {midnight:'🌙 Medianoche', arctic:'❄️ Ártico', tableau:'📊 Tableau', forest:'🌿 Bosque',
  sunset:'🌅 Atardecer', slate:'🪨 Pizarra', lavender:'💜 Lavanda', solarized:'☀️ Solarizado'};
function renderThemes() {
  const themes = globalThis.MarketBacktestTheme;
  $('themeSwitcher').innerHTML = Object.entries(themes.THEMES).map(([id,theme]) =>
    `<button type="button" class="theme-dot${themes.getTheme() === id ? ' active' : ''}" data-theme="${id}" style="background:${theme.color}" title="${escape(t(themeNames[id]))}" aria-label="${escape(t(themeNames[id]))}" aria-pressed="${themes.getTheme() === id}"></button>`).join('');
}
function updateThemeButtons() {
  const selected = globalThis.MarketBacktestTheme.getTheme();
  for (const button of $('themeSwitcher').querySelectorAll('[data-theme]')) {
    button.classList.toggle('active', button.dataset.theme === selected);
    button.setAttribute('aria-pressed', String(button.dataset.theme === selected));
  }
}

function translated(descriptor) {
  const params = typeof descriptor.params === 'function' ? descriptor.params() : descriptor.params;
  return descriptor.raw ? translateMessage(t(descriptor.source)) : t(descriptor.source, params);
}
function renderMessage() {
  if (!state.message) return;
  $('message').textContent = translated(state.message);
  $('message').className = 'notice' + (state.message.type ? ' ' + state.message.type : '');
  $('message').hidden = !state.message.source;
}
function message(source, type = '', params = {}) {
  state.message = { source, type, params }; renderMessage();
}
function fail(error) {
  state.message = { source: error instanceof Error ? error.message : String(error), type: 'error', raw: true };
  renderMessage();
}
function status(id, source, params = {}, raw = false) {
  const descriptor = { source, params, raw };
  state.statuses.set(id, descriptor); $(id).textContent = translated(descriptor);
}
function changed() {
  state.revision++;
  $('dirty-label').hidden = !state.result || state.revision === state.resultRevision;
}
function hasHistory() {
  const tickers = selectedTickers();
  return tickers.length > 0 && state.rows.length > 0 && tickers.every(ticker => state.scope.has(ticker));
}
function currentStrategy() {
  const preset = $('strategy-preset').value;
  if (preset !== 'custom') return { ...PRESET_STRATEGIES[preset], preset };
  return { ...PRESET_STRATEGIES.custom, preset, ...Object.fromEntries(Object.entries(strategyFields).map(([key, id]) => [key, Number($(id).value)])),
    exitMode: $('exit-mode').value, strongOnly: $('strong-only').checked };
}
function applyPreset() {
  const preset = $('strategy-preset').value;
  const strategy = PRESET_STRATEGIES[preset];
  for (const [key, id] of Object.entries(strategyFields)) $(id).value = strategy[key];
  $('strong-only').checked = strategy.strongOnly;
  $('exit-mode').value = strategy.exitMode;
  updateStrategyDisabled();
  renderPresetDescription();
}
function renderPresetDescription() {
  const preset = $('strategy-preset').value;
  $('preset-description').textContent = t(preset === 'v3'
    ? 'Reglas de producción v3, sin modificaciones. Selecciona Personalizada para editar los criterios.'
    : preset === 'sma200'
      ? 'Compras v3. Venta tras 3 cierres consecutivos por debajo de SMA200; la ruptura bloquea también nuevas compras. Reglas fijas.'
      : 'Experimento editable. Los cambios afectan a esta simulación; no modifican las señales del scanner.');
}
function updateStrategyDisabled() {
  const custom = $('strategy-preset').value === 'custom';
  $('strategy-fields').disabled = state.busy || !custom;
  $('exit-period').disabled = state.busy || !custom || $('exit-mode').value !== 'long_trend';
  $('exit-confirmations').disabled = $('exit-period').disabled;
  $('exit-score').disabled = state.busy || !custom || $('exit-mode').value !== 'v3';
}
function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('.setup input, .setup select, .setup button').forEach(element => { element.disabled = busy; });
  $('cancel').hidden = !busy;
  $('cancel').disabled = false;
  $('run-progress').hidden = !busy;
  $('run').disabled = busy || !hasHistory();
  $('load-history').disabled = busy || !state.universe || !selectedTickers().length;
  updateStrategyDisabled();
  $('save-portfolio').disabled = busy || !state.storageReady;
  $('delete-portfolio').disabled = busy || !state.storageReady;
}

function renderUniverse() {
  if (!state.universe) {
    if (state.universeFailed) $('universe-list').innerHTML = `<p class="muted">${escape(t('No se pudo cargar el universo. Recarga la página para reintentar.'))}</p>`;
    return;
  }
  const query = $('search').value.toLocaleLowerCase(getLanguage()).trim();
  const type = $('type-filter').value;
  const items = state.universe.instruments.filter(item => (type === 'all' || item.type === type) &&
    (!query || (item.ticker + ' ' + item.name).toLocaleLowerCase(getLanguage()).includes(query)));
  $('universe-list').innerHTML = items.length ? items.map(item => `<label class="asset-option"><input type="checkbox" data-ticker="${escape(item.ticker)}" ${Object.hasOwn(state.weights, item.ticker) ? 'checked' : ''}><span><strong>${escape(item.ticker)}</strong><span class="asset-name">${escape(item.name)}</span></span><span class="asset-kind">${item.type === 'STOCK' ? escape(t('ACCIÓN')) : item.dailyLeverage !== 1 ? escape(item.dailyLeverage) + '× ETF' : 'ETF'}</span></label>`).join('')
    : `<p class="muted">${escape(t('No hay coincidencias.'))}</p>`;
}
function renderSelection() {
  const tickers = selectedTickers();
  $('selection-count').textContent = t(tickers.length === 1 ? '{count} activo' : '{count} activos', { count: number(tickers.length, 0) });
  $('selection-body').innerHTML = tickers.length ? tickers.map(ticker => `<tr><td>${escape(ticker)}</td><td><label class="sr-only" for="weight-${escape(ticker)}">${escape(t('Peso de {ticker} en porcentaje', { ticker }))}</label><input id="weight-${escape(ticker)}" data-weight="${escape(ticker)}" type="number" min="0" max="100" step="any" value="${Number((state.weights[ticker] * 100).toFixed(6))}"></td><td><button type="button" data-remove="${escape(ticker)}" aria-label="${escape(t('Quitar {ticker}', { ticker }))}">×</button></td></tr>`).join('')
    : `<tr><td colspan="3" class="empty-small">${escape(t('Selecciona un activo para empezar.'))}</td></tr>`;
  renderTotal();
  $('run').disabled = state.busy || !hasHistory();
  $('load-history').disabled = state.busy || !tickers.length;
}
function renderTotal() {
  const total = Object.values(state.weights).reduce((sum, value) => sum + value, 0);
  $('weight-total').textContent = percent(total);
  $('weight-total').className = Math.abs(total - 1) <= 1e-9 ? '' : 'invalid';
}
function selectionChanged() {
  changed(); renderSelection(); renderUniverse(); refreshCoverage(false);
  if (!hasHistory()) status('history-status', 'La selección cambió. Carga su historial antes de ejecutar.');
}
function renderPortfolios() {
  const current = $('saved-portfolio').value, parent = $('portfolio-parent').value;
  $('saved-portfolio').innerHTML = `<option value="">${escape(t('Elige una cartera…'))}</option>` + state.portfolios.map(item => `<option value="${escape(item.id)}">${item.parentId ? '↳ ' : ''}${escape(item.name)} · ${escape(t(Object.keys(item.weights).length === 1 ? '{count} activo' : '{count} activos', { count: number(Object.keys(item.weights).length, 0) }))}</option>`).join('');
  $('portfolio-parent').innerHTML = `<option value="">${escape(t('Cartera independiente'))}</option>` + state.portfolios.filter(item => !item.parentId).map(item => `<option value="${escape(item.id)}">${escape(t('Subcartera de {name}', { name: item.name }))}</option>`).join('');
  if (state.portfolios.some(item => item.id === current)) $('saved-portfolio').value = current;
  if (state.portfolios.some(item => item.id === parent)) $('portfolio-parent').value = parent;
  $('portfolio-count').textContent = state.portfolios.length;
}

function warningsHtml(warnings) {
  return warnings?.length ? '<ul class="warning-list">' + [...new Set(warnings)].map(warning => `<li>${escape(translateMessage(warning))}</li>`).join('') + '</ul>' : `<p class="hint">${escape(t('Sin advertencias adicionales registradas.'))}</p>`;
}
function renderCoverage() {
  const info = state.inspection;
  $('coverage-panel').hidden = !info;
  if (!info) return;
  $('coverage-count').textContent = t(info.coverage.length === 1 ? '{count} activo' : '{count} activos', { count: number(info.coverage.length, 0) });
  $('coverage-summary').textContent = t('Se requieren {count} cierres previos antes de operar, también para comprar y mantener. Cada activo entra cuando reúne su historial mínimo.', { count: number(info.warmupBars, 0) });
  $('coverage-body').innerHTML = info.coverage.map(item => `<tr><td>${escape(item.ticker)}</td><td>${number(item.bars, 0)}</td><td>${escape(item.firstDate || '—')}</td><td>${escape(item.lastDate || '—')}</td><td>${escape(item.firstEligibleDate || t('Sin historial suficiente'))}</td></tr>`).join('');
  $('coverage-warnings').innerHTML = warningsHtml(info.warnings);
}
function refreshCoverage(resetDates) {
  if (!hasHistory()) { $('coverage-panel').hidden = true; state.inspection = null; return; }
  try {
    // Inspection only needs the selected symbols; unfinished weights stay editable.
    const weights = equalWeights(selectedTickers());
    const info = inspectHistory(state.rows, { weights, strategy: currentStrategy() });
    for (const item of state.source?.coverage || []) {
      if (Object.hasOwn(weights, item.ticker) && item.last_error) info.warnings.push(`${item.ticker}: la última actualización falló; se conserva el historial confirmado hasta ${item.last_date}.`);
    }
    state.inspection = info;
    renderCoverage();
    if (resetDates || !$('start-date').value) $('start-date').value = defaultHistoryStart(info.endDate, info.startDate);
    if (resetDates || !$('end-date').value) $('end-date').value = info.endDate || '';
    status('history-status', info.coverage.length === 1 ? '{count} activo cargado · {warmup} sesiones de preparación · cierres confirmados.' : '{count} activos cargados · {warmup} sesiones de preparación · cierres confirmados.', () => ({ count: number(info.coverage.length, 0), warmup: number(info.warmupBars, 0) }));
    status('run-status', 'Historial listo. Revisa las fechas y ejecuta la simulación.');
  } catch (error) {
    state.inspection = null;
    $('coverage-panel').hidden = true;
    status('history-status', error.message, {}, true);
  }
}
async function loadHistory() {
  if (!selectedTickers().length) return message('Selecciona al menos un activo.', 'error');
  const request = ++state.request, tickers = selectedTickers();
  const controller = new AbortController(); state.download = controller;
  message(''); setBusy(true); $('run-progress').removeAttribute('value');
  status('run-status', 'Descargando únicamente sesiones confirmadas…');
  try {
    const response = await fetchBacktestHistory({tickers, baseUrl: SUPABASE_URL, headers: globalThis._publicReadHeaders(), signal: controller.signal,
      onProgress: progress => {
        if (request === state.request) status('run-status', 'Cargando historial largo: {count} barras · {completed} de {total} activos listos…',
          () => ({count: number(progress.received, 0), completed: number(progress.completed, 0), total: number(progress.total, 0)}));
      }});
    if (request !== state.request) return;
    if (!Array.isArray(response.finalizedData)) throw new Error('La fuente no devolvió un historial confirmado. No se ejecutará el backtest.');
    state.rows = response.finalizedData;
    state.scope = new Set(tickers);
    state.source = response.source;
    changed(); refreshCoverage(true);
    if (!state.inspection) throw new Error(state.statuses.get('history-status')?.source || 'No se pudo comprobar el historial.');
    message('Historial cargado. Las fechas sugeridas respetan el historial mínimo de la estrategia.', 'success');
  } catch (error) { if (request === state.request) { fail(error); status('run-status', 'No se pudo cargar el historial de esta selección.'); } }
  finally { if (state.download === controller) state.download = null; if (request === state.request) { setBusy(false); $('run-progress').value = 0; } }
}
function readConfig() {
  for (const element of document.querySelectorAll('.setup input[type=number]:not(:disabled), .setup input[type=date]:not(:disabled)')) {
    if (!element.reportValidity()) throw new Error('Revisa los valores marcados en la configuración.');
  }
  return { ...DEFAULT_CONFIG, weights: validateWeights(state.weights), startDate: $('start-date').value, endDate: $('end-date').value,
    initialCapital: Number($('capital').value), commissionBps: Number($('commission').value) * 100,
    slippageBps: Number($('slippage').value) * 100, strategy: currentStrategy() };
}
function run() {
  if (!hasHistory()) return message('Carga el historial de la selección antes de ejecutar.', 'error');
  let config;
  try { config = readConfig(); } catch (error) { fail(error); return; }
  const request = ++state.request, revision = state.revision;
  message(''); setBusy(true); $('run-progress').value = 0;
  status('run-status', 'Calculando señales y ejecuciones…');
  try {
    const worker = new Worker(new URL('./worker.mjs?v=2', import.meta.url), { type: 'module' });
    state.worker = worker;
    const finish = () => { worker.terminate(); if (state.worker === worker) state.worker = null; if (request === state.request) setBusy(false); };
    worker.onmessage = event => {
      const response = event.data;
      if (request !== state.request || response.id !== String(request)) return;
      if (response.type === 'progress') {
        const { completed, total, ticker } = response.progress;
        $('run-progress').value = total ? completed / total * 100 : 0;
        status('run-status', total === 1 ? 'Calculando {ticker} · {completed} de {total} activo' : 'Calculando {ticker} · {completed} de {total} activos', () => ({ ticker: ticker || '', completed: number(completed, 0), total: number(total, 0) }));
      } else if (response.type === 'result') {
        state.result = response.result; state.resultRevision = revision; state.tradePage = 0;
        finish(); renderResult();
        status('run-status', 'Simulación terminada. Los resultados incluyen costes de entrada y salida.');
        $('results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      } else if (response.type === 'error') { finish(); fail(response.error); status('run-status', 'No se completó esta ejecución.'); }
    };
    worker.onerror = event => { finish(); if (request === state.request) { fail(event.message || 'No se pudo iniciar el motor. Recarga la página e inténtalo de nuevo.'); status('run-status', 'La ejecución falló.'); } };
    worker.postMessage({ type: 'run', id: String(request), payload: { rows: state.rows.filter(row => Object.hasOwn(config.weights, row[1])), config, source: state.source } });
  } catch (error) { state.worker?.terminate(); state.worker = null; setBusy(false); fail(error); }
}

function chart(container, strategy, benchmark, key, drawdown = false) {
  const width = 760, height = drawdown ? 150 : 255, left = 76, right = 14, top = 15, bottom = 30;
  const series = [strategy, benchmark];
  const dates = [...new Set(series.flatMap(rows => rows.map(row => row.date)))].sort();
  const values = series.flatMap(rows => rows.map(row => row[key])).filter(Number.isFinite);
  if (!dates.length || !values.length) { container.textContent = t('Sin datos para esta curva.'); return; }
  let min = Math.min(...values, drawdown ? 0 : Infinity), max = Math.max(...values, drawdown ? 0 : -Infinity);
  if (min === max) { min -= drawdown ? .01 : Math.max(1, Math.abs(min) * .01); max += drawdown ? 0 : Math.max(1, Math.abs(max) * .01); }
  const pad = drawdown ? 0 : (max - min) * .1; min -= pad; max += pad;
  const first = Date.parse(dates[0]), last = Date.parse(dates.at(-1));
  const x = date => left + (Date.parse(date) - first) / Math.max(1, last - first) * (width - left - right);
  const y = value => top + (max - value) / (max - min) * (height - top - bottom);
  const path = rows => rows.map((row, index) => `${index ? 'L' : 'M'}${x(row.date).toFixed(2)},${y(row[key]).toFixed(2)}`).join(' ');
  const ticks = Array.from({ length: 4 }, (_, i) => min + (max - min) * i / 3);
  const yLabel = value => drawdown ? number(value * 100, 1) + '%' : '$' + (Math.abs(value) >= 1000000 ? number(value / 1000000, 1) + ' M' : Math.abs(value) >= 1000 ? number(value / 1000, 1) + ' k' : number(value, 0));
  const dateLabels = [...new Set([dates[0], dates[Math.floor((dates.length - 1) / 2)], dates.at(-1)])];
  const description = t('{measure}: estrategia y comprar y mantener entre {start} y {end}', { measure: t(drawdown ? 'Caída porcentual desde máximos' : 'Capital en dólares'), start: dates[0], end: dates.at(-1) });
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(description)}">${ticks.map(tick => `<line class="chart-grid" x1="${left}" y1="${y(tick)}" x2="${width - right}" y2="${y(tick)}"/><text x="${left - 12}" y="${y(tick) + 4}" text-anchor="end">${escape(yLabel(tick))}</text>`).join('')}<path class="chart-benchmark" d="${path(benchmark)}"/><path class="chart-strategy" d="${path(strategy)}"/>${dateLabels.map((date, index) => `<text x="${x(date)}" y="${height - 7}" text-anchor="${index === 0 ? 'start' : index === dateLabels.length - 1 ? 'end' : 'middle'}">${escape(date)}</text>`).join('')}</svg>`;
}
function renderResult() {
  const result = state.result, strategy = result.strategy, benchmark = result.benchmark, config = result.config;
  $('empty-state').hidden = true; $('results').hidden = false; $('dirty-label').hidden = state.revision === state.resultRevision;
  $('result-title').textContent = t(strategyNames[config.strategy.preset] || 'Estrategia');
  $('result-meta').textContent = t('{start} → {end} · {sessions} sesiones · Motor {version}', { start: strategy.period.startDate, end: strategy.period.endDate, sessions: number(strategy.period.sessions, 0), version: result.engineVersion });
  const assetCount = Object.keys(config.weights).length;
  $('result-config').textContent = t(assetCount === 1 ? '{count} activo · Capital {capital} · Comisión {commission}% y deslizamiento {slippage}% por lado · Pesos iniciales sin rebalanceo' : '{count} activos · Capital {capital} · Comisión {commission}% y deslizamiento {slippage}% por lado · Pesos iniciales sin rebalanceo', { count: number(assetCount, 0), capital: money(config.initialCapital), commission: number(config.commissionBps / 100), slippage: number(config.slippageBps / 100) });
  const a = strategy.metrics, b = benchmark.metrics;
  const cards = [['Rentabilidad neta', 'totalReturn', percent, 'Ganancia acumulada'], ['Caída máxima', 'maxDrawdown', percent, 'Desde un máximo previo'], ['Rentabilidad anualizada', 'cagr', percent, 'CAGR del período'], ['Costes totales', 'totalCost', money, 'Comisión + deslizamiento']];
  $('metrics').innerHTML = cards.map(([label, key, format, note]) => `<article class="metric"><div class="metric-label">${escape(t(label))}</div><div class="metric-value ${a[key] < 0 ? 'negative' : ''}">${format(a[key])}</div><div class="metric-benchmark">${escape(t('{value} mantener', { value: format(b[key]) }))}</div><div class="metric-note">${escape(t(note))}</div></article>`).join('');
  const rows = [['Capital final', 'finalEquity', money], ['Beneficio neto', 'netProfit', money], ['Sharpe (tipo libre de riesgo 0)', 'sharpeRatio', number], ['Volatilidad anualizada', 'annualizedVolatility', percent], ['Exposición media', 'averageExposure', percent], ['Ciclos de compra y venta', 'tradeCount', value => number(value, 0)], ['Salidas por señal', 'signalExits', value => number(value, 0)], ['Liquidaciones al final', 'terminalExits', value => number(value, 0)], ['Operaciones con ganancia', 'winRate', percent], ['Duración media · sesiones', 'averageHoldingSessions', number], ['Duración mediana · sesiones', 'medianHoldingSessions', number], ['Comisiones', 'commissionCost', money], ['Deslizamiento', 'slippageCost', money]];
  $('metrics-detail').innerHTML = rows.map(([label, key, format]) => `<tr><td>${escape(t(label))}</td><td>${format(a[key])}</td><td>${format(b[key])}</td></tr>`).join('');
  chart($('equity-chart'), strategy.equityCurve, benchmark.equityCurve, 'equity');
  chart($('drawdown-chart'), strategy.equityCurve, benchmark.equityCurve, 'drawdown', true);
  const benchmarkTickers = new Map(benchmark.perTicker.map(item => [item.ticker, item]));
  $('ticker-results').innerHTML = strategy.perTicker.map(item => `<tr><td><a class="ticker-link" href="${escape(languageLink('ticker.html?ticker=' + encodeURIComponent(item.ticker)))}">${escape(item.ticker)}</a></td><td>${percent(config.weights[item.ticker])}</td><td class="${signClass(item.totalReturn)}">${percent(item.totalReturn)}</td><td>${percent(benchmarkTickers.get(item.ticker)?.totalReturn)}</td><td class="${signClass(item.netProfit)}">${money(item.netProfit)}</td><td>${number(item.tradeCount, 0)}</td></tr>`).join('');
  const warnings = [...(result.data.warnings || []), ...(strategy.dataQuality?.warnings || []), ...(benchmark.dataQuality?.warnings || [])];
  $('result-warnings').innerHTML = warningsHtml(warnings);
  $('data-hash').textContent = t('Datos {start} → {end} · SHA-256 {hash} · Creado {created}', { start: result.data.firstDate, end: result.data.lastDate, hash: result.data.hash, created: result.createdAt });
  renderTrades();
}
function renderTrades() {
  if (!state.result) return;
  const trades = state.result[$('trades-strategy').value].trades;
  const pages = Math.max(1, Math.ceil(trades.length / PAGE_SIZE));
  state.tradePage = Math.min(Math.max(0, state.tradePage), pages - 1);
  const subset = trades.slice(state.tradePage * PAGE_SIZE, (state.tradePage + 1) * PAGE_SIZE);
  $('trade-results').innerHTML = subset.length ? subset.map(item => `<tr><td>${escape(item.ticker)}</td><td>${escape(item.entryDate)}</td><td>${escape(item.exitDate)}</td><td>${escape(t(item.exitIsExecutable === false ? 'Valoración sin ejecución' : item.exitReason === 'signal' ? 'Señal' : 'Fin del período'))}</td><td class="${signClass(item.netReturn)}">${percent(item.netReturn)}</td><td class="${signClass(item.netProfit)}">${money(item.netProfit)}</td><td>${money(item.totalCost)}</td><td>${number(item.holdingSessions, 0)}</td></tr>`).join('') : `<tr><td colspan="8" class="empty-small">${escape(t('No se produjeron operaciones en este período.'))}</td></tr>`;
  $('trades-page').textContent = t('{count} ciclos · {page} / {pages}', { count: number(trades.length, 0), page: number(state.tradePage + 1, 0), pages: number(pages, 0) });
  $('trades-prev').disabled = state.tradePage === 0;
  $('trades-next').disabled = state.tradePage >= pages - 1;
}
function download(content, type, suffix) {
  if (!state.result) return;
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `backtest-${state.result.config.strategy.preset}-${state.result.strategy.period.endDate}.${suffix}`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('search').addEventListener('input', renderUniverse);
$('type-filter').addEventListener('change', renderUniverse);
$('universe-list').addEventListener('change', event => {
  const ticker = event.target.dataset.ticker;
  if (!ticker) return;
  if (event.target.checked) state.weights[ticker] = selectedTickers().length ? 0 : 1;
  else delete state.weights[ticker];
  selectionChanged();
});
$('selection-body').addEventListener('input', event => {
  if (!event.target.dataset.weight) return;
  state.weights[event.target.dataset.weight] = Number(event.target.value) / 100;
  changed(); renderTotal();
});
$('selection-body').addEventListener('click', event => {
  const ticker = event.target.closest('[data-remove]')?.dataset.remove;
  if (ticker) { delete state.weights[ticker]; selectionChanged(); }
});
for (const [id, type] of [['group-stocks', 'STOCK'], ['group-etfs', 'ETF'], ['group-all', 'all']]) $(id).addEventListener('click', () => {
  if (!state.universe) return;
  state.weights = equalWeights(state.universe.instruments.filter(item => type === 'all' || item.type === type).map(item => item.ticker));
  selectionChanged();
});
$('clear-selection').addEventListener('click', () => { state.weights = {}; selectionChanged(); });
$('equal-weights').addEventListener('click', () => { try { state.weights = equalWeights(selectedTickers()); changed(); renderSelection(); message('Pesos distribuidos por igual.', 'success'); } catch (error) { fail(error); } });
$('normalize-weights').addEventListener('click', () => { try { state.weights = normalizeWeights(state.weights); changed(); renderSelection(); message('Pesos normalizados a 100%.', 'success'); } catch (error) { fail(error); } });
$('save-portfolio').addEventListener('click', () => {
  try {
    if (!state.storageReady) throw new Error('No se puede escribir en el archivo local de carteras.');
    const item = { id: uuid(), name: $('portfolio-name').value, parentId: $('portfolio-parent').value || null,
      weights: validateWeights(state.weights), createdAt: new Date().toISOString() };
    state.portfolios = savePortfolio(localStorage, state.portfolios, item);
    renderPortfolios(); $('saved-portfolio').value = item.id;
    message('“{name}” guardada en este navegador.', 'success', { name: item.name.trim() });
  } catch (error) { fail(error); }
});
$('load-portfolio').addEventListener('click', () => {
  try {
    const portfolio = state.portfolios.find(item => item.id === $('saved-portfolio').value);
    if (!portfolio) throw new Error('Elige una cartera guardada.');
    if (Object.keys(portfolio.weights).some(ticker => !state.universe?.byTicker.has(ticker))) throw new Error('Esta cartera contiene activos fuera del universo actual.');
    state.weights = { ...portfolio.weights }; $('portfolio-name').value = portfolio.name; $('portfolio-parent').value = portfolio.parentId || '';
    selectionChanged(); message('Selección cargada: {name}.', 'success', { name: portfolio.name });
  } catch (error) { fail(error); }
});
$('delete-portfolio').addEventListener('click', () => {
  try {
    const id = $('saved-portfolio').value;
    if (!id) throw new Error('Elige la cartera que deseas eliminar.');
    state.portfolios = deletePortfolio(localStorage, state.portfolios, id); renderPortfolios(); message('Cartera local eliminada. La selección actual se conserva.', 'success');
  } catch (error) { fail(error); }
});
$('strategy-preset').addEventListener('change', () => { applyPreset(); changed(); refreshCoverage(false); });
for (const id of [...Object.values(strategyFields), 'strong-only', 'exit-mode', 'start-date', 'end-date', 'capital', 'commission', 'slippage']) {
  $(id).addEventListener('change', () => { changed(); if (['exit-period', 'exit-confirmations', 'exit-mode'].includes(id)) { updateStrategyDisabled(); refreshCoverage(false); } });
}
$('load-history').addEventListener('click', loadHistory);
$('run').addEventListener('click', run);
$('cancel').addEventListener('click', () => {
  state.request++; state.download?.abort(); state.download = null; state.worker?.terminate(); state.worker = null; setBusy(false);
  status('run-status', 'Operación cancelada. Los resultados anteriores se conservan.');
});
$('trades-strategy').addEventListener('change', () => { state.tradePage = 0; renderTrades(); });
$('trades-prev').addEventListener('click', () => { state.tradePage--; renderTrades(); });
$('trades-next').addEventListener('click', () => { state.tradePage++; renderTrades(); });
$('export-json').addEventListener('click', () => download(JSON.stringify(state.result, null, 2), 'application/json', 'json'));
$('export-trades').addEventListener('click', () => {
  const rows = ['strategy', 'benchmark'].flatMap(comparator => state.result[comparator].trades.map(row => ({ comparator, ...row })));
  const columns = ['comparator', 'ticker', 'entryDate', 'entrySignalDate', 'exitDate', 'exitSignalDate', 'exitReason', 'entryPrice', 'exitPrice', 'units', 'capitalInvested', 'netProceeds', 'netProfit', 'netReturn', 'commissionCost', 'slippageCost', 'totalCost', 'holdingSessions', 'exitIsExecutable'];
  download(toCsv(rows, columns), 'text/csv;charset=utf-8', 'operations.csv');
});
$('export-equity').addEventListener('click', () => {
  const rows = ['strategy', 'benchmark'].flatMap(comparator => state.result[comparator].equityCurve.map(row => ({ comparator, ...row })));
  download(toCsv(rows, ['comparator', 'date', 'equity', 'cash', 'investedValue', 'dailyReturn', 'drawdown']), 'text/csv;charset=utf-8', 'equity.csv');
});

async function initialize() {
  $('strategy-preset').value = DEFAULT_CONFIG.strategy.preset;
  $('capital').value = DEFAULT_CONFIG.initialCapital;
  $('commission').value = DEFAULT_CONFIG.commissionBps / 100;
  $('slippage').value = DEFAULT_CONFIG.slippageBps / 100;
  applyPreset(); setBusy(false);
  try { state.portfolios = readPortfolios(localStorage); renderPortfolios(); }
  catch (error) { state.storageReady = false; fail(error); $('save-portfolio').disabled = true; $('delete-portfolio').disabled = true; }
  try {
    state.universe = await globalThis.loadMarketUniverse();
    const requested = new URLSearchParams(location.search).get('ticker')?.trim().toUpperCase();
    if (requested && !state.universe.byTicker.has(requested)) message('El ticker solicitado no pertenece al universo disponible. Selecciona un activo.', 'error');
    else state.weights = { [requested || 'SPY']: 1 };
    renderUniverse(); renderSelection();
  } catch (error) { state.universeFailed = true; renderUniverse(); fail(error); }
}
function renderLanguage() {
  // Presentation only: retain entered weights exactly and do not reload data or recompute results.
  const weightInputs = new Map([...document.querySelectorAll('[data-weight]')].map(input => [input.dataset.weight, input.value]));
  applyTranslations();
  $('language').value = getLanguage();
  renderThemes(); renderPresetDescription(); renderUniverse(); renderSelection(); renderPortfolios(); renderCoverage();
  for (const input of document.querySelectorAll('[data-weight]')) {
    if (weightInputs.has(input.dataset.weight)) input.value = weightInputs.get(input.dataset.weight);
  }
  if (state.result) renderResult();
  renderMessage();
  for (const [id, descriptor] of state.statuses) $(id).textContent = translated(descriptor);
  setBusy(state.busy);
}
$('language').addEventListener('change', event => setLanguage(event.target.value));
$('themeSwitcher').addEventListener('click', event => {
  const id = event.target.closest('[data-theme]')?.dataset.theme;
  if (id) globalThis.MarketBacktestTheme.setTheme(id);
});
globalThis.MarketBacktestTheme.onChange(updateThemeButtons);
onLanguageChange(renderLanguage);
$('language').value = getLanguage();
applyTranslations();
renderThemes();
initialize();
