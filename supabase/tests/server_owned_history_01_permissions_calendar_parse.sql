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

 -- Authorization remains server-only, including the worker-token verifier.
 foreach fn in array array['public.market_ingest_recent(jsonb)','public.market_verify_worker_token(text)',
  'public.market_claim_repairs(integer)','public.market_fail_repair(bigint,uuid,text)','public.market_replace_history(bigint,uuid,jsonb)'] loop
  perform pg_temp.market_assert(not has_function_privilege('anon',fn,'execute') and not has_function_privilege('authenticated',fn,'execute')
   and has_function_privilege('service_role',fn,'execute'),'private_RPC_'||fn);
 end loop;
 perform pg_temp.market_assert(not has_schema_privilege('anon','market_scanner','usage') and
  not has_schema_privilege('authenticated','market_scanner','usage'),'private_schema_not_accessible_to_public_roles');
 perform pg_temp.market_assert(not has_table_privilege('anon','market_scanner.repair_queue','select') and
  not has_table_privilege('authenticated','market_scanner.worker_credentials','select'),'queue_and_worker_credentials_are_private');
 perform pg_temp.market_assert(not public.market_verify_worker_token(null) and not public.market_verify_worker_token('invalid'),
  'missing_or_malformed_worker_tokens_fail_closed');
 perform pg_temp.market_assert(has_table_privilege('anon','public.market_history','select') and
  not has_table_privilege('anon','public.market_history','insert') and not has_table_privilege('anon','public.market_history','update'),
  'public_history_remains_read_only');

 -- Guard must reject direct writes before and after successful validated calls.
 perform set_config('market_scanner.validated_write','off',true);
 blocked:=false;
 begin update public.market_history set close=close where ticker='AAPL' and fecha=last_day;
 exception when insufficient_privilege then blocked:=true;end;
 perform pg_temp.market_assert(blocked,'direct_write_is_blocked_before_ingestion');

 -- Calendar checks use actual regular/early closes and both sides of DST.
 perform pg_temp.market_assert(market_scanner.expected_session('2026-10-15 20:59:59Z')=date '2026-10-14' and
  market_scanner.expected_session('2026-10-15 21:00:00Z')=date '2026-10-15','normal_close_confirmation_boundary');
 perform pg_temp.market_assert((select closes_at=timestamptz '2025-11-28 18:00Z' and confirms_at=timestamptz '2025-11-28 19:00Z'
  from market_scanner.sessions where session_date=date '2025-11-28'),'thanksgiving_early_close_is_13_ET');
 perform pg_temp.market_assert(market_scanner.expected_session('2025-11-28 18:59:59Z')=date '2025-11-26' and
  market_scanner.expected_session('2025-11-28 19:00Z')=date '2025-11-28','early_close_confirmation_boundary');
 perform pg_temp.market_assert((select closes_at=timestamptz '2026-03-06 21:00Z' from market_scanner.sessions where session_date=date '2026-03-06') and
  (select closes_at=timestamptz '2026-03-09 20:00Z' from market_scanner.sessions where session_date=date '2026-03-09'),'DST_changes_UTC_close_but_not_NY_session');
 perform pg_temp.market_assert(not exists(select 1 from market_scanner.sessions where session_date in (date '2025-01-09',date '2026-04-03',date '2026-07-03')) and
  market_scanner.expected_session('2026-07-03 22:00Z')=date '2026-07-02','mourning_good_friday_and_independence_holidays');

 p:=pg_temp.market_payload_day('2026-10-15','2026-10-15 21:01Z');r:=market_scanner.parse_payload(p,false,'2026-10-15 21:01Z');
 perform pg_temp.market_assert(not(r?'error') and (r->'bars'->0->>'is_final')::boolean,'normal_real_bar_becomes_final_after_confirmation');
 p:=pg_temp.market_payload_day('2026-10-15','2026-10-15 18:00Z','2026-10-15 18:00Z');r:=market_scanner.parse_payload(p,false,'2026-10-15 18:00Z');
 perform pg_temp.market_assert(not(r?'error') and not (r->'bars'->0->>'is_final')::boolean,'open_session_real_bar_is_provisional');
 p:=pg_temp.market_payload_day('2025-11-28','2025-11-28 18:30Z','2025-11-28 18:00Z');r:=market_scanner.parse_payload(p,false,'2025-11-28 18:30Z');
 perform pg_temp.market_assert(not(r?'error') and not (r->'bars'->0->>'is_final')::boolean,'early_close_bar_waits_for_confirmation');
 p:=pg_temp.market_payload_day('2025-11-28','2025-11-28 19:01Z');r:=market_scanner.parse_payload(p,false,'2025-11-28 19:01Z');
 perform pg_temp.market_assert(not(r?'error') and (r->'bars'->0->>'is_final')::boolean,'early_close_bar_is_final_after_confirmation');
 p:=pg_temp.market_payload_day('2026-03-06','2026-03-06 22:01Z');r:=market_scanner.parse_payload(p,false,'2026-03-06 22:01Z');
 perform pg_temp.market_assert(not(r?'error') and (r->'bars'->0->>'is_final')::boolean,'pre_DST_real_bar_final');
 p:=pg_temp.market_payload_day('2026-03-09','2026-03-09 21:01Z');r:=market_scanner.parse_payload(p,false,'2026-03-09 21:01Z');
 perform pg_temp.market_assert(not(r?'error') and (r->'bars'->0->>'is_final')::boolean,'post_DST_real_bar_final');

 p:=pg_temp.market_payload_day('2026-07-02','2026-07-03 22:00Z');
 p:=jsonb_set(p,'{rows,0,timestamp}',to_jsonb(extract(epoch from timestamptz '2026-07-03 13:30Z')));
 r:=market_scanner.parse_payload(p,false,'2026-07-03 22:00Z');
 perform pg_temp.market_assert(r->>'error'='FECHA_NO_BURSATIL','holiday_timestamp_is_rejected');
 p:=pg_temp.market_payload_day('2026-10-15','2026-10-15 21:01Z');
 p:=jsonb_set(p,'{rows,0,timestamp}',to_jsonb(extract(epoch from timestamptz '2026-10-16 13:30Z')));
 r:=market_scanner.parse_payload(p,false,'2026-10-15 21:01Z');
 perform pg_temp.market_assert(r->>'error'='FECHA_FUTURA','future_session_is_rejected');
 p:=pg_temp.market_payload_day('2026-10-15','2026-10-15 20:44Z','2026-10-15 20:00Z');r:=market_scanner.parse_payload(p,false,'2026-10-15 21:01Z');
 perform pg_temp.market_assert(r->>'error'='CAPTURA_ANTIGUA_O_FECHA_FUTURA','stale_capture_is_rejected');
 p:=pg_temp.market_payload_day('2026-10-15','2026-10-15 21:01Z');p:=jsonb_set(p,'{rows,0,high}','0');
 r:=market_scanner.parse_payload(p,false,'2026-10-15 21:01Z');
 perform pg_temp.market_assert(r->>'error'='OHLCV_INCOHERENTE','incoherent_OHLC_is_rejected');
 p:=pg_temp.market_payload_day('2026-10-15','2026-10-15 21:01Z');p:=jsonb_set(p,'{rows,0,volume}','null');
 r:=market_scanner.parse_payload(p,false,'2026-10-15 21:01Z');
 perform pg_temp.market_assert(r->>'error'='OHLCV_NO_NUMERICO','null_volume_is_rejected');

 perform pg_temp.market_assert(pg_temp.market_history_hash('AAPL')=before_aapl,'AAPL_price_hash_unchanged_after_all_cases');
 perform pg_temp.market_assert(pg_temp.market_history_hash()=before_all,'global_history_hash_unchanged_after_all_cases');
end $regression$;

select jsonb_build_object('group','01_permissions_calendar_parse','status','passed','assertions',count(*),'history_mutations_committed',false,
 'fixture','500 current server-validated AAPL bars','checks',jsonb_agg(check_name order by check_name)) as regression_summary
from market_server_test_results;
rollback;
