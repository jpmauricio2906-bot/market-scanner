begin isolation level repeatable read;
set local statement_timeout='60s';set local lock_timeout='5s';
create temporary table daily_checks(name text primary key) on commit drop;
create function pg_temp.daily_ok(v boolean,n text) returns void language plpgsql as $$begin
if v is distinct from true then raise exception 'Daily close audit regression failed: %',n;end if;
insert into daily_checks values(n);end$$;
do $test$
declare flag boolean;cron_before text;history_before jsonb;begin
select md5(coalesce(string_agg(to_jsonb(j)::text,E'\n' order by jobid),'')) into cron_before from cron.job j;
select jsonb_build_array(count(*),max(fecha),count(*) filter(where is_final)) into history_before from public.market_history;
delete from public.market_close_audits where session_date in(date '2026-11-27',date '2027-03-15');
perform pg_temp.daily_ok(not market_scanner.capture_close_audit(timestamptz '2027-03-16 00:29:59Z')
and market_scanner.capture_close_audit(timestamptz '2027-03-16 00:30Z'),'spring_DST_uses_2030_EDT');
perform pg_temp.daily_ok(market_scanner.capture_close_audit(timestamptz '2026-11-28 01:30Z')
and exists(select 1 from market_scanner.sessions where session_date=date '2026-11-27' and extract(hour from closes_at at time zone 'America/New_York')=13),
'early_close_session_is_reviewed_at_normal_evening_time');
perform pg_temp.daily_ok(exists(select 1 from cron.job where jobname='market-scanner-daily-close-review' and active and schedule='*/5 * * * *')
and not exists(select 1 from cron.job where jobname='market-scanner-close-review-20261019')
and cron_before=(select md5(coalesce(string_agg(to_jsonb(j)::text,E'\n' order by jobid),'')) from cron.job j),
'permanent_cron_survives_captures_and_one_off_is_removed');
perform pg_temp.daily_ok(not exists(select 1 from(values('anon'),('authenticated'),('service_role'))roles(n)
where has_function_privilege(roles.n,'market_scanner.capture_close_audit(timestamptz)','execute'))
and (select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='market_scanner.capture_close_audit(timestamptz)'::regprocedure),
'capture_keeps_private_invoker_permissions');
flag:=false;begin perform market_scanner.capture_close_audit(timestamptz '2029-01-03 01:30Z');exception when others then flag:=true;end;
perform pg_temp.daily_ok(flag,'unreviewed_calendar_horizon_fails_explicitly');
perform pg_temp.daily_ok(history_before=(select jsonb_build_array(count(*),max(fecha),count(*) filter(where is_final)) from public.market_history),
'review_preserves_history_count_latest_date_and_final_count');
end $test$;
select jsonb_build_object('status','passed','assertions',count(*),'group','daily_close_audit_02_calendar_permissions','committed_fixtures',false,
'checks',jsonb_agg(name order by name)) as summary from daily_checks;
rollback;
