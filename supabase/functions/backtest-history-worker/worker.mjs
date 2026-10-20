/** Independent long-history transport. SQL owns the dates, validation and atomic publication. */
const DEFAULT_LIMITS = Object.freeze({
  budgetMs: 85_000,
  yahooMs: 20_000,
  rpcMs: 25_000,
  claimMs: 10_000,
  verifyMs: 10_000,
  failMs: 5_000,
});

class WorkerFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  } });
}

async function readJson(response, limit, stage) {
  if (response.status === 204) return null;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new WorkerFailure(stage + "_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WorkerFailure(stage + "_invalid_json");
  const chunks = [], decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new WorkerFailure(stage + "_response_too_large");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally { reader.releaseLock(); }
  try {
    const raw = chunks.join("");
    const body = JSON.parse(raw);
    if (stage !== "yahoo") return body;
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return { body, sourceSha256: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("") };
  }
  catch { throw new WorkerFailure(stage + "_invalid_json"); }
}

function isJob(job) {
  return job && ((typeof job.id === "number" && Number.isSafeInteger(job.id) && job.id > 0) ||
    (typeof job.id === "string" && /^[1-9]\d*$/.test(job.id))) &&
    typeof job.ticker === "string" && /^[A-Z][A-Z0-9-]{0,9}$/.test(job.ticker) &&
    typeof job.yahoo_symbol === "string" && job.yahoo_symbol.length > 0 && job.yahoo_symbol.length <= 64 &&
    typeof job.lease_token === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.lease_token) &&
    isDate(job.requested_start) && isDate(job.requested_end) && job.requested_start < job.requested_end &&
    Date.parse(job.requested_end) - Date.parse(job.requested_start) <= 12 * 366 * 86400000;
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function yahooPayload(body, job, requestedAt, fetchedAt, sourceSha256) {
  const result = body?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !Array.isArray(result.timestamp) || !quote || typeof quote !== "object") {
    throw new WorkerFailure("yahoo_invalid_response");
  }
  const meta = result.meta ?? {};
  // Preserve nulls, bad numbers, duplicate times and provisional rows for SQL to
  // validate. Never silently filter or relabel a price, session, split or ticker.
  return {
    ticker: job.ticker,
    source: "yahoo",
    symbol: meta.symbol ?? null,
    currency: meta.currency ?? null,
    exchange_timezone: meta.exchangeTimezoneName ?? null,
    exchange_name: meta.exchangeName ?? null,
    first_trade_epoch: meta.firstTradeDate ?? null,
    regular_market_time: meta.regularMarketTime ?? null,
    requested_at: requestedAt,
    fetched_at: fetchedAt,
    requested_start: job.requested_start,
    requested_end: job.requested_end,
    source_sha256: sourceSha256,
    rows: result.timestamp.map((timestamp, n) => ({
      timestamp,
      open: quote.open?.[n] ?? null,
      high: quote.high?.[n] ?? null,
      low: quote.low?.[n] ?? null,
      close: quote.close?.[n] ?? null,
      volume: quote.volume?.[n] ?? null,
    })),
    splits: Object.entries(result.events?.splits ?? {}).map(([epoch, split]) => ({
      timestamp: split?.date ?? Number(epoch),
      numerator: split?.numerator ?? null,
      denominator: split?.denominator ?? null,
    })),
  };
}

export function createBacktestHistoryWorker({
  supabaseUrl = "", serviceRoleKey = "", fetchImpl = fetch, now = Date.now, limits = {},
} = {}) {
  const base = supabaseUrl.replace(/\/+$/, "");
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base) &&
    typeof serviceRoleKey === "string" && serviceRoleKey.length > 0;
  const timeouts = { ...DEFAULT_LIMITS, ...limits };

  async function jsonFetch(url, options, stage, milliseconds, signal, maxBytes) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchImpl(url, { ...options, redirect: "error", signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new WorkerFailure(stage + "_http_" + response.status);
      }
      return await readJson(response, maxBytes, stage);
    } catch (error) {
      if (controller.signal.aborted) throw new WorkerFailure(stage + "_timeout");
      if (error instanceof WorkerFailure) throw error;
      throw new WorkerFailure(stage + "_transport_failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  function rpc(name, args, stage, milliseconds, signal) {
    return jsonFetch(base + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: { apikey: serviceRoleKey, ...(serviceRoleKey.startsWith("sb_secret_") ? {} : { Authorization: "Bearer " + serviceRoleKey }), "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }, stage, milliseconds, signal, 65_536);
  }

  async function repair(job, signal) {
    try {
      const requestedAt = new Date(now()).toISOString();
      const query = new URLSearchParams({ interval: "1d", period1: String(Date.parse(job.requested_start) / 1000),
        period2: String(Date.parse(job.requested_end) / 1000 + 86400), events: "splits", includePrePost: "false" });
      const yahoo = await jsonFetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(job.yahoo_symbol) +
        "?" + query, {
        method: "GET", headers: { "User-Agent": "Mozilla/5.0" },
      }, "yahoo", timeouts.yahooMs, signal, 4_000_000);
      const payload = yahooPayload(yahoo.body, job, requestedAt, new Date(now()).toISOString(), yahoo.sourceSha256);
      const result = await rpc("backtest_replace_history", {
        p_job_id: job.id, p_lease_token: job.lease_token, p_payload: payload,
      }, "replace", timeouts.rpcMs, signal);
      if (result?.status === "completed") return { status: "completed" };
      // A semantic rejection has already been persisted by the SQL transaction.
      if (result?.status === "rejected") return { status: "rejected" };
      throw new WorkerFailure("replace_invalid_response");
    } catch (error) {
      const reason = error instanceof WorkerFailure ? error.code : "worker_failed";
      try {
        // Five seconds for cleanup after the 85s request budget; the 10-minute
        // SQL lease still recovers the job if the runtime dies before this RPC.
        await rpc("backtest_fail_history", {
          p_job_id: job.id, p_lease_token: job.lease_token, p_reason: reason,
        }, "fail", timeouts.failMs);
        return { status: "failed", reported: true };
      } catch { return { status: "failed", reported: false }; }
    }
  }

  return async function backtestHistoryWorker(request) {
    if (request.method !== "POST") return reply(405, { error: "method_not_allowed" }, { Allow: "POST" });
    // No JWT or public API key substitutes for Cron's independently scoped token.
    const token = request.headers.get("X-Market-Worker-Token") ?? "";
    if (!/^[0-9a-f]{64}$/i.test(token)) return reply(401, { error: "unauthorized" });
    if (!configured) return reply(503, { error: "worker_unavailable" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeouts.budgetMs);
    try {
      let verified;
      try {
        verified = await rpc("market_verify_worker_token", { p_token: token }, "verify", timeouts.verifyMs, controller.signal);
      } catch { return reply(503, { error: "worker_unavailable" }); }
      if (verified !== true) return reply(401, { error: "unauthorized" });
      let jobs;
      try { jobs = await rpc("backtest_claim_history", { p_limit: 2 }, "claim", timeouts.claimMs, controller.signal); }
      catch { return reply(503, { error: "repair_queue_unavailable" }); }
      if (!Array.isArray(jobs) || jobs.length > 2 || jobs.some(job => !isJob(job)) || new Set(jobs.map(job => String(job.id))).size !== jobs.length) {
        return reply(503, { error: "repair_queue_unavailable" });
      }
      const results = await Promise.all(jobs.map(job => repair(job, controller.signal)));
      const summary = {
        claimed: jobs.length,
        completed: results.filter(r => r.status === "completed").length,
        rejected: results.filter(r => r.status === "rejected").length,
        failed: results.filter(r => r.status === "failed").length,
        unreported: results.filter(r => r.status === "failed" && !r.reported).length,
      };
      return reply(summary.unreported ? 503 : 200, { ok: !summary.unreported, ...summary });
    } catch { return reply(503, { error: "worker_unavailable" }); }
    finally { clearTimeout(timer); }
  };
}
