/** Transport only. Supabase validates identity, sessions, OHLCV and finality. */
function msYahooRequest_(company) {
  return {url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(company.yahooTicker || company.ticker) +
    '?interval=1d&range=5d&includePrePost=false&events=splits',
    method: 'get', muteHttpExceptions: true, headers: {'User-Agent': 'Mozilla/5.0'}};
}

function msParseYahoo_(response, company, requestedAt, fetchedAt) {
  if (response.getResponseCode() !== 200) throw new Error('Yahoo HTTP ' + response.getResponseCode());
  let body;
  try { body = JSON.parse(response.getContentText()); } catch (error) { throw new Error('Yahoo: respuesta JSON no válida.'); }
  const result = body && body.chart && body.chart.result && body.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) throw new Error('Yahoo: respuesta sin serie diaria.');
  const meta = result.meta || {}, quote = result.indicators && result.indicators.quote && result.indicators.quote[0] || {};
  const value = (column, n) => Array.isArray(quote[column]) && quote[column][n] !== undefined ? quote[column][n] : null;
  const splits = result.events && result.events.splits || {};
  return {
    ticker: company.ticker, source: 'yahoo', symbol: meta.symbol ?? null, currency: meta.currency ?? null,
    exchange_timezone: meta.exchangeTimezoneName ?? null, exchange_name: meta.exchangeName ?? null,
    first_trade_epoch: meta.firstTradeDate ?? null, regular_market_time: meta.regularMarketTime ?? null,
    requested_at: requestedAt, fetched_at: fetchedAt,
    rows: result.timestamp.map(function(timestamp, n) {
      return {timestamp: timestamp, open: value('open', n), high: value('high', n), low: value('low', n),
        close: value('close', n), volume: value('volume', n)};
    }),
    splits: Object.keys(splits).map(function(key) {
      const split = splits[key] || {};
      return {timestamp: split.date ?? Number(key), numerator: split.numerator ?? null, denominator: split.denominator ?? null};
    })
  };
}

function msFetchYahooBatch_(companies) {
  const requestedAt = new Date().toISOString();
  let responses;
  try { responses = UrlFetchApp.fetchAll(companies.map(msYahooRequest_)); }
  catch (error) { return companies.map(() => ({error: 'Yahoo: fallo de transporte.'})); }
  const fetchedAt = new Date().toISOString();
  return companies.map(function(company, n) {
    try { return {payload: msParseYahoo_(responses[n], company, requestedAt, fetchedAt)}; }
    catch (error) { return {error: error.message}; }
  });
}
