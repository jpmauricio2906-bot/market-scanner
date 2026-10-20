-- Run only after backtest_history.sql, deployment and rollback regression tests.
begin;
select cron.schedule('backtest-history-worker','* * * * *',
 $job$select market_scanner.dispatch_backtest_history_worker();$job$);
select cron.schedule('backtest-history-nightly','45 * * * *',
 $job$select market_scanner.refresh_backtest_history()
 where extract(hour from now() at time zone 'America/New_York')=20
 and exists(select 1 from market_scanner.sessions
  where session_date=(now() at time zone 'America/New_York')::date and confirms_at<=now());$job$);
-- Initial backfill. Re-running this file is idempotent and retains accepted data.
select market_scanner.refresh_backtest_history();
commit;
