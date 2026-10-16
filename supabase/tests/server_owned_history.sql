-- Run the three self-contained files separately; each preserves BEGIN/ROLLBACK.
-- Fixtures are aggregated from CURRENT server-validated AAPL prices, avoiding
-- frozen volumes after a legitimate provider revision. Each file is <12 KiB.
-- The 52 unique original cases plus repeated isolation/hash checks produce
-- 31 + 16 + 15 = 62 runtime assertions across the three transactions.
select jsonb_build_object('status','run_split_suite','files',jsonb_build_array(
 'server_owned_history_01_permissions_calendar_parse.sql',
 'server_owned_history_02_recent_ingest_cache_splits.sql',
 'server_owned_history_03_full_repair_leases.sql')) as regression_instructions;
