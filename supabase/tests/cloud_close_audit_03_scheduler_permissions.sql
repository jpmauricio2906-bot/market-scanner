-- Independent rollback group; run all three cloud_close_audit*.sql files.
begin isolation level repeatable read;
set local statement_timeout='60s';set local lock_timeout='5s';
create temporary table close_audit_checks(name text primary key) on commit drop;
create function pg_temp.audit_ok(v boolean,n text) returns void language plpgsql as $$begin
if v is distinct from true then raise exception 'Cloud close audit regression failed: %',n;end if;
insert into close_audit_checks values(n);end$$;
do $test$
declare r jsonb;before_report jsonb;flag boolean;begin
delete from public.market_close_audits where session_date=date '2026-10-19';
perform pg_temp.audit_ok(not market_scanner.capture_close_audit(timestamptz '2026-10-20 00:29:59Z')
and not market_scanner.capture_close_audit(timestamptz '2026-10-19 00:30Z')
and not exists(select 1 from public.market_close_audits where session_date=date '2026-10-19'),'fixed_target_not_captured_early_or_on_wrong_day');
perform pg_temp.audit_ok(market_scanner.capture_close_audit(timestamptz '2026-10-20 00:30Z'),'capture_runs_at_2030_New_York');
select report into before_report from public.market_close_audits where session_date=date '2026-10-19';
perform pg_temp.audit_ok(market_scanner.capture_close_audit(timestamptz '2026-10-20 15:00Z')
and (select report=before_report and captured_at=timestamptz '2026-10-20 00:30Z' from public.market_close_audits where session_date=date '2026-10-19')
and not exists(select 1 from cron.job where jobname='market-scanner-close-review-20261019'),'capture_is_idempotent_and_unschedules_only_its_job');
delete from public.market_close_audits where session_date=date '2026-10-19';
perform pg_temp.audit_ok(market_scanner.capture_close_audit(timestamptz '2026-10-21 03:59Z'),'next_day_catchup_is_allowed');
perform pg_temp.audit_ok(not market_scanner.capture_close_audit(timestamptz '2026-10-21 04:00Z'),'catchup_window_has_an_explicit_end');
flag:=false;begin r:=market_scanner.build_close_audit(date '2026-10-18',timestamptz '2026-10-20 00:30Z');exception when others then flag:=true;end;
perform pg_temp.audit_ok(flag,'non_trading_target_is_rejected');
perform pg_temp.audit_ok(has_table_privilege('anon','public.market_close_audits','select') and has_table_privilege('authenticated','public.market_close_audits','select')
and (select relrowsecurity from pg_class where oid='public.market_close_audits'::regclass),'public_snapshot_read_has_RLS');
perform pg_temp.audit_ok(not exists(select 1 from(values('anon'),('authenticated'),('service_role'))roles(n)
cross join(values('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'))priv(p) where has_table_privilege(roles.n,'public.market_close_audits',priv.p))
and not exists(select 1 from(values('anon'),('authenticated'),('service_role'))roles(n)
cross join(values('market_scanner.build_close_audit(date,timestamptz)'),('market_scanner.capture_close_audit(timestamptz)'))fn(s)
where has_function_privilege(roles.n,fn.s,'execute')),'API_roles_cannot_mutate_snapshots_or_invoke_private_audit');
perform pg_temp.audit_ok((select bool_and(not prosecdef and proconfig @> array['search_path=""']) from pg_proc
where oid in('market_scanner.build_close_audit(date,timestamptz)'::regprocedure,'market_scanner.capture_close_audit(timestamptz)'::regprocedure)),
'new_functions_are_invoker_with_empty_search_path');
end $test$;
select jsonb_build_object('status','passed','assertions',count(*),'group','cloud_close_audit_03_scheduler_permissions','committed_fixtures',false,
'checks',jsonb_agg(name order by name)) as summary from close_audit_checks;
rollback;
