import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const universe = JSON.parse(fs.readFileSync(path.join(root, 'data/universe.json'), 'utf8'));
if (!Array.isArray(universe.companies) || universe.companies.length !== 200) throw new Error('Expected 200 companies');
if (new Set(universe.companies.map(c => c.companyKey)).size !== 200) throw new Error('Duplicate company');
if (!Array.isArray(universe.etfs) || universe.etfs.length !== 50) throw new Error('Expected 50 ETFs');
if (!Array.isArray(universe.instruments) || universe.instruments.length !== 250 || universe.count !== 250) throw new Error('Expected 250 instruments');
if (new Set(universe.instruments.map(c => c.ticker)).size !== 250) throw new Error('Duplicate ticker');
if (universe.instruments.filter(c => c.type === 'STOCK').length !== 200 || universe.instruments.filter(c => c.type === 'ETF').length !== 50) throw new Error('Invalid instrument types');
if (JSON.stringify(universe.instruments) !== JSON.stringify([...universe.companies.map(c => ({...c, type: 'STOCK'})), ...universe.etfs])) throw new Error('Instrument list differs from companies + ETFs; rebuild the universe');
const instruments = universe.instruments.map(({ticker, yahooTicker, name, exchange, type, category, issuer, dailyLeverage, inverse, resetPeriod, sourceUrl}) =>
  ({ticker, yahooTicker: yahooTicker || ticker, name, exchange, type, ...(type === 'ETF' ? {category, issuer, dailyLeverage, inverse, resetPeriod, sourceUrl} : {})}));
fs.writeFileSync(path.join(root, 'apps-script/Universe.gs'),
  '// Generated from data/universe.json. Stocks as of ' + universe.asOf + '; ETFs verified ' + universe.etfSelection.verifiedAt + '. Do not edit by hand.\nconst MS_UNIVERSE = ' + JSON.stringify(instruments, null, 2) + ';\n');
console.log('Generated Universe.gs: 250 instruments (200 companies + 50 ETFs), stocks as of ' + universe.asOf);
