-- Independent rollback group; run all three cloud_close_audit*.sql files.
begin isolation level repeatable read;
set local statement_timeout='60s';set local lock_timeout='5s';
create temporary table close_audit_checks(name text primary key) on commit drop;
create function pg_temp.audit_ok(v boolean,n text) returns void language plpgsql as $$begin
if v is distinct from true then raise exception 'Cloud close audit regression failed: %',n;end if;
insert into close_audit_checks values(n);end$$;
create function pg_temp.audit_has(r jsonb,t text,c text) returns boolean language sql as $$
select exists(select 1 from jsonb_array_elements(r->'issues') x where x->>'ticker'=t and x->>'code'=c);$$;
create function pg_temp.audit_prices_hash() returns text language sql stable as $$
select md5((select coalesce(string_agg(to_jsonb(h)::text,E'\n' order by ticker,fecha),'') from public.market_history h)||
(select coalesce(string_agg(to_jsonb(q)::text,E'\n' order by ticker),'') from public.market_latest_quotes q)||
(select coalesce(string_agg(to_jsonb(q)::text,E'\n' order by ticker),'') from market_scanner.current_quotes q));$$;
select set_config('market_scanner.validated_write','on',true),set_config('market_scanner.live_validated_write','on',true),set_config('market_scanner.live_write_source','yahoo',true);
delete from market_scanner.repair_queue;
delete from market_scanner.ingest_events;
delete from public.market_history h using market_scanner.instruments i
where h.ticker=i.ticker and i.active and (not h.is_final or h.fecha>date '2026-10-19' or h.fecha<greatest(coalesce(i.first_trade_date,date '2024-01-01'),
(select session_date from market_scanner.sessions where session_date<=date '2026-10-19' order by session_date desc offset 499 limit 1)));
insert into public.market_history(fecha,ticker,open,high,low,close,volumen,is_final)
select s.session_date,i.ticker,100,105,95,102,1000,true from market_scanner.instruments i join market_scanner.sessions s
on s.session_date between greatest(coalesce(i.first_trade_date,date '2024-01-01'),
(select session_date from market_scanner.sessions where session_date<=date '2026-10-19' order by session_date desc offset 499 limit 1)) and date '2026-10-19'
where i.active on conflict(fecha,ticker) do nothing;
delete from public.market_latest_quotes;
insert into market_scanner.current_quotes(ticker,current_bar,status,reason,fetched_at,source_quote_at)
select h.ticker,to_jsonb(h),'FINAL','ROLLBACK_FIXTURE',timestamptz '2026-10-20 00:20Z',s.closes_at
from public.market_history h join market_scanner.instruments i on i.ticker=h.ticker and i.active
join market_scanner.sessions s on s.session_date=h.fecha where h.fecha=date '2026-10-19' and h.is_final
on conflict(ticker) do update set current_bar=excluded.current_bar,status=excluded.status,reason=excluded.reason,
fetched_at=excluded.fetched_at,source_quote_at=excluded.source_quote_at;
insert into market_scanner.ingest_events(ticker,status,reason,payload,received_at)
select i.ticker,case x.source when 'yahoo' then 'FINAL' else 'PROVISIONAL' end,'ROLLBACK_FIXTURE',jsonb_build_object('source',x.source),timestamptz '2026-10-20 00:20Z'
from market_scanner.instruments i cross join(values('googlefinance'),('yahoo'))x(source) where i.active;
select cron.alter_job(jobid,active:=true) from cron.job where jobname='market-scanner-repair-worker';
insert into cron.job_run_details(jobid,runid,job_pid,database,username,command,status,start_time,end_time,return_message)
select jobid,-2026101901,0,current_database(),current_user,'ROLLBACK_FIXTURE','succeeded',timestamptz '2026-10-20 00:29Z',timestamptz '2026-10-20 00:29:01Z','SELECT 1'
from cron.job where jobname='market-scanner-repair-worker';
create temporary table audit_aapl_history as select * from public.market_history where ticker='AAPL';
create temporary table audit_aapl_quote as select * from public.market_latest_quotes where ticker='AAPL';
create temporary table audit_aapl_private as select * from market_scanner.current_quotes where ticker='AAPL';
create temporary table audit_aapl_events as select * from market_scanner.ingest_events where ticker='AAPL';
create function pg_temp.audit_restore() returns void language plpgsql as $$begin
perform set_config('market_scanner.validated_write','on',true);perform set_config('market_scanner.live_validated_write','on',true);perform set_config('market_scanner.live_write_source','yahoo',true);
delete from market_scanner.repair_queue where ticker='AAPL';
delete from public.market_history where ticker='AAPL';insert into public.market_history select * from audit_aapl_history;
update market_scanner.current_quotes q set current_bar=b.current_bar,status=b.status,reason=b.reason,fetched_at=b.fetched_at,source_quote_at=b.source_quote_at from audit_aapl_private b where q.ticker=b.ticker;
delete from public.market_latest_quotes where ticker='AAPL';insert into public.market_latest_quotes select * from audit_aapl_quote;
delete from market_scanner.ingest_events where ticker='AAPL';
insert into market_scanner.ingest_events(ticker,status,reason,payload,received_at) select ticker,status,reason,payload,received_at from audit_aapl_events;
end$$;
create function pg_temp.audit_report() returns jsonb language sql stable as $$
select market_scanner.build_close_audit(date '2026-10-19',timestamptz '2026-10-20 00:30Z');$$;
do $test$
declare r jsonb;h text:=pg_temp.audit_prices_hash();begin
r:=pg_temp.audit_report();
perform pg_temp.audit_ok(r->>'ok'='true' and (r->>'complete')::integer=250 and jsonb_array_length(r->'issues')=0,'250_valid_final_closes_are_healthy');
perform pg_temp.audit_ok(jsonb_array_length(r->'universe')=250 and (r#>>'{checks,universe_count}')::integer=250
and r#>>'{automatic,googlefinance,distinct_tickers}'='250' and r#>>'{automatic,yahoo,distinct_tickers}'='250','universe_and_lowercase_provider_receipts_reported');
perform pg_temp.audit_ok(pg_temp.audit_prices_hash()=h and not exists(select 1 from public.market_close_audits where session_date=date '2026-10-19'),'builder_does_not_write_prices_or_snapshot');
perform pg_temp.audit_ok(not market_scanner.close_audit_bar_valid(110,105,95,102,1)
and not market_scanner.close_audit_bar_valid('NaN'::float8,105,95,102,1)
and not market_scanner.close_audit_bar_valid(100,105,95,102,-1),'invalid_OHLCV_and_NaN_fail_closed');
delete from public.market_history where ticker='AAPL' and fecha=date '2026-10-19';
r:=pg_temp.audit_report();
perform pg_temp.audit_ok(pg_temp.audit_has(r,'AAPL','MISSING_FINAL_CLOSE') and r->>'complete'='249','missing_close_is_actionable');
perform pg_temp.audit_restore();
perform set_config('market_scanner.live_write_source','googlefinance',true);
update public.market_latest_quotes set is_final=false,status='PROVISIONAL',source='googlefinance',datadelay_minutes=20 where ticker='AAPL';
r:=pg_temp.audit_report();
perform pg_temp.audit_ok(pg_temp.audit_has(r,'AAPL','PROVISIONAL_CLOSE'),'provisional_is_not_a_final_close');
perform pg_temp.audit_restore();
update public.market_latest_quotes set close=close+0.01 where ticker='AAPL';
r:=pg_temp.audit_report();
perform pg_temp.audit_ok(pg_temp.audit_has(r,'AAPL','PUBLIC_HISTORY_MISMATCH'),'accepted_projection_must_match_history');
perform pg_temp.audit_restore();
end $test$;
select jsonb_build_object('status','passed','assertions',count(*),'group','cloud_close_audit_01_prices','committed_fixtures',false,
'checks',jsonb_agg(name order by name)) as summary from close_audit_checks;
rollback;
