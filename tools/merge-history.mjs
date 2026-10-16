/** Reuse the validated stock capture and add a separately fetched ETF capture. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=path.join(root,'outputs/yahoo');
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const universe=JSON.parse(fs.readFileSync(path.join(root,'data/universe.json'),'utf8'));
const stocks=read('history.json'),etfs=read('etfs-history.json');
const stockNames=new Set(universe.companies.map(c=>c.ticker)),etfNames=new Set(universe.etfs.map(c=>c.ticker));
assert.equal(stockNames.size,200);assert.equal(etfNames.size,50);
const stockRows=stocks.rows.filter(r=>stockNames.has(r.ticker));
assert.ok(etfs.rows.every(r=>etfNames.has(r.ticker)));
const rows=[...stockRows,...etfs.rows].sort((a,b)=>a.ticker.localeCompare(b.ticker)||a.fecha.localeCompare(b.fecha));
assert.equal(new Set(rows.map(r=>r.ticker+'|'+r.fecha)).size,rows.length,'Duplicate history keys');
const diagnostics=[
  ...read('diagnostics.json').filter(d=>stockNames.has(d.ticker)).map(d=>({...d,type:'STOCK',retrievedAt:d.retrievedAt||stocks.retrievedAt})),
  ...read('etfs-diagnostics.json').map(d=>({...d,type:'ETF',retrievedAt:d.retrievedAt||etfs.retrievedAt}))
];
assert.equal(diagnostics.length,250);assert.equal(new Set(diagnostics.map(d=>d.ticker)).size,250);
assert.ok(diagnostics.every(d=>!d.error),'Failed downloads must be resolved before merging');
const retrievedAtByTicker=Object.fromEntries(diagnostics.map(d=>[d.ticker,d.retrievedAt]));
const capture={retrievedAt:etfs.retrievedAt,source:'Yahoo Finance daily chart, 3y; unchanged stock capture plus ETF extension',
  sources:[{type:'STOCK',retrievedAt:stocks.retrievedAt},{type:'ETF',retrievedAt:etfs.retrievedAt}],retrievedAtByTicker,rows};
fs.writeFileSync(path.join(dir,'history-250.json'),JSON.stringify(capture));
fs.writeFileSync(path.join(dir,'diagnostics-250.json'),JSON.stringify(diagnostics,null,2));
console.log(JSON.stringify({instruments:250,stockBars:stockRows.length,etfBars:etfs.rows.length,totalBars:rows.length,output:path.join(dir,'history-250.json')}));
