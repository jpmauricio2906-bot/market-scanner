-- V3 regression. Real numeric source values; temporary captures remain in ROLLBACK.
begin;
set local statement_timeout='25s';set local lock_timeout='5s';set local extra_float_digits=3;
create temporary table live_checks(name text primary key) on commit drop;
create function pg_temp.ok(v boolean,n text) returns void language plpgsql as $$begin
 if v is distinct from true then raise exception 'Live quote regression failed: %',n;end if;
 insert into live_checks values(n);end$$;
create function pg_temp.hhash() returns text language sql stable as $$
 select md5(coalesce(string_agg(to_jsonb(h)::text,E'\n' order by ticker,fecha),'')) from public.market_history h;$$;
create function pg_temp.phash() returns text language sql stable as $$
 select md5(coalesce(string_agg(to_jsonb(q)::text,E'\n' order by ticker),'')) from market_scanner.current_quotes q;$$;
create function pg_temp.gf(t text,q timestamptz,f timestamptz) returns jsonb language plpgsql as $$
 declare h public.market_history%rowtype;i market_scanner.instruments%rowtype;prev float8;s text;begin
 select * into h from public.market_history where ticker=t and is_final order by fecha desc limit 1;
 select * into i from market_scanner.instruments where ticker=t;
 select close into prev from public.market_history where ticker=t and is_final and fecha<(q at time zone 'America/New_York')::date order by fecha desc limit 1;
 s:=case i.exchange_name when 'NASDAQ' then 'NASDAQ:' when 'NYSE' then 'NYSE:' when 'NYSEARCA' then 'NYSEARCA:' when 'CBOEBZX' then 'BATS:' end||case when t='BRK-B' then 'BRK.B' else t end;
 return jsonb_build_object('ticker',t,'source','googlefinance','symbol',s,'currency','USD','source_quote_at',q,'fetched_at',f,
  'open',h.open,'high',h.high,'low',h.low,'close',h.close,'volume',h.volumen,'previous_close',coalesce(prev,h.close),'datadelay_minutes',20);end$$;
do $test$
declare p jsonb;r jsonb;q jsonb;bad jsonb;bar jsonb;oldbar jsonb;raw jsonb;pub jsonb;priv jsonb;h public.market_history%rowtype;
 s market_scanner.sessions%rowtype;d date;qt timestamptz;c timestamptz:=clock_timestamp();finished timestamptz;
 hh text:=pg_temp.hhash();ph text:=pg_temp.phash();flag boolean;f text;n integer;j bigint;lease uuid:='233c2ae0-564b-4d88-b479-a57d0b3f1191';
begin
 select * into h from public.market_history where ticker='AAPL' and is_final order by fecha desc limit 1;
 select * into s from market_scanner.sessions where opens_at<=c order by session_date desc limit 1;
 qt:=case when c<s.closes_at then greatest(s.opens_at,c-interval '1 minute') else s.closes_at end;
 d:=s.session_date;p:=pg_temp.gf('AAPL',qt,c);

 update market_scanner.repair_queue set status='completed',finished_at=c-interval '1 hour',lease_until=null where ticker='AAPL';
 perform market_scanner.clear_live_quote('AAPL');
 r:=public.market_ingest_sheet_quotes('[]');perform pg_temp.ok(r=jsonb_build_object('version',3,'results','[]'::jsonb),'empty_batch_v3');
 r:=public.market_ingest_sheet_quotes(jsonb_build_array(p));
 perform pg_temp.ok(r->>'version'='3' and r->'results'->0->>'status'='PROVISIONAL','GF_published_as_provisional');
 select to_jsonb(x) into pub from public.market_latest_quotes x where ticker='AAPL';
 perform pg_temp.ok(pub->>'source'='googlefinance' and not(pub->>'is_final')::boolean and pub->>'status'='PROVISIONAL','GF_row_never_final');
 perform pg_temp.ok((r->'results'->0)?&array['ticker','status','reason','current','previous_close','history_count','last_final_date','needs_replacement'],'full_result_envelope');
 bad:=jsonb_set(p,'{close}','"#N/A"');r:=public.market_ingest_sheet_quotes(jsonb_build_array(bad));
 perform pg_temp.ok(r->'results'->0->>'status'='PENDIENTE_DE_ACTUALIZAR' and (select to_jsonb(x)=pub from public.market_latest_quotes x where ticker='AAPL'),'missing_formula_preserves_last_good');
 bad:=p||jsonb_build_object('source_quote_at',qt-interval '1 second','fetched_at',c+interval '1 second');r:=public.market_ingest_sheet_quotes(jsonb_build_array(bad));
 perform pg_temp.ok(r->'results'->0->>'status'='PROVISIONAL' and (select to_jsonb(x)=pub from public.market_latest_quotes x where ticker='AAPL'),'older_trade_does_not_regress_published_row');
 q:=pub||jsonb_build_object('source','yahoo','source_quote_at',qt+interval '1 second','fetched_at',c+interval '1 second','datadelay_minutes',null);
 perform market_scanner.store_live_quote(q);
 r:=public.market_ingest_sheet_quotes(jsonb_build_array(p));
 perform pg_temp.ok(r->'results'->0->>'status'='PROVISIONAL' and r->'results'->0->'current'->>'source'='yahoo','newer_other_provider_returned_without_regression');
 select jsonb_agg(p) into raw from generate_series(1,250);r:=public.market_ingest_sheet_quotes(raw);
 perform pg_temp.ok(jsonb_array_length(r->'results')=250,'batch_250_supported');
 select jsonb_agg(p) into raw from generate_series(1,251);flag:=false;begin perform public.market_ingest_sheet_quotes(raw);exception when raise_exception then flag:=true;end;
 perform pg_temp.ok(flag,'batch_251_rejected');
 flag:=false;begin perform public.market_ingest_sheet_quotes(jsonb_build_array(p||jsonb_build_object('padding',repeat('x',1048577))));exception when raise_exception then flag:=true;end;
 perform pg_temp.ok(flag,'batch_over_1MB_rejected');
 -- Fresh observation must reach the scale check rather than the out-of-order path.
 bad:=p||jsonb_build_object('source_quote_at',qt+interval '2 seconds','fetched_at',c+interval '2 seconds');
 bad:=jsonb_set(bad,'{previous_close}',to_jsonb((p->>'previous_close')::float8*1.02));
 r:=public.market_ingest_sheet_quotes(jsonb_build_array(bad));
 perform pg_temp.ok(r->'results'->0->>'status'='REEMPLAZO_PENDIENTE' and not exists(select 1 from public.market_latest_quotes where ticker='AAPL'),'previous_close_scale_change_hides_overlay_and_queues');
 r:=public.market_ingest_sheet_quotes(jsonb_build_array(p));
 perform pg_temp.ok(r->'results'->0->>'status'='REEMPLAZO_PENDIENTE' and not exists(select 1 from public.market_latest_quotes where ticker='AAPL'),'active_repair_blocks_republication');
 perform pg_temp.ok(pg_temp.phash()=ph,'GF_ingest_never_modifies_private_Yahoo_metadata');

 perform pg_temp.ok(pg_temp.hhash()=hh,'global_canonical_history_hash_unchanged');
end $test$;
select jsonb_build_object('status','passed','assertions',count(*),'group','02_ingestion_out_of_order','checks',jsonb_agg(name order by name)) as summary from live_checks;
rollback;
