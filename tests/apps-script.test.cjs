const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function formatDate(date, timezone, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23'}).formatToParts(date).map(x => [x.type,x.value]));
  return pattern === 'HH' ? parts.hour : `${parts.year}-${parts.month}-${parts.day}`;
}
function context(extra={}) {
  const props = new Map(), triggers = [];
  const ctx = vm.createContext({console, Date, Utilities:{formatDate},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null, setProperty:(k,v)=>props.set(k,v)})},
    ScriptApp:{getProjectTriggers:()=>triggers,deleteTrigger:t=>triggers.splice(triggers.indexOf(t),1),newTrigger:handler=>({timeBased(){return this},everyMinutes(){return this},create(){triggers.push({getHandlerFunction:()=>handler});}})},
    ...extra});
  ['Yahoo.gs','Storage.gs','Code.gs'].forEach(name => vm.runInContext(fs.readFileSync(path.join(root,'apps-script',name),'utf8'),ctx,{filename:name}));
  return ctx;
}
function call(ctx, js) { return vm.runInContext(js,ctx); }
function plain(x) {return JSON.parse(JSON.stringify(x));}
function response(body,code=200) {return {getResponseCode:()=>code,getContentText:()=>JSON.stringify(body)};}
function yahoo(dates,options={}) {
  const rows=dates.map(date=>Date.parse(date+'T13:30:00Z')/1000);
  return {chart:{result:[{meta:{symbol:'AAPL',currency:'USD',exchangeTimezoneName:'America/New_York',...options.meta},timestamp:rows,
    indicators:{quote:[{open:dates.map(()=>100),high:dates.map(()=>110),low:dates.map(()=>90),close:dates.map(()=>105),volume:dates.map(()=>1234),...options.quote}]}}]}};
}

test('NYSE calendar: holidays, Good Friday, one-off closure, Saturday New Year exception',()=>{
  const c=context();
  for(const date of ['2025-01-09','2026-01-19','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-11-26','2026-12-25','2028-02-30']) assert.equal(c.msIsSession_(date),false,date);
  for(const date of ['2026-07-02','2026-11-27','2026-12-24','2027-12-31']) assert.equal(c.msIsSession_(date),true,date);
  assert.equal(c.msIsSession_('2031-01-02'),false);
});
test('completed sessions respect New York DST, holidays and conservative 17 ET cutoff',()=>{
  const c=context();
  assert.equal(c.msExpectedSession_(new Date('2026-10-15T20:59:59Z')),'2026-10-14');
  assert.equal(c.msExpectedSession_(new Date('2026-10-15T21:00:00Z')),'2026-10-15');
  assert.equal(c.msExpectedSession_(new Date('2026-11-27T21:59:59Z')),'2026-11-25');
  assert.equal(c.msExpectedSession_(new Date('2026-11-27T22:00:00Z')),'2026-11-27');
  assert.equal(c.msExpectedSession_(new Date('2026-07-05T22:00:00Z')),'2026-07-02');
});
test('daily Yahoo timestamp stays aligned; provisional current bar excluded from history',()=>{
  const c=context(),data=yahoo(['2026-10-13','2026-10-14','2026-10-15']);
  const parsed=c.msParseYahoo_(response(data),{ticker:'AAPL'},false,new Date('2026-10-15T18:00:00Z'));
  assert.deepEqual(plain(parsed.rows.map(x=>x.fecha)),['2026-10-13','2026-10-14']);
  assert.equal(parsed.current.fecha,'2026-10-15'); assert.equal(parsed.status,'PROVISIONAL'); assert.equal(parsed.previous,105);
});
test('nulls, zero prices, incoherent OHLC, stale series, wrong identity and gaps fail closed',()=>{
  const c=context(),company={ticker:'AAPL'},now=new Date('2026-10-15T22:00:00Z');
  for(const quote of [{close:[null]},{open:[0]},{high:[99]},{volume:[null]},{volume:[-1]}]) assert.throws(()=>c.msParseYahoo_(response(yahoo(['2026-10-15'],{quote})),company,false,now));
  assert.throws(()=>c.msParseYahoo_(response(yahoo(['2026-10-14'])),company,false,now),/atrasada/);
  assert.throws(()=>c.msParseYahoo_(response(yahoo(['2026-10-15'],{meta:{symbol:'MSFT'}})),company,false,now),/Símbolo/);
  assert.throws(()=>c.msParseYahoo_(response(yahoo(['2026-10-13','2026-10-15'])),company,false,now),/Falta sesión/);
  assert.equal(c.msValidBar_({fecha:'2026-10-15',ticker:'AAPL',open:100,high:100,low:100,close:100,volumen:0}),true);
});
test('new IPO publishes only real rows and explicitly reports fewer than 500 sessions',()=>{
  const c=context(),data=yahoo(['2026-10-14','2026-10-15'],{meta:{firstTradeDate:Date.parse('2026-10-14T13:30:00Z')/1000}});
  const r=c.msParseYahoo_(response(data),{ticker:'AAPL'},true,new Date('2026-10-15T22:00:00Z'));
  assert.equal(r.shortHistory,true);assert.equal(r.rows.length,2);assert.match(r.status,/HISTORIA CORTA/);
  assert.throws(()=>c.msParseYahoo_(response(yahoo(['2026-10-14','2026-10-15'])),{ticker:'AAPL'},true,new Date('2026-10-15T22:00:00Z')),/inicio de cotización/);
});
test('per-company retention keeps exactly newest 500 and refresh replaces corrections',()=>{
  const c=context(),old=Array.from({length:500},(_,i)=>({fecha:String(i).padStart(4,'0'),ticker:'AAPL',close:100}));
  const rows=c.msMergeRows_(old,[{fecha:'0500',ticker:'AAPL',close:200},{fecha:'0499',ticker:'AAPL',close:300}],false);
  assert.equal(rows.length,500);assert.equal(rows[0].fecha,'0001');assert.equal(rows[498].close,300);
  assert.equal(c.msMergeRows_(old,[{fecha:'0500'}],true).length,1);
});
test('secret API keys do not become bearer JWTs; upsert conflict and scoped retention explicit',()=>{
  const requests=[],c=context({UrlFetchApp:{fetch:(url,opts)=>{requests.push({url,opts});return response({});}}});
  c.msProperties_().setProperty('SUPABASE_URL','https://example.supabase.co');
  c.msProperties_().setProperty('SUPABASE_WRITE_KEY','sb_secret_TEST');
  const bar={fecha:'2026-10-15',ticker:'AAPL',open:100,high:110,low:90,close:105,volumen:0};
  c.msPublish_([bar],'2024-10-15','AAPL');
  assert.match(requests[0].url,/on_conflict=fecha,ticker/);
  assert.equal(requests[0].opts.headers.apikey,'sb_secret_TEST');assert.equal(requests[0].opts.headers.Authorization,undefined);
  assert.match(requests[1].url,/ticker=eq.AAPL&fecha=lt.2024-10-15/);
  c.msProperties_().setProperty('SUPABASE_WRITE_KEY','sb_publishable_TEST');assert.throws(()=>c.msSupaConfig_(),/privada/);
});
test('failed tickers retry and never silently count as completed; final failed queue persists',()=>{
  const c=context();
  c.msBook_=()=>({getSheetByName:()=>({})}); c.msUniverse_=()=>Array.from({length:200},(_,i)=>({ticker:'T'+i}));
  c.msLoadHistory_=()=>({byTicker:{}});c.msFetchYahooBatch_=batch=>batch.map(()=>({error:'HTTP 429'}));c.msWritePrice_=()=>{};
  const job=c.msNewJob_();job.cursor=195;c.msRunJob_('history',job);
  assert.equal(job.completed,0);assert.equal(job.round,1);assert.equal(job.cursor,0);assert.equal(job.work.length,5);
  c.msRunJob_('history',job);assert.equal(job.round,2);
  c.msRunJob_('history',job);assert.equal(job.status,'INCOMPLETO');assert.equal(job.failed.length,5);
  assert.equal(c.msGetJob_('history').status,'INCOMPLETO');
});
test('a process crash during publish leaves cursor retryable and continuation already installed',()=>{
  const c=context(); c.msBook_=()=>({getSheetByName:()=>({})}); c.msUniverse_=()=>[{ticker:'AAPL'}];
  c.msLoadHistory_=()=>{throw new Error('unexpected termination')};
  const job=c.msNewJob_();c.msPutJob_('daily',job);
  assert.throws(()=>c.msRunJob_('daily',job),/unexpected termination/);
  assert.equal(c.msGetJob_('daily').cursor,0);
  assert.equal(c.ScriptApp.getProjectTriggers()[0].getHandlerFunction(),'continuarActualizacion');
});
test('stopping timers records intent even while another process owns the lock',()=>{
  const c=context({LockService:{getScriptLock:()=>({tryLock:()=>false})}});
  c.msEnsureRecurring_('continuarActualizacion',5);
  c.detenerTemporizadores();
  assert.equal(c.msProperties_().getProperty('MS_PAUSED'),'true');
  assert.equal(c.ScriptApp.getProjectTriggers().length,0);
  c.msBook_=()=>{throw new Error('paused work must not open the sheet')};
  c.msRunJob_('daily',c.msNewJob_());
});
test('imported Sheets dates do not force unchanged 500-day histories to be rewritten',()=>{
  const c=context(),sheet={getLastRow:()=>2,getRange:()=>({getValues:()=>[[new Date('2026-10-15T04:00:00Z'),'AAPL',100,110,90,105,1000]]})};
  const cache=c.msLoadHistory_(sheet);
  assert.equal(cache.values[0][0],'2026-10-15');
  c.msSaveTicker_(cache,'AAPL',[{fecha:'2026-10-15',ticker:'AAPL',open:100,high:110,low:90,close:105,volumen:1000}]);
  assert.equal(Object.keys(cache.dirty).length,0);
});
