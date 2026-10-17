#!/usr/bin/env node
// Reads the immutable Supabase close audit; never uploads quotes or repairs data.
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SESSION = '2026-10-19';
const CHECKS = ['calendar_confirmed', 'final_history_valid', 'projection_consistent',
  'history_coverage_valid', 'no_active_repairs', 'no_current_rejections',
  'googlefinance_received', 'yahoo_received', 'worker_active', 'worker_recent_success'];
const ISSUE_CODES = new Set(['MISSING_FINAL_CLOSE', 'INVALID_FINAL_OHLCV', 'PROVISIONAL_CLOSE',
  'STALE_OR_MISSING_PUBLIC_QUOTE', 'PUBLIC_HISTORY_MISMATCH', 'HISTORY_COVERAGE_OR_QUALITY',
  'ACTIVE_REPAIR', 'LATEST_CAPTURE_REJECTED', 'UNIVERSE_COUNT', 'SESSION_NOT_CONFIRMED',
  'GOOGLEFINANCE_RECEIPTS_INCOMPLETE', 'YAHOO_RECEIPTS_INCOMPLETE', 'WORKER_NOT_ACTIVE',
  'WORKER_EXECUTION_FAILED_OR_MISSING']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class AuditError extends Error {
  constructor(code) { super(code); this.name = 'AuditError'; this.code = code; }
}
function requireAudit(condition, code) { if (!condition) throw new AuditError(code); }
export function validSession(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    validSession(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
function count(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}
export function validateUniverse(document) {
  const values = Array.isArray(document) ? document : document?.instruments;
  requireAudit(Array.isArray(values) && values.length === 250, 'UNIVERSE_INVALID');
  const tickers = values.map(row => typeof row === 'string' ? row : row?.ticker);
  requireAudit(tickers.every(ticker => typeof ticker === 'string' && /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker)) &&
    new Set(tickers).size === 250, 'UNIVERSE_INVALID');
  return [...tickers].sort();
}
// This is the single October 19 review: 20:30 New York = 00:30 UTC the next day.
export function minimumCapture(sessionDate) {
  requireAudit(validSession(sessionDate), 'SESSION_INVALID');
  return new Date(Date.parse(`${sessionDate}T00:30:00Z`) + 86400000).toISOString();
}
export function validateSnapshot(rows, universe, {
  sessionDate = DEFAULT_SESSION, minimumCapturedAt = minimumCapture(sessionDate), now = Date.now()
} = {}) {
  const expected = validateUniverse(universe);
  requireAudit(validSession(sessionDate), 'SESSION_INVALID');
  requireAudit(Array.isArray(rows) && rows.length > 0, 'SNAPSHOT_MISSING');
  requireAudit(rows.length === 1 && object(rows[0]), 'SNAPSHOT_AMBIGUOUS');
  const row = rows[0], report = row.report;
  requireAudit(row.session_date === sessionDate && object(report) && report.schema_version === 1 &&
    report.session_date === sessionDate, 'SNAPSHOT_SCHEMA_INVALID');
  requireAudit(timestamp(row.captured_at) && timestamp(report.captured_at) &&
    Date.parse(row.captured_at) === Date.parse(report.captured_at) &&
    Date.parse(row.captured_at) >= Date.parse(minimumCapturedAt) &&
    Date.parse(row.captured_at) <= now + 120000, 'SNAPSHOT_TIME_INVALID');
  requireAudit(Array.isArray(report.universe) && report.universe.length === 250 &&
    report.universe.every(ticker => typeof ticker === 'string') &&
    [...report.universe].sort().every((ticker, index) => ticker === expected[index]), 'SNAPSHOT_UNIVERSE_INVALID');
  requireAudit(report.expected === 250 && count(report.complete, 250) && typeof report.ok === 'boolean' &&
    Array.isArray(report.issues) && object(report.summary) && report.summary.expected === 250 &&
    report.summary.complete === report.complete && report.summary.issues === report.issues.length,
  'SNAPSHOT_COUNTS_INVALID');
  requireAudit(report.issues.length <= 10000 && Object.values(report.summary).every(value =>
    typeof value !== 'number' || count(value)), 'SNAPSHOT_COUNTS_INVALID');
  requireAudit(object(report.checks) && report.checks.universe_count === 250 &&
    CHECKS.every(key => typeof report.checks[key] === 'boolean'), 'SNAPSHOT_CHECKS_INVALID');
  const issueKeys = new Set();
  for (const issue of report.issues) {
    requireAudit(object(issue) && (issue.ticker === null || expected.includes(issue.ticker)) &&
      ISSUE_CODES.has(issue.code), 'SNAPSHOT_ISSUE_INVALID');
    for (const field of ['status', 'reason']) if (own(issue, field) && issue[field] !== null) {
      requireAudit(typeof issue[field] === 'string' && issue[field].length <= 500, 'SNAPSHOT_ISSUE_INVALID');
    }
    if (own(issue, 'last_final_date') && issue.last_final_date !== null) {
      requireAudit(validSession(issue.last_final_date) && issue.last_final_date <= sessionDate, 'SNAPSHOT_ISSUE_INVALID');
    }
    if (own(issue, 'next_retry_at') && issue.next_retry_at !== null) {
      requireAudit(timestamp(issue.next_retry_at), 'SNAPSHOT_ISSUE_INVALID');
    }
    for (const field of ['expected_history_days', 'actual_history_days']) if (own(issue, field)) {
      requireAudit(count(issue[field]), 'SNAPSHOT_ISSUE_INVALID');
    }
    const key = `${issue.ticker ?? '*'}:${issue.code}`;
    requireAudit(!issueKeys.has(key), 'SNAPSHOT_ISSUE_DUPLICATED'); issueKeys.add(key);
  }
  requireAudit(object(report.automatic) && object(report.automatic.worker), 'SNAPSHOT_AUTOMATIC_INVALID');
  for (const provider of ['googlefinance', 'yahoo']) {
    const value = report.automatic[provider];
    requireAudit(object(value) && count(value.received) && count(value.distinct_tickers, 250) &&
      value.distinct_tickers <= value.received && value.execution_origin_recorded === false &&
      (value.last_received_at === null || timestamp(value.last_received_at)), 'SNAPSHOT_AUTOMATIC_INVALID');
    requireAudit(report.checks[`${provider}_received`] === (value.distinct_tickers === 250), 'SNAPSHOT_AUTOMATIC_INCONSISTENT');
  }
  const worker = report.automatic.worker;
  requireAudit(typeof worker.active === 'boolean' && count(worker.recent_successes) && count(worker.recent_failures) &&
    (worker.last_success_at === null || timestamp(worker.last_success_at)) &&
    report.checks.worker_active === worker.active &&
    report.checks.worker_recent_success === (worker.recent_successes > 0 && worker.recent_failures === 0), 'SNAPSHOT_AUTOMATIC_INCONSISTENT');
  const healthy = report.complete === 250 && report.issues.length === 0 && CHECKS.every(key => report.checks[key]);
  requireAudit(report.ok === healthy && (report.complete === 250 || report.issues.length > 0) &&
    (healthy || report.issues.length > 0), 'SNAPSHOT_RESULT_INCONSISTENT');
  return report;
}

export function readPublicConfig(source, env = {}) {
  const constant = name => source.match(new RegExp(`\\bconst\\s+${name}\\s*=\\s*["']([^"']+)["']\\s*;`))?.[1];
  const url = env.SUPABASE_URL || constant('SUPABASE_URL');
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.PUBLISHABLE_KEY || constant('SUPABASE_KEY');
  let parsed; try { parsed = new URL(url); } catch { throw new AuditError('PUBLIC_CONFIG_INVALID'); }
  requireAudit(parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(key || ''), 'PUBLIC_CONFIG_INVALID');
  return { url: parsed.origin, key };
}
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
export async function requestJson(url, options = {}, { fetchImpl = fetch, sleepImpl = sleep, attempts = 3 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) }); }
    catch {
      if (attempt + 1 < attempts) { await sleepImpl(500 * 2 ** attempt); continue; }
      throw new AuditError('HTTP_TRANSPORT_ERROR');
    }
    if ([429, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
      await sleepImpl(500 * 2 ** attempt); continue;
    }
    requireAudit(response.ok, `HTTP_STATUS_${response.status}`);
    let value; try { value = await response.json(); } catch { throw new AuditError('HTTP_JSON_INVALID'); }
    return value;
  }
  throw new AuditError('HTTP_TRANSPORT_ERROR');
}
export async function fetchSnapshot(config, sessionDate, {
  fetchImpl = fetch, sleepImpl = sleep, now = Date.now, maxPollMs = 180000, probe = false
} = {}) {
  requireAudit(validSession(sessionDate), 'SESSION_INVALID');
  const url = new URL(`${config.url}/rest/v1/market_close_audits`);
  url.searchParams.set('session_date', `eq.${sessionDate}`);
  url.searchParams.set('select', 'session_date,captured_at,report');
  url.searchParams.set('limit', '2');
  const started = now();
  for (let poll = 0; poll <= 12; poll++) {
    const rows = await requestJson(url, { headers: { apikey: config.key } }, { fetchImpl, sleepImpl });
    requireAudit(Array.isArray(rows), 'SNAPSHOT_SCHEMA_INVALID');
    if (probe || rows.length || now() - started >= maxPollMs || poll === 12) return rows;
    await sleepImpl(Math.min(15000, Math.max(0, maxPollMs - (now() - started))));
  }
  return [];
}

export function escapeMarkdown(value) {
  return String(value ?? '—').slice(0, 500).replace(/[\\`*_[\]{}()!#]/g, '\\$&')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;').replace(/\|/g, '&#124;').replace(/[\r\n]/g, ' ');
}
export function renderReport({ sessionDate, report, error, runUrl }) {
  const lines = [`## Market Scanner — cierre ${escapeMarkdown(sessionDate)}`, ''];
  if (error) lines.push(`No se pudo comprobar el cierre: **${escapeMarkdown(error)}**.`, '',
    'Esto es una incidencia de verificación; no se han modificado ni aceptado precios.');
  else {
    lines.push(`Cierres confirmados: **${report.complete}/250**. Incidencias: **${report.issues.length}**.`, '');
    if (report.issues.length) {
      lines.push('| Ticker | Motivo | Estado | Último cierre | Próximo reintento |', '|---|---|---|---|---|');
      for (const issue of report.issues) lines.push(`| ${[issue.ticker ?? 'GLOBAL', issue.code, issue.status,
        issue.last_final_date, issue.next_retry_at].map(escapeMarkdown).join(' | ')} |`);
    } else lines.push('Los 250 tickers tienen un cierre válido para la sesión y todos los controles del informe están conformes.');
    lines.push('', `Snapshot: ${escapeMarkdown(report.captured_at)}.`, '',
      'La recepción de datos está comprobada; los recibos no identifican si Google inició la carga mediante temporizador o manualmente.');
  }
  if (runUrl) lines.push('', `Ejecución de GitHub: ${runUrl}`);
  return `${lines.join('\n')}\n`;
}
async function incidentContext({ repository, token, sessionDate, apiUrl = 'https://api.github.com' }, deps) {
  requireAudit(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') && token && validSession(sessionDate), 'GITHUB_CONFIG_MISSING');
  let parsed; try { parsed = new URL(apiUrl); } catch { throw new AuditError('GITHUB_CONFIG_INVALID'); }
  requireAudit(parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'GITHUB_CONFIG_INVALID');
  const marker = `<!-- market-scanner-close-audit:${sessionDate} -->`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
  const base = `${parsed.origin}/repos/${repository}/issues`;
  const matches = [];
  for (let page = 1; page <= 100; page++) {
    const issues = await requestJson(`${base}?state=all&per_page=100&page=${page}`, { headers }, deps);
    requireAudit(Array.isArray(issues), 'GITHUB_RESPONSE_INVALID');
    matches.push(...issues.filter(issue => !issue.pull_request && typeof issue.body === 'string' && issue.body.includes(marker)));
    if (issues.length < 100) break;
    requireAudit(page < 100, 'GITHUB_PAGINATION_LIMIT');
  }
  return { base, headers, marker, matches: matches.sort((a, b) => a.number - b.number) };
}
export async function upsertIncident(config, deps = {}) {
  const { base, headers, marker, matches } = await incidentContext(config, deps);
  const { sessionDate, body } = config;
  const existing = matches.find(issue => issue.user?.login === 'github-actions[bot]');
  const payload = { title: `Market Scanner: incidencias del cierre ${sessionDate}`, body: `${marker}\n${body}`, state: 'open' };
  if (!existing) payload.assignees = ['jpmauricio2906-bot'];
  if (existing) requireAudit(Number.isSafeInteger(existing.number) && existing.number > 0, 'GITHUB_RESPONSE_INVALID');
  // Do not retry an ambiguous POST: a server may have created it before the connection broke.
  const result = await requestJson(existing ? `${base}/${existing.number}` : base,
    { method: existing ? 'PATCH' : 'POST', headers, body: JSON.stringify(payload) }, { ...deps, attempts: 1 });
  requireAudit(object(result) && Number.isSafeInteger(result.number), 'GITHUB_RESPONSE_INVALID');
  return { number: result.number, updated: Boolean(existing) };
}
export async function closeRecoveredIncident(config, deps = {}) {
  const { base, headers, marker, matches } = await incidentContext(config, deps);
  // Only this workflow's bot may have its earlier alert closed automatically.
  const existing = matches.find(issue => issue.state === 'open' && issue.user?.login === 'github-actions[bot]');
  if (!existing) return null;
  requireAudit(Number.isSafeInteger(existing.number) && existing.number > 0, 'GITHUB_RESPONSE_INVALID');
  const result = await requestJson(`${base}/${existing.number}`, { method: 'PATCH', headers,
    body: JSON.stringify({ state: 'closed', state_reason: 'completed', body: `${marker}\n${config.body}\nRevisión posterior conforme; incidencia resuelta.` })
  }, { ...deps, attempts: 1 });
  requireAudit(object(result) && result.number === existing.number, 'GITHUB_RESPONSE_INVALID');
  return { number: result.number, closed: true };
}

export function parseArguments(args) {
  const result = { sessionDate: DEFAULT_SESSION, noNotify: false, probe: false, input: null };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--session') result.sessionDate = args[++index];
    else if (args[index] === '--input') result.input = args[++index];
    else if (args[index] === '--no-notify') result.noNotify = true;
    else if (args[index] === '--probe') result.probe = true;
    else throw new AuditError('ARGUMENT_INVALID');
  }
  requireAudit(validSession(result.sessionDate) && (result.input === null || typeof result.input === 'string'), 'ARGUMENT_INVALID');
  requireAudit(!result.input || result.noNotify, 'FIXTURE_REQUIRES_NO_NOTIFY');
  return result;
}
export async function main(args = process.argv.slice(2), env = process.env) {
  let options = { sessionDate: env.TARGET_SESSION || DEFAULT_SESSION,
    noNotify: args.includes('--no-notify') || args.includes('--input'), probe: args.includes('--probe') };
  let report = null, error = null, status = 2;
  try {
    options = parseArguments(env.TARGET_SESSION && !args.includes('--session') ? ['--session', env.TARGET_SESSION, ...args] : args);
    const universe = validateUniverse(JSON.parse(await readFile(resolve(ROOT, 'data/universe.json'), 'utf8')));
    let rows;
    if (options.input) {
      const fixture = JSON.parse(await readFile(resolve(options.input), 'utf8'));
      rows = Array.isArray(fixture) ? fixture : [fixture];
    } else {
      const config = readPublicConfig(await readFile(resolve(ROOT, 'js/config.js'), 'utf8'), env);
      rows = await fetchSnapshot(config, options.sessionDate, { probe: options.probe });
    }
    if (options.probe) {
      console.log('Conectividad de lectura Supabase: correcta. Esta prueba no evalúa el cierre ni emite avisos.');
      return 0;
    }
    report = validateSnapshot(rows, universe, { sessionDate: options.sessionDate });
    status = report.ok ? 0 : 1;
  } catch (failure) { error = failure instanceof AuditError ? failure.code : 'AUDIT_INTERNAL_ERROR'; }
  const repository = env.GITHUB_REPOSITORY;
  const runUrl = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') && /^\d+$/.test(env.GITHUB_RUN_ID || '')
    ? `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const safeSession = validSession(options.sessionDate) ? options.sessionDate : DEFAULT_SESSION;
  let markdown = renderReport({ sessionDate: safeSession, report, error, runUrl });
  if (status && !options.noNotify && !options.probe) {
    try {
      const issue = await upsertIncident({ repository, token: env.GITHUB_TOKEN, sessionDate: safeSession,
        body: markdown, apiUrl: env.GITHUB_API_URL });
      markdown += `\nIncidencia GitHub: #${issue.number}.\n`;
    } catch (failure) {
      const code = failure instanceof AuditError ? failure.code : 'GITHUB_NOTIFICATION_ERROR';
      markdown += `\nNo se pudo publicar el aviso: ${code}. Consulta esta ejecución de Actions.\n`; status = 2;
    }
  } else if (!status && !options.noNotify && !options.probe) {
    try {
      const issue = await closeRecoveredIncident({ repository, token: env.GITHUB_TOKEN,
        sessionDate: safeSession, body: markdown, apiUrl: env.GITHUB_API_URL });
      if (issue) markdown += `\nIncidencia recuperada y cerrada: #${issue.number}.\n`;
    } catch (failure) {
      const code = failure instanceof AuditError ? failure.code : 'GITHUB_NOTIFICATION_ERROR';
      markdown += `\nNo se pudo comprobar si había un aviso anterior que cerrar: ${code}.\n`; status = 2;
    }
  }
  try {
    const directory = resolve(env.AUDIT_OUTPUT_DIR || resolve(ROOT, 'outputs', `close-audit-${safeSession}`));
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'audit.json'), `${JSON.stringify({ session_date: safeSession, status, error, report }, null, 2)}\n`);
    await writeFile(resolve(directory, 'audit.md'), markdown);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, markdown);
  } catch { console.error('ARTIFACT_WRITE_ERROR'); return 2; }
  console.log(markdown);
  return status;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
