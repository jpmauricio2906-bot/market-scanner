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

 perform pg_temp.ok(has_table_privilege('anon','public.market_latest_quotes','select') and has_table_privilege('authenticated','public.market_latest_quotes','select'),'public_quote_readable');
 perform pg_temp.ok(not has_table_privilege('anon','public.market_latest_quotes','insert') and not has_table_privilege('authenticated','public.market_latest_quotes','update') and not has_table_privilege('service_role','public.market_latest_quotes','truncate'),'public_no_direct_write_or_truncate');
 perform pg_temp.ok(not has_function_privilege('anon','public.market_ingest_sheet_quotes(jsonb)','execute') and not has_function_privilege('authenticated','public.market_ingest_sheet_quotes(jsonb)','execute') and has_function_privilege('service_role','public.market_ingest_sheet_quotes(jsonb)','execute'),'GF_RPC_server_only');
 perform pg_temp.ok(not has_schema_privilege('anon','market_scanner','usage') and not has_schema_privilege('authenticated','market_scanner','usage'),'private_Yahoo_schema_not_exposed');
 perform pg_temp.ok((select relrowsecurity from pg_class where oid='public.market_latest_quotes'::regclass),'public_table_RLS_enabled');
 flag:=false;begin
 insert into public.market_latest_quotes(ticker,fecha,open,high,low,close,volumen,is_final,status,source,source_quote_at,fetched_at)
 values(h.ticker,h.fecha,h.open,h.high,h.low,h.close,h.volumen,true,'FINAL','yahoo',qt,c);
 exception when insufficient_privilege then flag:=true;end;
 perform pg_temp.ok(flag,'unvalidated_public_write_blocked');
 select * into s from market_scanner.sessions where session_date=h.fecha;
 p:=pg_temp.gf('AAPL',s.opens_at+interval '1 hour',s.opens_at+interval '1 hour');
 r:=market_scanner.parse_sheet_quote(p,s.opens_at+interval '1 hour');
 perform pg_temp.ok(not(r?'error') and not(r->>'is_final')::boolean and r->>'status'='PROVISIONAL','valid_intraday_GF_is_always_provisional');
 p:=pg_temp.gf('AAPL',s.closes_at,s.closes_at+interval '2 hours');r:=market_scanner.parse_sheet_quote(p,s.closes_at+interval '2 hours');
 perform pg_temp.ok(not(r?'error') and not(r->>'is_final')::boolean,'after_close_GF_still_not_final');
 p:=pg_temp.gf('AAPL',s.opens_at+interval '1 hour',s.opens_at+interval '1 hour');
 foreach f in array array['null','"#N/A"','"Loading..."'] loop
  bad:=jsonb_set(p,'{close}',f::jsonb);r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');
  perform pg_temp.ok(r->>'status'='PENDIENTE_DE_ACTUALIZAR' and r->>'error'='FALTAN_DATOS_PROVEEDOR','missing_provider_'||f);
 end loop;
 bad:=jsonb_set(p,'{close}','"123"');r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');
 perform pg_temp.ok(r->>'status'='RECHAZADO','numeric_strings_not_prices');
 foreach f in array array['high','volume','previous_close'] loop
  bad:=jsonb_set(p,array[f],'-1');r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');
  perform pg_temp.ok(r->>'status'='RECHAZADO','invalid_numeric_'||f);
 end loop;
 bad:=jsonb_set(p,'{volume}','1.5');r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');perform pg_temp.ok(r->>'status'='RECHAZADO','fractional_volume_rejected');
 bad:=jsonb_set(p,'{datadelay_minutes}','21');r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');perform pg_temp.ok(r->>'status'='RECHAZADO','delay_over_twenty_rejected');
 bad:=p||jsonb_build_object('fetched_at',s.opens_at+interval '44 minutes');r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');perform pg_temp.ok(r->>'status'='RECHAZADO','stale_capture_rejected');
 bad:=p||jsonb_build_object('source_quote_at',s.opens_at+interval '1 hour 3 minutes');r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');perform pg_temp.ok(r->>'status'='RECHAZADO','future_source_rejected');
 bad:=p||jsonb_build_object('source_quote_at',s.opens_at+interval '29 minutes');r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');perform pg_temp.ok(r->>'status'='RECHAZADO','intraday_source_older_than_delay_tolerance_rejected');
 bad:=p||jsonb_build_object('symbol','NASDAQ:MSFT');r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');perform pg_temp.ok(r->>'status'='RECHAZADO','wrong_symbol_rejected');
 bad:=pg_temp.gf('BRK-B',s.opens_at+interval '1 hour',s.opens_at+interval '1 hour');r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');perform pg_temp.ok(not(r?'error') and bad->>'symbol'='NYSE:BRK.B','BRK_dot_and_NYSE_mapping');
 bad:=pg_temp.gf('SPY',s.opens_at+interval '1 hour',s.opens_at+interval '1 hour');r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');perform pg_temp.ok(not(r?'error') and bad->>'symbol'='NYSEARCA:SPY','ARCA_mapping');
 bad:=pg_temp.gf('MAGS',s.opens_at+interval '1 hour',s.opens_at+interval '1 hour');r:=market_scanner.parse_sheet_quote(bad,s.opens_at+interval '1 hour');perform pg_temp.ok(not(r?'error') and bad->>'symbol'='BATS:MAGS','BATS_mapping');
 perform pg_temp.ok(pg_temp.phash()=ph,'parser_and_security_do_not_modify_private_Yahoo');

 perform pg_temp.ok(pg_temp.hhash()=hh,'global_canonical_history_hash_unchanged');
end $test$;
select jsonb_build_object('status','passed','assertions',count(*),'group','01_security_quality','checks',jsonb_agg(name order by name)) as summary from live_checks;
rollback;
