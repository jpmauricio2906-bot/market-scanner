#!/usr/bin/env node
// Offline snapshot comparison. This tool never fetches prices or credentials.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scoring = require('../js/scoring.js');

// Frozen before the Entry Timing revision. Do not replace these functions with
// the current engine: keeping the old errors is necessary for an honest audit.
// Source: index.html, function sma through computeScore, reviewed 2026-10-19.
export const LEGACY_SOURCE_SHA256 = '8eb6da4655d30b3abb00344a250ae2353ae84ace6b371a7b5cb7a64fa2df75c3';
export const LEGACY_INDICATORS = Object.freeze(Object.entries({
  sma_cross:2, ema_cross:2, sma50:1, macd:2, rsi:3, stoch_rsi:2, roc:1,
  williams:1, bb:2, atr:1, obv:1, vol_avg:1, candle:2, gap:1
}).map(([id, weight]) => Object.freeze({ id, weight })));

function sma(a,n){if(a.length<n)return null;var s=0;for(var i=a.length-n;i<a.length;i++)s+=a[i];return s/n;}
function ema(a,n){if(a.length<n)return null;var k=2/(n+1),s=0;for(var i=0;i<n;i++)s+=a[i];var e=s/n;for(var i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return e;}
function emaArr(a,n){if(a.length<n)return[];var k=2/(n+1),out=new Array(a.length).fill(null),s=0;for(var i=0;i<n;i++)s+=a[i];out[n-1]=s/n;for(var i=n;i<a.length;i++)out[i]=a[i]*k+out[i-1]*(1-k);return out;}
function rsiCalc(a,n){
  if(a.length<n+1)return 50;
  var g=0,l=0,d;
  for(var i=1;i<=n;i++){d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;}
  var mg=g/n,ml=l/n;
  for(var i=n+1;i<a.length;i++){d=a[i]-a[i-1];if(d>0){mg=(mg*(n-1)+d)/n;ml=ml*(n-1)/n;}else{mg=mg*(n-1)/n;ml=(ml*(n-1)-d)/n;}}
  return ml===0?100:100-(100/(1+mg/ml));
}
function macdFull(c){
  var e12=emaArr(c,12),e26=emaArr(c,26);
  if(!e12.length)return{hist:0,prevHist:0};
  var vm=[];for(var i=0;i<c.length;i++){if(e12[i]!=null&&e26[i]!=null)vm.push(e12[i]-e26[i]);}
  if(vm.length<9)return{hist:vm[vm.length-1]||0,prevHist:0};
  var k9=2/10,s=0;for(var i=0;i<9;i++)s+=vm[i];var sig=s/9,ps=sig;
  for(var i=9;i<vm.length;i++){ps=sig;sig=vm[i]*k9+sig*(1-k9);}
  var cur=vm[vm.length-1],prev=vm.length>1?vm[vm.length-2]:cur;
  return{hist:cur-sig,prevHist:prev-ps};
}
function bbPct(a){if(a.length<20)return 0.5;var sub=a.slice(-20),m=0;for(var i=0;i<20;i++)m+=sub[i];m/=20;var v=0;for(var i=0;i<20;i++)v+=(sub[i]-m)*(sub[i]-m);var std=Math.sqrt(v/20);if(std===0)return 0.5;return(a[a.length-1]-(m-2*std))/(4*std);}
function atrN(d){if(d.length<15)return 0;var s=0;for(var i=d.length-14;i<d.length;i++){var tr=Math.max(d[i].high-d[i].low,Math.abs(d[i].high-d[i-1].close),Math.abs(d[i].low-d[i-1].close));s+=tr;}return(s/14)/d[d.length-1].close*100;}
function obvT(d){if(d.length<2)return 0;var o=0,arr=[];for(var i=1;i<d.length;i++){if(d[i].close>d[i-1].close)o+=d[i].vol;else if(d[i].close<d[i-1].close)o-=d[i].vol;arr.push(o);}if(arr.length<20)return 0;var n=20,mid=10,f=0,s2=0;for(var i=arr.length-n;i<arr.length-mid;i++)f+=arr[i];f/=mid;for(var i=arr.length-mid;i<arr.length;i++)s2+=arr[i];s2/=mid;return f===0?0:(s2-f)/Math.abs(f);}
function stochRSI(a){if(a.length<29)return 50;var rv=[];for(var i=14;i<a.length;i++)rv.push(rsiCalc(a.slice(0,i+1),14));if(rv.length<14)return 50;var sub=rv.slice(-14),mn=sub[0],mx=sub[0];for(var i=1;i<14;i++){if(sub[i]<mn)mn=sub[i];if(sub[i]>mx)mx=sub[i];}return mx===mn?50:((rv[rv.length-1]-mn)/(mx-mn))*100;}
function willR(d){if(d.length<14)return-50;var r=d.slice(-14),hh=r[0].high,ll=r[0].low;for(var i=1;i<14;i++){if(r[i].high>hh)hh=r[i].high;if(r[i].low<ll)ll=r[i].low;}var c=d[d.length-1].close;return hh===ll?-50:((hh-c)/(hh-ll))*-100;}
function roc10(a){if(a.length<11)return 0;return(a[a.length-1]-a[a.length-11])/a[a.length-11]*100;}
function volAvg(d){if(d.length<21)return 0;var avg=0;for(var i=d.length-21;i<d.length-1;i++)avg+=d[i].vol;avg/=20;if(!avg)return 0;var rat=d[d.length-1].vol/avg,up=d[d.length-1].close>d[d.length-2].close;return rat>1.5?(up?1:-1):rat>1.2?(up?.5:-.5):0;}
function candlePat(d){if(d.length<2)return 0;var c=d[d.length-1],p=d[d.length-2],body=Math.abs(c.close-c.open),rng=c.high-c.low;if(rng===0)return 0;var br=body/rng;if(br<0.1)return 0;var bull=c.close>c.open,ls=Math.min(c.close,c.open)-c.low,us=c.high-Math.max(c.close,c.open);if(ls>2*body&&us<0.3*body&&p.close<p.open)return 0.8;if(us>2*body&&ls<0.3*body&&p.close>p.open)return-0.8;if(bull&&p.close<p.open&&c.open<p.close&&c.close>p.open)return 1;if(!bull&&p.close>p.open&&c.open>p.close&&c.close<p.open)return-1;return bull&&br>0.6?.4:!bull&&br>0.6?-.4:0;}
function gapSig(d){if(d.length<2)return 0;var g=(d[d.length-1].open-d[d.length-2].close)/d[d.length-2].close*100;return g>2?.8:g>.5?.3:g<-2?-.8:g<-.5?-.3:0;}

function computeSignals(d){
  var c=new Array(d.length),s={};
  for(var i=0;i<d.length;i++)c[i]=d[i].close;
  var sm5=sma(c,5),sm20=sma(c,20),pm5=sma(c.slice(0,-1),5),pm20=sma(c.slice(0,-1),20);
  s.sma_cross=sm5!==null&&sm20!==null?(pm5<=pm20&&sm5>sm20?1:pm5>=pm20&&sm5<sm20?-1:sm5>sm20?.3:-.3):0;
  var e12=ema(c,12),e26=ema(c,26),pe12=ema(c.slice(0,-1),12),pe26=ema(c.slice(0,-1),26);
  s.ema_cross=e12!==null&&e26!==null&&pe12!==null&&pe26!==null?(pe12<=pe26&&e12>e26?1:pe12>=pe26&&e12<e26?-1:e12>e26?.3:-.3):0;
  var s50=sma(c,50);s.sma50=s50!==null?(function(){var dv=(c[c.length-1]-s50)/s50;return dv>.05?.8:dv>0?.3:dv<-.05?-.8:-.3;})():0;
  var m=macdFull(c);s.macd=m.prevHist<=0&&m.hist>0?1:m.prevHist>=0&&m.hist<0?-1:m.hist>0?.3:-.3;
  var r=rsiCalc(c,14);s.rsi=r<30?1:r<40?.5:r>70?-1:r>60?-.5:0;
  var sr=stochRSI(c);s.stoch_rsi=sr<20?1:sr<30?.5:sr>80?-1:sr>70?-.5:0;
  var rc=roc10(c);s.roc=rc>10?1:rc>5?.5:rc>2?.2:rc<-10?-1:rc<-5?-.5:rc<-2?-.2:0;
  var wr=willR(d);s.williams=wr<-80?1:wr<-70?.5:wr>-20?-1:wr>-30?-.5:0;
  s.bb=(function(){var b=bbPct(c);return b<.15?1:b<.25?.5:b>.85?-1:b>.75?-.5:0;})();
  var at=atrN(d);s.atr=at<1?.2:at>5?-.2:0;
  var ov=obvT(d);s.obv=ov>.1?.7:ov>.02?.3:ov<-.1?-.7:ov<-.02?-.3:0;
  s.vol_avg=volAvg(d);s.candle=candlePat(d);s.gap=gapSig(d);
  return s;
}

function computeScore(sig){
  var ws=0,mw=0;
  LEGACY_INDICATORS.forEach(function(i){if(i.weight===0)return;ws+=(sig[i.id]||0)*i.weight;mw+=i.weight;});
  return mw===0?50:Math.round(((ws/mw)+1)/2*100);
}

export { computeSignals as legacySignals, computeScore as legacyComposite };

const SIGNALS = ['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL', 'WAIT'];
const strictNumber = value => value === null || value === undefined || typeof value === 'boolean' ||
  (typeof value === 'string' && !value.trim()) ? NaN : Number(value);
const round = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T12:00:00Z')) &&
    new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}

/** Accept the repository's Yahoo {rows}, Supabase row array, and workbook tuples. */
export function normalizeSnapshot(document, { historyDays = 500 } = {}) {
  if (!Number.isSafeInteger(historyDays) || historyDays < 50) throw new Error('historyDays must be an integer of at least 50.');
  const rows = Array.isArray(document) ? document : document?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('Input must contain a nonempty row array or {rows:[...]}.');
  const byTicker = new Map();
  const quality = { inputRows: rows.length, acceptedRows: 0, invalidRows: 0, provisionalRows: 0,
    duplicateRows: 0, truncatedRows: 0, unknownFinalityRows: 0 };
  for (const row of rows) {
    const item = Array.isArray(row) ? { date: row[0], ticker: row[1], open: row[2], high: row[3],
      low: row[4], close: row[5], vol: row[6] } : row;
    if (!item || typeof item !== 'object') { quality.invalidRows++; continue; }
    const ticker = typeof item.ticker === 'string' ? item.ticker.trim().toUpperCase() : '';
    if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker)) { quality.invalidRows++; continue; }
    if (!byTicker.has(ticker)) byTicker.set(ticker, new Map());
    if (item.is_final === false || item.status === 'PROVISIONAL') { quality.provisionalRows++; continue; }
    const date = item.fecha ?? item.date;
    const [open, high, low, close, vol] = [item.open, item.high, item.low, item.close,
      item.volumen ?? item.vol ?? item.volume].map(strictNumber);
    if (!validDate(date) || ![open, high, low, close, vol].every(Number.isFinite) ||
        Math.min(open, high, low, close) <= 0 || high < Math.max(open, close) ||
        low > Math.min(open, close) || !Number.isSafeInteger(vol) || vol < 0) {
      quality.invalidRows++; continue;
    }
    const bar = { date, open, high, low, close, vol };
    const tickerRows = byTicker.get(ticker);
    if (tickerRows.has(date)) {
      quality.duplicateRows++;
      if (JSON.stringify(tickerRows.get(date)) !== JSON.stringify(bar)) {
        throw new Error('Conflicting duplicate OHLCV for ' + ticker + ' on ' + date + '.');
      }
      continue;
    }
    if (item.is_final !== true) quality.unknownFinalityRows++;
    tickerRows.set(date, bar);
  }
  const series = [...byTicker.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ticker, values]) => {
    const sorted = [...values.values()].sort((a, b) => a.date.localeCompare(b.date));
    quality.truncatedRows += Math.max(0, sorted.length - historyDays);
    const bars = sorted.slice(-historyDays);
    quality.acceptedRows += bars.length;
    return { ticker, bars };
  });
  if (!series.length || !quality.acceptedRows) throw new Error('Input contains no usable OHLCV history.');
  return { series, quality };
}

function scoreRange(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, min: null, median: null, max: null, mean: null };
  const middle = Math.floor(sorted.length / 2);
  return { count: sorted.length, min: round(sorted[0]), median: round(sorted.length % 2 ?
    sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2), max: round(sorted.at(-1)),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) };
}

function counts(rows, key) {
  const result = Object.fromEntries(SIGNALS.map(signal => [signal, 0]));
  for (const row of rows) {
    const signal = row[key];
    result[signal] = (result[signal] || 0) + 1;
  }
  return result;
}

/** A deterministic latest-bar comparison, not a return backtest or a live quote. */
export function auditSnapshot(document, { historyDays = 500, minSignalDays = 50, inputSha256 = null } = {}) {
  if (!Number.isSafeInteger(minSignalDays) || minSignalDays < 50 || minSignalDays > historyDays) {
    throw new Error('minSignalDays must be an integer between 50 and historyDays.');
  }
  const { series, quality } = normalizeSnapshot(document, { historyDays });
  const expectedLatestDate = validDate(document?.latestDate) ? document.latestDate : null;
  const rows = series.map(({ ticker, bars }) => {
    const ready = bars.length >= minSignalDays;
    const oldSignals = ready ? computeSignals(bars) : {};
    const oldComposite = ready ? computeScore(oldSignals) : null;
    const stale = Boolean(expectedLatestDate && bars.length && bars.at(-1).date < expectedLatestDate);
    const analysis = scoring.analyze(bars, { minSignalDays, provisional: false, stale });
    const newSignals = ready ? scoring.computeSignals(bars) : {};
    const newComposite = ready ? scoring.computeScore(newSignals, LEGACY_INDICATORS) : null;
    return { ticker, days: bars.length, asOf: bars.at(-1)?.date ?? null, stale,
      capturedAt: document?.retrievedAtByTicker?.[ticker] ?? document?.retrievedAt ?? document?.capturedAt ?? null,
      close: bars.at(-1)?.close ?? null, oldComposite, newComposite,
      oldSignal: ready ? oldComposite >= 70 ? 'BUY' : oldComposite <= 30 ? 'SELL' : 'HOLD' : 'WAIT',
      newSignal: analysis.signal, trendScore: analysis.trendScore, trendLabel: analysis.trendLabel,
      entryScore: analysis.entryScore, exitScore: analysis.exitScore,
      oldStochRsiSignal: ready ? oldSignals.stoch_rsi : null,
      newStochRsiSignal: ready ? newSignals.stoch_rsi : null,
      components: analysis.components, reasons: analysis.reasons };
  });
  const oldCounts = counts(rows, 'oldSignal'), newCounts = counts(rows, 'newSignal');
  const dates = rows.map(row => row.asOf).filter(Boolean).sort();
  const capturedAt = document?.retrievedAt ?? document?.capturedAt ?? null;
  const vlo = rows.find(row => row.ticker === 'VLO');
  return {
    schemaVersion: 1,
    kind: 'offline-scoring-snapshot',
    inputSha256,
    source: document?.source ?? null,
    capturedAt,
    scope: 'Tickers present in the input; missing universe tickers cannot be inferred.',
    limitations: [
      'Historical file capture only; prices and signals are not current quotations.',
      'This compares the last available bar per ticker, not trading returns or predictive accuracy.',
      'Default Composite weights are frozen for an apples-to-apples comparison; custom presets are excluded.',
      'No thresholds are fitted to this sample and no target BUY/SELL quota is imposed.',
      'Explicit provisional rows are excluded. Older files without finality fields are treated as stored history and counted separately.',
      'OHLCV and ISO dates are validated; source provenance, exchange calendars and split adjustments are not reverified offline.'
    ],
    baseline: { source: 'index.html before the Entry Timing revision, 2026-10-19',
      sourceSha256: LEGACY_SOURCE_SHA256, thresholds: { buy: 70, sell: 30 },
      weights: Object.fromEntries(LEGACY_INDICATORS.map(({ id, weight }) => [id, weight])) },
    currentEngine: { version: scoring.VERSION, thresholds: scoring.THRESHOLDS },
    settings: { historyDays, minSignalDays },
    asOf: { earliestTickerDate: dates[0] ?? null, latestTickerDate: dates.at(-1) ?? null,
      mixedTickerDates: new Set(dates).size > 1, expectedLatestDate,
      staleTickers: rows.filter(row => row.stale).map(row => row.ticker) },
    quality,
    summary: {
      tickers: rows.length, oldCounts, newCounts,
      oldHoldPercent: round(oldCounts.HOLD / rows.length * 100),
      newHoldPercent: round(newCounts.HOLD / rows.length * 100),
      oldWait: oldCounts.WAIT, newWait: newCounts.WAIT,
      ranges: { oldComposite: scoreRange(rows.map(row => row.oldComposite)),
        newComposite: scoreRange(rows.map(row => row.newComposite)),
        trend: scoreRange(rows.map(row => row.trendScore)),
        entry: scoreRange(rows.map(row => row.entryScore)), exit: scoreRange(rows.map(row => row.exitScore)) }
    },
    vlo: vlo ? { label: 'VLO historical snapshot as of ' + vlo.asOf + '; not a current quotation.', ...vlo } : null,
    rows
  };
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node tools/audit-scoring.mjs --input PATH [--output PATH]\n' +
      'Compares a local JSON snapshot using frozen legacy and current scoring. No network access.\n');
    return;
  }
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--input', '--output'].includes(flag) || !value || value.startsWith('--') || options[flag]) {
      throw new Error('Usage: node tools/audit-scoring.mjs --input PATH [--output PATH]');
    }
    options[flag] = value;
  }
  if (!options['--input']) throw new Error('--input PATH is required.');
  const inputPath = resolve(options['--input']);
  const outputPath = options['--output'] ? resolve(options['--output']) : null;
  if (outputPath && outputPath.toLowerCase() === inputPath.toLowerCase()) {
    throw new Error('The output path must differ from the input snapshot.');
  }
  const input = await readFile(inputPath, 'utf8');
  let document;
  try { document = JSON.parse(input.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Input is not valid JSON.'); }
  const report = auditSnapshot(document, { inputSha256: createHash('sha256').update(input).digest('hex') });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json, 'utf8');
    process.stdout.write(JSON.stringify({ output: outputPath, summary: report.summary, asOf: report.asOf }) + '\n');
  } else process.stdout.write(json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write('Scoring audit: ' + error.message + '\n'); process.exitCode = 1; });
}
