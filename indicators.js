// ============================================================
// indicators.js — all math, shared between index.html and ticker.html
// ============================================================

// ── Basic ──────────────────────────────────────────────────
function sma(a, n) {
  if (a.length < n) return null;
  let s = 0; for (let i = a.length - n; i < a.length; i++) s += a[i]; return s / n;
}
function ema(a, n) {
  if (a.length < n) return null;
  const k = 2 / (n + 1); let e = 0;
  for (let i = 0; i < n; i++) e += a[i]; e /= n;
  for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k);
  return e;
}

// ── RSI (last value) ───────────────────────────────────────
function rsiCalc(a, n = 14) {
  if (a.length < n + 1) return 50;
  let g = 0, l = 0, d;
  for (let i = 1; i <= n; i++) { d = a[i] - a[i-1]; d > 0 ? g += d : l -= d; }
  let mg = g/n, ml = l/n;
  for (let i = n+1; i < a.length; i++) {
    d = a[i] - a[i-1];
    if (d > 0) { mg=(mg*(n-1)+d)/n; ml=ml*(n-1)/n; }
    else        { mg=mg*(n-1)/n;    ml=(ml*(n-1)-d)/n; }
  }
  return ml === 0 ? 100 : 100 - (100 / (1 + mg / ml));
}

// ── RSI full series ────────────────────────────────────────
function rsiSeries(closes, dates, n = 14) {
  if (closes.length < n + 1) return [];
  const out = [];
  let g = 0, l = 0, d;
  for (let i = 1; i <= n; i++) { d = closes[i]-closes[i-1]; d>0?g+=d:l-=d; }
  let mg = g/n, ml = l/n;
  out.push({ time: dates[n], value: ml===0?100:100-(100/(1+mg/ml)) });
  for (let i = n+1; i < closes.length; i++) {
    d = closes[i]-closes[i-1];
    if (d>0){mg=(mg*(n-1)+d)/n;ml=ml*(n-1)/n;}else{mg=mg*(n-1)/n;ml=(ml*(n-1)-d)/n;}
    out.push({ time: dates[i], value: ml===0?100:100-(100/(1+mg/ml)) });
  }
  return out;
}

// ── MACD full series ───────────────────────────────────────
function macdSeries(closes, dates) {
  const k12=2/13, k26=2/27, k9=2/10;
  if (closes.length < 35) return { macd:[], signal:[], hist:[] };
  let e12=0, e26=0;
  for (let i=0;i<12;i++) e12+=closes[i]; e12/=12;
  for (let i=0;i<26;i++) e26+=closes[i]; e26/=26;
  const macdVals=[], macdDates=[];
  for (let i=0;i<closes.length;i++){
    if(i>=12) e12=closes[i]*k12+e12*(1-k12);
    if(i>=26){ e26=closes[i]*k26+e26*(1-k26); macdVals.push(e12-e26); macdDates.push(dates[i]); }
  }
  if (macdVals.length < 9) return { macd:[], signal:[], hist:[] };
  let sig=0; for(let i=0;i<9;i++) sig+=macdVals[i]; sig/=9;
  const macdOut=[], sigOut=[], histOut=[];
  for (let j=0;j<macdVals.length;j++){
    if(j>=9) sig=macdVals[j]*k9+sig*(1-k9);
    const h=macdVals[j]-sig;
    macdOut.push({time:macdDates[j], value:macdVals[j]});
    sigOut.push( {time:macdDates[j], value:sig});
    histOut.push({time:macdDates[j], value:h, color:h>=0?"rgba(0,230,118,.7)":"rgba(255,61,87,.7)"});
  }
  return { macd:macdOut, signal:sigOut, hist:histOut };
}

// ── Bollinger Bands full series ────────────────────────────
function bollingerSeries(closes, dates, n=20, mult=2) {
  const upper=[], mid=[], lower=[];
  for (let i=n-1;i<closes.length;i++){
    const sub=closes.slice(i-n+1,i+1);
    const mean=sub.reduce((a,b)=>a+b,0)/n;
    const std=Math.sqrt(sub.reduce((a,b)=>a+(b-mean)**2,0)/n);
    const t=dates[i];
    upper.push({time:t,value:+(mean+mult*std).toFixed(4)});
    mid.push(  {time:t,value:+(mean).toFixed(4)});
    lower.push({time:t,value:+(mean-mult*std).toFixed(4)});
  }
  return {upper, mid, lower};
}

// ── Stochastic RSI full series ─────────────────────────────
function stochRsiSeries(closes, dates, n=14) {
  if (closes.length < n*2+1) return [];
  const rsiArr=[];
  for (let i=n;i<closes.length;i++) rsiArr.push({v:rsiCalc(closes.slice(0,i+1),n), d:dates[i]});
  const out=[];
  for (let i=n;i<rsiArr.length;i++){
    const sub=rsiArr.slice(i-n+1,i+1).map(x=>x.v);
    const mn=Math.min(...sub), mx=Math.max(...sub);
    out.push({time:rsiArr[i].d, value: mx===mn?50:((rsiArr[i].v-mn)/(mx-mn))*100});
  }
  return out;
}

// ── Williams %R full series ────────────────────────────────
function williamsRSeries(data, dates, n=14) {
  const out=[];
  for (let i=n-1;i<data.length;i++){
    const sub=data.slice(i-n+1,i+1);
    const hh=Math.max(...sub.map(d=>d.high)), ll=Math.min(...sub.map(d=>d.low));
    const c=data[i].close;
    out.push({time:dates[i], value:hh===ll?-50:((hh-c)/(hh-ll))*-100});
  }
  return out;
}

// ── OBV full series ────────────────────────────────────────
function obvSeries(data, dates) {
  const out=[]; let obv=0;
  for (let i=1;i<data.length;i++){
    if (data[i].close>data[i-1].close) obv+=data[i].vol;
    else if (data[i].close<data[i-1].close) obv-=data[i].vol;
    out.push({time:dates[i], value:obv});
  }
  return out;
}

// ── ROC full series ────────────────────────────────────────
function rocSeries(closes, dates, n=10) {
  const out=[];
  for (let i=n;i<closes.length;i++){
    out.push({time:dates[i], value:+(((closes[i]-closes[i-n])/closes[i-n])*100).toFixed(3)});
  }
  return out;
}

// ── ATR full series ────────────────────────────────────────
function atrSeries(data, dates, n=14) {
  if (data.length < n+1) return [];
  const trs=[];
  for (let i=1;i<data.length;i++){
    trs.push(Math.max(data[i].high-data[i].low, Math.abs(data[i].high-data[i-1].close), Math.abs(data[i].low-data[i-1].close)));
  }
  let atr=0; for(let i=0;i<n;i++) atr+=trs[i]; atr/=n;
  const out=[];
  for (let i=n;i<trs.length;i++){
    atr=(trs[i]*(2/(n+1)))+atr*(1-(2/(n+1)));
    out.push({time:dates[i+1], value:+(atr/data[i+1].close*100).toFixed(3)});
  }
  return out;
}

// ── Single-value indicator signals (for heatmap) ───────────
function computeSignals(data) {
  const c = data.map(d => d.close), s = {};
  const sm5=sma(c,5),sm20=sma(c,20),pm5=sma(c.slice(0,-1),5),pm20=sma(c.slice(0,-1),20);
  s.sma_cross=sm5!==null&&sm20!==null?(pm5<=pm20&&sm5>sm20?1:pm5>=pm20&&sm5<sm20?-1:sm5>sm20?.3:-.3):0;
  const e12=ema(c,12),e26=ema(c,26),pe12=ema(c.slice(0,-1),12),pe26=ema(c.slice(0,-1),26);
  s.ema_cross=e12!==null&&e26!==null&&pe12!==null&&pe26!==null?(pe12<=pe26&&e12>e26?1:pe12>=pe26&&e12<e26?-1:e12>e26?.3:-.3):0;
  const s50=sma(c,50);s.sma50=s50!==null?((c[c.length-1]-s50)/s50>.05?.8:(c[c.length-1]-s50)/s50>0?.3:(c[c.length-1]-s50)/s50<-.05?-.8:-.3):0;
  const mr=macdSeries(c,Array(c.length).fill(0));
  s.macd=mr.hist.length>1?(mr.hist[mr.hist.length-2].value<=0&&mr.hist[mr.hist.length-1].value>0?1:mr.hist[mr.hist.length-2].value>=0&&mr.hist[mr.hist.length-1].value<0?-1:mr.hist[mr.hist.length-1].value>0?.3:-.3):0;
  const r=rsiCalc(c,14);s.rsi=r<30?1:r<40?.5:r>70?-1:r>60?-.5:0;
  const sr=stochRsiSeries(c,Array(c.length).fill("x"),14);s.stoch_rsi=sr.length?( sr[sr.length-1].value<20?1:sr[sr.length-1].value<30?.5:sr[sr.length-1].value>80?-1:sr[sr.length-1].value>70?-.5:0):0;
  const rc=c.length>10?(c[c.length-1]-c[c.length-11])/c[c.length-11]*100:0;s.roc=rc>10?1:rc>5?.5:rc>2?.2:rc<-10?-1:rc<-5?-.5:rc<-2?-.2:0;
  const wr_v=williamsRSeries(data,Array(data.length).fill("x"),14);s.williams=wr_v.length?(wr_v[wr_v.length-1].value<-80?1:wr_v[wr_v.length-1].value<-70?.5:wr_v[wr_v.length-1].value>-20?-1:wr_v[wr_v.length-1].value>-30?-.5:0):0;
  const boll=bollingerSeries(c,Array(c.length).fill("x"));s.bb=boll.upper.length?(function(){const idx=boll.upper.length-1;const pct=(c[c.length-1]-boll.lower[idx].value)/(boll.upper[idx].value-boll.lower[idx].value);return pct<.15?1:pct<.25?.5:pct>.85?-1:pct>.75?-.5:0;})():0;
  const atr_v=atrSeries(data,Array(data.length).fill("x"),14);s.atr=atr_v.length?(atr_v[atr_v.length-1].value<1?.2:atr_v[atr_v.length-1].value>5?-.2:0):0;
  const obv_v=obvSeries(data,Array(data.length).fill("x"));if(obv_v.length>=20){const n=20,f=obv_v.slice(-n,-10).reduce((a,b)=>a+b.value,0)/10,sv=obv_v.slice(-10).reduce((a,b)=>a+b.value,0)/10;s.obv=f===0?0:(sv-f)/Math.abs(f)>.1?.7:(sv-f)/Math.abs(f)>.02?.3:(sv-f)/Math.abs(f)<-.1?-.7:(sv-f)/Math.abs(f)<-.02?-.3:0;}else s.obv=0;
  if(data.length>=21){const avg=data.slice(-21,-1).reduce((a,b)=>a+b.vol,0)/20;const rat=data[data.length-1].vol/avg;const up=data[data.length-1].close>data[data.length-2].close;s.vol_avg=rat>1.5?(up?1:-1):rat>1.2?(up?.5:-.5):0;}else s.vol_avg=0;
  if(data.length>=2){const c2=data[data.length-1],p=data[data.length-2],body=Math.abs(c2.close-c2.open),rng=c2.high-c2.low;if(rng>0){const br=body/rng,bull=c2.close>c2.open,ls=Math.min(c2.close,c2.open)-c2.low,us=c2.high-Math.max(c2.close,c2.open);s.candle=ls>2*body&&us<.3*body&&p.close<p.open?.8:us>2*body&&ls<.3*body&&p.close>p.open?-.8:bull&&p.close<p.open&&c2.open<p.close&&c2.close>p.open?1:!bull&&p.close>p.open&&c2.open>p.close&&c2.close<p.open?-1:bull&&br>.6?.4:!bull&&br>.6?-.4:0;}else s.candle=0;}else s.candle=0;
  if(data.length>=2){const g=(data[data.length-1].open-data[data.length-2].close)/data[data.length-2].close*100;s.gap=g>2?.8:g>.5?.3:g<-2?-.8:g<-.5?-.3:0;}else s.gap=0;
  return s;
}

function computeScore(signals, indicators) {
  let ws=0, mw=0;
  indicators.forEach(i=>{ if(i.weight===0)return; ws+=(signals[i.id]||0)*i.weight; mw+=i.weight; });
  return mw===0?50:Math.round(((ws/mw)+1)/2*100);
}
