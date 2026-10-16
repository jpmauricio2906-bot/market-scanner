# Market history repair worker

This private worker transports queued history repairs. Postgres owns the ticker
universe, leases, date/session rules, OHLCV validation, split handling, retention,
transactional replacement and retries. The worker does not write a table directly
or accept ticker/history data from its caller.

Only `POST` requests with `X-Market-Worker-Token` are accepted. Cron obtains a
32-byte random token (64 hexadecimal characters) from Vault. Before claiming work,
the handler calls the service-only RPC `market_verify_worker_token(p_token)`.
The database compares the token with a private hash. Missing or invalid tokens
return 401; a public API key or user/service JWT by itself never authorizes a call.
No token, credential, provider body or SQL diagnostic is logged or returned.

Deploy with `verify_jwt = false`, because this endpoint uses the mandatory token
check above instead of the platform JWT gate. This is **not** an anonymous worker.
The platform-supplied `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are used only
inside the Edge runtime for its private RPC calls. Do not copy a service key into
Sheets, GitHub, the Cron request or its Vault token.

The handler claims at most two jobs using `market_claim_repairs(p_limit: 2)`.
Each contains `id`, `ticker`, `yahoo_symbol` and `lease_token`. It downloads Yahoo's
complete daily `3y` chart and passes the raw metadata, timestamps, OHLCV values and
splits to `market_replace_history(p_job_id, p_lease_token, p_payload)`. Nulls,
duplicate timestamps and incomplete bars are preserved for the SQL validator.
SQL returns `status: completed` on success or `status: rejected` after persisting
a semantic rejection. Only HTTP/transport/protocol failures cause the separate
`market_fail_repair` call, with a bounded generic reason and the same lease.

Two downloads run concurrently. The shared request budget is 85 seconds; failure
cleanup gets at most five additional seconds. Yahoo requests have a 20-second
timeout and bodies are capped at 2 MB. SQL calls have individual timeouts. The
10-minute SQL lease recovers work if the runtime stops before it records failure.
The response contains counts only. No external package or browser access is used.

Auth/configuration and runtime limits were checked against the official
[function configuration](https://supabase.com/docs/guides/functions/function-configuration),
[function limits](https://supabase.com/docs/guides/functions/limits), and
[API key](https://supabase.com/docs/guides/getting-started/api-keys) documentation.
