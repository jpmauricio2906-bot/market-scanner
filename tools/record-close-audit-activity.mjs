#!/usr/bin/env node
// Keep a functional record of monitor activity; this never describes market data.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newYorkParts, validDate } from './close-audit-schedule.mjs';

const REPOSITORY = 'jpmauricio2906-bot/market-scanner';
const API = 'https://api.github.com';
const CONTENT_PATH = '.github/close-audit-activity.json';
const MAX_AGE = 28 * 86400000;
const KEYS = ['last_checked_at', 'monitor', 'schema_version', 'session_date'];
export class ActivityError extends Error {
  constructor(code) { super(code); this.name = 'ActivityError'; this.code = code; }
}
const requireValue = (condition, code) => { if (!condition) throw new ActivityError(code); };
export function validateMetadata(value, now = Date.now()) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === KEYS.join(',') && value.schema_version === 1 &&
    value.monitor === 'daily-close-audit' && typeof value.last_checked_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.last_checked_at) &&
    validDate(value.last_checked_at.slice(0, 10)) && Number.isFinite(Date.parse(value.last_checked_at)) &&
    Date.parse(value.last_checked_at) <= now && validDate(value.session_date) &&
    newYorkParts(value.last_checked_at).date === value.session_date, 'ACTIVITY_METADATA_INVALID');
  return value;
}
export function activityPlan(previous, now = Date.now()) {
  requireValue(Number.isFinite(now), 'ACTIVITY_TIME_INVALID');
  if (previous !== null) validateMetadata(previous, now);
  const needed = previous === null || Date.parse(previous.last_checked_at) < now - MAX_AGE;
  return { needed, metadata: { schema_version: 1, monitor: 'daily-close-audit',
    last_checked_at: new Date(now).toISOString(), session_date: newYorkParts(now).date } };
}
function decodeFile(file) {
  requireValue(file && file.type === 'file' && file.encoding === 'base64' &&
    typeof file.sha === 'string' && /^[a-f0-9]{40}$/.test(file.sha) &&
    typeof file.content === 'string' && file.content.length <= 4096, 'ACTIVITY_FILE_INVALID');
  const encoded = file.content.replace(/[\r\n]/g, '');
  requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'ACTIVITY_FILE_INVALID');
  const bytes = Buffer.from(encoded, 'base64');
  requireValue(bytes.toString('base64') === encoded && bytes.length <= 2048, 'ACTIVITY_FILE_INVALID');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ActivityError('ACTIVITY_METADATA_INVALID'); }
}
export async function recordActivity({ repository = REPOSITORY, apiUrl = API, token,
  dryRun = false, now = Date.now() } = {}, { fetchImpl = fetch } = {}) {
  requireValue(repository === REPOSITORY && apiUrl === API, 'ACTIVITY_DESTINATION_INVALID');
  const endpoint = `${API}/repos/${REPOSITORY}/contents/${CONTENT_PATH}`;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = async (url, options) => {
    let result;
    try { result = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw new ActivityError('ACTIVITY_HTTP_TRANSPORT_ERROR'); }
    return result;
  };
  const read = await request(`${endpoint}?ref=main`, { headers });
  let previous = null, sha;
  if (read.status !== 404) {
    requireValue(read.ok, `ACTIVITY_HTTP_STATUS_${read.status}`);
    let file; try { file = await read.json(); } catch { throw new ActivityError('ACTIVITY_FILE_INVALID'); }
    previous = validateMetadata(decodeFile(file), now); sha = file.sha;
  }
  const plan = activityPlan(previous, now);
  if (!plan.needed || dryRun) return { changed: false, needed: plan.needed, dry_run: dryRun };
  requireValue(typeof token === 'string' && token.length > 0, 'ACTIVITY_WRITE_TOKEN_REQUIRED');
  const payload = { message: 'Update daily close audit activity record', branch: 'main',
    content: Buffer.from(`${JSON.stringify(plan.metadata, null, 2)}\n`, 'utf8').toString('base64') };
  if (sha) payload.sha = sha;
  // A failed or ambiguous PUT is never retried; the next scheduled run reads first.
  const written = await request(endpoint, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) });
  requireValue(written.ok, `ACTIVITY_HTTP_STATUS_${written.status}`);
  let result; try { result = await written.json(); } catch { throw new ActivityError('ACTIVITY_WRITE_RESPONSE_INVALID'); }
  requireValue(typeof result?.commit?.sha === 'string' && /^[a-f0-9]{40}$/.test(result.commit.sha), 'ACTIVITY_WRITE_RESPONSE_INVALID');
  return { changed: true, needed: true, dry_run: false, commit_sha: result.commit.sha };
}
export async function main(args = process.argv.slice(2), env = process.env) {
  try {
    requireValue(args.every(arg => arg === '--dry-run'), 'ACTIVITY_ARGUMENT_INVALID');
    const result = await recordActivity({ repository: env.GITHUB_REPOSITORY || REPOSITORY,
      apiUrl: env.GITHUB_API_URL || API, token: env.GITHUB_TOKEN, dryRun: args.includes('--dry-run') });
    console.log(JSON.stringify(result)); return 0;
  } catch (failure) {
    console.error(failure instanceof ActivityError ? failure.code : 'ACTIVITY_INTERNAL_ERROR'); return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
