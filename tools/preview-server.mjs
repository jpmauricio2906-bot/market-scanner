/** Local read-only preview. --snapshot uses a captured history and never contacts Supabase. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const snapshot=process.argv.includes('--snapshot');
const snapshotFile=['history-250.json','history.json'].map(name=>path.join(root,'outputs/yahoo',name)).find(file=>fs.existsSync(file));
if(snapshot&&!snapshotFile)throw new Error('Download a Yahoo history capture before starting --snapshot.');
const history=snapshot?JSON.parse(fs.readFileSync(snapshotFile,'utf8')).rows.sort((a,b)=>a.ticker.localeCompare(b.ticker)||a.fecha.localeCompare(b.fecha)):[];
const types={'.html':'text/html','.js':'application/javascript','.json':'application/json','.csv':'text/csv','.css':'text/css'};
http.createServer((request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1:8765');
  if(snapshot&&url.pathname==='/__history'){
    let rows=history;
    const ticker=url.searchParams.get('ticker');
    if(ticker?.startsWith('eq.')) rows=rows.filter(r=>r.ticker===ticker.slice(3));
    const cursor=url.searchParams.get('or')?.match(/ticker\.gt\.([^,]+),and\(ticker\.eq\.[^,]+,fecha\.gt\.(\d{4}-\d{2}-\d{2})/);
    if(cursor)rows=rows.filter(r=>r.ticker>cursor[1]||(r.ticker===cursor[1]&&r.fecha>cursor[2]));
    const date=url.searchParams.get('fecha');
    if(date?.startsWith('gt.'))rows=rows.filter(r=>r.fecha>date.slice(3));
    response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    // Captures contain only confirmed bars selected by the Yahoo validator.
    // Supply the same confirmation field that the production writer adds.
    response.end(JSON.stringify(rows.slice(0,Math.min(1000,Number(url.searchParams.get('limit'))||1000)).map(row=>({...row,is_final:true})))) ;return;
  }
  const relative=decodeURIComponent(url.pathname==='/'?'index.html':url.pathname.slice(1));
  const file=path.resolve(root,relative);
  if(!file.startsWith(root)||!['index.html','ticker.html','js','data'].includes(relative.split('/')[0])){response.writeHead(404);response.end();return;}
  try{
    let body=fs.readFileSync(file);
    if(snapshot&&relative==='js/config.js'){
      body=body.toString().replace(/const SUPABASE_URL = .*?;/,'const SUPABASE_URL = "https://preview.invalid";').replace(/const SUPABASE_KEY = .*?;/,'const SUPABASE_KEY = "sb_publishable_preview";');
      body+='\nconst previewFetch=window.fetch.bind(window);window.fetch=(input,options)=>String(input).startsWith("https://preview.invalid/rest/v1/market_history")?previewFetch("/__history?"+String(input).split("?")[1],options):previewFetch(input,options);\n';
    }
    response.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});response.end(body);
  }catch{response.writeHead(404);response.end();}
}).listen(8765,'127.0.0.1',()=>console.log('Local '+(snapshot?'snapshot ':'')+'preview: http://127.0.0.1:8765'));
