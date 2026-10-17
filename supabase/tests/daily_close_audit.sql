begin isolation level repeatable read;
set local statement_timeout='60s';set local lock_timeout='5s';
create temporary table daily_checks(name text primary key) on commit drop;
create function pg_temp.daily_ok(v boolean,n text) returns void language plpgsql as $$begin
if v is distinct from true then raise exception 'Daily close audit regression failed: %',n;end if;
insert into daily_checks values(n);end$$;
do $test$
declare r jsonb;flag boolean;begin
delete from public.market_close_audits where session_date in(date '2026-10-19',date '2026-10-20',date '2026-11-02');
perform pg_temp.daily_ok(not market_scanner.capture_close_audit(null) and not market_scanner.capture_close_audit(timestamptz '2026-10-17 00:30Z')
and not market_scanner.capture_close_audit(timestamptz '2026-10-20 00:29:59Z'),'no_null_pre_start_or_early_capture');
perform pg_temp.daily_ok(not market_scanner.capture_close_audit(timestamptz '2026-10-25 00:30Z')
and not market_scanner.capture_close_audit(timestamptz '2026-11-27 01:30Z')
and not market_scanner.capture_close_audit(timestamptz '2027-07-06 00:30Z')
and not market_scanner.capture_close_audit(timestamptz '2026-07-04 00:30Z'),'weekend_and_reviewed_holidays_do_not_create_reports');
perform pg_temp.daily_ok(market_scanner.capture_close_audit(timestamptz '2026-10-20 00:30Z'),'first_day_capture_starts_2030_EDT');
select report into r from public.market_close_audits where session_date=date '2026-10-19';
perform pg_temp.daily_ok(market_scanner.capture_close_audit(timestamptz '2026-10-20 00:35Z')
and (select report=r and captured_at=timestamptz '2026-10-20 00:30Z' from public.market_close_audits where session_date=date '2026-10-19'),
'same_day_capture_is_immutable_and_idempotent');
flag:=not market_scanner.capture_close_audit(timestamptz '2026-10-21 00:29:59Z')
and market_scanner.capture_close_audit(timestamptz '2026-10-21 00:30Z');
perform pg_temp.daily_ok(flag and (select count(*)=2 from public.market_close_audits where session_date in(date '2026-10-19',date '2026-10-20')),
'next_trading_day_creates_a_distinct_report');
flag:=not market_scanner.capture_close_audit(timestamptz '2026-11-03 01:29:59Z')
and market_scanner.capture_close_audit(timestamptz '2026-11-03 01:30Z');
perform pg_temp.daily_ok(flag and (select captured_at at time zone 'America/New_York'=timestamp '2026-11-02 20:30' from public.market_close_audits where session_date=date '2026-11-02'),
'fall_DST_uses_2030_EST_not_fixed_UTC');
end $test$;
select jsonb_build_object('status','passed','assertions',count(*),'group','daily_close_audit_01_timing','committed_fixtures',false,
'checks',jsonb_agg(name order by name)) as summary from daily_checks;
rollback;
