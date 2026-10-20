-- Synthetic fixtures are confined to one rollback transaction, never published.
-- Run this complete file after backtest_history.sql and before schedule activation.
begin;
set local lock_timeout='5s';
set local statement_timeout='45s';
set local extra_float_digits=3;
create temporary table backtest_test_results(check_name text primary key,passed boolean not null) on commit drop;
create function pg_temp.bt_assert(condition boolean,label text) returns void language plpgsql as $$ begin
 if condition is distinct from true then raise exception 'Backtest regression failed: %',label;end if;
 insert into pg_temp.backtest_test_results values(label,true);
end $$;
create function pg_temp.bt_fixture(t text,first_day date,start_day date,end_day date,test_clock timestamptz) returns jsonb
language sql as $$
 select jsonb_build_object('ticker',t,'source','yahoo','symbol',t,'currency','USD','exchange_timezone','America/New_York',
  'exchange_name','NMS','first_trade_epoch',extract(epoch from ((first_day+time '09:30') at time zone 'America/New_York')),
  'regular_market_time',extract(epoch from (select closes_at from market_scanner.sessions where session_date=end_day)),
  'requested_at',test_clock,'fetched_at',test_clock,'requested_start',start_day,'requested_end',end_day,
  'source_sha256',repeat('a',64),'splits','[]'::jsonb,
  'rows',(select jsonb_agg(jsonb_build_object('timestamp',extract(epoch from ((session_date+time '09:30') at time zone 'America/New_York')),
   'open',100,'high',110,'low',90,'close',105,'volume',1234) order by session_date)
   from market_scanner.backtest_sessions where session_date between greatest(start_day,first_day) and end_day));
$$;

do $regression$
declare clock_at timestamptz:=clock_timestamp();end_day date;start_day date;p jsonb;r jsonb;bad jsonb;bars jsonb;jobs jsonb;
 before_short text;before_long text;before_snapshot uuid;fn text;blocked boolean;job_id bigint;n integer;ipo_day date;later_day date;
 previous_day date;previous_start date;too_old date;fallback_job jsonb;
 lease uuid:='ac04a657-684f-480e-91d6-aae2cb334e8c';wrong uuid:='042077c2-71e5-430e-9b6a-928bb5eb3d03';
begin
 end_day:=market_scanner.expected_session(clock_at);start_day:=(end_day-interval '11 years')::date;
 select md5(string_agg(concat_ws('|',fecha,ticker,open,high,low,close,volumen,is_final),E'\n' order by ticker,fecha))
 into before_short from public.market_history;
 p:=pg_temp.bt_fixture('AAPL',date '1980-12-12',start_day,end_day,clock_at);
 n:=jsonb_array_length(p->'rows');
 perform pg_temp.bt_assert(n>2700 and n<2900,'eleven_year_fixture_has_expected_session_count');
 perform pg_temp.bt_assert(not exists(select 1 from market_scanner.backtest_sessions where session_date in
  (date '2018-12-05',date '2022-06-20',date '2025-01-09')),'calendar_contains_extraordinary_and_Juneteenth_closures');
 perform pg_temp.bt_assert(exists(select 1 from market_scanner.backtest_sessions where session_date=date '2021-12-31'),
  'Saturday_New_Year_does_not_close_previous_December_31');
 perform pg_temp.bt_assert((select bool_and(relrowsecurity) from pg_class where oid in
  ('public.backtest_history'::regclass,'public.backtest_history_coverage'::regclass,
   'market_scanner.backtest_history_queue'::regclass,'market_scanner.backtest_history_audit'::regclass)), 'all_archive_tables_have_RLS');
 perform pg_temp.bt_assert(has_table_privilege('anon','public.backtest_history','SELECT')
  and not has_table_privilege('anon','public.backtest_history','INSERT,UPDATE,DELETE'), 'anonymous_history_is_read_only');
 perform pg_temp.bt_assert(has_table_privilege('authenticated','public.backtest_history_coverage','SELECT')
  and not has_table_privilege('authenticated','public.backtest_history_coverage','INSERT,UPDATE,DELETE'), 'coverage_is_read_only');
 foreach fn in array array['public.backtest_claim_history(integer)','public.backtest_fail_history(bigint,uuid,text)',
  'public.backtest_replace_history(bigint,uuid,jsonb)'] loop
  perform pg_temp.bt_assert(not has_function_privilege('anon',fn,'EXECUTE') and not has_function_privilege('authenticated',fn,'EXECUTE')
   and has_function_privilege('service_role',fn,'EXECUTE'),'private_RPC_'||fn);
 end loop;
 perform pg_temp.bt_assert(not has_function_privilege('service_role','market_scanner.dispatch_backtest_history_worker()','EXECUTE'),
  'worker_cannot_read_vault_or_dispatch_itself');
 r:=market_scanner.parse_backtest_payload(p,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(not r?'error' and (r->>'row_count')::integer=n,'complete_payload_is_accepted');
 bad:=jsonb_set(p,'{currency}','"EUR"');r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='INVALID_PROVIDER_IDENTITY','wrong_currency_rejected');
 bad:=jsonb_set(p,'{symbol}','"MSFT"');r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='INVALID_PROVIDER_IDENTITY','wrong_symbol_rejected');
 bad:=jsonb_set(p,'{rows,0,volume}','null');r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='NON_NUMERIC_OHLCV','missing_volume_is_not_zero');
 bad:=jsonb_set(p,'{rows,0,high}','50');r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='INCOHERENT_OHLCV','material_bad_OHLC_rejected');
 bad:=jsonb_set(p,'{rows,0,volume}','-1');r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='INCOHERENT_OHLCV','negative_volume_rejected');
 bad:=jsonb_set(p,'{rows,0,high}','104.999999');r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(not r?'error' and (r->'bars'->0->>'high')::float8=105 and (r->>'rounding_envelope_rows')::integer=1,
  'tiny_vendor_rounding_is_normalized_and_counted');
 bad:=jsonb_set(p,'{rows}',(p->'rows')||jsonb_build_array(p->'rows'->0));r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='DUPLICATE_SESSION','duplicate_date_rejected');
 bad:=jsonb_set(p,'{rows}',(p->'rows')-100);r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='INCOMPLETE_HISTORY','internal_gap_rejected');
 bad:=jsonb_set(p,'{rows}',(p->'rows')-(n-1));r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='INCOMPLETE_HISTORY','missing_latest_close_rejected');
 bad:=jsonb_set(p,'{regular_market_time}',to_jsonb(extract(epoch from clock_at-interval '7 days')));
 r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='STALE_OR_INVALID_CAPTURE','unconfirmed_or_stale_source_time_rejected');
 bad:=jsonb_set(p,'{requested_at}',to_jsonb(clock_at-interval '20 minutes'));
 r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='STALE_OR_INVALID_CAPTURE','stale_download_rejected');
 bad:=jsonb_set(p,'{rows,0,timestamp}',to_jsonb(extract(epoch from timestamptz '2018-12-05 14:30Z')));
 r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='INVALID_SESSION_DATE','holiday_bar_rejected');
 bad:=jsonb_set(p,'{splits}','[{"timestamp":1,"numerator":0,"denominator":1}]');
 r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='INVALID_SPLITS','invalid_split_rejected');

 -- Isolate all queue activity inside this transaction to test the global cap.
 update market_scanner.backtest_history_queue set status='completed',lease_until=null,next_attempt_at=now()+interval '1 day';
 perform market_scanner.queue_backtest_history(ticker,'ROLLBACK_TEST',true) from market_scanner.instruments where ticker in ('AAPL','MSFT','QQQ');
 jobs:=public.backtest_claim_history(250);
 perform pg_temp.bt_assert(jsonb_array_length(jobs)=2,'claim_is_capped_at_two');
 perform pg_temp.bt_assert(public.backtest_claim_history(250)='[]'::jsonb,'overlapping_dispatch_cannot_exceed_two_live_leases');
 update market_scanner.backtest_history_queue set status='completed',lease_until=null;
 insert into market_scanner.backtest_history_queue(ticker,reason,status,attempts,requested_start,requested_end,lease_token,lease_until)
 values('AAPL','ROLLBACK_TEST','running',1,start_day,end_day,lease,now()+interval '10 minutes')
 on conflict(ticker) do update set status='running',attempts=1,requested_start=excluded.requested_start,requested_end=excluded.requested_end,
  lease_token=lease,lease_until=now()+interval '10 minutes' returning id into job_id;
 r:=public.backtest_replace_history(job_id,wrong,p);
 perform pg_temp.bt_assert(r->>'reason'='INVALID_LEASE','wrong_lease_cannot_publish');
 r:=public.backtest_replace_history(job_id,lease,p);
 perform pg_temp.bt_assert(r->>'status'='completed' and (select count(*)=n from public.backtest_history where ticker='AAPL'),
  'complete_history_and_coverage_publish_atomically');
 select snapshot_id into before_snapshot from public.backtest_history_coverage where ticker='AAPL';
 perform pg_temp.bt_assert((select status='ready' and row_count=n and snapshot_id is not null from public.backtest_history_coverage where ticker='AAPL'),
  'accepted_snapshot_has_ready_coverage');
 select md5(string_agg(concat_ws('|',fecha,open,high,low,close,volumen),E'\n' order by fecha)) into before_long
 from public.backtest_history where ticker='AAPL';
 update market_scanner.backtest_history_queue set status='running',lease_token=lease,lease_until=now()+interval '10 minutes' where id=job_id;
 r:=public.backtest_replace_history(job_id,lease,p);
 perform pg_temp.bt_assert(r->>'status'='completed' and (r->>'changed_rows')::integer=0 and (r->>'deleted_rows')::integer=0,
  'repeat_download_does_not_rewrite_unchanged_bars');
 select snapshot_id into before_snapshot from public.backtest_history_coverage where ticker='AAPL';
 update market_scanner.backtest_history_queue set status='running',lease_token=lease,lease_until=now()+interval '10 minutes' where id=job_id;
 bad:=jsonb_set(p,'{rows,100,low}','200');r:=public.backtest_replace_history(job_id,lease,bad);
 perform pg_temp.bt_assert(r->>'status'='rejected' and (select snapshot_id=before_snapshot and status='ready' and last_error='INCOHERENT_OHLCV'
  from public.backtest_history_coverage where ticker='AAPL'), 'failed_refresh_preserves_previous_ready_snapshot');
 perform pg_temp.bt_assert((select md5(string_agg(concat_ws('|',fecha,open,high,low,close,volumen),E'\n' order by fecha))=before_long
  from public.backtest_history where ticker='AAPL'),'failed_refresh_never_changes_accepted_bars');
 perform pg_temp.bt_assert((select status='failed' and next_attempt_at>now() from market_scanner.backtest_history_queue where id=job_id),
  'rejected_refresh_has_bounded_retry');
 blocked:=false;
 begin delete from public.backtest_history where ticker='AAPL';exception when insufficient_privilege then blocked:=true;end;
 perform pg_temp.bt_assert(blocked,'direct_history_mutation_is_guarded');

 -- A late IPO can legitimately have fewer rows, but its reported listing date
 -- cannot move forward later and erase known in-window observations.
 insert into market_scanner.instruments(ticker,yahoo_symbol,instrument_type,exchange_name,currency,active)
 values('BTTEST','BTTEST','STOCK','NASDAQ','USD',true);
 select session_date into ipo_day from market_scanner.backtest_sessions where session_date<=end_day order by session_date desc offset 9 limit 1;
 select session_date into later_day from market_scanner.backtest_sessions where session_date<=end_day order by session_date desc offset 4 limit 1;
 p:=pg_temp.bt_fixture('BTTEST',ipo_day,start_day,end_day,clock_at);
 r:=market_scanner.parse_backtest_payload(p,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(not r?'error' and (r->>'row_count')::integer=10,'genuine_IPO_keeps_its_actual_short_history');
 insert into market_scanner.backtest_history_queue(ticker,reason,status,attempts,requested_start,requested_end,lease_token,lease_until)
 values('BTTEST','ROLLBACK_IPO','running',1,start_day,end_day,lease,now()+interval '10 minutes') returning id into job_id;
 r:=public.backtest_replace_history(job_id,lease,p);
 perform pg_temp.bt_assert(r->>'status'='completed','short_IPO_history_is_publishable');
 bad:=pg_temp.bt_fixture('BTTEST',later_day,start_day,end_day,clock_at);
 r:=market_scanner.parse_backtest_payload(bad,start_day,end_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='LISTING_DATE_REGRESSION','provider_listing_date_cannot_truncate_known_archive');

 -- Bootstrap only: a first-load latest-day defect permits exactly one complete
 -- download ending on the immediately previous confirmed session.
 update market_scanner.backtest_history_queue set status='completed',lease_until=null;
 insert into market_scanner.instruments(ticker,yahoo_symbol,instrument_type,exchange_name,currency,active)
 values('BTFALL','BTFALL','STOCK','NASDAQ','USD',true);
 insert into public.backtest_history_coverage(ticker,requested_start,requested_end) values('BTFALL',start_day,end_day);
 insert into market_scanner.backtest_history_queue(ticker,reason,status,attempts,requested_start,requested_end,lease_token,lease_until)
 values('BTFALL','ROLLBACK_FALLBACK','running',1,start_day,end_day,lease,now()+interval '10 minutes') returning id into job_id;
 p:=pg_temp.bt_fixture('BTFALL',ipo_day,start_day,end_day,clock_at);
 bad:=jsonb_set(p,array['rows',(jsonb_array_length(p->'rows')-1)::text,'high'],'50');
 r:=public.backtest_replace_history(job_id,lease,bad);
 perform pg_temp.bt_assert(r->>'reason'='INCOHERENT_OHLCV' and not exists(select 1 from public.backtest_history where ticker='BTFALL'),
  'bad_latest_first_load_publishes_no_partial_rows');
 update market_scanner.backtest_history_queue set next_attempt_at=now()-interval '1 second' where id=job_id;
 jobs:=public.backtest_claim_history(2);fallback_job:=jobs->0;
 select max(session_date) into previous_day from market_scanner.backtest_sessions where session_date<end_day;
 previous_start:=(previous_day-interval '11 years')::date;
 perform pg_temp.bt_assert(jsonb_array_length(jobs)=1 and fallback_job->>'ticker'='BTFALL'
  and (fallback_job->>'requested_end')::date=previous_day and (fallback_job->>'requested_start')::date=previous_start,
  'second_attempt_claims_exact_previous_session_for_empty_archive');
 p:=pg_temp.bt_fixture('BTFALL',ipo_day,previous_start,previous_day,clock_at);
 bad:=jsonb_set(p,'{rows,0,high}','50');
 r:=market_scanner.parse_backtest_payload(bad,previous_start,previous_day,clock_at);
 perform pg_temp.bt_assert(r->>'error'='INCOHERENT_OHLCV','fallback_does_not_hide_invalid_historical_rows');
 select max(session_date) into too_old from market_scanner.backtest_sessions where session_date<previous_day;
 bad:=pg_temp.bt_fixture('BTFALL',ipo_day,(too_old-interval '11 years')::date,too_old,clock_at);
 r:=market_scanner.parse_backtest_payload(bad,(too_old-interval '11 years')::date,too_old,clock_at);
 perform pg_temp.bt_assert(r->>'error'='INVALID_HISTORY_WINDOW','fallback_cannot_step_back_more_than_one_session');
 update market_scanner.backtest_history_queue set last_error=null where id=job_id;
 r:=public.backtest_replace_history(job_id,(fallback_job->>'lease_token')::uuid,p);
 perform pg_temp.bt_assert(r->>'reason'='INVALID_FALLBACK_WINDOW','missing_prior_error_does_not_bypass_fallback_gate');
 update market_scanner.backtest_history_queue set status='running',last_error='INCOHERENT_OHLCV',lease_until=now()+interval '10 minutes' where id=job_id;
 r:=public.backtest_replace_history(job_id,(fallback_job->>'lease_token')::uuid,p);
 perform pg_temp.bt_assert(r->>'status'='completed' and (select status='ready' and last_date=previous_day and row_count=9
  and last_error='LATEST_SESSION_UNAVAILABLE' from public.backtest_history_coverage where ticker='BTFALL'),
  'validated_previous_session_snapshot_is_ready_with_explicit_warning');
 -- A later failed refresh must never use the bootstrap fallback again.
 update market_scanner.backtest_history_queue set status='failed',attempts=1,last_error='INCOHERENT_OHLCV',
  next_attempt_at=now()-interval '1 second',lease_until=null where id=job_id;
 jobs:=public.backtest_claim_history(2);fallback_job:=jobs->0;
 perform pg_temp.bt_assert((fallback_job->>'requested_end')::date=end_day,'accepted_archive_retries_current_session_without_bootstrap');
 -- Server publication independently enforces the first-load/attempt gate.
 update market_scanner.backtest_history_queue set requested_start=previous_start,requested_end=previous_day where id=job_id;
 r:=public.backtest_replace_history(job_id,(fallback_job->>'lease_token')::uuid,p);
 perform pg_temp.bt_assert(r->>'reason'='INVALID_FALLBACK_WINDOW','ready_archive_cannot_publish_a_bootstrap_window');
 insert into market_scanner.instruments(ticker,yahoo_symbol,instrument_type,exchange_name,currency,active)
 values('BTHIST','BTHIST','STOCK','NASDAQ','USD',true);
 insert into public.backtest_history_coverage(ticker,requested_start,requested_end) values('BTHIST',start_day,end_day);
 insert into market_scanner.backtest_history_queue(ticker,reason,status,attempts,requested_start,requested_end,lease_token,lease_until,last_error)
 values('BTHIST','ROLLBACK_HISTORIC_BAD','running',2,previous_start,previous_day,lease,now()+interval '10 minutes','INCOHERENT_OHLCV') returning id into job_id;
 p:=pg_temp.bt_fixture('BTHIST',ipo_day,previous_start,previous_day,clock_at);
 bad:=jsonb_set(p,'{rows,0,high}','50');r:=public.backtest_replace_history(job_id,lease,bad);
 perform pg_temp.bt_assert(r->>'reason'='INCOHERENT_OHLCV' and not exists(select 1 from public.backtest_history where ticker='BTHIST'),
  'historical_defect_still_rejects_full_fallback_publication');
 update market_scanner.backtest_history_queue set next_attempt_at=now()-interval '1 second' where id=job_id;
 jobs:=public.backtest_claim_history(2);fallback_job:=jobs->0;
 perform pg_temp.bt_assert(fallback_job->>'ticker'='BTHIST' and (fallback_job->>'requested_end')::date=end_day,
  'failed_second_attempt_returns_to_current_session_on_attempt_three');
 perform pg_temp.bt_assert((select md5(string_agg(concat_ws('|',fecha,ticker,open,high,low,close,volumen,is_final),E'\n' order by ticker,fecha))=before_short
  from public.market_history),'scanner_history_unchanged_by_all_archive_operations');
end $regression$;
select jsonb_build_object('group','backtest_history','status','passed','assertions',count(*),
 'fixture','synthetic bars only inside rollback transaction','history_mutations_committed',false,
 'checks',jsonb_agg(check_name order by check_name)) as regression_summary from backtest_test_results;
rollback;
