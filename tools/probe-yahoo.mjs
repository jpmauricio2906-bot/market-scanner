/** Optional live read-only smoke test. No credentials or remote writes. */
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const ctx=vm.createContext({console,Date,Utilities:{formatDate(date,tz,pattern){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value]));
  return pattern==='HH'?p.hour:`${p.year}-${p.month}-${p.day}`;
}}});
vm.runInContext(fs.readFileSync(fileURLToPath(new URL('../apps-script/Yahoo.gs',import.meta.url)),'utf8'),ctx);
const args=process.argv.slice(2),retry=args.includes('--retry-failed'),allowStale=args.includes('--allow-stale');
const etfs=args.includes('--etfs'),all=args.includes('--all')||retry||etfs;
const universe=JSON.parse(fs.readFileSync(path.join(root,'data/universe.json'),'utf8'));
const instruments=universe.instruments||universe.companies;
const byTicker=new Map(instruments.map(c=>[c.ticker,c]));
const dir=path.join(root,'outputs/yahoo'),stem=etfs?'etfs-':'';
const historyPath=path.join(dir,stem+'history.json'),diagnosticPath=path.join(dir,stem+'diagnostics.json');
const saved=retry?JSON.parse(fs.readFileSync(diagnosticPath,'utf8')):[];
const savedHistory=retry?JSON.parse(fs.readFileSync(historyPath,'utf8')):null;
const selected=etfs?universe.etfs:instruments;
const positional=args.filter(a=>!a.startsWith('--'));
const tickers=retry?saved.filter(d=>d.error).map(d=>d.ticker):all?selected.map(c=>c.ticker):positional.length?positional:['AAPL','BRK-B','TSM'];
const bars=savedHistory?savedHistory.rows:[],diagnostics=retry?saved.filter(d=>!d.error):[];
for(let index=0;index<tickers.length;index+=5) {
await Promise.all(tickers.slice(index,index+5).map(async ticker=>{
  try {
    const instrument=byTicker.get(ticker)||{ticker};
    const request=ctx.msYahooRequest_(instrument,true);
    const response=await fetch(request.url,{headers:request.headers,signal:AbortSignal.timeout(30000)}),text=await response.text();
    const adapter={getResponseCode:()=>response.status,getContentText:()=>text};
    let parsed;
    try { parsed=ctx.msParseYahoo_(adapter,instrument,true,new Date()); }
    catch(error){
      if(!allowStale||!error.message.includes('atrasada')) throw error;
      parsed=ctx.msParseYahoo_(adapter,instrument,true,new Date(Date.now()-86400000));
      parsed.status='ATRASADO · último cierre disponible '+parsed.rows.at(-1).fecha;
    }
    const info={ticker,type:instrument.type||'STOCK',retrievedAt:new Date().toISOString(),rows:parsed.rows.length,first:parsed.rows[0].fecha,last:parsed.rows.at(-1).fecha,status:parsed.status,rejected:parsed.rejected};
    diagnostics.push(info);bars.push(...parsed.rows);
    if(!all)console.log(JSON.stringify(info));
  } catch(error) {const info={ticker,type:byTicker.get(ticker)?.type||'STOCK',error:error.message};diagnostics.push(info);console.log(JSON.stringify(info));process.exitCode=1;}
}));
if(all && index+5<tickers.length) await new Promise(resolve=>setTimeout(resolve,350));
}
if(all){
  fs.mkdirSync(dir,{recursive:true});
  bars.sort((a,b)=>a.ticker.localeCompare(b.ticker)||a.fecha.localeCompare(b.fecha));
  fs.writeFileSync(historyPath,JSON.stringify({retrievedAt:new Date().toISOString(),source:'Yahoo Finance daily chart, 3y',rows:bars}));
  fs.writeFileSync(diagnosticPath,JSON.stringify(diagnostics,null,2));
  console.log(JSON.stringify({instruments:diagnostics.length,valid:diagnostics.filter(d=>!d.error).length,failed:diagnostics.filter(d=>d.error),short:diagnostics.filter(d=>d.rows<500),rows:bars.length,output:historyPath}));
}
