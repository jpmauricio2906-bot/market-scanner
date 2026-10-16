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
 -- Emulate a trusted Yahoo current observation using real stored OHLCV, only
 -- inside this rolled-back transaction. Canonical history is never seeded/faked.
 bar:=to_jsonb(h)||jsonb_build_object('fecha',d,'is_final',false);
 delete from market_scanner.current_quotes where ticker='AAPL';
 insert into market_scanner.current_quotes(ticker,current_bar,status,reason,fetched_at,source_quote_at,updated_at)
 values('AAPL',bar,'PROVISIONAL','ROLLBACK_ONLY',c,qt,c);
 select to_jsonb(x) into priv from market_scanner.current_quotes x where ticker='AAPL';
 select to_jsonb(x) into oldbar from public.market_history x where ticker='AAPL' and is_final and fecha<d order by fecha desc limit 1;
 update market_scanner.current_quotes set current_bar=oldbar,status='FINAL',fetched_at=c+interval '1 second',source_quote_at=qt+interval '1 second' where ticker='AAPL';
 perform pg_temp.ok((select to_jsonb(x)=priv from market_scanner.current_quotes x where ticker='AAPL'),'backfill_previous_day_cannot_regress_private_current');
 perform market_scanner.queue_repair('AAPL','ROLLBACK_RESCALE');
 perform pg_temp.ok(not exists(select 1 from public.market_latest_quotes where ticker='AAPL'),'pending_repair_removes_public_quote');
 finished:=c+interval '1 second';
 update market_scanner.repair_queue set status='completed',finished_at=finished,lease_until=null where ticker='AAPL';
 perform pg_temp.ok(not exists(select 1 from public.market_latest_quotes where ticker='AAPL'),'completed_repair_does_not_resurrect_old_today_provisional');
 r:=public.market_ingest_sheet_quotes(jsonb_build_array(p));
 perform pg_temp.ok(r->'results'->0->>'status'='PENDIENTE_DE_ACTUALIZAR' and not exists(select 1 from public.market_latest_quotes where ticker='AAPL'),'GF_capture_before_repair_waits_for_fresh_capture');
 bad:=p||jsonb_build_object('fetched_at',c+interval '2 seconds');r:=public.market_ingest_sheet_quotes(jsonb_build_array(bad));
 perform pg_temp.ok(r->'results'->0->>'status'='PROVISIONAL' and exists(select 1 from public.market_latest_quotes where ticker='AAPL'),'fresh_GF_after_repair_can_publish');
 -- Simulate arrival in a later transaction by setting server updated_at too.
 update market_scanner.current_quotes set fetched_at=c+interval '3 seconds',source_quote_at=qt+interval '1 second',updated_at=c+interval '3 seconds' where ticker='AAPL';
 perform pg_temp.ok((select source='yahoo' from public.market_latest_quotes where ticker='AAPL'),'fresh_Yahoo_after_repair_can_publish');
 -- A complete real 500-bar replacement still leaves a newer private session
 -- observation intact, and its completion cannot resurrect a pre-repair overlay.
 select jsonb_build_object('ticker','AAPL','source','yahoo','symbol','AAPL','currency','USD','exchange_timezone','America/New_York','exchange_name','NMS',
  'first_trade_epoch',345479400,'regular_market_time',extract(epoch from qt+interval '2 seconds'),'requested_at',c+interval '4 seconds','fetched_at',c+interval '4 seconds',
  'rows',jsonb_agg(jsonb_build_object('timestamp',extract(epoch from ((fecha+time '09:30') at time zone 'America/New_York')),'open',open,'high',high,'low',low,'close',close,'volume',volumen) order by fecha),'splits','[]'::jsonb)
 into raw from public.market_history where ticker='AAPL' and is_final;
 insert into market_scanner.repair_queue(ticker,reason,status,attempts,next_attempt_at,lease_token,lease_until)
 values('AAPL','ROLLBACK_FULL_REPAIR','running',1,now(),lease,now()+interval '10 minutes')
 on conflict(ticker) do update set status='running',lease_token=excluded.lease_token,lease_until=excluded.lease_until,finished_at=null returning id into j;
 r:=public.market_replace_history(j,lease,raw);
 perform pg_temp.ok(r->>'status'='completed','actual_500_bar_repair_completes');
 perform pg_temp.ok((select (current_bar->>'fecha')::date=d from market_scanner.current_quotes where ticker='AAPL'),'full_repair_keeps_newer_private_session');

 perform pg_temp.ok(pg_temp.hhash()=hh,'global_canonical_history_hash_unchanged');
end $test$;
select jsonb_build_object('status','passed','assertions',count(*),'group','03_repair_no_regression','checks',jsonb_agg(name order by name)) as summary from live_checks;
rollback;
