const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname,'..');
const plain = value => JSON.parse(JSON.stringify(value));
const response = (body,code=200) => ({getResponseCode:()=>code,getContentText:()=>typeof body==='string'?body:JSON.stringify(body)});

function yahoo(symbol, overrides={}) {
  return {chart:{result:[{
    meta:{symbol,currency:'USD',exchangeTimezoneName:'America/New_York',exchangeName:'NMS',firstTradeDate:345479400,regularMarketTime:1792094400,...overrides.meta},
    timestamp:[1791984600,1792071000],
    indicators:{quote:[{open:[100,101],high:[105,106],low:[98,99],close:[103,104],volume:[1000,1100],...overrides.quote}]},
    ...overrides.result
  }]}};
}
function serverResult(ticker,status='FINAL',extra={}) {
  return {ticker,status,reason:null,current:{fecha:'2026-10-15',open:101,high:106,low:99,close:104,volumen:1100},
    previous_close:103,history_count:500,last_final_date:'2026-10-15',needs_replacement:false,...extra};
}

function harness(options={}) {
  const base = Date.parse(options.now || '2026-10-15T22:00:00Z'); let elapsed=0, locked=true, failWrite=false;
  const props = new Map([['SUPABASE_URL','https://example.supabase.co'],['SUPABASE_WRITE_KEY','sb_secret_TEST_ONLY']]);
  const events=[],logs=[],triggers=[],cells=new Map(),formulas=new Map(),menus=[];
  let rows=200, exists=false, ctx;
  const record = (op,extra={}) => events.push({op,at:elapsed,...extra});
  class Clock extends Date { constructor(...args){super(...(args.length?args:[base+elapsed]));} static now(){return base+elapsed;} }
  const key=(row,col)=>row+','+col;
  const sheet={getMaxRows:()=>rows,getLastRow:()=>Math.max(0,...[...cells.entries()].filter(([,v])=>v!=='').map(([k])=>Number(k.split(',')[0]))),
    insertRowsAfter(after,count){assert.equal(after,rows);rows+=count;record('expand',{rows});},setFrozenRows(n){record('freeze',{n});},
    getRange(row,col=1,height=1,width=1){
      if(typeof row==='string'){
        const match=/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(row);assert.ok(match);
        const column=s=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
        col=column(match[1]);width=column(match[3])-col+1;row=Number(match[2]);height=Number(match[4])-row+1;
      }
      assert.ok(row+height-1<=rows,'Precios range stays bounded');
      const details={row,col,height,width};
      return {getValues(){record('read',details);return Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>cells.get(key(row+y,col+x))??''));},
        setValues(values){
          if(failWrite){failWrite=false;throw new Error('simulated hard interruption');}
          record('write',details);assert.equal(values.length,height);
          values.forEach((line,y)=>{assert.equal(line.length,width);line.forEach((value,x)=>cells.set(key(row+y,col+x),value));});return this;
        },
        setValue(value){return this.setValues([[value]]);},setFormulas(values){record('formulas',details);values.forEach((line,y)=>line.forEach((v,x)=>formulas.set(key(row+y,col+x),v)));return this;},
        setNumberFormat(){return this;},setBackground(){return this;},setFontColor(){return this;},setFontWeight(){return this;}};
    }};
  const book={getId:()=> 'test-sheet-v2',getSheetByName(name){record('sheet',{name});assert.equal(name,'Precios','Google must never access the archived history');return exists?sheet:null;},
    insertSheet(name){assert.equal(name,'Precios');exists=true;return sheet;}};
  let yahooGroups=0,rpcGroups=0;
  const properties={getProperty:k=>props.get(k)??null,setProperty(k,v){props.set(k,v);if(k==='MS_JOB_RECENT_V2')record('checkpoint',{saved:JSON.parse(v)});}};
  ctx=vm.createContext({Date:Clock,console:{log:v=>logs.push(v)},PropertiesService:{getScriptProperties:()=>properties},
    LockService:{getScriptLock:()=>({tryLock:()=>locked,releaseLock(){}})},
    SpreadsheetApp:{getActiveSpreadsheet:()=>book,openById:id=>{assert.equal(id,book.getId());record('open');return book;},flush(){record('flush');},
      getUi:()=>({createMenu:()=>({addItem(label,fn){menus.push({label,fn});return this;},addSeparator(){return this;},addToUi(){}})})},
    Utilities:{formatDate(date,timeZone,pattern){const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value]));return pattern==='HH'?p.hour:`${p.year}-${p.month}-${p.day}`;}},
    ScriptApp:{getProjectTriggers:()=>triggers.slice(),deleteTrigger:t=>triggers.splice(triggers.indexOf(t),1),
      newTrigger:handler=>({handler,timeBased(){return this;},everyMinutes(n){this.minutes=n;return this;},everyHours(n){this.hours=n;return this;},create(){const trigger={handler,minutes:this.minutes,hours:this.hours,getHandlerFunction:()=>handler};triggers.push(trigger);record('trigger',{handler,minutes:this.minutes,hours:this.hours});return trigger;}})},
    UrlFetchApp:{fetchAll(requests){yahooGroups++;record('yahoo',{requests:plain(requests)});elapsed+=options.yahooCost||0;
      if(options.onYahoo)options.onYahoo({ctx,props});
      if(options.yahooThrow)throw new Error('external transport internals');
      return requests.map((request,n)=>options.yahooResponse?options.yahooResponse(request,n,yahooGroups):response(yahoo(decodeURIComponent(/chart\/([^?]+)/.exec(request.url)[1]))));},
      fetch(url,opts){rpcGroups++;const payload=JSON.parse(opts.payload);record('rpc',{url,payload,headers:plain(opts.headers)});elapsed+=options.rpcCost||0;
        if(options.rpcResponse)return options.rpcResponse(payload.p_batch,rpcGroups,{ctx,props});
        return response({version:2,results:payload.p_batch.map(item=>serverResult(item.ticker))});}}
  });
  for(const file of ['Universe.gs','Yahoo.gs','Storage.gs','Code.gs'])vm.runInContext(fs.readFileSync(path.join(root,'apps-script',file),'utf8'),ctx,{filename:file});
  return {ctx,props,events,logs,triggers,menus,cells,formulas,sheet,book,
    prepare(){ctx.prepararMarketScanner();events.length=0;},
    reset(){events.length=0;},setLocked(value){locked=value;},interruptNextWrite(){failWrite=true;},
    cell:(row,col)=>cells.get(key(row,col))??'',putCell:(row,col,value)=>cells.set(key(row,col),value),
    tailJob(count=5){const job=ctx.msNewJob_();job.cursor=250-count;job.completed=250-count;ctx.msPutJob_(job);return job;},
    get elapsed(){return elapsed;}};
}

test('the shipped universe retains all 200 companies and 50 ETFs, including signed exposure',()=>{
  const h=harness(),actual=plain(h.ctx.msUniverse_()),json=JSON.parse(fs.readFileSync(path.join(root,'data/universe.json'),'utf8'));
  assert.deepEqual(actual.map(c=>c.ticker),json.instruments.map(c=>c.ticker));
  assert.equal(actual.filter(c=>c.type==='STOCK').length,200);assert.equal(actual.filter(c=>c.type==='ETF').length,50);
  assert.equal(actual.find(c=>c.ticker==='USD').dailyLeverage,2);assert.equal(actual.find(c=>c.ticker==='SOXS').dailyLeverage,-3);
  assert.ok(actual.some(c=>c.ticker==='MAGS'));
});

test('preparation writes only 251 Precios rows, formulas and metadata; it never opens history',()=>{
  const h=harness();h.ctx.prepararMarketScanner();
  assert.equal(h.props.get('SPREADSHEET_ID'),'test-sheet-v2');
  assert.equal(h.sheet.getMaxRows(),251);assert.equal(h.cell(251,1),h.ctx.msUniverse_()[249].ticker);
  assert.ok(h.formulas.get('251,10').includes('G251-I251'));
  assert.deepEqual(h.sheet.getRange(1,17,1,5).getValues()[0],['Tipo','Categoria','Emisor','Apalancamiento diario','Inverso']);
  assert.ok(h.events.filter(e=>e.op==='read').every(e=>e.height<=250));
  assert.ok(h.events.filter(e=>e.op==='sheet').every(e=>e.name==='Precios'));
  h.ctx.onOpen();assert.ok(h.menus.every(item=>!item.fn.includes('Historial')));
  for(const name of ['msLoadHistory_','msLoadTickerHistory_','msIsSession_','msValidBar_','iniciarHistorial','continuarHistorial'])assert.equal(typeof h.ctx[name],'undefined',name+' is retired');
});

test('incompatible Precios ordering is detected before downloads or price writes',()=>{
  const h=harness();h.prepare();h.putCell(2,1,'WRONG');h.reset();
  assert.throws(()=>h.ctx.actualizarMarketScanner(),/Precios cambió/);
  assert.equal(h.events.filter(e=>e.op==='yahoo'||e.op==='rpc'||e.op==='write').length,0);
  assert.equal(h.ctx.msGetJob_().cursor,0);
});

test('Yahoo transport forwards malformed OHLCV and source metadata without applying market rules',()=>{
  const h=harness(),body=yahoo('DIFFERENT',{meta:{currency:'EUR',exchangeTimezoneName:'UTC'},quote:{open:[-1,'100'],high:[null,2],low:[99,99],close:[null,0],volume:[1.5,-2]}});
  body.chart.result[0].events={splits:{'1792071000':{date:1792071000,numerator:3,denominator:1}}};
  const raw=h.ctx.msParseYahoo_(response(body),{ticker:'AAPL'},'2026-10-15T20:00:00Z','2026-10-15T20:00:01Z');
  assert.equal(raw.symbol,'DIFFERENT');assert.equal(raw.currency,'EUR');assert.equal(raw.exchange_timezone,'UTC');
  assert.deepEqual(plain(raw.rows),[{timestamp:1791984600,open:-1,high:null,low:99,close:null,volume:1.5},{timestamp:1792071000,open:'100',high:2,low:99,close:0,volume:-2}]);
  assert.deepEqual(plain(raw.splits),[{timestamp:1792071000,numerator:3,denominator:1}]);
  assert.equal(raw.requested_at,'2026-10-15T20:00:00Z');assert.equal(raw.fetched_at,'2026-10-15T20:00:01Z');
  assert.equal(raw.is_final,undefined);assert.equal(raw.rows[0].fecha,undefined);
});

test('empty and truncated Yahoo quote arrays reach the server as null fields rather than invented values',()=>{
  const h=harness(),body=yahoo('AAPL',{quote:{open:[],close:[null]}});
  const raw=h.ctx.msParseYahoo_(response(body),{ticker:'AAPL'},'request','fetch');
  assert.equal(raw.rows.length,2);assert.equal(raw.rows[0].open,null);assert.equal(raw.rows[1].close,null);
  assert.throws(()=>h.ctx.msParseYahoo_(response('not JSON'),{ticker:'AAPL'}),/JSON no válida/);
  assert.throws(()=>h.ctx.msParseYahoo_(response({},429),{ticker:'AAPL'}),/Yahoo HTTP 429/);
});

test('one invocation processes at most 20 tickers as four groups of five with one RPC per group',()=>{
  const h=harness();h.prepare();h.ctx.actualizarMarketScanner();
  const downloads=h.events.filter(e=>e.op==='yahoo'),uploads=h.events.filter(e=>e.op==='rpc');
  assert.equal(downloads.length,4);assert.equal(uploads.length,4);
  for(const group of downloads){assert.equal(group.requests.length,5);assert.ok(group.requests.every(r=>r.url.includes('range=5d')&&!r.url.includes('range=3y')));}
  for(const group of uploads){assert.equal(group.payload.p_batch.length,5);assert.equal(group.url,'https://example.supabase.co/rest/v1/rpc/market_ingest_recent');}
  assert.equal(h.ctx.msGetJob_().cursor,20);assert.equal(h.ctx.msGetJob_().completed,20);
  const reads=h.events.filter(e=>e.op==='read');assert.deepEqual(reads.map(e=>[e.row,e.col,e.height,e.width]),[[2,1,250,1]]);
  assert.equal(h.triggers.find(t=>t.handler==='continuarActualizacion').minutes,1);
  assert.ok(h.events.findIndex(e=>e.op==='trigger')<h.events.findIndex(e=>e.op==='yahoo'));
});

test('a slow download stops after its current group and leaves the next cursor resumable',()=>{
  const h=harness({yahooCost:55000});h.prepare();h.ctx.actualizarMarketScanner();
  assert.equal(h.events.filter(e=>e.op==='yahoo').length,1);assert.equal(h.ctx.msGetJob_().cursor,5);
  h.ctx.continuarActualizacion();assert.equal(h.ctx.msGetJob_().cursor,10);
});

test('server FINAL and PROVISIONAL statuses are displayed without Google recomputing finality',()=>{
  for(const [now,status] of [['2026-10-15T14:00:00Z','FINAL'],['2026-10-15T23:00:00Z','PROVISIONAL']]){
    const h=harness({now,rpcResponse:payload=>response({version:2,results:payload.map(p=>serverResult(p.ticker,status))})});h.prepare();h.tailJob();h.ctx.actualizarMarketScanner();
    assert.equal(h.cell(247,13),status);assert.equal(h.ctx.msGetJob_().status,'COMPLETADO');
  }
});

test('all server decisions and reasons survive transport; rejected/pending values preserve displayed prices',()=>{
  const statuses=['FINAL','PROVISIONAL','RECHAZADO','PENDIENTE_DE_ACTUALIZAR','REEMPLAZO_PENDIENTE'];
  const h=harness({rpcResponse:payload=>response({version:2,results:payload.map((p,n)=>serverResult(p.ticker,statuses[n],{reason:'decisión SQL',current:n<2?serverResult(p.ticker).current:null}))})});
  h.prepare();h.tailJob();for(let row=247;row<=251;row++){h.putCell(row,7,777);h.putCell(row,12,'earlier');}
  h.ctx.actualizarMarketScanner();
  statuses.forEach((status,n)=>assert.equal(h.cell(n+247,13),status+' · decisión SQL'));
  for(let row=249;row<=251;row++){assert.equal(h.cell(row,7),777);assert.equal(h.cell(row,12),'earlier');}
  const job=h.ctx.msGetJob_();assert.equal(job.completed,247);assert.equal(job.rejected.length,1);assert.equal(job.pending.length,2);assert.equal(job.status,'COMPLETADO CON RECHAZOS');
  assert.equal(h.events.filter(e=>e.op==='rpc').length,1);
});

test('Yahoo failure keeps ticker positions while successful payloads and out-of-order server results map by ticker',()=>{
  const h=harness({yahooResponse:(request,n,group)=>group===1&&n===1?response({},429):response(yahoo(decodeURIComponent(/chart\/([^?]+)/.exec(request.url)[1]))),
    rpcResponse:payload=>response({version:2,results:payload.map(p=>serverResult(p.ticker)).reverse()})});
  h.prepare();const job=h.tailJob(),failed=h.ctx.msUniverse_()[246].ticker;h.ctx.actualizarMarketScanner();
  assert.equal(h.ctx.msGetJob_().round,1);assert.deepEqual(plain(h.ctx.msGetJob_().work),[failed]);assert.equal(h.cell(248,13),'ERROR: Yahoo HTTP 429');
  assert.equal(h.events.find(e=>e.op==='rpc').payload.p_batch.length,4);
  h.ctx.continuarActualizacion();assert.equal(h.ctx.msGetJob_().completed,250);assert.equal(h.ctx.msGetJob_().status,'COMPLETADO');
});

test('RPC transport failures preserve old values, retry twice, then report incomplete without exposing response bodies',()=>{
  const h=harness({rpcResponse:()=>response('sb_secret_MUST_NOT_APPEAR',503)});h.prepare();h.tailJob();h.putCell(247,7,777);h.putCell(247,12,'earlier');
  h.ctx.actualizarMarketScanner();h.ctx.continuarActualizacion();h.ctx.continuarActualizacion();
  assert.equal(h.cell(247,7),777);assert.equal(h.cell(247,12),'earlier');assert.match(h.cell(247,13),/ERROR: Supabase RPC HTTP 503/);
  const job=h.ctx.msGetJob_();assert.equal(job.status,'INCOMPLETO');assert.equal(job.failed.length,5);assert.equal(job.completed,245);
  assert.ok(!JSON.stringify([h.logs,h.cell(247,13),job]).includes('MUST_NOT_APPEAR'));assert.ok(!h.triggers.some(t=>t.handler==='continuarActualizacion'));
});

test('a Sheets interruption leaves the group checkpoint unchanged and its RPC safe to replay',()=>{
  const h=harness();h.prepare();h.interruptNextWrite();
  assert.throws(()=>h.ctx.actualizarMarketScanner(),/simulated hard interruption/);assert.equal(h.ctx.msGetJob_().cursor,0);assert.equal(h.ctx.msGetJob_().completed,0);
  assert.ok(h.triggers.some(t=>t.handler==='continuarActualizacion'));
  const first=h.events.find(e=>e.op==='rpc').payload.p_batch.map(p=>p.ticker);h.reset();h.ctx.continuarActualizacion();
  assert.deepEqual(h.events.find(e=>e.op==='rpc').payload.p_batch.map(p=>p.ticker),first);assert.equal(h.ctx.msGetJob_().completed,20);
  for(let n=0;n<h.events.length;n++)if(h.events[n].op==='checkpoint'&&h.events[n].saved.cursor>0)assert.ok(h.events.slice(0,n).some(e=>e.op==='flush'));
});

test('pause finishes only the active group, then a manual restart resumes the saved cursor',()=>{
  let stopped=false;const h=harness({onYahoo:({ctx})=>{if(!stopped){stopped=true;ctx.detenerTemporizadores();}}});h.prepare();h.ctx.actualizarMarketScanner();
  assert.equal(h.ctx.msGetJob_().cursor,5);assert.equal(h.props.get('MS_PAUSED'),'true');assert.equal(h.events.filter(e=>e.op==='rpc').length,1);
  h.reset();h.ctx.continuarActualizacion();assert.equal(h.events.filter(e=>e.op==='rpc').length,0);
  h.ctx.actualizarMarketScanner();assert.equal(h.ctx.msGetJob_().cursor,25);assert.equal(h.props.get('MS_PAUSED'),'false');
});

test('stop works while a downloader owns the lock and removes only scanner/retired timers',()=>{
  const h=harness();h.prepare();
  for(const handler of ['actualizarMarketScanner','continuarActualizacion','continuarHistorial','iniciarHistorialSemanal','_procesarLote','unrelated'])h.triggers.push({handler,getHandlerFunction:()=>handler});
  h.setLocked(false);h.ctx.detenerTemporizadores();
  assert.equal(h.props.get('MS_PAUSED'),'true');assert.deepEqual(h.triggers.map(t=>t.handler),['unrelated']);
});

test('install replaces old timers with hourly downloads and one-minute continuation, without a weekly history timer',()=>{
  const h=harness();h.prepare();h.tailJob();
  for(const handler of ['actualizarMarketScanner','continuarActualizacion','continuarHistorial','iniciarHistorialSemanal','guardarSnapshotDiario'])h.triggers.push({handler,getHandlerFunction:()=>handler});
  h.ctx.instalarTemporizadores();
  assert.deepEqual(h.triggers.map(t=>[t.handler,t.hours??null,t.minutes??null]),[['actualizarMarketScanner',1,null],['continuarActualizacion',null,1]]);
});

test('timer window is only a weekday/hour filter; manual requests still run on weekends',()=>{
  const h=harness({now:'2026-10-17T16:00:00Z'});h.prepare();h.ctx.actualizarMarketScanner({triggerUid:'timer'});
  assert.equal(h.events.filter(e=>e.op==='yahoo').length,0);h.ctx.actualizarMarketScanner();assert.equal(h.events.filter(e=>e.op==='yahoo').length,4);
  assert.equal(h.ctx.msTimerWindow_(new Date('2026-12-25T15:00:00Z')),true,'exchange holidays are decided by Supabase');
});

test('connection probe sends an empty authenticated RPC and rejects incompatible server envelopes',()=>{
  const h=harness();h.ctx.comprobarConexion();const request=h.events.find(e=>e.op==='rpc');
  assert.deepEqual(request.payload,{p_batch:[]});assert.equal(request.headers.apikey,'sb_secret_TEST_ONLY');assert.equal(request.headers.Authorization,undefined);
  assert.equal(h.events.filter(e=>e.op==='yahoo'||e.op==='write').length,0);
  const bad=harness({rpcResponse:()=>response({version:1,results:[]})});assert.throws(()=>bad.ctx.comprobarConexion(),/incompatible/);
  h.props.set('SUPABASE_WRITE_KEY','sb_publishable_READ_ONLY');assert.throws(()=>h.ctx.comprobarConexion(),/privada/);
});

test('RPC protocol errors cannot mix, duplicate or silently omit ticker results',()=>{
  for(const results of [[],[serverResult('WRONG')],[serverResult('AAPL','UNKNOWN')],[serverResult('AAPL','FINAL',{current:{fecha:'2026-10-15'}})]]){
    const h=harness({rpcResponse:()=>response({version:2,results})});assert.throws(()=>h.ctx.msIngestRecent_([{ticker:'AAPL'}]),/Supabase:/);
  }
  const h=harness({rpcResponse:()=>response({version:2,results:[serverResult('AAPL'),serverResult('AAPL')]})});
  assert.throws(()=>h.ctx.msIngestRecent_([{ticker:'AAPL'},{ticker:'MSFT'}]),/inconsistentes/);
});

test('progress reads the small Precios table and reports server-owned validation',()=>{
  const h=harness();h.prepare();const coverage=h.ctx.verEstadoMarketScanner();assert.equal(coverage.length,250);
  assert.deepEqual(h.events.filter(e=>e.op==='read').map(e=>[e.height,e.width]),[[250,14]]);
  assert.match(h.logs.at(-1),/"validacion":"Supabase"/);
});
