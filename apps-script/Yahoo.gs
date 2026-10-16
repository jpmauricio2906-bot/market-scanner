/** Yahoo daily bars. Dates always belong to the exchange, never the fetch clock. */
const MS_HOLIDAY_CACHE = {};
function msDate_(date) {
  return Utilities.formatDate(date, 'America/New_York', 'yyyy-MM-dd');
}

function msAddDays_(date, count) {
  return new Date(Date.parse(date + 'T12:00:00Z') + count * 86400000).toISOString().slice(0, 10);
}

function msEaster_(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451), n = h + l - 7 * m + 114;
  return year + '-' + String(Math.floor(n / 31)).padStart(2, '0') + '-' + String(n % 31 + 1).padStart(2, '0');
}

function msHolidays_(year) {
  function day(month, date) { return year + '-' + String(month).padStart(2, '0') + '-' + String(date).padStart(2, '0'); }
  function dow(date) { return new Date(date + 'T12:00:00Z').getUTCDay(); }
  function nth(month, weekday, n) { return day(month, 1 + (weekday - dow(day(month, 1)) + 7) % 7 + (n - 1) * 7); }
  function observed(date) { return msAddDays_(date, dow(date) === 6 ? -1 : dow(date) === 0 ? 1 : 0); }
  const jan1 = day(1, 1);
  // NYSE does not observe a Saturday New Year's Day on December 31.
  const dates = [dow(jan1) === 6 ? jan1 : observed(jan1), nth(1, 1, 3), nth(2, 1, 3),
    msAddDays_(msEaster_(year), -2), msAddDays_(day(6, 1), -((dow(day(6, 1)) + 6) % 7 || 7)),
    observed(day(6, 19)), observed(day(7, 4)), nth(9, 1, 1), nth(11, 4, 4), observed(day(12, 25))];
  if (year === 2025) dates.push('2025-01-09'); // President Carter national day of mourning.
  return dates;
}

function msIsSession_(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + 'T12:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  const year = parsed.getUTCFullYear();
  // Fail closed beyond the documented calendar horizon; review special closures annually.
  if (year < 2024 || year > 2030) return false;
  if (!MS_HOLIDAY_CACHE[year]) MS_HOLIDAY_CACHE[year] = new Set(msHolidays_(year));
  return parsed.getUTCDay() !== 0 && parsed.getUTCDay() !== 6 && !MS_HOLIDAY_CACHE[year].has(date);
}

function msExpectedSession_(now) {
  let date = msDate_(now);
  if (Number(Utilities.formatDate(now, 'America/New_York', 'HH')) < 17) date = msAddDays_(date, -1);
  for (let i = 0; i < 15; i++, date = msAddDays_(date, -1)) if (msIsSession_(date)) return date;
  throw new Error('Calendario fuera de rango o cierre extraordinario: revisar Yahoo.gs.');
}

function msValidBar_(row) {
  if (!row || !msIsSession_(row.fecha) || !/^[A-Z][A-Z0-9-]{0,9}$/.test(row.ticker || '')) return false;
  if (!['open', 'high', 'low', 'close'].every(k => typeof row[k] === 'number' && Number.isFinite(row[k]) && row[k] > 0)) return false;
  return row.low <= Math.min(row.open, row.close) && row.high >= Math.max(row.open, row.close) && row.low <= row.high &&
    Number.isSafeInteger(row.volumen) && row.volumen >= 0;
}

function msContinuous_(rows, expected) {
  if (!rows.length || rows[rows.length - 1].fecha !== expected) return false;
  const dates = {};
  rows.forEach(r => { dates[r.fecha] = true; });
  for (let date = rows[0].fecha; date <= expected; date = msAddDays_(date, 1)) {
    if (msIsSession_(date) && !dates[date]) return false;
  }
  return true;
}

function msNeedsFull_(old, result, merged, expected) {
  if (!msContinuous_(merged, expected)) return true;
  if (merged.length < 500 && merged[0].fecha !== result.firstTradeDate) return true;
  const previous = {};
  old.forEach(r => { previous[r.fecha] = r; });
  const last = old.map(r => r.fecha).sort().slice(-1)[0] || '';
  if ((result.splitDates || []).some(date => date > last)) return true;
  return result.rows.some(row => previous[row.fecha] && ['open','high','low','close'].some(k =>
    Math.abs(row[k] - previous[row.fecha][k]) > Math.max(0.000001, Math.abs(row[k]) * 1e-8)));
}

function msYahooRequest_(company, history) {
  return {url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(company.yahooTicker || company.ticker) +
    '?interval=1d&range=' + (history ? '3y' : '1mo') + '&includePrePost=false&events=splits',
    method: 'get', muteHttpExceptions: true, headers: {'User-Agent': 'Mozilla/5.0'}};
}

function msParseYahoo_(response, company, history, now) {
  if (response.getResponseCode() !== 200) throw new Error('Yahoo HTTP ' + response.getResponseCode());
  const body = JSON.parse(response.getContentText());
  const result = body.chart && body.chart.result && body.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) throw new Error('Yahoo sin serie diaria');
  const meta = result.meta || {}, quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!quote || meta.currency !== 'USD' || meta.exchangeTimezoneName !== 'America/New_York') throw new Error('Moneda/zona/serie inesperada');
  if (String(meta.symbol || '').toUpperCase().replace('.', '-') !== (company.yahooTicker || company.ticker)) throw new Error('Símbolo Yahoo distinto al solicitado');
  const expected = msExpectedSession_(now), today = msDate_(now), finalRows = [], seen = {};
  let current = null, rejected = 0;
  result.timestamp.forEach(function(timestamp, n) {
    const date = msDate_(new Date(timestamp * 1000));
    const row = {fecha: date, ticker: company.ticker, open: quote.open && quote.open[n], high: quote.high && quote.high[n],
      low: quote.low && quote.low[n], close: quote.close && quote.close[n], volumen: quote.volume && quote.volume[n]};
    if (!msValidBar_(row) || date > today) { rejected++; return; }
    if (seen[date]) throw new Error('Yahoo devolvió fechas duplicadas');
    seen[date] = true;
    if (!current || row.fecha > current.fecha) current = row;
    if (date <= expected) finalRows.push(row);
  });
  finalRows.sort((a, b) => a.fecha.localeCompare(b.fecha));
  if (!current || !finalRows.length || finalRows[finalRows.length - 1].fecha !== expected) throw new Error('Serie ausente/atrasada; cierre esperado ' + expected);
  let shortHistory = false;
  if (history && finalRows.length < 500) {
    const firstTrade = Number.isFinite(meta.firstTradeDate) ? msDate_(new Date(meta.firstTradeDate * 1000)) : null;
    // New listings cannot have 500 sessions: accept their real series, expose the shortfall.
    if (!firstTrade || finalRows[0].fecha !== firstTrade) throw new Error('Historial incompleto sin inicio de cotización verificable: ' + finalRows.length + '/500');
    shortHistory = true;
  }
  const final = finalRows.slice(-500);
  if (!msContinuous_(final, expected)) throw new Error('Falta sesión; serie rechazada');
  const previous = finalRows.filter(r => r.fecha < current.fecha).slice(-1)[0];
  return {rows: final, current: current, previous: previous ? previous.close : '',
    status: (current.fecha > expected ? 'PROVISIONAL' : 'FINAL') + (shortHistory ? ' · HISTORIA CORTA ' + final.length + '/500' : ''),
    shortHistory: shortHistory, rejected: rejected,
    firstTradeDate: Number.isFinite(meta.firstTradeDate) ? msDate_(new Date(meta.firstTradeDate * 1000)) : null,
    splitDates: Object.keys(result.events && result.events.splits || {}).map(key => msDate_(new Date(Number(key) * 1000)))};
}

function msFetchYahooBatch_(companies, history, now) {
  // At most five concurrent requests. A failed transport never shifts ticker positions.
  let responses;
  try { responses = UrlFetchApp.fetchAll(companies.map(c => msYahooRequest_(c, history))); }
  catch (error) { return companies.map(() => ({error: 'Yahoo: fallo de transporte'})); }
  return companies.map(function(company, n) {
    try { return msParseYahoo_(responses[n], company, history, now); }
    catch (error) { return {error: error.message}; }
  });
}
