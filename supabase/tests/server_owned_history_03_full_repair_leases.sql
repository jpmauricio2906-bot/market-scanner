-- Regression only. Run after server_owned_history.sql with its reviewed seed.
-- Real prices are captured from current server-validated AAPL history at test start.
-- Negative cases alter payloads only. All table/queue/audit effects are ROLLED BACK.
-- Keep BEGIN and ROLLBACK together in one connection; do not run this piecemeal.
begin;
set local lock_timeout='5s';
set local extra_float_digits=3;
set local statement_timeout='25s';

create temporary table market_server_test_results(check_name text primary key,passed boolean not null) on commit drop;
create temporary table market_server_test_fixture(payload jsonb not null) on commit drop;
insert into market_server_test_fixture
select jsonb_build_object('ticker','AAPL','source','yahoo','symbol','AAPL','currency','USD',
 'exchange_timezone','America/New_York','exchange_name','NMS','first_trade_epoch',345479400,
 'regular_market_time',extract(epoch from ((max(fecha)+time '16:00') at time zone 'America/New_York')),
 'requested_at',clock_timestamp(),'fetched_at',clock_timestamp(),
 'rows',jsonb_agg(jsonb_build_object('timestamp',extract(epoch from ((fecha+time '09:30') at time zone 'America/New_York')),
  'open',open,'high',high,'low',low,'close',close,'volume',volumen) order by fecha),'splits','[]'::jsonb)
from public.market_history where ticker='AAPL' and is_final;

create function pg_temp.market_assert(p_condition boolean,p_name text) returns void
language plpgsql as $$ begin
 if p_condition is distinct from true then raise exception 'Regression failed: %',p_name;end if;
 insert into pg_temp.market_server_test_results values(p_name,true);
end $$;

create function pg_temp.market_history_hash(p_ticker text default null) returns text
language sql stable as $$
 select md5(coalesce(string_agg(concat_ws('|',fecha::text,ticker,open::text,high::text,low::text,close::text,volumen::text,is_final::text),E'\n' order by ticker,fecha),''))
 from public.market_history where p_ticker is null or ticker=p_ticker;
$$;

create function pg_temp.market_payload_day(p_day date,p_clock timestamptz,p_quote_clock timestamptz default null) returns jsonb
language plpgsql as $$
declare base jsonb;bar jsonb;quote_clock timestamptz;begin
 select payload into base from pg_temp.market_server_test_fixture;
 select value into bar from jsonb_array_elements(base->'rows')
 where (to_timestamp((value->>'timestamp')::float8) at time zone 'America/New_York')::date=p_day;
 if bar is null then raise exception 'Real AAPL fixture has no bar for %',p_day;end if;
 select coalesce(p_quote_clock,closes_at) into quote_clock from market_scanner.sessions where session_date=p_day;
 return base||jsonb_build_object('requested_at',p_clock,'fetched_at',p_clock,
  'regular_market_time',extract(epoch from quote_clock),'rows',jsonb_build_array(bar),'splits','[]'::jsonb);
end $$;

do $regression$
declare p jsonb;r jsonb;base jsonb;full_payload jsonb;bars jsonb;bar jsonb;bad jsonb;job_row jsonb;quote_row jsonb;jobs jsonb;claimed_job jsonb;fn text;
 d date;last_day date;extra_day date;latest_closes timestamptz;test_clock timestamptz:=clock_timestamp();
 before_all text;before_aapl text;blocked boolean;job_id bigint;
 revisions_before bigint;
 lease uuid:='d83f14a9-1895-4421-aa3a-574c0c28d137';bad_lease uuid:='bc412f19-cfd6-46d9-ae2b-95237562dd48';
begin
 select payload into base from pg_temp.market_server_test_fixture;
 select max((to_timestamp((value->>'timestamp')::float8) at time zone 'America/New_York')::date) into last_day
 from jsonb_array_elements(base->'rows');
 before_all:=pg_temp.market_history_hash();before_aapl:=pg_temp.market_history_hash('AAPL');
 -- Isolate capture-order fixtures from any production quote metadata. ROLLBACK
 -- restores this private row, including a newer real provider quote timestamp.
 delete from market_scanner.current_quotes where ticker='AAPL';
 perform pg_temp.market_assert(jsonb_array_length(base->'rows')=500,'fixture_has_500_real_AAPL_bars');
 perform pg_temp.market_assert(market_scanner.expected_session(test_clock)=last_day,
  'fixture_latest_date_matches_current_expected_close_refresh_fixture_if_this_fails');
 perform pg_temp.market_assert((select count(*)=500 from public.market_history where ticker='AAPL' and is_final),'live_AAPL_has_500_confirmed_bars');

 perform set_config('market_scanner.validated_write','off',true);
 select closes_at into latest_closes from market_scanner.sessions where session_date=last_day;
 p:=pg_temp.market_payload_day(last_day,test_clock);

 -- Use a real complete 500-session series with fresh capture metadata. No
 -- history prices are fabricated, and successful replacement stays idempotent.
 full_payload:=base||jsonb_build_object('requested_at',test_clock,'fetched_at',test_clock,
  'regular_market_time',extract(epoch from latest_closes));
 insert into market_scanner.repair_queue(ticker,reason,status,attempts,next_attempt_at,lease_token,lease_until)
 values('AAPL','ROLLBACK_REGRESSION_ONLY','running',1,now(),lease,now()+interval '10 minutes')
 on conflict(ticker) do update set reason=excluded.reason,status='running',attempts=1,next_attempt_at=now(),lease_token=excluded.lease_token,
  lease_until=excluded.lease_until,finished_at=null,last_error=null returning id into job_id;
 select to_jsonb(q) into job_row from market_scanner.repair_queue q where id=job_id;
 r:=public.market_replace_history(job_id,bad_lease,full_payload);
 perform pg_temp.market_assert(r->>'status'='rejected' and r->>'reason'='LEASE_INVALIDO' and
  pg_temp.market_history_hash('AAPL')=before_aapl and (select to_jsonb(q)=job_row from market_scanner.repair_queue q where id=job_id),
  'invalid_lease_never_changes_history_or_job');
 bad:=jsonb_set(full_payload,'{rows,0,high}','0');r:=public.market_replace_history(job_id,lease,bad);
 perform pg_temp.market_assert(r->>'status'='rejected' and pg_temp.market_history_hash('AAPL')=before_aapl and
  (select status='failed' from market_scanner.repair_queue where id=job_id),'invalid_full_series_is_rejected_without_partial_writes');
 update market_scanner.repair_queue set status='running',lease_token=lease,lease_until=now()+interval '10 minutes',last_error=null where id=job_id;
 -- Simulate one incorrectly confirmed future/session row inside this rollback
 -- transaction, using the unchanged real source OHLCV. Full replacement must
 -- remove it rather than retaining it and evicting a valid old source session.
 select min(session_date) into extra_day from market_scanner.sessions where session_date>last_day;
 select count(*) into revisions_before from market_scanner.history_revisions where ticker='AAPL';
 perform set_config('market_scanner.validated_write','on',true);
 insert into public.market_history(fecha,ticker,open,high,low,close,volumen,is_final)
 select extra_day,ticker,open,high,low,close,volumen,true from public.market_history where ticker='AAPL' and fecha=last_day;
 perform set_config('market_scanner.validated_write','off',true);
 perform pg_temp.market_assert((select count(*)=501 from public.market_history where ticker='AAPL' and is_final),'rollback_only_corruption_fixture_has_one_extra_final_row');
 r:=public.market_replace_history(job_id,lease,full_payload);
 perform pg_temp.market_assert(r->>'status'='completed' and (select status='completed' from market_scanner.repair_queue where id=job_id),
  'real_500_session_repair_completes_with_its_lease');
 perform pg_temp.market_assert(not exists(select 1 from public.market_history where ticker='AAPL' and fecha=extra_day and is_final) and
  (select count(*)>revisions_before from market_scanner.history_revisions where ticker='AAPL'),
  'atomic_full_repair_removes_and_audits_extra_confirmed_rows');
 perform pg_temp.market_assert((select count(*)=500 from public.market_history where ticker='AAPL' and is_final) and
  not exists(select 1 from jsonb_array_elements(base->'rows') b left join public.market_history h on h.ticker='AAPL' and
   h.fecha=(to_timestamp((b->>'timestamp')::float8) at time zone 'America/New_York')::date
   where h.ticker is null or row(h.open,h.high,h.low,h.close,h.volumen,h.is_final) is distinct from
    row((b->>'open')::float8,(b->>'high')::float8,(b->>'low')::float8,(b->>'close')::float8,(b->>'volume')::bigint,true)),
  'successful_repair_matches_every_real_source_OHLCV_bar');
 -- SQL enforces the batch limit independently of the worker, with durable
 -- leases and token-checked failure recording. These queue changes also roll back.
 insert into market_scanner.repair_queue(ticker,reason,status,attempts,requested_at,next_attempt_at)
 select ticker,'ROLLBACK_CLAIM_LIMIT','pending',0,now()-interval '1 day',now()-interval '1 day'
 from market_scanner.instruments where ticker in ('AAPL','MSFT','QQQ')
 on conflict(ticker) do update set reason=excluded.reason,status='pending',attempts=0,requested_at=excluded.requested_at,
  next_attempt_at=excluded.next_attempt_at,lease_token=null,lease_until=null,finished_at=null,last_error=null;
 jobs:=public.market_claim_repairs(250);
 perform pg_temp.market_assert(jsonb_typeof(jobs)='array' and jsonb_array_length(jobs)=2,'claim_limit_is_clamped_to_two_even_for_large_request');
 perform pg_temp.market_assert(not exists(select 1 from jsonb_array_elements(jobs) j left join market_scanner.repair_queue q
  on q.id=(j->>'id')::bigint where q.status is distinct from 'running' or q.lease_token is distinct from (j->>'lease_token')::uuid or
  q.lease_until<=now() or q.attempts<1),'claimed_jobs_have_matching_live_leases');
 claimed_job:=jobs->0;
 select to_jsonb(q) into job_row from market_scanner.repair_queue q where id=(claimed_job->>'id')::bigint;
 r:=public.market_fail_repair((claimed_job->>'id')::bigint,bad_lease,'ROLLBACK_ONLY');
 perform pg_temp.market_assert(r->>'status'='lease_expired' and
  (select to_jsonb(q)=job_row from market_scanner.repair_queue q where id=(claimed_job->>'id')::bigint),
  'failure_with_wrong_lease_cannot_change_a_claimed_job');
 r:=public.market_fail_repair((claimed_job->>'id')::bigint,(claimed_job->>'lease_token')::uuid,'ROLLBACK_ONLY');
 perform pg_temp.market_assert(r->>'status'='failed' and
  (select status='failed' and next_attempt_at>now() from market_scanner.repair_queue where id=(claimed_job->>'id')::bigint),
  'failure_with_valid_lease_persists_retry_backoff');
 perform pg_temp.market_assert(pg_temp.market_history_hash('AAPL')=before_aapl,'AAPL_price_hash_unchanged_after_all_cases');
 perform pg_temp.market_assert(pg_temp.market_history_hash()=before_all,'global_history_hash_unchanged_after_all_cases');
end $regression$;

select jsonb_build_object('group','03_full_repair_leases','status','passed','assertions',count(*),'history_mutations_committed',false,
 'fixture','500 current server-validated AAPL bars','checks',jsonb_agg(check_name order by check_name)) as regression_summary
from market_server_test_results;
rollback;
