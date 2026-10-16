import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const universe=JSON.parse(fs.readFileSync(path.join(root,'data/universe.json'),'utf8'));
const ctx=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root,'js/market-calendar.js'),'utf8')+'\nglobalThis.holidays=[...MARKET_CALENDAR.holidays];',ctx);
const holidays=[...ctx.holidays].filter(d=>d<'2029-01-01').sort();
const earlyCloses=['2024-07-03','2024-11-29','2024-12-24','2025-07-03','2025-11-28','2025-12-24','2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24'];
const calendar={firstYear:2024,lastYear:2028,timeZone:'America/New_York',holidays,earlyCloses,
 normalClose:'16:00',earlyClose:'13:00',confirmationDelayMinutes:60,
 sources:['https://www.nyse.com/trade/hours-calendars','https://ir.theice.com/press/news-details/2023/NYSE-Group-Announces-2024-2025-and-2026-Holiday-and-Early-Closings-Calendar/default.aspx'],
 review:'Review extraordinary closures annually; server refuses dates after 2028 until reviewed.'};
assert.equal(universe.instruments.length,250);
const shortHistories=JSON.parse(fs.readFileSync(path.join(root,'data/instrument-history-starts.json'),'utf8'));
const firstTrade=new Map(Object.entries(shortHistories.firstTradeDates));
const quote=v=>v===null||v===undefined?'null':"'"+String(v).replaceAll("'","''")+"'";
const list=values=>'array['+values.map(quote).join(',')+']::date[]';
const seed=`-- Generated universe and exchange calendar. Source files: data/universe.json; supabase/calendar.json.\n`+
`insert into market_scanner.instruments(ticker,yahoo_symbol,instrument_type,exchange_name,first_trade_date) values\n`+
universe.instruments.map(i=>'('+[i.ticker,i.yahooTicker||i.ticker,i.type,i.exchange,firstTrade.get(i.ticker)||null].map(quote).join(',')+')').join(',\n')+
`\non conflict(ticker) do update set yahoo_symbol=excluded.yahoo_symbol,instrument_type=excluded.instrument_type,exchange_name=excluded.exchange_name,first_trade_date=coalesce(market_scanner.instruments.first_trade_date,excluded.first_trade_date);\n`+
`insert into market_scanner.sessions(session_date,opens_at,closes_at,confirms_at)\nselect d::date,(d::date+time '09:30') at time zone 'America/New_York',\n (d::date+case when d::date=any(${list(earlyCloses)}) then time '13:00' else time '16:00' end) at time zone 'America/New_York',\n ((d::date+case when d::date=any(${list(earlyCloses)}) then time '13:00' else time '16:00' end) at time zone 'America/New_York')+interval '1 hour'\n`+
`from generate_series(date '2024-01-01',date '2028-12-31',interval '1 day') s(d)\nwhere extract(isodow from d) between 1 and 5 and not(d::date=any(${list(holidays)}))\non conflict(session_date) do update set opens_at=excluded.opens_at,closes_at=excluded.closes_at,confirms_at=excluded.confirms_at;\n`;
fs.writeFileSync(path.join(root,'supabase/calendar.json'),JSON.stringify(calendar,null,2)+'\n');
const file=path.join(root,'supabase/server_owned_history.sql');
let sql=fs.readFileSync(file,'utf8');
const start='-- BEGIN GENERATED SERVER SEED',end='-- END GENERATED SERVER SEED';
if(sql.includes(start))sql=sql.slice(0,sql.indexOf(start))+start+'\n'+seed+end+sql.slice(sql.indexOf(end)+end.length);
else sql=sql.replace('-- __SERVER_SEED__',start+'\n'+seed+end);
assert.ok(!sql.includes('-- __SERVER_SEED__'));
fs.writeFileSync(file,sql);
console.log(JSON.stringify({instruments:250,calendarFirstYear:2024,calendarLastYear:2028,earlyCloses:earlyCloses.length,holidays:holidays.length,verifiedIpoFirstDates:[...firstTrade]}));
