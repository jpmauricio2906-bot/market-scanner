# Independent backtesting history worker

This worker maintains `public.backtest_history`, independently of the scanner's
500-session `public.market_history`. It never calls the scanner repair or quote
publication functions. The archive uses Yahoo's provider OHLC and volume, with
its split representation and **without cash dividends**. No optimization or
strategy evaluation occurs during ingestion.

The server assigns an explicit rolling eleven-year interval ending on the latest
confirmed exchange session: ten years for analysis and an earlier year for
indicator warm-up. IPOs retain their actual shorter history. The server validates
every row, provider identity, USD, New York timezone, complete exchange-session
coverage, source freshness, OHLCV and split metadata. Only OHLC envelope errors
within `1e-6 × close` are normalized and counted. Material invalid rows, gaps and
duplicates reject the entire ticker; no missing sessions are filled.

Publication is atomic per ticker. A validated full download replaces changed
bars, retains unchanged rows without rewriting them and removes dates outside
the accepted window. A snapshot UUID in `backtest_history_coverage` permits a
reader to detect concurrent refreshes. A provider listing date cannot move
forward and erase known in-window data. A failed refresh preserves the previously
accepted series and its `ready` status, while `last_error` records the failure.
An instrument without an accepted download stays `pending`.

There is one bounded bootstrap exception for an empty archive. If its first
download fails OHLC validation, attempt two may request a new complete download
ending on the immediately previous confirmed session. Every row in that download
must pass the same checks; historical defects still reject it. A successful
bootstrap is `ready` with `last_error=LATEST_SESSION_UNAVAILABLE` and its actual
older end date. A failure returns attempt three to the current session. Already
accepted archives never use this bootstrap; daily refreshes retry the current
session and preserve their accepted snapshot if validation fails. No source row
is removed or modified to make a download pass.

The separate private queue exposes these service-only RPCs:

- `backtest_claim_history(p_limit)` returns at most two jobs, with an eleven-year
  interval and a ten-minute lease token. An advisory lock enforces at most two
  live leases globally, including overlapping Cron or manual invocations.
- `backtest_replace_history(p_job_id,p_lease_token,p_payload)` validates and
  publishes the complete ticker or records a rejection.
- `backtest_fail_history(p_job_id,p_lease_token,p_reason)` records a transport
  failure with delays of 2, 4, 8 and 16 minutes, then one hour between attempts.

Each invocation accepts only POST plus the mandatory private
`X-Market-Worker-Token`. It calls the existing service-only
`market_verify_worker_token` before claiming work. The caller cannot choose
tickers, dates or payloads. Configure `verify_jwt=false`; the mandatory private
token replaces the platform JWT gate. The worker prefers platform
`SUPABASE_SECRET_KEYS.default` and supports `SUPABASE_SERVICE_ROLE_KEY` as a
fallback. Keys stay in Edge runtime; only legacy JWT keys use an Authorization
header. New secret keys use the `apikey` header.

Yahoo downloads run concurrently for two jobs, with a 20-second per-download
timeout and 4 MB body cap. The shared request budget is 85 seconds, with a
separate five-second failure cleanup allowance. The worker returns counts and
generic errors only, never provider bodies, SQL diagnostics or credentials.

The SQL installation uses RLS and explicit public SELECT grants on the two public
tables. Private tables and write RPCs have no anonymous/authenticated grants.
Direct history writes are guarded. A 420 MiB database-size guard pauses claims,
dispatch and publication before the current 500 MB plan limit. It is a protective
threshold, not a storage quota or paid upgrade. Provenance stores hashes and
compact metadata for thirty days, without repeated raw downloads or duplicate
bar snapshots.

Deployment order:

1. Apply `supabase/backtest_history.sql` with its reviewed calendar seed.
2. Deploy this worker and verify missing/incorrect tokens return 401.
3. Execute all of `supabase/tests/backtest_history.sql` in one connection. The
   fixtures are synthetic and all their effects are rolled back.
4. Apply `supabase/activate_backtest_history.sql` to enqueue the initial backfill,
   dispatch eligible work each minute, and queue daily full refreshes at 20:45
   New York on confirmed trading days. Reusing the Cron names is idempotent.
5. Verify per-ticker coverage, queue failures and public read/write permissions.

Rebuild the historical calendar seed with
`node tools/build-backtest-calendar.mjs`; `--check` verifies it without edits.
The scanner calendar and frozen historical experiment calendars stay unchanged.

Operational inspection uses `market_scanner.backtest_history_queue`,
`market_scanner.backtest_history_audit`, `public.backtest_history_coverage` and
`pg_database_size(current_database())`. The source remains the current universe;
delisted instruments, historical membership and point-in-time vendor vintages
are not supplied by this archive.

Runtime and credential behavior follow the official
[Edge Function limits](https://supabase.com/docs/guides/functions/limits),
[API-key migration](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys),
and [RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security).
