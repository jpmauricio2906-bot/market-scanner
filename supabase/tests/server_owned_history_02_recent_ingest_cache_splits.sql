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

 -- Public ingestion has no client clock override and safely accepts an empty batch.
 r:=public.market_ingest_recent('[]');
 perform pg_temp.market_assert(r=jsonb_build_object('version',2,'results','[]'::jsonb),'empty_public_batch_is_a_no_op');
 p:=pg_temp.market_payload_day(last_day,test_clock);
 bad:=jsonb_set(p,'{rows,0,high}','0');r:=public.market_ingest_recent(jsonb_build_array(bad));
 perform pg_temp.market_assert(r->'results'->0->>'status'='RECHAZADO' and pg_temp.market_history_hash('AAPL')=before_aapl,
  'RECHAZADO_never_mutates_confirmed_history');
 bad:=p||jsonb_build_object('requested_at',test_clock-interval '16 minutes','fetched_at',test_clock-interval '16 minutes');
 r:=public.market_ingest_recent(jsonb_build_array(bad));
 perform pg_temp.market_assert(r->'results'->0->>'status'='RECHAZADO' and pg_temp.market_history_hash('AAPL')=before_aapl,
  'stale_public_capture_never_mutates_history');

 -- A bar not proven final must not replace an already confirmed bar, even if
 -- its source fields differ. The old quote timestamp makes this bar provisional
 -- independently of the wall clock at which this regression is executed.
 select closes_at into latest_closes from market_scanner.sessions where session_date=last_day;
 bad:=p||jsonb_build_object('regular_market_time',extract(epoch from latest_closes-interval '1 hour'));
 bad:=jsonb_set(bad,'{rows,0,volume}',to_jsonb((bad->'rows'->0->>'volume')::bigint+1));
 r:=market_scanner.parse_payload(bad,false,test_clock);
 perform pg_temp.market_assert(not(r?'error') and not(r->'bars'->0->>'is_final')::boolean,'unconfirmed_source_bar_is_provisional');
 r:=public.market_ingest_recent(jsonb_build_array(bad));
 perform pg_temp.market_assert(pg_temp.market_history_hash('AAPL')=before_aapl,'provisional_bar_never_overwrites_confirmed_close');

 -- Valid recent capture is idempotent and must not leave the write guard open.
 r:=public.market_ingest_recent(jsonb_build_array(p));
 perform pg_temp.market_assert(r->'results'->0->>'status'='FINAL' and pg_temp.market_history_hash('AAPL')=before_aapl,
  'valid_real_recent_capture_is_idempotent');
 select to_jsonb(q) into quote_row from market_scanner.current_quotes q where ticker='AAPL';
 bad:=p||jsonb_build_object('requested_at',test_clock-interval '1 minute','fetched_at',test_clock-interval '1 minute');
 bad:=jsonb_set(bad,'{rows,0,volume}',to_jsonb((bad->'rows'->0->>'volume')::bigint+1));
 r:=public.market_ingest_recent(jsonb_build_array(bad));
 perform pg_temp.market_assert(r->'results'->0->>'status'='RECHAZADO' and pg_temp.market_history_hash('AAPL')=before_aapl and
  (select to_jsonb(q)=quote_row from market_scanner.current_quotes q where ticker='AAPL'),
  'capture_older_than_accepted_quote_cannot_rewrite_volume_or_current_quote');
 blocked:=false;
 begin update public.market_history set close=close where ticker='AAPL' and fecha=last_day;
 exception when insufficient_privilege then blocked:=true;end;
 perform pg_temp.market_assert(blocked,'direct_write_is_still_blocked_after_validated_ingestion');

 -- Hypothetical split/revision payloads only enqueue replacement; public prices
 -- stay untouched until a complete validated Yahoo series arrives.
 bad:=p||jsonb_build_object('splits',jsonb_build_array(jsonb_build_object('timestamp',p->'rows'->0->'timestamp','numerator',2,'denominator',1)));
 r:=public.market_ingest_recent(jsonb_build_array(bad));
 perform pg_temp.market_assert(r->'results'->0->>'status'='REEMPLAZO_PENDIENTE' and
  pg_temp.market_history_hash('AAPL')=before_aapl,'new_split_queues_without_publishing_mixed_prices');
 bad:=p;bar:=bad->'rows'->0;
 foreach fn in array array['open','high','low','close'] loop
  bar:=jsonb_set(bar,array[fn],to_jsonb((bar->>fn)::numeric*1.01));
 end loop;
 bad:=jsonb_set(bad,'{rows,0}',bar);r:=public.market_ingest_recent(jsonb_build_array(bad));
 perform pg_temp.market_assert(r->'results'->0->>'status'='REEMPLAZO_PENDIENTE' and pg_temp.market_history_hash('AAPL')=before_aapl,
  'OHLC_revision_queues_without_overwriting_public_prices');
 perform pg_temp.market_assert(exists(select 1 from market_scanner.repair_queue where ticker='AAPL' and status in ('pending','running')),
  'split_or_revision_has_a_persisted_repair_job');

 perform pg_temp.market_assert(pg_temp.market_history_hash('AAPL')=before_aapl,'AAPL_price_hash_unchanged_after_all_cases');
 perform pg_temp.market_assert(pg_temp.market_history_hash()=before_all,'global_history_hash_unchanged_after_all_cases');
end $regression$;

select jsonb_build_object('group','02_recent_ingest_cache_splits','status','passed','assertions',count(*),'history_mutations_committed',false,
 'fixture','500 current server-validated AAPL bars','checks',jsonb_agg(check_name order by check_name)) as regression_summary
from market_server_test_results;
rollback;
