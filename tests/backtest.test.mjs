import test from 'node:test';
import assert from 'node:assert/strict';
import {eventStudy,blockBootstrapDifference,csv,marketDates} from '../tools/backtest.mjs';
function panel(){
  const bars=Array.from({length:80},(_,i)=>({date:new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10),open:100,close:100,high:100,low:100,vol:1000}));
  const signals=bars.map(b=>({date:b.date,oldSignal:'HOLD',newSignal:'HOLD'}));
  return {series:[{ticker:'TEST',bars,signals}]};
}
test('event returns use next open and two-sided costs; sell outcome compares to holding',()=>{
  const p=panel(),s=p.series[0];s.signals[49].oldSignal='BUY';s.signals[49].newSignal='SELL';
  s.bars[49].open=1;s.bars[50].open=100;s.bars[55].open=90;
  const result=eventStudy(p,{startDate:s.bars[50].date,endDate:s.bars[79].date,calendarDates:s.bars.map(b=>b.date),horizons:[5],commissionBps:10,slippageBps:20});
  const factor=(1-.002)*(1-.001)/((1+.002)*(1+.001));
  const buy=result.events.find(e=>e.model==='old'),sell=result.events.find(e=>e.model==='new'&&!e.strongOnly);
  assert.equal(buy.entryDate,s.bars[50].date);assert.equal(buy.exitDate,s.bars[55].date);
  assert.ok(Math.abs(buy.netLongReturn-(.9*factor-1))<1e-12);
  assert.ok(Math.abs(sell.exitAdvantage-(factor-.9))<1e-12);
});
test('event study excludes overlapping same-family events and incomplete horizons',()=>{
  const p=panel(),s=p.series[0];
  for(const i of [49,50,52,60,78])s.signals[i].newSignal='BUY';
  const result=eventStudy(p,{startDate:s.bars[50].date,endDate:s.bars[79].date,calendarDates:s.bars.map(b=>b.date),horizons:[5]});
  assert.deepEqual(result.events.filter(e=>e.model==='new'&&e.direction==='buy'&&!e.strongOnly).map(e=>e.signalDate),[s.bars[49].date,s.bars[60].date]);
});
test('missing exchange sessions prevent a false event horizon or stale signal execution',()=>{
  const p=panel(),s=p.series[0],calendarDates=s.bars.map(b=>b.date);s.signals[49].newSignal='BUY';
  s.bars.splice(50,1);s.signals.splice(50,1);
  const result=eventStudy(p,{startDate:calendarDates[50],endDate:calendarDates[79],calendarDates,horizons:[5]});
  assert.equal(result.events.length,0);
});
test('paired bootstrap is reproducible, identical series are zero, constant differences exact',()=>{
  const a=Array.from({length:75},(_,i)=>({date:new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10),dailyReturn:.001+i*.00001})),b=a.map(x=>({...x,dailyReturn:x.dailyReturn-.002}));
  const result=blockBootstrapDifference(a,b,{iterations:100});
  assert.deepEqual(result,blockBootstrapDifference(a,b,{iterations:100}));
  assert.ok(Math.abs(result.meanDailyDifference-.002)<1e-12);
  assert.ok(Math.abs(result.lower95-.002)<1e-12);assert.ok(Math.abs(result.upper95-.002)<1e-12);
  assert.equal(blockBootstrapDifference(a,a,{iterations:30}).upper95,0);
});

test('event study rejects noncausal horizons and invalid costs before evaluating signals',()=>{
  const p=panel(),bars=p.series[0].bars;
  const options={startDate:bars[50].date,endDate:bars[79].date,calendarDates:bars.map(b=>b.date)};
  for(const horizons of [[],[0],[-5],[1.5],[Infinity],[NaN],['5'],[5,5],null,5]){
    assert.throws(()=>eventStudy(p,{...options,horizons}),/horizons/);
  }
  for(const key of ['commissionBps','slippageBps'])for(const value of [-1,10000,Infinity,NaN,'0',null]){
    assert.throws(()=>eventStudy(p,{...options,[key]:value}),new RegExp(key));
  }
  p.series[0].signals[49].newSignal='BUY';
  const result=eventStudy(p,{...options,horizons:[1],commissionBps:0,slippageBps:0});
  const event=result.events.find(e=>e.model==='new'&&!e.strongOnly);
  assert.equal(event.signalDate,bars[49].date);
  assert.equal(event.entryDate,bars[50].date);
  assert.equal(event.exitDate,bars[51].date);
  assert.equal(event.netLongReturn,0);
});

test('bootstrap rejects unaligned, duplicate, unordered and invalid observation dates',()=>{
  const a=panel().series[0].bars.slice(0,30).map(b=>({date:b.date,dailyReturn:.001}));
  for(const [first,second] of [[[],[]],[null,a],[a,{}],[a,a.slice(1)]]){
    assert.throws(()=>blockBootstrapDifference(first,second),/nonempty arrays.*same length/);
  }
  const shifted=a.map(row=>({...row}));
  shifted.at(-1).date='2025-02-01';
  assert.throws(()=>blockBootstrapDifference(a,shifted),/aligned dates/);
  for(const which of ['first','second']){
    for(const mutate of [
      rows=>{rows[1].date=rows[0].date;},
      rows=>{[rows[0],rows[1]]=[rows[1],rows[0]];},
      rows=>{rows[0].date='2025-02-30';},
      rows=>{rows[0].date='2025-1-01';},
      rows=>{rows[0]=null;}
    ]){
      const invalid=a.map(row=>({...row}));mutate(invalid);
      assert.throws(()=>blockBootstrapDifference(which==='first'?invalid:a,which==='second'?invalid:a),/valid unique ascending ISO dates/);
    }
  }
});

test('bootstrap rejects nonfinite returns rather than producing null interval estimates',()=>{
  const a=panel().series[0].bars.slice(0,30).map(b=>({date:b.date,dailyReturn:.001}));
  for(const value of [NaN,Infinity,-Infinity,null,undefined,'.01']){
    const invalid=a.map(row=>({...row}));invalid[5].dailyReturn=value;
    assert.throws(()=>blockBootstrapDifference(invalid,a),/dailyReturn must be finite/);
    assert.throws(()=>blockBootstrapDifference(a,invalid),/dailyReturn must be finite/);
  }
  const positive=a.map(row=>({...row,dailyReturn:Number.MAX_VALUE}));
  const negative=a.map(row=>({...row,dailyReturn:-Number.MAX_VALUE}));
  assert.throws(()=>blockBootstrapDifference(positive,negative),/paired return differences must be finite/);
});
test('market calendar excludes holidays and weekends and rejects missing year coverage',()=>{
  const calendar={firstYear:2025,lastYear:2025,holidays:['2025-01-01']};
  assert.deepEqual(marketDates(calendar,'2025-01-01','2025-01-06'),['2025-01-02','2025-01-03','2025-01-06']);
  assert.throws(()=>marketDates(calendar,'2024-12-31','2025-01-06'),/cover/);
});
test('CSV escapes delimiters, quotes and null without changing numbers',()=>{
  assert.equal(csv([{a:'a,b',b:'a"b',c:null,n:-.5}]),'a,b,c,n\n"a,b","a""b",,-0.5\n');
});
