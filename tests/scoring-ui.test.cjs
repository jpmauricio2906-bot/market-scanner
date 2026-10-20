const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const scoring = require('../js/scoring.js');
function dashboard(saved = null) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {innerHTML:'',textContent:'',value:id==='instrumentType'?'ALL':'',
      style:{setProperty(){}},classList:{add(){},remove(){},toggle(){}},querySelectorAll:()=>[],addEventListener(){}});
    return elements.get(id);
  };
  const context = vm.createContext({MarketScoring:scoring,MARKET_SETTINGS:{minSignalDays:50},
    document:{getElementById:element,querySelectorAll:()=>[],documentElement:element('root')},
    localStorage:{getItem:key=>key==='marketScanner.compositeWeights.v1'?saved:null,setItem(){}},
    instrumentDescription:instrument=>instrument.name,instrumentTypeLabel:()=> 'Stock',escapeHtml:String,
    window:{location:{}},Intl});
  const source = [...fs.readFileSync(path.join(root,'index.html'),'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  vm.runInContext(source.replace(/loadData\(\);\s*$/,''),context);
  return {context,element};
}
function bars() {
  return Array.from({length:95},(_,i)=>{
    const close=100+i*.15+1.5*Math.sin(i/3),open=i?100+(i-1)*.15+1.5*Math.sin((i-1)/3):close;
    return {date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),open,close,
      high:Math.max(open,close)+.6,low:Math.min(open,close)-.6,vol:i===94?2000:1000};
  });
}
function setRows(context, symbols) {
  context.companyUniverse={byTicker:new Map(symbols.map(ticker=>[ticker,{ticker,name:ticker,type:'STOCK'}]))};
  return context.computeAll(Object.fromEntries(symbols.map(ticker=>[ticker,bars()])));
}
test('dashboard filters include strong classes and sums them correctly',()=>{
  const {context,element}=dashboard();
  context.results=setRows(context,['AAA','BBB','CCC','DDD','EEE','FFF']);
  const signals=['STRONG_BUY','BUY','HOLD','SELL','STRONG_SELL','WAIT'];
  context.results.forEach((row,i)=>row.signal=signals[i]);
  context.updateSummary();
  assert.equal(element('cBuy').textContent,2);
  assert.equal(element('cSell').textContent,2);
  assert.equal(element('cHold').textContent,1);
  context.filter='BUY'; context.renderTable();
  assert.match(element('tbody').innerHTML,/>AAA</); assert.match(element('tbody').innerHTML,/>BBB</);
  assert.doesNotMatch(element('tbody').innerHTML,/>EEE</);
  context.filter='STRONG_SELL';context.renderTable();
  assert.match(element('tbody').innerHTML,/>EEE</);assert.doesNotMatch(element('tbody').innerHTML,/>DDD</);
});
test('numeric rankings keep missing and stale WAIT rows last in either direction',()=>{
  const {context,element}=dashboard();context.results=setRows(context,['AAA','BBB','CCC']);
  context.results[0].entryScore=70;context.results[1].entryScore=20;
  context.results[2].entryScore=95;context.results[2].signal='WAIT';
  for(const ascending of [true,false]){
    context.sortAsc=ascending;context.renderTable();const html=element('tbody').innerHTML;
    assert.ok(html.indexOf('>CCC<')>html.indexOf('>AAA<'));
    assert.ok(html.indexOf('>CCC<')>html.indexOf('>BBB<'));
    assert.equal(html.indexOf('>AAA<')<html.indexOf('>BBB<'),!ascending);
  }
});
test('preset recalculation changes only Composite, preserving timing and direction',()=>{
  const {context}=dashboard();context.results=setRows(context,['AAA']);
  const before=JSON.stringify(context.results.map(({entryScore,exitScore,trendScore,signal})=>({entryScore,exitScore,trendScore,signal})));
  context.INDICATORS.forEach(indicator=>indicator.weight=0);context.recalc();
  assert.equal(context.results[0].score,50);
  assert.equal(JSON.stringify(context.results.map(({entryScore,exitScore,trendScore,signal})=>({entryScore,exitScore,trendScore,signal}))),before);
});
test('table and detail restore the same Composite weights and use the shared engine',()=>{
  const weights=Object.fromEntries(scoring.DEFAULT_INDICATORS.map(indicator=>[indicator.id,indicator.id==='roc'?3:0]));
  const saved=JSON.stringify({weights}),{context}=dashboard(saved);
  const table=setRows(context,['AAA'])[0],elements={};
  const html=fs.readFileSync(path.join(root,'ticker.html'),'utf8');
  const detail=vm.createContext({MarketScoring:scoring,localStorage:{getItem:()=>saved},
    document:{getElementById:id=>elements[id]??={style:{}}}});
  vm.runInContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1],detail);
  const start=html.indexOf('const INDICATORS = ['),end=html.indexOf('// ── Chart.js global defaults',start);
  vm.runInContext(html.slice(start,end)+'\nrestoreCompositeWeights();globalThis.detailScore=raw=>computeScore(computeSignals(raw),INDICATORS);',detail);
  assert.equal(detail.detailScore(bars()),table.score);
});
test('stale history or an outdated provisional quote cannot escape WAIT',()=>{
  const {context}=dashboard();setRows(context,['AAA']);const grouped={AAA:bars()};
  const metadata={quality:{laggingTickers:['AAA']},provisionalTickers:[],quoteByTicker:new Map()};
  assert.equal(context.computeAll(grouped,metadata)[0].signal,'WAIT');
  metadata.provisionalTickers=['AAA'];metadata.quoteByTicker.set('AAA',{outdated:true});
  assert.equal(context.computeAll(grouped,metadata)[0].signal,'WAIT');
  metadata.quoteByTicker.set('AAA',{outdated:false});
  assert.equal(context.computeAll(grouped,metadata)[0].signal,'BUY','fresh provisional can emit ordinary buy, never strong');
});
