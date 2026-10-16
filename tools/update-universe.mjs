#!/usr/bin/env node
/**
 * Rebuild 200 companies plus 50 curated ETFs from saved official sources.
 * Node >= 20, no dependencies. Use --refresh to download a new snapshot.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(projectRoot, 'data');
const sourceDir = join(dataDir, 'sources');
const exchanges = { nasdaq: 'NASDAQ', nyse: 'NYSE', amex: 'NYSEAMERICAN' };
const count = 200;
const etfCount = 50;
// Choose an accessible class deliberately; never count classes as companies.
const representativeTickers = new Map([
  ['1067983', 'BRK-B'],
  ['1652044', 'GOOGL'],
]);
const sourceUrl = 'https://www.nasdaq.com/market-activity/stocks/screener';
const secUrl = 'https://www.sec.gov/files/company_tickers_exchange.json';
// Nasdaq's legacy BNS name contains "Pfd" although BNS is common equity.
// Verified against the issuer's current shareholder FAQ, recorded in the output.
const securityOverrides = {
  BNS: {
    name: 'The Bank of Nova Scotia',
    source: 'https://www.scotiabank.com/ca/en/about/investors-shareholders/frequently-asked-questions.html',
    reason: 'El emisor confirma que BNS son acciones comunes en NYSE; Nasdaq conserva Pfd en el nombre.',
  },
};

export function normalizeTicker(ticker) {
  return String(ticker).trim().toUpperCase().replace(/[/.]/g, '-');
}

function marketCap(value) {
  const parsed = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sourceDate(value) {
  const match = String(value).match(/as of ([A-Za-z]+ \d{1,2}, \d{4})/i);
  if (!match) throw new Error(`Nasdaq did not provide a recognized as-of date: ${value}`);
  const parsed = new Date(`${match[1]} 12:00:00 UTC`);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid Nasdaq date: ${value}`);
  return parsed.toISOString().slice(0, 10);
}

function isOperatingEquity(row) {
  if (securityOverrides[normalizeTicker(row.symbol)]) return true;
  const name = String(row.name);
  // ADRs on non-voting underlying equity remain eligible (e.g. ITUB).
  const adr = /\b(?:ADR|ADS)\b|American Deposit(?:a|o)ry Share/i.test(name);
  if (/\b(?:Preferred|Preference|Pfd)\b/i.test(name) && !adr) return false;
  return !/\b(?:Warrants?|Rights?|Notes?|Debentures?|Bonds?|ETFs?|ETNs?|ZONES)\b|\bFund\b|Exchange.Traded|Closed.End|Tangible Equity Unit|Debt Securities/i.test(name);
}

function cleanName(name) {
  return name
    .replace(/\s+Class\s+[A-Z]\s+(?:Common|Capital)\s+Stock.*$/i, '')
    .replace(/\s+(?:Common|Capital)\s+Stock.*$/i, '')
    .replace(/\s+(?:Registered\s+)?Ordinary\s+Shares?.*$/i, '')
    .replace(/\s+American Deposit(?:a|o)ry\s+Shares?.*$/i, '')
    .replace(/\s+(?:Sponsored|Unsponsored|Sponosred)\s+ADR.*$/i, '')
    .replace(/\s+(?:ADR|ADS)\b.*$/i, '')
    .replace(/\s+New York Registry Shares.*$/i, '')
    .replace(/\s+Class\s+[A-Z]\s+(?:Subordinate|Limited).*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function requestJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json, text/plain, */*',
      ...headers,
    },
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return {
    url,
    retrievedAt: new Date().toISOString(),
    httpDate: response.headers.get('date'),
    data: await response.json(),
  };
}

function buildUniverse(snapshots, secSnapshot) {
  const sec = secSnapshot.data;
  if (JSON.stringify(sec.fields) !== JSON.stringify(['cik', 'name', 'ticker', 'exchange']) || !Array.isArray(sec.data) || sec.data.length < 5000) {
    throw new Error('The SEC identity table is incomplete or its schema changed.');
  }
  const identities = new Map(sec.data.map(([cik, name, ticker, exchange]) => [normalizeTicker(ticker), { cik: String(cik), name, exchange }]));
  const candidates = [];
  const audit = { sourceRows: 0, noMarketCap: 0, excludedNonEquity: 0, noSecIdentity: 0, duplicateCompany: 0 };
  const dates = new Set();
  const sources = [];

  for (const [exchange, snapshot] of Object.entries(snapshots)) {
    const payload = snapshot.data?.data;
    const rows = payload?.table?.rows;
    if (!Array.isArray(rows) || rows.length < 100 || rows.length !== Number(payload.totalrecords)) {
      throw new Error(`Incomplete Nasdaq ${exchange} snapshot. Existing universe was not changed.`);
    }
    const asOf = sourceDate(payload.asof);
    if (asOf > snapshot.retrievedAt.slice(0, 10)) throw new Error('Source date is later than retrieval date.');
    dates.add(asOf);
    sources.push({
      exchange: exchanges[exchange], url: snapshot.url, asOf,
      retrievedAt: snapshot.retrievedAt, reportedAsOf: payload.asof,
      rows: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    });
    for (const row of rows) {
      audit.sourceRows += 1;
      const cap = marketCap(row.marketCap);
      if (!cap) { audit.noMarketCap += 1; continue; }
      if (!isOperatingEquity(row)) { audit.excludedNonEquity += 1; continue; }
      const ticker = normalizeTicker(row.symbol);
      const identity = identities.get(ticker);
      if (!identity) { audit.noSecIdentity += 1; continue; }
      candidates.push({
        ticker, yahooTicker: ticker, name: securityOverrides[ticker]?.name ?? cleanName(row.name),
        exchange: exchanges[exchange], marketCapUsd: cap,
        companyKey: `cik:${identity.cik.padStart(10, '0')}`,
        cik: identity.cik,
      });
    }
  }
  if (dates.size !== 1) throw new Error('Exchange snapshots have different valuation dates; refresh again.');
  const companyGroups = new Map();
  for (const candidate of candidates) {
    const group = companyGroups.get(candidate.companyKey) ?? [];
    group.push(candidate);
    companyGroups.set(candidate.companyKey, group);
  }
  const uniqueCompanies = [...companyGroups.values()].map(group => {
    group.sort((a, b) => b.marketCapUsd - a.marketCapUsd || a.ticker.localeCompare(b.ticker));
    audit.duplicateCompany += group.length - 1;
    const preferred = representativeTickers.get(group[0].cik);
    const representative = preferred ? group.find(row => row.ticker === preferred) : group[0];
    if (!representative) throw new Error(`Expected representative ${preferred} is missing.`);
    const { cik, ...company } = representative;
    return company;
  }).sort((a, b) => b.marketCapUsd - a.marketCapUsd || a.ticker.localeCompare(b.ticker));

  const companies = uniqueCompanies.slice(0, count).map((company, index) => ({ rank: index + 1, ...company }));
  if (companies.length !== count || new Set(companies.map(x => x.ticker)).size !== count || new Set(companies.map(x => x.companyKey)).size !== count) {
    throw new Error('Universe must contain exactly 200 distinct tickers and companies.');
  }
  if (companies.some((company, index) => index && company.marketCapUsd > companies[index - 1].marketCapUsd)) throw new Error('Market-cap sort is invalid.');
  // Missing SEC identifiers must never silently remove a contender near the cutoff.
  const cutoff = companies.at(-1).marketCapUsd;
  const unresolved = Object.values(snapshots).flatMap(snapshot => snapshot.data.data.table.rows)
    .filter(row => marketCap(row.marketCap) >= cutoff && isOperatingEquity(row) && !identities.has(normalizeTicker(row.symbol)));
  if (unresolved.length) throw new Error(`SEC identities missing above cutoff: ${unresolved.map(row => row.symbol).join(', ')}`);

  return {
    asOf: [...dates][0],
    retrievedAt: [...sources.map(x => x.retrievedAt), secSnapshot.retrievedAt].sort().at(-1),
    source: sourceUrl,
    methodology: 'Las 200 empresas distintas con mayor capitalización reportada por Nasdaq para valores de renta variable cotizados en NASDAQ, NYSE o NYSE American. Incluye empresas extranjeras y ADR; excluye fondos, deuda, warrants y acciones preferentes, salvo ADR sobre capital no votante. Una empresa por CIK de SEC. Se elige la clase con mayor capitalización reportada, excepto GOOGL y BRK-B, seleccionadas expresamente. No se suman capitalizaciones de clases. La capitalización de Nasdaq puede reflejar solo el capital asociado al valor cotizado; no constituye una clasificación auditada del valor económico total de cada grupo. asOf es la fecha declarada por Nasdaq; retrievedAt es la descarga, no una cotización en tiempo real.',
    count,
    identitySource: { url: secUrl, retrievedAt: secSnapshot.retrievedAt, rows: sec.data.length },
    securityOverrides,
    sources,
    audit: { ...audit, eligibleDistinctCompanies: uniqueCompanies.length, cutoffMarketCapUsd: cutoff },
    companies,
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** ETFs are funds, not operating companies: never deduplicate them by issuer/CIK. */
export function appendEtfs(stockUniverse, etfSource) {
  if (!Array.isArray(stockUniverse.companies) || stockUniverse.companies.length !== count || new Set(stockUniverse.companies.map(company => company.companyKey)).size !== count) {
    throw new Error('Stock source must retain exactly 200 distinct companies.');
  }
  if (etfSource.count !== etfCount || !Array.isArray(etfSource.etfs) || etfSource.etfs.length !== etfCount) {
    throw new Error('ETF source must contain exactly 50 curated funds.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(etfSource.verifiedAt) || !etfSource.methodology) throw new Error('ETF source metadata is incomplete.');
  const required = ['TQQQ', 'QQQ', 'LABU', 'XBI', 'SOXX', 'USD', 'SOXL', 'SOXS', 'UPRO', 'QLD', 'MAGS'];
  const etfs = etfSource.etfs;
  for (const etf of etfs) {
    if (etf.type !== 'ETF' || !/^[A-Z][A-Z0-9-]{0,9}$/.test(etf.ticker) || etf.yahooTicker !== etf.ticker || !etf.name || !etf.issuer || !etf.category || !etf.exchange) {
      throw new Error(`Invalid ETF identity: ${etf.ticker}`);
    }
    if (![1, 2, 3, -1, -2, -3].includes(etf.dailyLeverage) || typeof etf.inverse !== 'boolean' || etf.inverse !== (etf.dailyLeverage < 0)) {
      throw new Error(`Invalid ETF leverage: ${etf.ticker}`);
    }
    const geared = etf.dailyLeverage !== 1;
    if (etf.resetPeriod !== (geared ? 'daily' : null)) throw new Error(`Invalid ETF reset period: ${etf.ticker}`);
    let source;
    try { source = new URL(etf.sourceUrl); } catch { throw new Error(`Invalid ETF source URL: ${etf.ticker}`); }
    if (source.protocol !== 'https:' || !etf.verifiedAt || etf.verifiedAt !== etfSource.verifiedAt) throw new Error(`Incomplete ETF evidence: ${etf.ticker}`);
  }
  if (required.some(ticker => !etfs.some(etf => etf.ticker === ticker))) throw new Error('A user-requested ETF is missing.');
  if (etfs.some(etf => etf.ticker === 'MAG7')) throw new Error('Use the verified US ticker MAGS for the Magnificent Seven ETF.');
  const instruments = [...stockUniverse.companies.map(company => ({ ...company, type: 'STOCK' })), ...etfs];
  if (instruments.length !== count + etfCount || new Set(instruments.map(instrument => instrument.ticker)).size !== count + etfCount) {
    throw new Error('Universe must contain exactly 250 distinct instruments: 200 companies and 50 ETFs.');
  }
  const { etfs: omitted, ...selection } = etfSource;
  return { ...stockUniverse, count: instruments.length, companyCount: count, etfCount, etfSelection: selection, etfs, instruments };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--refresh', '--from-snapshots', '--check'].includes(arg))) {
    throw new Error('Usage: node tools/update-universe.mjs [--refresh | --from-snapshots] [--check]');
  }
  const refresh = args.includes('--refresh');
  if (refresh && args.includes('--from-snapshots')) throw new Error('Choose --refresh or --from-snapshots.');
  if (refresh && args.includes('--check')) throw new Error('--check uses existing snapshots and must not download.');
  const snapshots = {};
  let secSnapshot;
  if (refresh) {
    // A few sequential public requests, never hundreds of per-symbol calls.
    for (const exchange of Object.keys(exchanges)) {
      snapshots[exchange] = await requestJson(`https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&exchange=${exchange}`, {
        Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/',
      });
    }
    secSnapshot = await requestJson(`${secUrl}?_=${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`, process.env.SEC_USER_AGENT ? { 'User-Agent': process.env.SEC_USER_AGENT } : {});
  } else {
    for (const exchange of Object.keys(exchanges)) snapshots[exchange] = JSON.parse(await readFile(join(sourceDir, `${exchange}.json`), 'utf8'));
    secSnapshot = JSON.parse(await readFile(join(sourceDir, 'sec-company-tickers.json'), 'utf8'));
  }
  // Both rebuild and refresh retain the independently maintained ETF selection.
  const etfSource = JSON.parse(await readFile(join(dataDir, 'etfs.json'), 'utf8'));
  const universe = appendEtfs(buildUniverse(snapshots, secSnapshot), etfSource);
  const json = `${JSON.stringify(universe, null, 2)}\n`;
  const columns = ['type', 'rank', 'selectionOrder', 'ticker', 'yahooTicker', 'name', 'exchange', 'marketCapUsd', 'companyKey', 'category', 'issuer', 'dailyLeverage', 'inverse', 'resetPeriod', 'sourceUrl', 'verifiedAt'];
  const csv = `${columns.join(',')}\r\n${universe.instruments.map(instrument => columns.map(key => csvCell(instrument[key])).join(',')).join('\r\n')}\r\n`;
  if (args.includes('--check')) {
    if (await readFile(join(dataDir, 'universe.json'), 'utf8') !== json || await readFile(join(dataDir, 'universe.csv'), 'utf8') !== csv) {
      throw new Error('Universe differs from the committed source snapshots. Rebuild with --from-snapshots.');
    }
  } else {
    await mkdir(sourceDir, { recursive: true });
    // All downloads and validations complete before replacing canonical files.
    if (refresh) {
      for (const [exchange, snapshot] of Object.entries(snapshots)) await writeFile(join(sourceDir, `${exchange}.json`), JSON.stringify(snapshot));
      await writeFile(join(sourceDir, 'sec-company-tickers.json'), JSON.stringify(secSnapshot));
    }
    for (const [filename, content] of [['universe.json', json], ['universe.csv', csv]]) {
      const path = join(dataDir, filename);
      await writeFile(`${path}.tmp`, content);
      await rename(`${path}.tmp`, path);
    }
  }
  console.log(`${args.includes('--check') ? 'Verified' : 'Wrote'} ${universe.count} instruments (${count} companies + ${etfCount} ETFs); Nasdaq as of ${universe.asOf}; cutoff $${universe.audit.cutoffMarketCapUsd.toLocaleString('en-US')}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
