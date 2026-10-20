// Presentation-only: copies the frozen evaluation without recalculating returns.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { csv } from './backtest.mjs';
const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) throw Error('Missing ' + name);
  return args[i + 1];
}
const input = option('--input'), output = option('--output');
const bytes = fs.readFileSync(input), results = JSON.parse(bytes);
if (results.experiment !== 'long-trend-200-v1' || results.periods.length !== 3) throw Error('Unexpected experiment.');
const curves = [], instruments = [];
for (const period of results.periods) {
  const books = JSON.parse(fs.readFileSync(path.join(path.dirname(input), period.period.id, 'books.json')));
  const entries = Object.entries(books);
  for (const [strategy, book] of entries) {
    if (JSON.stringify(book.metrics) !== JSON.stringify(period.main[strategy].metrics)) throw Error('Book metrics do not match result: ' + strategy);
  }
  books.v3.equityCurve.forEach((row, i) => {
    const record = { period: period.period.id, date: row.date };
    for (const [strategy, book] of entries) {
      const point = book.equityCurve[i];
      if (point.date !== row.date) throw Error('Misaligned equity dates.');
      record[strategy + '_equity_usd'] = point.equity;
      record[strategy + '_drawdown_fraction'] = point.drawdown;
    }
    curves.push(record);
  });
  instruments.push(...period.perTicker.map(row => ({ period: period.period.id, ...row })));
}
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'long-trend-results.json'), bytes);
fs.writeFileSync(path.join(output, 'long-trend-equity.csv'), csv(curves));
fs.writeFileSync(path.join(output, 'long-trend-per-ticker.csv'), csv(instruments));
console.log(JSON.stringify({ sourceResultsSha256: createHash('sha256').update(bytes).digest('hex'),
  periods: results.periods.length, equityRows: curves.length, instrumentRows: instruments.length, output }));
