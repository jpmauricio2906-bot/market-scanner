-- Source identity/time regression. Run after arkk_exchange_correction.sql.
-- Prices come from actual stored final bars. Only capture times are simulated.
-- No ingest RPC or production write is executed; the entire test rolls back.
begin isolation level repeatable read;
set local statement_timeout='25s';
set local lock_timeout='5s';
set local extra_float_digits=3;
create temporary table source_checks(name text primary key) on commit drop;
create function pg_temp.source_ok(v boolean,n text) returns void language plpgsql as $$begin
 if v is distinct from true then raise exception 'Quote source correction regression failed: %',n;end if;
 insert into source_checks values(n);
end$$;
create function pg_temp.source_state() returns jsonb language sql stable as $$
 select jsonb_build_object(
  'history',(select md5(coalesce(string_agg(to_jsonb(h)::text,E'\n' order by ticker,fecha),'')) from public.market_history h),
  'private_yahoo',(select md5(coalesce(string_agg(to_jsonb(q)::text,E'\n' order by ticker),'')) from market_scanner.current_quotes q),
  'public_quotes',(select md5(coalesce(string_agg(to_jsonb(q)::text,E'\n' order by ticker),'')) from public.market_latest_quotes q));
$$;
create function pg_temp.source_capture(t text,s text,q timestamptz,c timestamptz) returns jsonb language plpgsql as $$
declare bar public.market_history%rowtype;
begin
 select * into bar from public.market_history where ticker=t and is_final order by fecha desc limit 1;
 if not found then raise exception 'Missing real final source fixture: %',t;end if;
 return jsonb_build_object('ticker',t,'source','googlefinance','symbol',s,'currency','USD',
  'source_quote_at',q,'fetched_at',c,'open',bar.open,'high',bar.high,'low',bar.low,
  'close',bar.close,'volume',bar.volumen,'previous_close',bar.close,'datadelay_minutes',0);
end$$;
do $tests$
declare before_state jsonb:=pg_temp.source_state();p jsonb;r jsonb;winter_valid jsonb;winter_invalid jsonb;
 summer_clock timestamptz:='2026-10-16T20:10:00Z';winter_clock timestamptz:='2026-01-15T21:10:00Z';
begin
 perform pg_temp.source_ok((select active and instrument_type='ETF' and exchange_name='CBOEBZX'
  from market_scanner.instruments where ticker='ARKK'),'ARKK_corrected_Cboe_BZX_identity');
 perform pg_temp.source_ok(not has_function_privilege('anon','public.market_ingest_sheet_quotes(jsonb)','execute'),'anonymous_ingest_RPC_stays_denied');
 perform pg_temp.source_ok(not has_function_privilege('authenticated','public.market_ingest_sheet_quotes(jsonb)','execute'),'authenticated_ingest_RPC_stays_denied');
 perform pg_temp.source_ok(has_function_privilege('service_role','public.market_ingest_sheet_quotes(jsonb)','execute'),'service_ingest_RPC_stays_allowed');
 perform pg_temp.source_ok(not has_table_privilege('anon','public.market_history','insert')
  and not has_table_privilege('authenticated','public.market_history','update'),'public_canonical_history_writes_stay_denied');

 p:=pg_temp.source_capture('ARKK','BATS:ARKK','2026-10-16T20:00:00Z',summer_clock);
 r:=market_scanner.parse_sheet_quote(p,summer_clock);
 perform pg_temp.source_ok(not(r?'error') and r->>'status'='PROVISIONAL' and not(r->>'is_final')::boolean,
  'ARKK_BATS_accepted_as_provisional');
 r:=market_scanner.parse_sheet_quote(p||jsonb_build_object('symbol','NYSEARCA:ARKK'),summer_clock);
 perform pg_temp.source_ok(r->>'error'='IDENTIDAD_MONEDA_INVALIDA' and r->>'status'='RECHAZADO',
  'ARKK_old_ARCA_identity_rejected');

 -- The corrected SOXS summer timestamp is 20:00 UTC, which is 16:00 NY.
 -- Sending 20:00 NY instead yields 00:00 UTC the next day and must be rejected.
 p:=pg_temp.source_capture('SOXS','NYSEARCA:SOXS','2026-10-16T20:00:00Z',summer_clock);
 r:=market_scanner.parse_sheet_quote(p,summer_clock);
 perform pg_temp.source_ok(not(r?'error') and r->>'status'='PROVISIONAL' and not(r->>'is_final')::boolean
  and (r->>'source_quote_at')::timestamptz=timestamptz '2026-10-16T20:00:00Z',
  'SOXS_summer_UTC_source_accepted_never_final');
 r:=market_scanner.parse_sheet_quote(p||jsonb_build_object('source_quote_at',timestamptz '2026-10-17T00:00:00Z'),summer_clock);
 perform pg_temp.source_ok(r->>'error'='CAPTURA_ANTIGUA_O_FECHA_FUTURA' and r->>'status'='RECHAZADO',
  'SOXS_summer_four_hour_future_still_rejected');

 -- Winter has a five-hour NY offset. Both acceptance and future rejection
 -- must hold without relaxing the server's clock checks or using fixed -4h.
 p:=pg_temp.source_capture('SOXS','NYSEARCA:SOXS','2026-01-15T21:00:00Z',winter_clock);
 winter_valid:=market_scanner.parse_sheet_quote(p,winter_clock);
 winter_invalid:=market_scanner.parse_sheet_quote(p||jsonb_build_object('source_quote_at',timestamptz '2026-01-16T02:00:00Z'),winter_clock);
 perform pg_temp.source_ok(not(winter_valid?'error') and not(winter_valid->>'is_final')::boolean
  and winter_invalid->>'error'='CAPTURA_ANTIGUA_O_FECHA_FUTURA' and winter_invalid->>'status'='RECHAZADO',
  'SOXS_winter_UTC_valid_and_five_hour_future_rejected');
 r:=market_scanner.parse_sheet_quote(p||jsonb_build_object('high',(p->>'low')::float8/2),winter_clock);
 perform pg_temp.source_ok(r->>'error'='OHLCV_INCOHERENTE' and r->>'status'='RECHAZADO',
  'malformed_OHLC_still_rejected');
 perform pg_temp.source_ok(pg_temp.source_state()=before_state,
  'canonical_history_private_Yahoo_and_public_quotes_hashes_unchanged');
end $tests$;
select jsonb_build_object('status','passed','assertions',count(*),'group','quote_source_corrections',
 'checks',jsonb_agg(name order by name)) as summary from source_checks;
rollback;
