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
  const base = Date.parse(options.now || '2026-10-15T22:00:00Z'); let elapsed=0, locked=true, quickLocked=true, failWrite=false;
  const props = new Map([['SUPABASE_URL','https://example.supabase.co'],['SUPABASE_WRITE_KEY','sb_secret_TEST_ONLY']]);
  const events=[],logs=[],triggers=[],cells=new Map(),formulas=new Map(),menus=[];
  let rows=200, columns=options.columns||21, exists=false, ctx;
  const record = (op,extra={}) => events.push({op,at:elapsed,...extra});
  class Clock extends Date { constructor(...args){super(...(args.length?args:[base+elapsed]));} static now(){return base+elapsed;} }
  const key=(row,col)=>row+','+col;
  const sheet={getMaxRows:()=>rows,getMaxColumns:()=>columns,getLastRow:()=>Math.max(0,...[...cells.entries()].filter(([,v])=>v!=='').map(([k])=>Number(k.split(',')[0]))),
    insertRowsAfter(after,count){assert.equal(after,rows);rows+=count;record('expand',{rows});},setFrozenRows(n){record('freeze',{n});},
    insertColumnsAfter(after,count){
      assert.ok(after>=1&&after<=columns);
      for(const map of [cells,formulas]){
        const entries=[...map];map.clear();
        for(const [address,value] of entries){const [row,col]=address.split(',').map(Number);map.set(key(row,col>after?col+count:col),value);}
      }
      columns+=count;record('expand-columns',{columns,after,count});
    },
    getRange(row,col=1,height=1,width=1){
      if(typeof row==='string'){
        const match=/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(row);assert.ok(match);
        const column=s=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
        col=column(match[1]);width=column(match[3])-col+1;row=Number(match[2]);height=Number(match[4])-row+1;
      }
      assert.ok(row+height-1<=rows,'Precios range stays bounded');
      assert.ok(col+width-1<=columns,'Precios columns stay bounded');
      const details={row,col,height,width};
      return {getValues(){record('read',details);return Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>cells.get(key(row+y,col+x))??''));},
        setValues(values){
          if(failWrite){failWrite=false;throw new Error('simulated hard interruption');}
          record('write',details);assert.equal(values.length,height);
          values.forEach((line,y)=>{assert.equal(line.length,width);line.forEach((value,x)=>{cells.set(key(row+y,col+x),value);formulas.delete(key(row+y,col+x));});});return this;
        },
        setValue(value){return this.setValues([[value]]);},setFormulas(values){record('formulas',details);values.forEach((line,y)=>line.forEach((v,x)=>formulas.set(key(row+y,col+x),v)));return this;},
        setNumberFormat(){return this;},setBackground(){return this;},setFontColor(){return this;},setFontWeight(){return this;}};
    }};
  const book={getId:()=> 'test-sheet-v2',getSpreadsheetTimeZone:()=>options.sheetTimeZone||'America/New_York',getSheetByName(name){record('sheet',{name});assert.equal(name,'Precios','Google must never access the archived history');return exists?sheet:null;},
    insertSheet(name){assert.equal(name,'Precios');exists=true;return sheet;}};
  let yahooGroups=0,rpcGroups=0;
  const properties={getProperty:k=>props.get(k)??null,setProperty(k,v){props.set(k,v);if(k==='MS_JOB_RECENT_V2')record('checkpoint',{saved:JSON.parse(v)});}};
  ctx=vm.createContext({Date:Clock,console:{log:v=>logs.push(v)},PropertiesService:{getScriptProperties:()=>properties},
    LockService:{getScriptLock:()=>({tryLock:()=>locked,releaseLock(){}}),
      getDocumentLock:()=>options.documentLockNull?null:({tryLock:()=>quickLocked,releaseLock(){record('quick-unlock');}}),
      getUserLock:()=>({tryLock:()=>quickLocked,releaseLock(){record('user-unlock');}})},
    SpreadsheetApp:{getActiveSpreadsheet:()=>book,openById:id=>{assert.equal(id,book.getId());record('open');return book;},flush(){record('flush');},
      getUi:()=>({createMenu:()=>({addItem(label,fn){menus.push({label,fn});return this;},addSeparator(){return this;},addToUi(){}})})},
    Utilities:{formatDate(date,timeZone,pattern){
      const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value]));
      if(pattern==='HH')return p.hour;
      const day=`${p.year}-${p.month}-${p.day}`;
      if(pattern==="yyyy-MM-dd'T'HH:mm:ss")return `${day}T${p.hour}:${p.minute}:${p.second}`;
      assert.equal(pattern,'yyyy-MM-dd');return day;
    }},
    ScriptApp:{getProjectTriggers:()=>triggers.slice(),deleteTrigger:t=>triggers.splice(triggers.indexOf(t),1),
      newTrigger:handler=>({handler,timeBased(){return this;},everyMinutes(n){this.minutes=n;return this;},everyHours(n){this.hours=n;return this;},create(){const trigger={handler,minutes:this.minutes,hours:this.hours,getHandlerFunction:()=>handler};triggers.push(trigger);record('trigger',{handler,minutes:this.minutes,hours:this.hours});return trigger;}})},
    UrlFetchApp:{fetchAll(requests){yahooGroups++;record('yahoo',{requests:plain(requests)});elapsed+=options.yahooCost||0;
      if(options.onYahoo)options.onYahoo({ctx,props});
      if(options.yahooThrow)throw new Error('external transport internals');
      return requests.map((request,n)=>options.yahooResponse?options.yahooResponse(request,n,yahooGroups):response(yahoo(decodeURIComponent(/chart\/([^?]+)/.exec(request.url)[1]))));},
      fetch(url,opts){rpcGroups++;const payload=JSON.parse(opts.payload);record('rpc',{url,payload,headers:plain(opts.headers)});elapsed+=options.rpcCost||0;
        if(options.rpcResponse)return options.rpcResponse(payload.p_batch,rpcGroups,{ctx,props,url});
        const isSheet=url.endsWith('/market_ingest_sheet_quotes');
        return response({version:isSheet?3:2,results:payload.p_batch.map(item=>serverResult(item.ticker,isSheet?'PROVISIONAL':'FINAL'))});}}
  });
  for(const file of ['Universe.gs','Yahoo.gs','Storage.gs','Code.gs'])vm.runInContext(fs.readFileSync(path.join(root,'apps-script',file),'utf8'),ctx,{filename:file});
  return {ctx,props,events,logs,triggers,menus,cells,formulas,sheet,book,
    prepare(){ctx.prepararMarketScanner();events.length=0;},
    reset(){events.length=0;},setLocked(value){locked=value;},setQuickLocked(value){quickLocked=value;},interruptNextWrite(){failWrite=true;},
    cell:(row,col)=>cells.get(key(row,col))??'',putCell:(row,col,value)=>cells.set(key(row,col),value),
    seedQuotes(){for(let n=0;n<250;n++){const row=n+2;cells.set(key(row,3),new Clock('2026-10-15T19:59:00Z'));for(const [col,value] of [[4,101],[5,106],[6,99],[7,104],[8,1100],[9,103],[22,15]])cells.set(key(row,col),value);}},
    legacy(width=21){exists=true;rows=251;columns=width;const headers=plain(vm.runInContext('MS_HEADERS.Precios.slice(0,21)',ctx));headers[11]='Actualizado';headers.forEach((v,n)=>cells.set(key(1,n+1),v));ctx.msUniverse_().forEach((c,n)=>cells.set(key(n+2,1),c.ticker));},
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
  assert.equal(h.sheet.getMaxColumns(),25);assert.equal(h.cell(1,12),'Enviado');
  assert.equal(h.formulas.get('2,3'),'=IFERROR(GOOGLEFINANCE("NASDAQ:NVDA","tradetime"),"")');
  assert.equal([...h.formulas.values()].filter(formula=>formula.includes('GOOGLEFINANCE')).length,2000);
  assert.ok([...h.formulas.values()].every(formula=>!formula.includes('NOW(')));
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
    assert.equal(h.cell(247,23),status);assert.equal(h.ctx.msGetJob_().status,'COMPLETADO');
  }
});

test('all server decisions and reasons survive transport; rejected/pending values preserve displayed prices',()=>{
  const statuses=['FINAL','PROVISIONAL','RECHAZADO','PENDIENTE_DE_ACTUALIZAR','REEMPLAZO_PENDIENTE'];
  const h=harness({rpcResponse:payload=>response({version:2,results:payload.map((p,n)=>serverResult(p.ticker,statuses[n],{reason:'decisión SQL',current:n<2?serverResult(p.ticker).current:null}))})});
  h.prepare();h.tailJob();for(let row=247;row<=251;row++){h.putCell(row,7,777);h.putCell(row,12,'earlier');}
  h.ctx.actualizarMarketScanner();
  statuses.forEach((status,n)=>assert.equal(h.cell(n+247,23),status+' · decisión SQL'));
  for(let row=249;row<=251;row++){assert.equal(h.cell(row,7),777);assert.equal(h.cell(row,12),'earlier');}
  const job=h.ctx.msGetJob_();assert.equal(job.completed,247);assert.equal(job.rejected.length,1);assert.equal(job.pending.length,2);assert.equal(job.status,'COMPLETADO CON RECHAZOS');
  assert.equal(h.events.filter(e=>e.op==='rpc').length,1);
});

test('Yahoo failure keeps ticker positions while successful payloads and out-of-order server results map by ticker',()=>{
  const h=harness({yahooResponse:(request,n,group)=>group===1&&n===1?response({},429):response(yahoo(decodeURIComponent(/chart\/([^?]+)/.exec(request.url)[1]))),
    rpcResponse:payload=>response({version:2,results:payload.map(p=>serverResult(p.ticker)).reverse()})});
  h.prepare();const job=h.tailJob(),failed=h.ctx.msUniverse_()[246].ticker;h.ctx.actualizarMarketScanner();
  assert.equal(h.ctx.msGetJob_().round,1);assert.deepEqual(plain(h.ctx.msGetJob_().work),[failed]);assert.equal(h.cell(248,23),'ERROR: Yahoo HTTP 429');
  assert.equal(h.events.find(e=>e.op==='rpc').payload.p_batch.length,4);
  h.ctx.continuarActualizacion();assert.equal(h.ctx.msGetJob_().completed,250);assert.equal(h.ctx.msGetJob_().status,'COMPLETADO');
});

test('RPC transport failures preserve old values, retry twice, then report incomplete without exposing response bodies',()=>{
  const h=harness({rpcResponse:()=>response('sb_secret_MUST_NOT_APPEAR',503)});h.prepare();h.tailJob();h.putCell(247,7,777);h.putCell(247,12,'earlier');
  h.ctx.actualizarMarketScanner();h.ctx.continuarActualizacion();h.ctx.continuarActualizacion();
  assert.equal(h.cell(247,7),777);assert.equal(h.cell(247,12),'earlier');assert.match(h.cell(247,23),/ERROR: Supabase RPC HTTP 503/);
  const job=h.ctx.msGetJob_();assert.equal(job.status,'INCOMPLETO');assert.equal(job.failed.length,5);assert.equal(job.completed,245);
  assert.ok(!JSON.stringify([h.logs,h.cell(247,23),job]).includes('MUST_NOT_APPEAR'));assert.ok(!h.triggers.some(t=>t.handler==='continuarActualizacion'));
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
  for(const handler of ['actualizarCotizacionesAhora','actualizarMarketScanner','continuarActualizacion','continuarHistorial','iniciarHistorialSemanal','_procesarLote','unrelated'])h.triggers.push({handler,getHandlerFunction:()=>handler});
  h.setLocked(false);h.ctx.detenerTemporizadores();
  assert.equal(h.props.get('MS_PAUSED'),'true');assert.deepEqual(h.triggers.map(t=>t.handler),['unrelated']);
});

test('install replaces duplicate timers with five-minute snapshots, hourly Yahoo and one-minute continuation',()=>{
  const h=harness();h.prepare();h.tailJob();
  for(const handler of ['actualizarCotizacionesAhora','actualizarCotizacionesAhora','actualizarMarketScanner','continuarActualizacion','continuarHistorial','iniciarHistorialSemanal','guardarSnapshotDiario'])h.triggers.push({handler,getHandlerFunction:()=>handler});
  h.ctx.instalarTemporizadores();h.ctx.instalarTemporizadores();
  assert.deepEqual(h.triggers.map(t=>[t.handler,t.hours??null,t.minutes??null]),[['actualizarCotizacionesAhora',null,5],['actualizarMarketScanner',1,null],['continuarActualizacion',null,1]]);
});

test('timer window is only a weekday/hour filter; manual requests still run on weekends',()=>{
  const h=harness({now:'2026-10-17T16:00:00Z'});h.prepare();h.ctx.actualizarMarketScanner({triggerUid:'timer'});
  assert.equal(h.events.filter(e=>e.op==='yahoo').length,0);h.ctx.actualizarMarketScanner();assert.equal(h.events.filter(e=>e.op==='yahoo').length,4);
  assert.equal(h.ctx.msTimerWindow_(new Date('2026-12-25T15:00:00Z')),true,'exchange holidays are decided by Supabase');
});

test('connection probe sends both empty authenticated RPCs and rejects incompatible server envelopes',()=>{
  const h=harness();h.ctx.comprobarConexion();const request=h.events.find(e=>e.op==='rpc');
  assert.deepEqual(request.payload,{p_batch:[]});assert.equal(request.headers.apikey,'sb_secret_TEST_ONLY');assert.equal(request.headers.Authorization,undefined);
  assert.deepEqual(h.events.filter(e=>e.op==='rpc').map(e=>e.url.split('/').at(-1)),['market_ingest_recent','market_ingest_sheet_quotes']);
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
  assert.deepEqual(h.events.filter(e=>e.op==='read').map(e=>[e.height,e.width]),[[250,24]]);
  assert.match(h.logs.at(-1),/"validacion":"Supabase"/);
});

test('preparation migrates the existing 21 columns without reimporting or reading history',()=>{
  const h=harness();h.legacy();h.putCell(2,12,'2026-10-15T22:00:00Z');h.putCell(2,13,'FINAL');h.putCell(2,14,500);
  h.ctx.prepararMarketScanner();
  assert.equal(h.sheet.getMaxColumns(),25);assert.equal(h.cell(2,23),'FINAL');assert.equal(h.cell(2,24),'2026-10-15T22:00:00Z');
  assert.equal(h.cell(2,12),'');assert.equal(h.cell(2,13),'PENDIENTE DE SUBIR');assert.equal(h.cell(2,14),500);
  assert.equal(h.formulas.get('2,7'),'=IFERROR(GOOGLEFINANCE("NASDAQ:NVDA","price"),"")');
  h.putCell(2,12,'quick time');h.putCell(2,13,'PROVISIONAL');h.ctx.prepararMarketScanner();
  assert.equal(h.cell(2,12),'quick time');assert.equal(h.cell(2,13),'PROVISIONAL');assert.equal(h.cell(2,23),'FINAL');
  assert.equal(h.events.filter(e=>e.op==='yahoo'||e.op==='rpc').length,0);
});

test('preparation migrates the shipped template with its W:X guide and preserves the guide on repeated runs',()=>{
  for(const width of [24,26]){
    const h=harness();h.legacy(width);
    h.putCell(1,23,'Market Scanner');h.putCell(2,23,'Uso');h.putCell(2,24,'Instrucciones originales');
    h.putCell(74,23,'Fuente ETF LABU');h.putCell(74,24,'https://example.com/original-source');
    h.putCell(2,12,'2026-10-16T16:29:48Z');h.putCell(2,13,'PROVISIONAL');h.putCell(2,14,500);
    if(width===26)h.putCell(90,26,'Preservar contenido a la derecha');
    h.ctx.prepararMarketScanner();
    assert.equal(h.sheet.getMaxColumns(),width+4);assert.equal(h.cell(1,26),'Market Scanner');
    assert.equal(h.cell(2,26),'Uso');assert.equal(h.cell(2,27),'Instrucciones originales');
    assert.equal(h.cell(74,26),'Fuente ETF LABU');assert.equal(h.cell(74,27),'https://example.com/original-source');
    if(width===26)assert.equal(h.cell(90,29),'Preservar contenido a la derecha');
    assert.equal(h.cell(1,23),'Estado historial');assert.equal(h.cell(1,24),'Historial comprobado');
    assert.equal(h.cell(2,23),'PROVISIONAL');assert.equal(h.cell(2,24),'2026-10-16T16:29:48Z');assert.equal(h.cell(2,14),500);
    assert.equal(h.formulas.get('2,7'),'=IFERROR(GOOGLEFINANCE("NASDAQ:NVDA","price"),"")');
    h.putCell(2,12,'quick upload');h.putCell(2,13,'PROVISIONAL');h.reset();h.ctx.prepararMarketScanner();
    assert.equal(h.events.filter(e=>e.op==='expand-columns').length,0);assert.equal(h.cell(1,26),'Market Scanner');
    assert.equal(h.cell(2,12),'quick upload');assert.equal(h.cell(2,24),'2026-10-16T16:29:48Z');
    assert.equal(h.events.filter(e=>e.op==='rpc'||e.op==='yahoo').length,0);
  }
});

test('template migration still rejects unknown headers and mismatched tickers before shifting columns',()=>{
  for(const invalid of ['unknown-guide','wrong-header','wrong-ticker']){
    const h=harness();h.legacy(26);h.putCell(1,23,'Market Scanner');
    if(invalid==='unknown-guide')h.putCell(1,23,'Contenido ajeno');
    if(invalid==='wrong-header')h.putCell(1,7,'Otra columna');
    if(invalid==='wrong-ticker')h.putCell(2,1,'WRONG');
    h.reset();assert.throws(()=>h.ctx.prepararMarketScanner(),/Precios:/);
    assert.equal(h.events.filter(e=>['write','formulas','expand-columns','rpc','yahoo'].includes(e.op)).length,0);
    assert.equal(h.sheet.getMaxColumns(),26);
  }
});

test('Google Finance identifiers disambiguate all exchanges, Berkshire class and the USD ETF',()=>{
  const h=harness();h.prepare();const companies=h.ctx.msUniverse_();
  assert.equal(h.ctx.msGoogleSymbol_(companies.find(c=>c.ticker==='BRK-B')),'NYSE:BRK.B');
  assert.equal(h.ctx.msGoogleSymbol_(companies.find(c=>c.ticker==='USD')),'NYSEARCA:USD');
  assert.match(h.ctx.msGoogleSymbol_(companies.find(c=>c.exchange==='CBOEBZX')),/^BATS:/);
  assert.equal(h.ctx.msGoogleSymbol_({ticker:'QQQ',exchange:'NASDAQ'}),'NASDAQ:QQQ');
  assert.throws(()=>h.ctx.msGoogleSymbol_({ticker:'X',exchange:'UNKNOWN'}),/equivalencia/);
  const usd=companies.findIndex(c=>c.ticker==='USD')+2;
  assert.equal(h.formulas.get(usd+',22'),'=IFERROR(GOOGLEFINANCE("NYSEARCA:USD","datadelay"),"")');
});

test('only SOXS tradetime uses a direct auxiliary-cell reference while all other provider formulas remain native',()=>{
  const h=harness();h.prepare();const companies=h.ctx.msUniverse_();
  const soxs=companies.findIndex(c=>c.ticker==='SOXS')+2,aapl=companies.findIndex(c=>c.ticker==='AAPL')+2;
  assert.equal(h.cell(1,25),'SOXS hora UTC');
  assert.equal(h.formulas.get(soxs+',3'),`=IFERROR(MARKET_SCANNER_UTC_TIME(Y${soxs}),"")`);
  assert.equal(h.formulas.get(soxs+',25'),'=IFERROR(GOOGLEFINANCE("NYSEARCA:SOXS","tradetime"),"")');
  assert.equal(h.formulas.get(aapl+',3'),'=IFERROR(GOOGLEFINANCE("NASDAQ:AAPL","tradetime"),"")');
  assert.equal(h.formulas.get(soxs+',7'),'=IFERROR(GOOGLEFINANCE("NYSEARCA:SOXS","price"),"")');
  assert.equal([...h.formulas.values()].filter(value=>value.includes('MARKET_SCANNER_UTC_TIME')).length,1);
  assert.equal([...h.formulas.values()].filter(value=>value.includes('GOOGLEFINANCE')).length,2000);
  assert.ok(h.menus.every(item=>item.fn!=='MARKET_SCANNER_UTC_TIME'));
});

test('SOXS UTC wall times preserve the true instant through summer, winter and both New York DST boundaries',()=>{
  const h=harness();
  const cases=[
    ['2026-10-17T00:00:00Z','2026-10-16T20:00:00.000Z'],
    ['2026-12-16T02:00:00Z','2026-12-15T21:00:00.000Z'],
    ['2026-03-07T02:00:00Z','2026-03-06T21:00:00.000Z'],
    ['2026-03-10T00:00:00Z','2026-03-09T20:00:00.000Z'],
    ['2026-10-31T00:00:00Z','2026-10-30T20:00:00.000Z'],
    ['2026-11-03T02:00:00Z','2026-11-02T21:00:00.000Z']
  ];
  for(const [sheetDate,instant]of cases){
    const actual=h.ctx.MARKET_SCANNER_UTC_TIME(new h.ctx.Date(sheetDate));
    assert.equal(actual.toISOString(),instant);
    assert.equal(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(actual),'16');
  }
  assert.equal(h.events.filter(e=>e.op==='rpc'||e.op==='yahoo'||e.op==='write').length,0);
});

test('SOXS UTC interpretation uses the sheet timezone and never clamps a genuinely future source time',()=>{
  for(const [sheetTimeZone,input]of [['UTC','2026-10-16T20:00:00Z'],['America/New_York','2026-10-17T00:00:00Z'],['America/Los_Angeles','2026-10-17T03:00:00Z']]){
    const h=harness({sheetTimeZone});
    assert.equal(h.ctx.MARKET_SCANNER_UTC_TIME(new h.ctx.Date(input)).toISOString(),'2026-10-16T20:00:00.000Z');
  }
  const h=harness({now:'2026-10-16T20:05:00Z'});h.prepare();h.seedQuotes();
  const soxs=h.ctx.msUniverse_().findIndex(c=>c.ticker==='SOXS')+2;
  const future=h.ctx.MARKET_SCANNER_UTC_TIME(new h.ctx.Date('2026-10-18T00:00:00Z'));
  assert.equal(future.toISOString(),'2026-10-17T20:00:00.000Z');
  h.putCell(soxs,3,future);h.ctx.actualizarCotizacionesAhora();
  const raw=h.events.find(e=>e.op==='rpc').payload.p_batch.find(item=>item.ticker==='SOXS');
  assert.equal(raw.source_quote_at,'2026-10-17T20:00:00.000Z');
  assert.equal(raw.fetched_at,'2026-10-16T20:05:00.000Z');
});

test('missing SOXS provider times fail the custom formula and stay missing when uploaded',()=>{
  const h=harness();
  for(const input of [null,undefined,'','#N/A','2026-10-16T20:00:00Z',0,new h.ctx.Date('invalid')])
    assert.throws(()=>h.ctx.MARKET_SCANNER_UTC_TIME(input),/hora válida del proveedor/);
  h.prepare();h.seedQuotes();const soxs=h.ctx.msUniverse_().findIndex(c=>c.ticker==='SOXS')+2;
  h.putCell(soxs,3,'');h.ctx.actualizarCotizacionesAhora();
  assert.equal(h.events.find(e=>e.op==='rpc').payload.p_batch.find(item=>item.ticker==='SOXS').source_quote_at,'');
});

test('UTC auxiliary setup appends safely, preserves notes and reuses its unique header beyond 64 columns',()=>{
  for(const width of [34,70]){
    const h=harness();h.legacy(width);
    plain(vm.runInContext('MS_HEADERS.Precios',h.ctx)).forEach((value,n)=>h.putCell(1,n+1,value));
    h.putCell(1,26,'Market Scanner');h.putCell(74,27,'Original guide');h.putCell(90,width,'Contenido existente');
    h.ctx.prepararMarketScanner();assert.equal(h.sheet.getMaxColumns(),width+1);assert.equal(h.cell(1,width+1),'SOXS hora UTC');
    assert.equal(h.cell(74,27),'Original guide');assert.equal(h.cell(90,width),'Contenido existente');
    h.reset();h.ctx.prepararMarketScanner();
    assert.equal(h.sheet.getMaxColumns(),width+1);assert.equal(h.events.filter(e=>e.op==='expand-columns').length,0);
    assert.ok(h.events.filter(e=>e.op==='read'&&e.row===1).every(e=>e.width<=64));
    h.putCell(1,25,'SOXS hora UTC');h.reset();
    assert.throws(()=>h.ctx.prepararMarketScanner(),/SOXS hora UTC duplicado/);
    assert.equal(h.events.filter(e=>['write','formulas','expand-columns','rpc','yahoo'].includes(e.op)).length,0);
  }
});

test('the primary menu action uploads all 250 native quotes with one read and one RPC',()=>{
  const h=harness({rpcCost:250});h.prepare();h.seedQuotes();h.ctx.onOpen();
  assert.equal(h.menus.find(item=>item.label.includes('aplicación ahora')).fn,'actualizarCotizacionesAhora');
  const before=[...h.formulas.entries()],report=h.ctx.actualizarCotizacionesAhora();
  assert.equal(report.instrumentos,250);assert.equal(report.aceptados,250);assert.equal(report.pendientes,0);assert.equal(report.segundos,0.25);
  assert.equal(h.events.filter(e=>e.op==='yahoo').length,0);
  const reads=h.events.filter(e=>e.op==='read');assert.deepEqual(reads.map(e=>[e.row,e.col,e.height,e.width]),[[2,1,250,24]]);
  const requests=h.events.filter(e=>e.op==='rpc');assert.equal(requests.length,1);
  assert.equal(requests[0].url,'https://example.supabase.co/rest/v1/rpc/market_ingest_sheet_quotes');
  assert.equal(requests[0].payload.p_batch.length,250);
  assert.deepEqual(requests[0].payload.p_batch[0],{ticker:'NVDA',source:'googlefinance',symbol:'NASDAQ:NVDA',currency:'USD',
    source_quote_at:'2026-10-15T19:59:00.000Z',open:101,high:106,low:99,close:104,volume:1100,previous_close:103,datadelay_minutes:15,fetched_at:'2026-10-15T22:00:00.000Z'});
  assert.deepEqual([...h.formulas.entries()],before,'snapshot uploads never replace native formulas');
  assert.deepEqual(h.events.filter(e=>e.op==='write').map(e=>[e.row,e.col,e.height,e.width]),[[2,12,250,3]]);
  assert.equal(h.ctx.msGetJob_(),null);assert.equal(h.triggers.length,0);
});

test('formula errors, missing fields, zero and malformed values reach SQL without client replacements',()=>{
  const h=harness();h.prepare();h.seedQuotes();h.putCell(2,3,'#N/A');h.putCell(2,4,'');h.putCell(2,5,'invalid');h.putCell(2,7,'');h.putCell(2,8,0);h.putCell(2,22,'#ERROR!');
  h.ctx.actualizarCotizacionesAhora();const first=h.events.find(e=>e.op==='rpc').payload.p_batch[0];
  assert.equal(first.source_quote_at,'#N/A');assert.equal(first.open,'');assert.equal(first.high,'invalid');assert.equal(first.close,'');assert.equal(first.volume,0);assert.equal(first.datadelay_minutes,'#ERROR!');
});

test('quick results map by ticker and preserve background details unless a repair is queued',()=>{
  const h=harness({rpcResponse:payload=>response({version:3,results:payload.map((p,n)=>serverResult(p.ticker,n===0?'PENDIENTE_DE_ACTUALIZAR':n===1?'RECHAZADO':'PROVISIONAL',
    {reason:n<2?'FALTAN_DATOS_PROVEEDOR':null,needs_replacement:n===2,history_count:500-n})).reverse()})});
  h.prepare();h.seedQuotes();for(let n=2;n<=251;n++){h.putCell(n,23,'FINAL');h.putCell(n,24,'history time');}
  const before=[...h.formulas.entries()],report=h.ctx.actualizarCotizacionesAhora();
  assert.equal(report.aceptados,248);assert.equal(report.pendientes,1);assert.equal(report.rechazados,1);
  assert.equal(h.cell(2,13),'PENDIENTE_DE_ACTUALIZAR · FALTAN_DATOS_PROVEEDOR');assert.equal(h.cell(2,14),500);assert.equal(h.cell(3,14),499);
  assert.equal(h.cell(2,23),'FINAL');assert.equal(h.cell(2,24),'history time');assert.equal(h.cell(4,23),'REEMPLAZO_PENDIENTE');assert.equal(h.cell(4,24),'2026-10-15T22:00:00.000Z');
  assert.deepEqual([...h.formulas.entries()],before);
  assert.deepEqual(h.events.filter(e=>e.op==='write').map(e=>[e.row,e.col,e.height,e.width]),[[2,12,250,3],[2,23,250,2]]);
});

test('Yahoo background updates history status and count without modifying formulas or the quick-upload result',()=>{
  const h=harness();h.prepare();h.seedQuotes();const before=[...h.formulas.entries()];h.putCell(247,12,'quick sent');h.putCell(247,13,'PROVISIONAL');h.tailJob();h.ctx.actualizarMarketScanner();
  assert.equal(h.cell(247,12),'quick sent');assert.equal(h.cell(247,13),'PROVISIONAL');assert.equal(h.cell(247,14),500);
  assert.equal(h.cell(247,23),'FINAL');assert.equal(h.cell(247,24),'2026-10-15T22:00:00.000Z');assert.deepEqual([...h.formulas.entries()],before);
  assert.ok(h.events.filter(e=>e.op==='write').every(e=>e.col===14||e.col===23));
});

test('quick transport failures mark every row and retain previous upload times and history details',()=>{
  const h=harness({rpcResponse:()=>response('sb_secret_MUST_NOT_APPEAR',503)});h.prepare();h.seedQuotes();h.putCell(2,12,'last sent');h.putCell(2,14,500);h.putCell(2,23,'FINAL');h.putCell(2,24,'history time');
  const before=[...h.formulas.entries()];assert.throws(()=>h.ctx.actualizarCotizacionesAhora(),/Supabase RPC HTTP 503/);
  assert.equal(h.cell(2,12),'last sent');assert.equal(h.cell(2,14),500);assert.equal(h.cell(2,23),'FINAL');assert.equal(h.cell(2,24),'history time');
  assert.match(h.cell(2,13),/^ERROR: Supabase RPC HTTP 503/);assert.match(h.cell(251,13),/^ERROR: Supabase RPC HTTP 503/);
  assert.deepEqual([...h.formulas.entries()],before);assert.ok(!JSON.stringify([h.logs,h.cell(2,13)]).includes('MUST_NOT_APPEAR'));
});

test('quick timer respects pause and New York hours while manual uploads remain available',()=>{
  const h=harness({now:'2026-10-17T16:00:00Z'});h.prepare();h.seedQuotes();h.ctx.actualizarCotizacionesAhora({triggerUid:'timer'});
  assert.equal(h.events.filter(e=>e.op==='rpc').length,0);
  h.ctx.instalarTemporizadores();h.ctx.detenerTemporizadores();h.ctx.actualizarCotizacionesAhora({triggerUid:'timer'});
  assert.equal(h.events.filter(e=>e.op==='rpc').length,0);assert.equal(h.triggers.length,0);
  h.ctx.actualizarCotizacionesAhora();assert.equal(h.events.filter(e=>e.op==='rpc').length,1);assert.equal(h.props.get('MS_PAUSED'),'true');
  for(const [instant,expected] of [['2026-10-16T12:59:00Z',false],['2026-10-16T13:00:00Z',true],['2026-10-17T00:59:00Z',true],['2026-10-17T01:00:00Z',false]])assert.equal(h.ctx.msTimerWindow_(new Date(instant)),expected);
});

test('quick snapshot detects changed ordering before posting and requires prepared columns',()=>{
  const h=harness();h.legacy();h.props.set('SPREADSHEET_ID',h.book.getId());assert.throws(()=>h.ctx.actualizarCotizacionesAhora(),/prepararMarketScanner/);
  h.prepare();h.putCell(2,1,'WRONG');h.reset();assert.throws(()=>h.ctx.actualizarCotizacionesAhora(),/Precios cambió/);
  assert.equal(h.events.filter(e=>e.op==='rpc'||e.op==='yahoo'||e.op==='write').length,0);
});

test('the v3 endpoint enforces a complete unique response before writing any success state',()=>{
  for(const envelope of [{version:2,results:[serverResult('AAPL')]},{version:3,results:[serverResult('WRONG')]},{version:3,results:[serverResult('AAPL','UNKNOWN')]}]){
    const h=harness({rpcResponse:()=>response(envelope)});assert.throws(()=>h.ctx.msIngestSheetQuotes_([{ticker:'AAPL'}]),/Supabase:/);
  }
  const h=harness({rpcResponse:()=>response({version:3,results:[serverResult('AAPL'),serverResult('AAPL')]})});
  assert.throws(()=>h.ctx.msIngestSheetQuotes_([{ticker:'AAPL'},{ticker:'MSFT'}]),/inconsistentes/);
});

test('quick uploads remain available while Yahoo owns ScriptLock and serialize only other quick uploads',()=>{
  const h=harness();h.prepare();h.seedQuotes();h.tailJob();const savedJob=h.props.get('MS_JOB_RECENT_V2');h.setLocked(false);
  assert.equal(h.ctx.actualizarCotizacionesAhora().aceptados,250);assert.equal(h.props.get('MS_JOB_RECENT_V2'),savedJob);
  assert.equal(h.events.filter(e=>e.op==='rpc').length,1);assert.equal(h.events.filter(e=>e.op==='quick-unlock').length,1);
  h.reset();h.setQuickLocked(false);
  assert.throws(()=>h.ctx.actualizarCotizacionesAhora(),/Ya hay un envío de cotizaciones en curso; espera a que termine/);
  assert.equal(h.events.filter(e=>e.op==='rpc'||e.op==='read'||e.op==='write').length,0);
});

test('quick uploads fall back to UserLock when a document lock is unavailable and release it on errors',()=>{
  const h=harness({documentLockNull:true,rpcResponse:()=>response({},503)});h.prepare();h.seedQuotes();
  assert.throws(()=>h.ctx.actualizarCotizacionesAhora(),/Supabase RPC HTTP 503/);
  assert.equal(h.events.filter(e=>e.op==='user-unlock').length,1);
});
