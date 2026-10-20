/** Fresh source capture and coverage audit only: never calculates strategy results. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchValidationHistory } from './fetch-validation-history.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function sessions(calendar, start, endExclusive) {
  if (Number(start.slice(0, 4)) < calendar.firstYear || Number(endExclusive.slice(0, 4)) > calendar.lastYear) {
    throw new Error('Requested dates exceed the reviewed backtest calendar');
  }
  const holidays = new Set(calendar.holidays), result = [];
  for (let date = new Date(start + 'T12:00:00Z'); date.toISOString().slice(0, 10) < endExclusive;
    date.setUTCDate(date.getUTCDate() + 1)) {
    const day = date.toISOString().slice(0, 10);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !holidays.has(day)) result.push(day);
  }
  return result;
}

/** A successful HTTP response does not establish usable, complete history. */
export function auditLongCoverage(availability, rows, calendar) {
  const requestedSessions = sessions(calendar, availability.startDate, availability.endExclusive);
  const sessionSet = new Set(requestedSessions), grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.ticker)) grouped.set(row.ticker, []);
    grouped.get(row.ticker).push(row);
  }
  const diagnostics = availability.diagnostics.map(source => {
    const bars = grouped.get(source.ticker) || [], dates = new Set(bars.map(row => row.fecha));
    const expected = requestedSessions.filter(day => !source.firstTradeDate || day >= source.firstTradeDate);
    const missingDates = expected.filter(day => !dates.has(day));
    const unexpectedDates = [...dates].filter(day => !sessionSet.has(day));
    const invalidRows = bars.filter(row => ![row.open, row.high, row.low, row.close].every(value => Number.isFinite(value) && value > 0)
      || !Number.isSafeInteger(row.volumen) || row.volumen < 0 || row.is_final !== true
      || row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close, row.high)).length;
    const rejectedBars = (source.quality?.invalidBars || 0) + (source.quality?.missingAdjustment || 0)
      + (source.quality?.duplicateDates || 0);
    const verifiedLaterListing = source.valid && source.status === 'no_pre_cutoff_history'
      && source.firstTradeDate >= availability.endExclusive;
    const complete = Boolean(source.valid && (bars.length > 0 || verifiedLaterListing)
      && !missingDates.length && !unexpectedDates.length && dates.size === bars.length && !invalidRows && !rejectedBars);
    return {
      ticker: source.ticker, complete, providerRequestValid: Boolean(source.valid),
      status: !source.valid ? 'source_error' : verifiedLaterListing ? 'not_yet_listed' : complete ? 'complete' : 'quality_blocked',
      bars: bars.length, expectedSessions: expected.length, firstDate: [...dates].sort()[0] || null,
      lastDate: [...dates].sort().at(-1) || null, providerFirstTradeDate: source.firstTradeDate || null,
      missingDates, unexpectedDates, duplicateRows: bars.length - dates.size, invalidRows, rejectedBars,
      sourceQuality: source.quality || null, sourceError: source.error || null,
      rawSha256: source.rawSha256 || null,
    };
  });
  const selected = new Set(diagnostics.map(item => item.ticker));
  const unknownTickers = [...grouped.keys()].filter(ticker => !selected.has(ticker));
  return {
    schemaVersion: 1, startDate: availability.startDate, endExclusive: availability.endExclusive,
    capturedAt: availability.capturedAt, completedAt: availability.completedAt,
    selectedTickers: diagnostics.length, bars: rows.length, requestedSessions: requestedSessions.length,
    completeTickers: diagnostics.filter(item => item.complete).length,
    blockedTickers: diagnostics.filter(item => !item.complete).length, unknownTickers,
    valid: diagnostics.every(item => item.complete) && !unknownTickers.length,
    methodology: 'Source availability, OHLCV validity, exchange sessions, listing dates, source checksums and continuity only. No parameter fitting or return calculations. Early closes remain sessions. Rejected bars are not invented or filled.',
    priceBasis: 'provider-quote: provider OHLC without adjclose scaling; dividend-adjusted companion file is retained separately, never mixed.',
    limitations: availability.limitations || [], diagnostics,
  };
}

export async function auditLongHistory(directory) {
  const output = path.resolve(directory);
  const availability = JSON.parse(await fs.readFile(path.join(output, 'availability.json'), 'utf8'));
  const calendarBytes = await fs.readFile(new URL('../data/backtest-calendar.json', import.meta.url));
  const priceBytes = await fs.readFile(path.join(output, availability.priceOnlyFile));
  const historyBytes = await fs.readFile(path.join(output, availability.historyFile));
  if (sha256(priceBytes) !== availability.priceOnlySha256 || sha256(historyBytes) !== availability.historySha256) {
    throw new Error('History checksum mismatch; preserve the original source capture');
  }
  for (const diagnostic of availability.diagnostics) {
    if (diagnostic.rawFile && sha256(await fs.readFile(path.join(output, diagnostic.rawFile))) !== diagnostic.rawSha256) {
      throw new Error(`Raw source checksum mismatch: ${diagnostic.ticker}`);
    }
  }
  const snapshot = JSON.parse(priceBytes);
  const result = auditLongCoverage(availability, snapshot.rows, JSON.parse(calendarBytes));
  result.calendarSha256 = sha256(calendarBytes);
  result.auditSourceSha256 = sha256(await fs.readFile(fileURLToPath(import.meta.url)));
  result.fetchSourceSha256 = availability.sourceSha256;
  result.priceOnlySha256 = availability.priceOnlySha256;
  result.historySha256 = availability.historySha256;
  await fs.writeFile(path.join(output, 'coverage-audit.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

async function main() {
  const options = {}, args = process.argv.slice(2);
  let auditOnly = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--audit-only') { auditOnly = true; continue; }
    const value = args[++i];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--output') options.outputDirectory = value;
    else if (flag === '--start') options.startDate = value;
    else if (flag === '--end-exclusive') options.endExclusive = value;
    else if (flag === '--tickers') options.tickers = value.split(',');
    else if (flag === '--concurrency') options.concurrency = Number(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.outputDirectory || (!auditOnly && (!options.startDate || !options.endExclusive))) {
    throw new Error('Use --start YYYY-MM-DD --end-exclusive YYYY-MM-DD --output path, or --audit-only --output path');
  }
  if (!auditOnly) {
    // Preserve previous evidence rather than accidentally overwrite a capture.
    try { await fs.access(path.join(options.outputDirectory, 'availability.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; options.fresh = true; }
    if (!options.fresh) throw new Error('Output already contains a capture; use a new directory or --audit-only');
    delete options.fresh;
    await fetchValidationHistory(options);
  }
  const audit = await auditLongHistory(options.outputDirectory);
  console.log(JSON.stringify({ outputDirectory: path.resolve(options.outputDirectory), bars: audit.bars,
    completeTickers: audit.completeTickers, blockedTickers: audit.blockedTickers,
    blocked: audit.diagnostics.filter(item => !item.complete).map(({ ticker, status, missingDates, rejectedBars, sourceError }) =>
      ({ ticker, status, missingDates, rejectedBars, sourceError })) }, null, 2));
  if (!audit.valid) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
