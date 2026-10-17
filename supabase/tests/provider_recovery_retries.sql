-- Run after provider_recovery_retries.sql. Every fixture change rolls back.
-- Isolate the queue in this transaction; do not dispatch network requests.
begin isolation level repeatable read;
set local statement_timeout='25s';set local lock_timeout='5s';
create temporary table retry_checks(name text primary key) on commit drop;
create function pg_temp.retry_ok(v boolean,n text) returns void language plpgsql as $$begin
 if v is distinct from true then raise exception 'Provider retry regression failed: %',n;end if;
 insert into retry_checks values(n);end$$;
create function pg_temp.retry_hash() returns jsonb language sql stable as $$
 select jsonb_build_object(
 'history',(select md5(coalesce(string_agg(to_jsonb(h)::text,E'\n' order by ticker,fecha),'')) from public.market_history h),
 'private_yahoo',(select md5(coalesce(string_agg(to_jsonb(q)::text,E'\n' order by ticker),'')) from market_scanner.current_quotes q));$$;
do $test$
declare before_state jsonb:=pg_temp.retry_hash();jobs jsonb;r jsonb;before_job jsonb;j bigint;old_token uuid:=gen_random_uuid();
 token uuid;n integer;claim_source text;dispatch_source text;
begin
 -- Other jobs and their original leases are restored by ROLLBACK.
 delete from market_scanner.repair_queue;
 insert into market_scanner.repair_queue(ticker,reason,status,attempts,next_attempt_at,lease_token,lease_until)
 values('AAPL','ROLLBACK_RETRY','failed',5,now()-interval '1 minute',old_token,null);
 jobs:=public.market_claim_repairs(1);j:=(jobs->0->>'id')::bigint;token:=(jobs->0->>'lease_token')::uuid;
 perform pg_temp.retry_ok(jsonb_array_length(jobs)=1 and (select status='running' and attempts=6 from market_scanner.repair_queue where id=j),
 'exhausted_failed_job_reclaimed_when_due');
 perform pg_temp.retry_ok(token is distinct from old_token and (select lease_token=token and lease_until=now()+interval '10 minutes' from market_scanner.repair_queue where id=j),
 'reclaim_issues_new_ten_minute_lease');
 delete from market_scanner.repair_queue;
 insert into market_scanner.repair_queue(ticker,reason,status,attempts,next_attempt_at,lease_token,lease_until)
 values('AAPL','ROLLBACK_RETRY','pending',0,now()+interval '1 hour',null,null),
 ('MSFT','ROLLBACK_RETRY','failed',25,now()+interval '1 hour',null,null),
 ('QQQ','ROLLBACK_RETRY','running',6,now()-interval '1 hour',old_token,now()+interval '1 minute'),
 ('NVDA','ROLLBACK_RETRY','completed',8,now()-interval '1 hour',null,null);
 jobs:=public.market_claim_repairs(250);
 perform pg_temp.retry_ok(not exists(select 1 from market_scanner.repair_queue where ticker in('AAPL','MSFT') and status='running') and jsonb_array_length(jobs)=0,
 'future_pending_and_failed_jobs_stay_unclaimed');
 perform pg_temp.retry_ok((select status='running' and lease_token=old_token and attempts=6 from market_scanner.repair_queue where ticker='QQQ'),
 'live_lease_is_not_stolen');
 perform pg_temp.retry_ok((select status='completed' and attempts=8 from market_scanner.repair_queue where ticker='NVDA'),
 'completed_job_is_not_reclaimed');
 update market_scanner.repair_queue set lease_until=now()-interval '1 second' where ticker='QQQ';
 jobs:=public.market_claim_repairs(1);
 perform pg_temp.retry_ok(jsonb_array_length(jobs)=1 and jobs->0->>'ticker'='QQQ'
  and (jobs->0->>'lease_token')::uuid is distinct from old_token
  and (select attempts=7 and lease_until>now() from market_scanner.repair_queue where ticker='QQQ'),
 'expired_lease_is_recovered_with_new_token');
 delete from market_scanner.repair_queue;
 insert into market_scanner.repair_queue(ticker,reason,status,attempts,next_attempt_at)
 select ticker,'ROLLBACK_RETRY','pending',0,now()-interval '1 minute' from market_scanner.instruments where ticker in('AAPL','MSFT','QQQ');
 jobs:=public.market_claim_repairs(250);
 perform pg_temp.retry_ok(jsonb_array_length(jobs)=2,'claim_limit_remains_two');
 j:=(jobs->0->>'id')::bigint;token:=(jobs->0->>'lease_token')::uuid;
 select to_jsonb(q) into before_job from market_scanner.repair_queue q where id=j;
 r:=public.market_fail_repair(j,gen_random_uuid(),'ROLLBACK_WRONG_TOKEN');
 perform pg_temp.retry_ok(r->>'status'='lease_expired' and (select to_jsonb(q)=before_job from market_scanner.repair_queue q where id=j),
 'wrong_token_cannot_fail_job');
 for n in 1..4 loop
  update market_scanner.repair_queue set status='running',attempts=n,lease_token=token,lease_until=now()+interval '10 minutes' where id=j;
  r:=public.market_fail_repair(j,token,'ROLLBACK_PROVIDER_UNAVAILABLE');
  perform pg_temp.retry_ok(r->>'status'='failed' and (select next_attempt_at=now()+make_interval(mins=>(2^n)::integer) and lease_until is null from market_scanner.repair_queue where id=j),
   'early_backoff_attempt_'||n);
 end loop;
 update market_scanner.repair_queue set status='running',attempts=5,lease_token=token where id=j;
 r:=public.market_fail_repair(j,token,'ROLLBACK_PROVIDER_UNAVAILABLE');
 perform pg_temp.retry_ok(r->>'status'='failed' and (select next_attempt_at=now()+interval '1 hour' from market_scanner.repair_queue where id=j),
 'fifth_failure_uses_hourly_cooldown');
 foreach n in array array[25,31] loop
  update market_scanner.repair_queue set status='running',attempts=n,lease_token=token where id=j;
  r:=public.market_fail_repair(j,token,'ROLLBACK_PROVIDER_UNAVAILABLE');
  if r->>'status'<>'failed' or not (select next_attempt_at=now()+interval '1 hour' from market_scanner.repair_queue where id=j) then
   raise exception 'High retry count did not keep hourly cooldown: %',n;end if;
 end loop;
 perform pg_temp.retry_ok(true,'high_attempt_counts_keep_hourly_cooldown_without_overflow');
 select regexp_replace(prosrc,'\s','','g') into claim_source from pg_proc where oid='public.market_claim_repairs(integer)'::regprocedure;
 select regexp_replace(prosrc,'\s','','g') into dispatch_source from pg_proc where oid='market_scanner.dispatch_worker()'::regprocedure;
 perform pg_temp.retry_ok(position('forupdateskiplocked' in claim_source)>0
  and position('attempts<5' in claim_source)=0 and position('attempts<5' in dispatch_source)=0
  and position('next_attempt_at<=now()' in claim_source)>0 and position('next_attempt_at<=now()' in dispatch_source)>0
  and position('statusin(''pending'',''failed'')or(status=''running''andlease_until<now())' in claim_source)>0
  and position('statusin(''pending'',''failed'')or(status=''running''andlease_until<now())' in dispatch_source)>0,
 'dispatch_and_claim_share_due_and_lease_conditions');
 perform pg_temp.retry_ok(not exists(select 1 from (values('anon'),('authenticated')) roles(role_name)
  cross join (values('public.market_claim_repairs(integer)'),('public.market_fail_repair(bigint,uuid,text)'),('market_scanner.dispatch_worker()')) f(signature)
  where has_function_privilege(roles.role_name,f.signature,'execute'))
  and has_function_privilege('service_role','public.market_claim_repairs(integer)','execute')
  and has_function_privilege('service_role','public.market_fail_repair(bigint,uuid,text)','execute')
  and not has_function_privilege('service_role','market_scanner.dispatch_worker()','execute')
  and not has_schema_privilege('anon','market_scanner','usage')
  and (select bool_and(not prosecdef and proconfig @> array['search_path=""']) from pg_proc
   where oid in('public.market_claim_repairs(integer)'::regprocedure,'public.market_fail_repair(bigint,uuid,text)'::regprocedure,'market_scanner.dispatch_worker()'::regprocedure)),
 'worker_RPC_permissions_and_private_dispatch_preserved');
 perform pg_temp.retry_ok(pg_temp.retry_hash()=before_state,'canonical_history_and_private_Yahoo_hashes_unchanged');
end $test$;
select jsonb_build_object('status','passed','assertions',count(*),'group','provider_recovery_retries',
 'history_mutations_committed',false,'checks',jsonb_agg(name order by name)) as summary from retry_checks;
rollback;
