// A single preregistered experimental exit rule; production v3 is unchanged.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildValidationPanel, validationPanelProvenance } from './validation-panel.mjs';
import { normalizeSnapshot } from './audit-scoring.mjs';
import { buildLongTrendPanel } from './long-trend-signals.mjs';
import { longTrendCalendar } from './long-trend-calendar.mjs';
import { validationCalendar } from './validation-calendar.mjs';
import { executionBarsWithSignals } from './validate-exits.mjs';
import { runPortfolio } from './backtest-execution.mjs';
import { marketDates, blockBootstrapDifference, csv } from './backtest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['tools/validate-long-trend.mjs', 'tools/long-trend-signals.mjs', 'tools/long-trend-calendar.mjs',
  'tools/validation-calendar.mjs', 'tools/validation-panel.mjs', 'tools/audit-scoring.mjs', 'tools/validate-exits.mjs',
  'tools/backtest.mjs', 'tools/backtest-execution.mjs', 'tools/backtest-signals.mjs',
  'tools/baselines/scoring-v2.cjs', 'js/scoring.js', 'tools/fetch-validation-history.mjs',
  'data/validation/long-trend-protocol.json', 'data/universe.json', 'supabase/calendar.json'];
const labels = { old: 'v3', new: 'long_trend_200', buy_hold: 'buy_hold' };
const omitCalendar = ({ calendarDates, ...rest }) => rest;
const compactRun = run => ({ strategy: run.strategy, options: omitCalendar(run.options), period: run.period,
  metrics: run.metrics, assumptions: run.assumptions, dataQuality: run.dataQuality });

export function verifyCacheProvenance(panel, expected) {
  if (panel.metadata?.cacheKey !== expected.cacheKey || JSON.stringify(panel.metadata?.cacheProvenance) !== JSON.stringify(expected.cacheProvenance)) {
    throw Error('Cached signal settings, input, universe or source hashes do not match.');
  }
}

export function adjustedPanel(quotePanel, document) {
  const normalized = normalizeSnapshot(document, { historyDays: Number.MAX_SAFE_INTEGER });
  if (normalized.quality.invalidRows || normalized.quality.provisionalRows || normalized.quality.duplicateRows) throw Error('Invalid adjusted input rows.');
  const byTicker = new Map(normalized.series.map(s => [s.ticker, s]));
  const statuses = new Map(document.instruments?.map(x => [x.ticker, x.status]));
  const expected = new Set(quotePanel.series.map(s => s.ticker));
  if ([...byTicker.keys(), ...statuses.keys()].some(t => !expected.has(t))) throw Error('Adjusted input has an unexpected ticker.');
  const series = quotePanel.series.map(s => {
    if (!s.bars.length) {
      if (statuses.get(s.ticker) !== 'not_listed' || byTicker.has(s.ticker)) throw Error('Adjusted empty sleeve is not verified: ' + s.ticker);
      return { ticker: s.ticker, bars: [] };
    }
    if (statuses.get(s.ticker) !== 'ok' || !byTicker.has(s.ticker)) throw Error('Adjusted history missing: ' + s.ticker);
    return byTicker.get(s.ticker);
  });
  return executionBarsWithSignals({ ...quotePanel, series, metadata: { priceBasis: 'adjclose-ratio' } }, quotePanel);
}

function runsAt(panel, options, basis) {
  return Object.fromEntries(Object.entries(labels).map(([strategy, label]) => {
    const run = runPortfolio(panel, { ...options, strategy });
    run.assumptions = { ...run.assumptions, priceReturnOnly: basis !== 'adjusted_proxy',
      dividendsIncluded: basis === 'adjusted_proxy', priceBasis: basis,
      adjustment: basis === 'adjusted_proxy' ? 'Synthetic adjusted OHLC, dividend-reinvestment proxy; not literal executable prices.' : 'Provider quote prices; cash dividends excluded.' };
    return [label, run];
  }));
}

export function evaluateLongTrend(quotePanel, { adjustedDocument = null, protocol, period, calendar, universe }) {
  const earliest = quotePanel.series.flatMap(s => s.bars.length ? [s.bars[0].date] : []).sort()[0];
  const calendarDates = marketDates(calendar, earliest, period.end);
  const spy = quotePanel.series.find(s => s.ticker === 'SPY');
  if (!spy || JSON.stringify(spy.bars.map(b => b.date)) !== JSON.stringify(calendarDates)) throw Error('SPY dates do not match the expected complete calendar.');
  const candidate = buildLongTrendPanel(quotePanel, { normalizedBarsAreFinal: true, calendarDates });
  const valuation = adjustedDocument ? adjustedPanel(candidate, adjustedDocument) : candidate;
  const basis = adjustedDocument ? 'adjusted_proxy' : 'quote_only';
  const common = { startDate: period.start, endDate: period.end, calendarDates,
    initialCapital: protocol.execution.initialCapital, commissionBps: protocol.execution.commissionBpsPerSide,
    slippageBps: protocol.execution.primarySlippageBpsPerSide, warmupBars: protocol.execution.primaryWarmupBars };
  const main = runsAt(valuation, common, basis), scenarios = [];
  function compare(id, panel = valuation, overrides = {}, priceBasis = basis) {
    const runs = runsAt(panel, { ...common, ...overrides }, priceBasis);
    scenarios.push(...Object.entries(runs).map(([strategy, run]) => ({ scenario: id, strategy,
      ...run.period, ...omitCalendar(run.options), ...run.metrics, priceBasis, strategy })));
  }
  for (const slippageBps of protocol.execution.sensitivitySlippageBpsPerSide) compare(`slippage_${slippageBps}bps`, valuation, { slippageBps });
  compare('warmup_50', valuation, { warmupBars: protocol.execution.sensitivityWarmupBars });
  compare('forced_initial_buy', valuation, { initialPosition: 'long' });
  for (const part of period.subperiods) compare(part.id, valuation, { startDate: part.start, endDate: part.end });
  if (adjustedDocument) compare('quote_prices_no_dividends', candidate, {}, 'quote_only');
  const meta = new Map(universe.instruments.map(x => [x.ticker, x]));
  for (const [id, predicate] of [['stocks', x => x.type === 'STOCK'], ['etf_1x', x => x.type === 'ETF' && x.dailyLeverage === 1],
    ['leveraged_inverse_etf', x => x.type === 'ETF' && x.dailyLeverage !== 1], ['SPY', x => x.ticker === 'SPY']]) {
    const subset = { ...valuation, series: valuation.series.filter(s => predicate(meta.get(s.ticker))) };
    if (subset.series.some(s => s.bars.length)) compare(id, subset);
  }
  const v3 = new Map(main.v3.perTicker.map(s => [s.ticker, s]));
  const bh = new Map(main.buy_hold.perTicker.map(s => [s.ticker, s]));
  const perTicker = main.long_trend_200.perTicker.map(s => ({ ticker: s.ticker, inactive: s.inactive,
    v3Return: v3.get(s.ticker).totalReturn, variantReturn: s.totalReturn, buyHoldReturn: bh.get(s.ticker).totalReturn,
    differenceVsV3: s.totalReturn - v3.get(s.ticker).totalReturn, differenceVsBuyHold: s.totalReturn - bh.get(s.ticker).totalReturn,
    v3Trades: v3.get(s.ticker).tradeCount, variantTrades: s.tradeCount, variantDrawdown: s.maxDrawdown, variantCosts: s.totalCost }));
  const beat = rows => rows.long_trend_200 > rows.v3 && rows.long_trend_200 > rows.buy_hold;
  const scenarioBeats = id => beat(Object.fromEntries(scenarios.filter(s => s.scenario === id).map(s => [s.strategy, s.totalReturn])));
  const distribution = { v3: {}, variant: {} }; let conflictingBuyDays = 0, suppressedV3SellDays = 0;
  for (const s of candidate.series) for (let i = 0; i < s.signals.length; i++) {
    const row = s.signals[i];
    if (row.date < period.start || row.date > period.end) continue;
    distribution.v3[row.oldSignal] = (distribution.v3[row.oldSignal] ?? 0) + 1;
    distribution.variant[row.newSignal] = (distribution.variant[row.newSignal] ?? 0) + 1;
    if (['BUY', 'STRONG_BUY'].includes(row.oldSignal) && row.newSignal === 'SELL') conflictingBuyDays++;
    if (['SELL', 'STRONG_SELL'].includes(row.oldSignal) && row.newSignal === 'HOLD') suppressedV3SellDays++;
  }
  return { period, basis, common: omitCalendar(common), main, scenarios, perTicker,
    quality: quotePanel.quality, signalDistribution: distribution, conflictingBuyDays, suppressedV3SellDays,
    criterion: { beatsBothAt5bps: beat(Object.fromEntries(Object.entries(main).map(([k, r]) => [k, r.metrics.totalReturn]))),
      beatsBothAt10bps: scenarioBeats('slippage_10bps'),
      beatsBothInAllFixedSubperiods: period.subperiods.length ? period.subperiods.every(s => scenarioBeats(s.id)) : null,
      prospectiveValidated: false },
    pairedTickers: { active: perTicker.filter(s => !s.inactive).length, variantBeatsV3: perTicker.filter(s => s.differenceVsV3 > 1e-10).length,
      variantBeatsBuyHold: perTicker.filter(s => s.differenceVsBuyHold > 1e-10).length },
    uncertainty: { variantVsV3: blockBootstrapDifference(main.long_trend_200.equityCurve, main.v3.equityCurve),
      variantVsBuyHold: blockBootstrapDifference(main.long_trend_200.equityCurve, main.buy_hold.equityCurve) } };
}

async function fingerprintFor(config, protocol) {
  const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, hash(await fs.readFile(path.join(root, name)))])));
  if (sources['js/scoring.js'] !== protocol.baseline.sourceSha256) throw Error('Production scorer no longer matches the frozen v3 baseline. Use the pinned experiment commit.');
  if (config.length !== protocol.periods.length || new Set(config.map(p => p.id)).size !== config.length) throw Error('Input periods must match protocol exactly.');
  const inputs = [];
  for (const period of protocol.periods) {
    const item = config.find(p => p.id === period.id);
    if (!item?.quote) throw Error('Missing quote input for ' + period.id);
    const hashes = {};
    for (const key of ['quote', 'adjusted', 'v3Cache']) if (item[key]) hashes[key] = hash(await fs.readFile(item[key]));
    if (period.id !== 'known_2025_2026' && !hashes.adjusted) throw Error('Adjusted input required for historical evaluation.');
    inputs.push({ id: period.id, hashes });
  }
  return { sources, inputs, protocolVersion: protocol.experiment };
}

export async function main(args = process.argv.slice(2)) {
  const options = {}; let prepareOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prepare-only') { prepareOnly = true; continue; }
    const name = args[i];
    if (!['--inputs', '--output'].includes(name) || options[name] || !args[i + 1]) throw Error('Usage: --inputs config.json --output DIRECTORY [--prepare-only]');
    options[name] = args[++i];
  }
  if (!options['--inputs'] || !options['--output']) throw Error('Missing --inputs or --output');
  const config = JSON.parse(await fs.readFile(options['--inputs'], 'utf8'));
  const protocol = JSON.parse(await fs.readFile(path.join(root, 'data/validation/long-trend-protocol.json'), 'utf8'));
  const output = path.resolve(options['--output']);
  const normalizedOutput = output.toLowerCase() + path.sep;
  for (const item of config) for (const key of ['quote', 'adjusted', 'v3Cache']) {
    if (item[key] && path.resolve(item[key]).toLowerCase().startsWith(normalizedOutput)) throw Error('Input cannot be inside the result output directory.');
  }
  const fingerprint = await fingerprintFor(config, protocol), fingerprintHash = hash(JSON.stringify(fingerprint));
  await fs.mkdir(output, { recursive: true });
  const freezePath = path.join(output, 'freeze.json'); let freeze;
  try { freeze = JSON.parse(await fs.readFile(freezePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' || !prepareOnly) throw error;
    freeze = { createdAt: new Date().toISOString(), beforeAnyExperimentReturns: true, fingerprintHash, ...fingerprint };
    await fs.writeFile(freezePath, JSON.stringify(freeze, null, 2) + '\n', { flag: 'wx' });
  }
  if (freeze.fingerprintHash !== fingerprintHash) throw Error('Frozen sources/inputs changed. Preserve experiment and disclose any correction.');
  if (prepareOnly) { console.log(JSON.stringify({ freezePath, createdAt: freeze.createdAt, fingerprintHash })); return freeze; }
  const universe = JSON.parse(await fs.readFile(path.join(root, 'data/universe.json'), 'utf8'));
  const expectedTickers = universe.instruments.map(s => s.ticker);
  const summary = { experiment: protocol.experiment, protocol, freeze, periods: [] };
  const allCurves = [], allTickers = [];
  for (const period of protocol.periods) {
    const input = config.find(p => p.id === period.id), frozen = freeze.inputs.find(p => p.id === period.id);
    console.error('Preparing signals for ' + period.id);
    let panel;
    if (input.v3Cache) {
      panel = JSON.parse(await fs.readFile(input.v3Cache, 'utf8'));
      const expected = await validationPanelProvenance(JSON.parse(await fs.readFile(input.quote, 'utf8')), {
        inputSha256: frozen.hashes.quote, expectedTickers, historyDays: 500, minSignalDays: 50 });
      verifyCacheProvenance(panel, expected);
      if (panel.metadata.inputSha256 !== frozen.hashes.quote || panel.metadata.currentEngine.sourceSha256 !== protocol.baseline.sourceSha256) throw Error('Cache does not match input/frozen v3.');
      if (JSON.stringify(panel.series.map(s => s.ticker).sort()) !== JSON.stringify([...expectedTickers].sort())) throw Error('Unexpected cache universe.');
    } else {
      panel = await buildValidationPanel(JSON.parse(await fs.readFile(input.quote, 'utf8')), {
        inputSha256: frozen.hashes.quote, expectedTickers, workers: 4,
        onProgress: p => { if (p.completedTickers % 25 === 0) console.error(`${period.id}: ${p.completedTickers}/${p.totalTickers}`); } });
    }
    const calendar = period.id === 'reserved_2008_2015' ? longTrendCalendar() : period.id === 'known_2018_2023' ? validationCalendar() : JSON.parse(await fs.readFile(path.join(root, 'supabase/calendar.json'), 'utf8'));
    const adjustedDocument = input.adjusted ? JSON.parse(await fs.readFile(input.adjusted, 'utf8')) : null;
    const result = evaluateLongTrend(panel, { adjustedDocument, protocol, period, calendar, universe });
    const folder = path.join(output, period.id); await fs.mkdir(folder, { recursive: true });
    const runs = Object.entries(result.main);
    const curves = runs.flatMap(([strategy, run]) => run.equityCurve.map(row => ({ period: period.id, strategy, ...row })));
    allCurves.push(...curves); allTickers.push(...result.perTicker.map(row => ({ period: period.id, ...row })));
    await Promise.all([
      ['books.json', JSON.stringify(result.main)],
      ['trades.csv', csv(runs.flatMap(([strategy, run]) => run.trades.map(row => ({ strategy, ...row }))))],
      ['executions.csv', csv(runs.flatMap(([strategy, run]) => run.executions.map(row => ({ strategy, ...row }))))],
      ['scenarios.csv', csv(result.scenarios)], ['per-ticker.csv', csv(result.perTicker)], ['equity.csv', csv(curves)]
    ].map(([name, body]) => fs.writeFile(path.join(folder, name), body)));
    summary.periods.push({ ...result, main: Object.fromEntries(runs.map(([key, run]) => [key, compactRun(run)])) });
    console.error('Evaluation saved for ' + period.id);
  }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'equity.csv'), csv(allCurves));
  await fs.writeFile(path.join(output, 'per-ticker.csv'), csv(allTickers));
  console.log(JSON.stringify(summary.periods.map(p => ({ period: p.period.id, main: Object.fromEntries(Object.entries(p.main).map(([k, r]) => [k, r.metrics])), criterion: p.criterion }))));
  return summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
