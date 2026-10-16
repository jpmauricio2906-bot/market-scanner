-- Activate only after installing server_owned_history.sql, deploying the worker,
-- and passing all three rollback regression groups in supabase/tests/.
-- Database cron runs as its owner. The worker token stays in Vault.
begin;
select cron.schedule('market-scanner-repair-worker','* * * * *',
 $job$select market_scanner.dispatch_worker();$job$);
-- Cron uses UTC; the local-time guard follows New York daylight saving time.
select cron.schedule('market-scanner-daily-audit','15 * * * *',
 $job$select market_scanner.audit_history(false)
 where extract(isodow from now() at time zone 'America/New_York') between 1 and 5
 and extract(hour from now() at time zone 'America/New_York')=20;$job$);
select cron.schedule('market-scanner-weekly-history','0 * * * 6',
 $job$select market_scanner.audit_history(true)
 where extract(isodow from now() at time zone 'America/New_York')=6
 and extract(hour from now() at time zone 'America/New_York')=2;$job$);
commit;
