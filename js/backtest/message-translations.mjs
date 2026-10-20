// Presentation-only translations. Engine errors and exported research records
// retain their original text; this module never changes inputs or calculations.
const pairs = [
  ['Selecciona al menos un activo.', 'Select at least one asset.'],
  ['Selecciona entre 1 y 250 activos.', 'Select between 1 and 250 assets.'],
  ['Selecciona activos y asigna sus pesos.', 'Select assets and assign their weights.'],
  ['Cada activo debe tener un peso mayor que 0% y no superior a 100%.', 'Every asset must have a weight greater than 0% and no greater than 100%.'],
  ['Cada activo necesita un ticker válido y un peso mayor que 0% y como máximo 100%.', 'Every asset needs a valid ticker and a weight greater than 0% and no greater than 100%.'],
  ['Los pesos deben sumar 100%. Utiliza Normalizar o Igualar.', 'Weights must add up to 100%. Use Normalize or Equal weight.'],
  ['Los pesos deben sumar 100%. Usa Normalizar pesos o corrígelos.', 'Weights must add up to 100%. Use Normalize weights or correct them.'],
  ['Introduce pesos positivos antes de normalizar, o utiliza Igualar.', 'Enter positive weights before normalizing, or use Equal weight.'],
  ['La cartera guardada no es válida.', 'The saved portfolio is invalid.'],
  ['El archivo local de carteras no es válido.', 'The local portfolio file is invalid.'],
  ['Hay carteras duplicadas en el archivo local.', 'The local file contains duplicate portfolios.'],
  ['La subcartera debe tener una cartera principal válida.', 'The subportfolio must have a valid parent portfolio.'],
  ['Una subcartera solo puede contener activos de su cartera principal.', 'A subportfolio can only contain assets from its parent portfolio.'],
  ['No se pueden leer las carteras locales. Sus datos se conservaron.', 'Local portfolios could not be read. Their data has been preserved.'],
  ['Versión de carteras locales no compatible. Sus datos se conservaron.', 'Unsupported local portfolio version. Their data has been preserved.'],
  ['Elimina primero las subcarteras de esta cartera.', 'Delete this portfolio’s subportfolios first.'],
  ['Configuración de backtest inválida.', 'Invalid backtest configuration.'],
  ['Selecciona fechas válidas: inicio anterior o igual al final.', 'Select valid dates: the start must be on or before the end.'],
  ['El capital debe ser mayor que 0 y no superar un billón.', 'Capital must be greater than 0 and no greater than one trillion.'],
  ['Comisión y deslizamiento deben estar entre 0% y 10% por lado.', 'Commission and slippage must be between 0% and 10% per side.'],
  ['El historial debe contener como máximo 250.000 barras.', 'History must contain no more than 250,000 bars.'],
  ['Formato de historial inválido: se requieren cierres confirmados.', 'Invalid history format: confirmed closing bars are required.'],
  ['Se necesita HTTPS o localhost para registrar la huella del experimento.', 'HTTPS or localhost is required to record the experiment fingerprint.'],
  ['El backtest requiere un historial de cierres confirmados; las velas provisionales no son válidas.', 'The backtest requires confirmed closing history; provisional bars are not valid.'],
  ['Callback de progreso inválido.', 'Invalid progress callback.'],
  ['No hay barras confirmadas en las fechas solicitadas.', 'There are no confirmed bars for the requested dates.'],
  ['El período debe incluir al menos dos sesiones bursátiles.', 'The period must include at least two trading sessions.'],
  ['La valoración requiere sesiones ausentes. El resultado no se publica.', 'Valuation requires missing sessions. The result is not published.'],
  ['No se pudo ejecutar el backtest.', 'The backtest could not be run.'],
  ['Exploración histórica: cambiar parámetros tras observar resultados no constituye validación fuera de muestra.', 'Historical exploration: changing parameters after observing results is not out-of-sample validation.'],
  ['Rentabilidad de precios, sin dividendos, impuestos ni interés del efectivo. Universo actual: posible sesgo de supervivencia.', 'Price returns exclude dividends, taxes and interest on cash. The current universe may have survivorship bias.'],
  ['Pesos iniciales con efectivo reservado por activo; sin rebalanceo ni redistribución. Liquidación contable al cierre final con costes.', 'Initial weights reserve cash per asset, with no rebalancing or redistribution. Accounting liquidation at the final close includes costs.'],
  ['Muestra menor de un año bursátil: la rentabilidad anualizada y el Sharpe pueden ser poco representativos.', 'The sample is shorter than one trading year: annualized returns and Sharpe may not be representative.'],
  ['El proveedor filtró filas inválidas o duplicadas; se comprobó la continuidad de los activos seleccionados.', 'The provider filtered invalid or duplicate rows; continuity was checked for the selected assets.'],
  ['La configuración de la estrategia debe ser un objeto.', 'Strategy config must be an object.'],
  ['Parámetro de estrategia desconocido.', 'Unknown strategy parameter.'],
  ['Estrategia predefinida desconocida.', 'Unknown strategy preset.'],
  ['La distancia mínima de entrada no puede superar la extensión máxima de entrada.', 'Minimum entry distance must not exceed maximum entry extension.'],
  ['El volumen relativo debe estar entre 0 y 10.', 'relativeVolume must be between 0 and 10.'],
  ['El criterio de solo compras fuertes debe ser verdadero o falso.', 'strongOnly must be boolean.'],
  ['Modo de venta desconocido.', 'Unknown exitMode.'],
  ['El período de la media de salida debe ser un entero entre 20 y 250.', 'exitPeriod must be an integer between 20 and 250.'],
  ['Los cierres de confirmación deben ser un entero entre 1 y 10.', 'exitConfirmations must be an integer between 1 and 10.'],
  ['Las barras deben ser una lista.', 'bars must be an array.'],
  ['El calendario debe contener fechas bursátiles previstas únicas y ordenadas.', 'calendarDates must contain unique ascending expected exchange dates.'],
  ['Las barras deben tener fechas ISO únicas y ordenadas.', 'Bars must have unique ascending ISO dates.'],
  ['La fecha de una barra está fuera del calendario bursátil proporcionado.', 'Bar date is outside the supplied exchange calendar.'],
  ['Una fecha de barra está fuera del calendario bursátil proporcionado.', 'A bar date is outside the supplied exchange calendar.'],
  ['Estrategia desconocida.', 'Unknown strategy.'],
  ['La posición inicial debe ser efectivo o una posición larga.', 'initialPosition must be cash or long.'],
  ['El capital inicial debe ser positivo.', 'initialCapital must be positive.'],
  ['Las barras de preparación deben ser un entero positivo.', 'warmupBars must be a positive integer.'],
  ['El panel debe contener al menos una serie.', 'panel.series must be nonempty.'],
  ['Los tickers deben ser únicos y no estar vacíos.', 'Tickers must be nonempty and unique.'],
  ['Al menos un ticker debe tener barras históricas.', 'At least one ticker must have historical bars.'],
  ['Los pesos deben contener una fracción positiva y finita para cada ticker seleccionado, y ningún otro ticker.', 'weights must contain one positive finite fraction for every selected ticker, and no other ticker.'],
  ['Los pesos deben sumar 1.', 'weights must sum to 1.'],
  ['El calendario debe contener fechas de sesión ISO únicas y ordenadas.', 'calendarDates must contain unique ascending ISO session dates.'],
  ['El intervalo de fechas de evaluación no es válido.', 'Invalid evaluation date range.'],
  ['El período de evaluación no contiene sesiones bursátiles.', 'Evaluation period contains no calendar sessions.'],
  ['El calendario inferido de las fechas observadas no puede detectar una sesión ausente en todos los tickers.', 'Calendar inferred from observed dates cannot detect a session missing from every ticker.'],
  ['Algunas valoraciones finales usan precios antiguos y no son ejecuciones observables.', 'Some terminal valuations use stale prices and are not observable executions.'],
  ['Ticker no válido.', 'Invalid ticker.'],
  ['Ejecuta la migración de Supabase (supabase/001_market_history.sql) antes de cargar datos confirmados.', 'Run the Supabase migration (supabase/001_market_history.sql) before loading finalized data.'],
  ['La solicitud de datos agotó el tiempo de espera. Vuelve a intentarlo.', 'Data request timed out. Please retry.'],
  ['Ticker duplicado en el universo de mercado.', 'Duplicate ticker in market universe.'],
  ['Instrumento no válido o duplicado en el universo.', 'Invalid or duplicate instrument in universe.'],
  ['Configura Supabase en js/config.js.', 'Configure Supabase in js/config.js.'],
  ['La URL de Supabase debe usar HTTPS.', 'The Supabase URL must use HTTPS.'],
  ['El navegador requiere una clave publicable de Supabase (o una clave anon heredada).', 'The browser requires a Supabase publishable key (or legacy anon key).'],
  ['Respuesta de Supabase no válida.', 'Invalid response from Supabase.'],
  ['La paginación de Supabase no avanzó. Revisa el orden de ticker y fecha.', 'Supabase pagination did not advance. Check the ticker/date ordering.'],
  ['El historial supera el límite seguro de paginación. Revisa la retención de datos.', 'History exceeds the pagination safety limit. Check data retention.'],
  ['Respuesta de cotizaciones recientes de Supabase no válida.', 'Invalid recent quote response from Supabase.'],
  ['El ticker está fuera del universo de mercado seleccionado.', 'Ticker is outside the selected market universe.'],
  ['No se pudo conectar para descargar los datos.', 'Failed to fetch'],
  ['Error de red al intentar descargar los datos.', 'NetworkError when attempting to fetch resource.'],
  ['No se pudieron cargar los datos.', 'Load failed']
];
for (const [key, label] of Object.entries({entryScore:'La puntuación de entrada',trendScore:'La puntuación de tendencia',momentum:'El momentum',exitScore:'La puntuación de salida'})) {
  pairs.push([`${label} debe estar entre 0 y 100.`, `${key} must be between 0 and 100.`]);
}
for (const [key, label] of Object.entries({maxEntryExtensionAtr:'La extensión máxima de entrada',minEntryDistanceAtr:'La distancia mínima de entrada'})) {
  pairs.push([`${label} debe estar entre -20 y 20 ATR.`, `${key} must be between -20 and 20 ATR.`]);
}
for (const [key, label] of Object.entries({commissionBps:'La comisión',slippageBps:'El deslizamiento'})) {
  pairs.push([`${label} debe ser mayor o igual que 0 y menor que 10.000 puntos básicos.`, `${key} must be between 0 and 10000 bps (exclusive).`]);
}
export const MESSAGE_TRANSLATIONS = Object.freeze(pairs.map(([es,en])=>Object.freeze({es,en})));
const exact = new Map(MESSAGE_TRANSLATIONS.flatMap(pair=>[[pair.es,pair],[pair.en,pair]]));

// Captured tickers, dates, counts and HTTP statuses pass through unchanged.
const patterns = [
  [/^Fechas fuera del calendario revisado \((\d{4})–(\d{4})\)\.$/, /^Dates outside the reviewed calendar \((\d{4})–(\d{4})\)\.$/,
    (a,b)=>`Fechas fuera del calendario revisado (${a}–${b}).`, (a,b)=>`Dates outside the reviewed calendar (${a}–${b}).`],
  [/^Barra inválida o no confirmada: (.+) (.+)\.$/, /^Invalid or unconfirmed bar: (.+) (.+)\.$/,
    (ticker,date)=>`Barra inválida o no confirmada: ${ticker} ${date}.`, (ticker,date)=>`Invalid or unconfirmed bar: ${ticker} ${date}.`],
  [/^Barra duplicada: (.+) (.+)\. Actualiza el historial\.$/, /^Duplicate bar: (.+) (.+)\. Refresh history\.$/,
    (ticker,date)=>`Barra duplicada: ${ticker} ${date}. Actualiza el historial.`, (ticker,date)=>`Duplicate bar: ${ticker} ${date}. Refresh history.`],
  [/^(.+): no hay cierres disponibles; la ejecución se bloqueará\.$/, /^(.+): no closing bars are available; execution will be blocked\.$/,
    ticker=>`${ticker}: no hay cierres disponibles; la ejecución se bloqueará.`, ticker=>`${ticker}: no closing bars are available; execution will be blocked.`],
  [/^(.+): (\d+) barras; necesita (\d+) para ejecutar\. Su asignación permanece en efectivo\.$/, /^(.+): (\d+) bars; (\d+) are required to run\. Its allocation remains in cash\.$/,
    (ticker,n,needed)=>`${ticker}: ${n} barras; necesita ${needed} para ejecutar. Su asignación permanece en efectivo.`, (ticker,n,needed)=>`${ticker}: ${n} bars; ${needed} are required to run. Its allocation remains in cash.`],
  [/^(.+): no hay historial confirmado en el período\. No se sustituye una descarga ausente por efectivo\.$/, /^(.+): no confirmed history is available in this period\. A missing download is not replaced with cash\.$/,
    ticker=>`${ticker}: no hay historial confirmado en el período. No se sustituye una descarga ausente por efectivo.`, ticker=>`${ticker}: no confirmed history is available in this period. A missing download is not replaced with cash.`],
  [/^(.+): último cierre (\S+), anterior al final (\S+)\. Actualiza datos o reduce la fecha final\.$/, /^(.+): last close (\S+), before the end date (\S+)\. Refresh data or choose an earlier end date\.$/,
    (ticker,a,b)=>`${ticker}: último cierre ${a}, anterior al final ${b}. Actualiza datos o reduce la fecha final.`, (ticker,a,b)=>`${ticker}: last close ${a}, before the end date ${b}. Refresh data or choose an earlier end date.`],
  [/^(.+): faltan sesiones entre (\S+) y (\S+)\. Actualiza o repara el historial antes de ejecutar\.$/, /^(.+): missing sessions between (\S+) and (\S+)\. Refresh or repair history before running\.$/,
    (ticker,a,b)=>`${ticker}: faltan sesiones entre ${a} y ${b}. Actualiza o repara el historial antes de ejecutar.`, (ticker,a,b)=>`${ticker}: missing sessions between ${a} and ${b}. Refresh or repair history before running.`],
  [/^No hay aperturas elegibles: se necesitan (\d+) cierres anteriores más una sesión de ejecución\.$/, /^No eligible opens: (\d+) previous closing bars plus an execution session are required\.$/,
    n=>`No hay aperturas elegibles: se necesitan ${n} cierres anteriores más una sesión de ejecución.`, n=>`No eligible opens: ${n} previous closing bars plus an execution session are required.`],
  [/^El historial disponible comienza el (\S+); selecciona un inicio dentro de su cobertura\.$/, /^Available history begins on (\S+); select a start within its coverage\.$/,
    date=>`El historial disponible comienza el ${date}; selecciona un inicio dentro de su cobertura.`, date=>`Available history begins on ${date}; select a start within its coverage.`],
  [/^(.+): no alcanza (\d+) cierres previos; su asignación queda en efectivo en ambas estrategias\.$/, /^(.+): fewer than (\d+) previous closing bars; its allocation stays in cash in both strategies\.$/,
    (ticker,n)=>`${ticker}: no alcanza ${n} cierres previos; su asignación queda en efectivo en ambas estrategias.`, (ticker,n)=>`${ticker}: fewer than ${n} previous closing bars; its allocation stays in cash in both strategies.`],
  [/^(.+): primera apertura elegible (\S+); mantiene efectivo hasta disponer de historial\.$/, /^(.+): first eligible open (\S+); cash is held until sufficient history is available\.$/,
    (ticker,date)=>`${ticker}: primera apertura elegible ${date}; mantiene efectivo hasta disponer de historial.`, (ticker,date)=>`${ticker}: first eligible open ${date}; cash is held until sufficient history is available.`],
  [/^Precios OHLC no válidos el (\S+)\.$/, /^Invalid OHLC prices on (\S+)\.$/,
    date=>`Precios OHLC no válidos el ${date}.`, date=>`Invalid OHLC prices on ${date}.`],
  [/^Las barras de (.+) deben ser una lista\.$/, /^Bars must be an array for (.+)\.$/,
    ticker=>`Las barras de ${ticker} deben ser una lista.`, ticker=>`Bars must be an array for ${ticker}.`],
  [/^Las señales deben coincidir con las barras de (.+)\.$/, /^Signals must align with bars for (.+)\.$/,
    ticker=>`Las señales deben coincidir con las barras de ${ticker}.`, ticker=>`Signals must align with bars for ${ticker}.`],
  [/^Las barras de (.+) deben tener fechas ISO únicas y ordenadas\.$/, /^Bars must have unique ascending ISO dates for (.+)\.$/,
    ticker=>`Las barras de ${ticker} deben tener fechas ISO únicas y ordenadas.`, ticker=>`Bars must have unique ascending ISO dates for ${ticker}.`],
  [/^Precios de ejecución no válidos para (.+) el (\S+)\.$/, /^Invalid execution prices for (.+) on (\S+)\.$/,
    (ticker,date)=>`Precios de ejecución no válidos para ${ticker} el ${date}.`, (ticker,date)=>`Invalid execution prices for ${ticker} on ${date}.`],
  [/^La fecha de la señal no coincide para (.+)\.$/, /^Signal date is misaligned for (.+)\.$/,
    ticker=>`La fecha de la señal no coincide para ${ticker}.`, ticker=>`Signal date is misaligned for ${ticker}.`],
  [/^Señal (.+) no válida para (.+) el (\S+)\.$/, /^Invalid (.+) signal for (.+) on (\S+)\.$/,
    (signal,ticker,date)=>`Señal ${signal} no válida para ${ticker} el ${date}.`, (signal,ticker,date)=>`Invalid ${signal} signal for ${ticker} on ${date}.`],
  [/^(\d+) ticker\(s\) tienen un historial explícitamente vacío; sus asignaciones iniciales (personalizadas|iguales) permanecen siempre en efectivo\.$/, /^(\d+) ticker\(s\) have explicitly empty history; their (custom|equal) initial allocations remain in cash throughout\.$/,
    (n,kind)=>`${n} ticker(s) tienen un historial explícitamente vacío; sus asignaciones iniciales ${kind==='custom'||kind==='personalizadas'?'personalizadas':'iguales'} permanecen siempre en efectivo.`,
    (n,kind)=>`${n} ticker(s) have explicitly empty history; their ${kind==='custom'||kind==='personalizadas'?'custom':'equal'} initial allocations remain in cash throughout.`],
  [/^La solicitud de datos falló \(HTTP (\d+)\)\.$/, /^Data request failed \(HTTP (\d+)\)\.$/,
    status=>`La solicitud de datos falló (HTTP ${status}).`, status=>`Data request failed (HTTP ${status}).`],
  [/^El universo de empresas debe contener (\d+) empresas\.$/, /^The company universe must contain (\d+) companies\.$/,
    n=>`El universo de empresas debe contener ${n} empresas.`, n=>`The company universe must contain ${n} companies.`],
  [/^El universo de ETF debe contener (\d+) ETF\.$/, /^The ETF universe must contain (\d+) ETFs\.$/,
    n=>`El universo de ETF debe contener ${n} ETF.`, n=>`The ETF universe must contain ${n} ETFs.`],
  [/^El universo de mercado debe contener (\d+) instrumentos\.$/, /^The market universe must contain (\d+) instruments\.$/,
    n=>`El universo de mercado debe contener ${n} instrumentos.`, n=>`The market universe must contain ${n} instruments.`],
  [/^Metadatos de ETF no válidos para (.+)\.$/, /^Invalid ETF metadata for (.+)\.$/,
    ticker=>`Metadatos de ETF no válidos para ${ticker}.`, ticker=>`Invalid ETF metadata for ${ticker}.`]
];

export function localizeMessage(text, language = 'es') {
  const source = String(text ?? '');
  const target = language === 'en' ? 'en' : 'es';
  const known = exact.get(source);
  if (known) return known[target];
  for (const [esPattern,enPattern,esText,enText] of patterns) {
    const match = esPattern.exec(source) ?? enPattern.exec(source);
    if (match) return (target === 'en' ? enText : esText)(...match.slice(1));
  }
  // Keep unrecognized provider or browser diagnostics visible for debugging.
  return source;
}
