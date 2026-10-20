#!/usr/bin/env node
// Presentation-only export: never recalculates signals, strategies or parameters.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return args[i + 1];
}
const input = option('--input');
const output = option('--output');
const bytes = fs.readFileSync(input);
const results = JSON.parse(bytes);
if (!results.signalsUseQuotedPrices || !results.main?.new?.metrics || !results.freeze) {
  throw new Error('Expected the frozen evaluation using quoted-price signals.');
}
const compactRun = ({ equityCurve, trades, executions, perTicker, options, ...rest }) => {
  const { calendarDates, ...compactOptions } = options;
  return { ...rest, options: compactOptions };
};
const { main, development, perTicker, settings, ...rest } = results;
const { calendarDates, ...compactSettings } = settings;
const summary = {
  ...rest,
  settings: compactSettings,
  main: Object.fromEntries(Object.entries(main).map(([key, value]) => [key, compactRun(value)])),
  development: Object.fromEntries(Object.entries(development).map(([key, value]) => [key, compactRun(value)])),
  export: {
    sourceResultsSha256: createHash('sha256').update(bytes).digest('hex'),
    omitted: 'Daily curves, individual trades, executions and per-ticker books; the complete captured evaluation is preserved locally.',
    units: 'Returns and drawdowns without a Pct suffix are decimal fractions, not percentages. Equity and costs are USD. old=frozen baseline v2; new=candidate v3.',
  },
};
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'exit-v3-results.json'), `${JSON.stringify(summary, null, 2)}\n`);
function csv(rows) {
  const keys = Object.keys(rows[0]);
  const cell = value => {
    const str = String(value ?? '');
    return /[",\n\r]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
  };
  return [keys.join(','), ...rows.map(row => keys.map(key => cell(row[key])).join(','))].join('\n') + '\n';
}
fs.writeFileSync(path.join(output, 'exit-v3-per-ticker.csv'), csv(perTicker));
const series = Object.entries(main);
const curves = main.new.equityCurve.map((row, index) => {
  const out = { date: row.date };
  for (const [key, value] of series) {
    const point = value.equityCurve[index];
    if (!point || point.date !== row.date) throw new Error(`Unaligned curve: ${key} ${row.date}`);
    out[`${key}_equity_usd`] = point.equity;
    out[`${key}_drawdown_fraction`] = point.drawdown;
  }
  return out;
});
fs.writeFileSync(path.join(output, 'exit-v3-equity.csv'), csv(curves));
console.log(JSON.stringify({ exported: output, sourceResultsSha256: summary.export.sourceResultsSha256, instruments: perTicker.length, sessions: curves.length }));
