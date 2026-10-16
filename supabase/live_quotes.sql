-- Intraday observations are separate from the canonical Yahoo daily history.
-- Apply after server_owned_history.sql. No GOOGLEFINANCE value becomes final.
begin;
create table if not exists public.market_latest_quotes (
 ticker text primary key references market_scanner.instruments(ticker),
 fecha date not null references market_scanner.sessions(session_date),
 open float8 not null,high float8 not null,low float8 not null,close float8 not null,volumen bigint not null,
 is_final boolean not null,status text not null check(status in ('FINAL','PROVISIONAL')),
 source text not null check(source in ('yahoo','googlefinance')),
 source_quote_at timestamptz not null,fetched_at timestamptz not null,
 previous_close float8,datadelay_minutes integer,
 check(open>0 and open<'Infinity'::float8 and high>0 and high<'Infinity'::float8 and low>0 and low<'Infinity'::float8 and close>0 and close<'Infinity'::float8
  and low<=least(open,close) and high>=greatest(open,close) and low<=high and volumen>=0 and volumen<=9007199254740991),
 check(previous_close is null or (previous_close>0 and previous_close<'Infinity'::float8)),
 check(source<>'googlefinance' or (not is_final and status='PROVISIONAL' and datadelay_minutes is not null and datadelay_minutes between 0 and 20)),
 check(is_final=(status='FINAL'))
);
alter table public.market_latest_quotes enable row level security;
create index if not exists market_latest_quotes_fecha_idx on public.market_latest_quotes(fecha);
revoke all on public.market_latest_quotes from public,anon,authenticated,service_role;
grant select on public.market_latest_quotes to anon,authenticated;
grant select,insert,update,delete on public.market_latest_quotes to service_role;
drop policy if exists market_latest_quotes_read on public.market_latest_quotes;
create policy market_latest_quotes_read on public.market_latest_quotes for select to anon,authenticated using(true);

create or replace function market_scanner.guard_live_quote_write() returns trigger
language plpgsql security invoker set search_path='' as $$ begin
 if current_setting('market_scanner.live_validated_write',true) is distinct from 'on' or
  coalesce(current_setting('market_scanner.live_write_source',true),'') not in ('yahoo','googlefinance','repair') then
  raise exception using errcode='42501',message='Usar la captura validada de cotizaciones.';
 end if;
 if tg_op='DELETE' then return old;end if;
 if current_setting('market_scanner.live_write_source',true) is distinct from new.source then
  raise exception using errcode='42501',message='Origen de cotización no validado.';end if;
 return new;
end $$;
drop trigger if exists market_latest_quotes_write_guard on public.market_latest_quotes;
create trigger market_latest_quotes_write_guard before insert or update or delete on public.market_latest_quotes
for each row execute function market_scanner.guard_live_quote_write();

create or replace function market_scanner.clear_live_quote(p_ticker text) returns void
language plpgsql security invoker set search_path='' as $$
declare w text:=coalesce(current_setting('market_scanner.live_validated_write',true),'off');
 s text:=coalesce(current_setting('market_scanner.live_write_source',true),'');begin
 perform set_config('market_scanner.live_validated_write','on',true);perform set_config('market_scanner.live_write_source','repair',true);
 delete from public.market_latest_quotes where ticker=p_ticker;
 perform set_config('market_scanner.live_validated_write',w,true);perform set_config('market_scanner.live_write_source',s,true);
end $$;

create or replace function market_scanner.store_live_quote(p jsonb) returns boolean
language plpgsql security invoker set search_path='' set extra_float_digits=3 as $$
declare w text:=coalesce(current_setting('market_scanner.live_validated_write',true),'off');
 s text:=coalesce(current_setting('market_scanner.live_write_source',true),'');n integer;begin
 perform set_config('market_scanner.live_validated_write','on',true);perform set_config('market_scanner.live_write_source',p->>'source',true);
 insert into public.market_latest_quotes(ticker,fecha,open,high,low,close,volumen,is_final,status,source,source_quote_at,fetched_at,previous_close,datadelay_minutes)
 values(p->>'ticker',(p->>'fecha')::date,(p->>'open')::float8,(p->>'high')::float8,(p->>'low')::float8,(p->>'close')::float8,
  (p->>'volumen')::bigint,(p->>'is_final')::boolean,p->>'status',p->>'source',(p->>'source_quote_at')::timestamptz,
  (p->>'fetched_at')::timestamptz,(p->>'previous_close')::float8,(p->>'datadelay_minutes')::integer)
 on conflict(ticker) do update set fecha=excluded.fecha,open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
  volumen=excluded.volumen,is_final=excluded.is_final,status=excluded.status,source=excluded.source,source_quote_at=excluded.source_quote_at,
  fetched_at=excluded.fetched_at,previous_close=excluded.previous_close,datadelay_minutes=excluded.datadelay_minutes
 where (excluded.fecha,excluded.source_quote_at,excluded.fetched_at)>
   (market_latest_quotes.fecha,market_latest_quotes.source_quote_at,market_latest_quotes.fetched_at)
  and not(market_latest_quotes.fecha=excluded.fecha and market_latest_quotes.is_final and not excluded.is_final)
  or (excluded.fecha=market_latest_quotes.fecha and excluded.is_final and not market_latest_quotes.is_final);
 get diagnostics n=row_count;
 perform set_config('market_scanner.live_validated_write',w,true);perform set_config('market_scanner.live_write_source',s,true);
 return n>0;
end $$;

create or replace function market_scanner.parse_sheet_quote(p jsonb,p_clock timestamptz default clock_timestamp()) returns jsonb
language plpgsql security invoker set search_path='' set extra_float_digits=3 as $$
declare i market_scanner.instruments%rowtype;s market_scanner.sessions%rowtype;f text;raw text;d date;latest_day date;
 q timestamptz;captured timestamptz;o float8;h float8;l float8;c float8;v numeric;prev float8;delay numeric;symbol text;begin
 if jsonb_typeof(p) is distinct from 'object' then return jsonb_build_object('error','PAYLOAD_INVALIDO','status','RECHAZADO');end if;
 select * into i from market_scanner.instruments where ticker=p->>'ticker' and active;
 if not found then return jsonb_build_object('error','TICKER_FUERA_DEL_UNIVERSO','status','RECHAZADO');end if;
 symbol:=case i.exchange_name when 'NASDAQ' then 'NASDAQ:' when 'NYSE' then 'NYSE:' when 'NYSEARCA' then 'NYSEARCA:' when 'CBOEBZX' then 'BATS:' end||
  case when i.ticker='BRK-B' then 'BRK.B' else i.ticker end;
 if p->>'source' is distinct from 'googlefinance' or p->>'symbol' is distinct from symbol or symbol is null or p->>'currency' is distinct from 'USD' then
  return jsonb_build_object('error','IDENTIDAD_MONEDA_INVALIDA','status','RECHAZADO');end if;
 foreach f in array array['source_quote_at','open','high','low','close','volume','previous_close','datadelay_minutes'] loop
  raw:=p->>f;
  if raw is null or btrim(raw)='' or raw~*'(^#|loading|cargando|calculando|error)' then
   return jsonb_build_object('error','FALTAN_DATOS_PROVEEDOR','status','PENDIENTE_DE_ACTUALIZAR');end if;
 end loop;
 if exists(select 1 from unnest(array['open','high','low','close','volume','previous_close','datadelay_minutes']) as fields(field_name) where jsonb_typeof(p->fields.field_name) is distinct from 'number') then
  return jsonb_build_object('error','OHLCV_NO_NUMERICO','status','RECHAZADO');end if;
 begin
  if jsonb_typeof(p->'source_quote_at') is distinct from 'string' or jsonb_typeof(p->'fetched_at') is distinct from 'string' or
   p->>'source_quote_at' !~ '^\d{4}-\d{2}-\d{2}T' or p->>'fetched_at' !~ '^\d{4}-\d{2}-\d{2}T' then raise exception 'time';end if;
  q:=(p->>'source_quote_at')::timestamptz;captured:=(p->>'fetched_at')::timestamptz;
  o:=(p->>'open')::float8;h:=(p->>'high')::float8;l:=(p->>'low')::float8;c:=(p->>'close')::float8;
  v:=(p->>'volume')::numeric;prev:=(p->>'previous_close')::float8;delay:=(p->>'datadelay_minutes')::numeric;
 exception when others then return jsonb_build_object('error','METADATOS_INVALIDOS','status','RECHAZADO');end;
 if captured is null or q is null or captured<p_clock-interval '15 minutes' or captured>p_clock+interval '2 minutes' or q>p_clock+interval '2 minutes' or q>captured+interval '2 minutes' then
  return jsonb_build_object('error','CAPTURA_ANTIGUA_O_FECHA_FUTURA','status','RECHAZADO');end if;
 if not(o>0 and o<'Infinity'::float8 and h>0 and h<'Infinity'::float8 and l>0 and l<'Infinity'::float8 and c>0 and c<'Infinity'::float8
  and l<=least(o,c) and h>=greatest(o,c) and l<=h and v>=0 and v<=9007199254740991 and v=trunc(v)
  and prev>0 and prev<'Infinity'::float8 and delay>=0 and delay<=20 and delay=trunc(delay)) then
  return jsonb_build_object('error','OHLCV_INCOHERENTE','status','RECHAZADO');end if;
 d:=(q at time zone 'America/New_York')::date;
 if (p_clock at time zone 'America/New_York')::date not between date '2024-01-01' and date '2028-12-31' then
  return jsonb_build_object('error','CALENDARIO_FUERA_DE_HORIZONTE','status','RECHAZADO');end if;
 select * into s from market_scanner.sessions where session_date=d;
 if not found or d>(p_clock at time zone 'America/New_York')::date then return jsonb_build_object('error','FECHA_NO_BURSATIL','status','RECHAZADO');end if;
 select max(session_date) into latest_day from market_scanner.sessions where opens_at<=p_clock;
 if d is distinct from latest_day then return jsonb_build_object('error','COTIZACION_ATRASADA','status','RECHAZADO');end if;
 if p_clock>=s.opens_at and p_clock<s.closes_at and q<p_clock-make_interval(mins=>least(30,delay::integer+10)) then
  return jsonb_build_object('error','COTIZACION_ATRASADA','status','RECHAZADO');end if;
 return jsonb_build_object('ticker',i.ticker,'fecha',d,'open',o,'high',h,'low',l,'close',c,'volumen',v::bigint,
  'is_final',false,'status','PROVISIONAL','source','googlefinance','source_quote_at',q,'fetched_at',captured,
  'previous_close',prev,'datadelay_minutes',delay::integer);
end $$;

-- A history backfill may finish during today's session. It cannot replace a
-- newer private Yahoo observation with its last confirmed bar from yesterday.
create or replace function market_scanner.keep_newer_yahoo_quote() returns trigger
language plpgsql security invoker set search_path='' as $$ begin
 if new.status in ('FINAL','PROVISIONAL') and old.current_bar is not null and
  ((new.current_bar->>'fecha')::date<(old.current_bar->>'fecha')::date or
   ((new.current_bar->>'fecha')::date=(old.current_bar->>'fecha')::date and
    (new.source_quote_at<old.source_quote_at or (new.source_quote_at=old.source_quote_at and new.fetched_at<old.fetched_at) or
     ((old.current_bar->>'is_final')::boolean and not(new.current_bar->>'is_final')::boolean)))) then return null;end if;
 return new;
end $$;
drop trigger if exists market_keep_newer_yahoo_quote on market_scanner.current_quotes;
create trigger market_keep_newer_yahoo_quote before update on market_scanner.current_quotes
for each row execute function market_scanner.keep_newer_yahoo_quote();

create or replace function market_scanner.project_yahoo_quote(p_ticker text) returns void
language plpgsql security invoker set search_path='' set extra_float_digits=3 as $$
declare q market_scanner.current_quotes%rowtype;b jsonb;prev float8;finished timestamptz;begin
 if exists(select 1 from market_scanner.repair_queue where ticker=p_ticker and status in ('pending','running','failed')) then
  perform market_scanner.clear_live_quote(p_ticker);return;end if;
 select * into q from market_scanner.current_quotes where ticker=p_ticker;
 if q.status='REEMPLAZO_PENDIENTE' then perform market_scanner.clear_live_quote(p_ticker);return;end if;
 if q.status not in ('FINAL','PROVISIONAL') or q.current_bar is null or q.source_quote_at is null or q.fetched_at is null then return;end if;
 b:=q.current_bar;
 select finished_at into finished from market_scanner.repair_queue where ticker=p_ticker and status='completed';
 if not (b->>'is_final')::boolean and (q.fetched_at<=finished or q.updated_at<=finished) then return;end if;
 if (b->>'is_final')::boolean then
  select to_jsonb(h) into b from public.market_history h where ticker=p_ticker and is_final and fecha=(q.current_bar->>'fecha')::date;
  if b is null then return;end if;
 end if;
 select close into prev from public.market_history where ticker=p_ticker and is_final and fecha<(b->>'fecha')::date order by fecha desc limit 1;
 perform market_scanner.store_live_quote(b||jsonb_build_object('ticker',p_ticker,'source','yahoo',
  'status',case when (b->>'is_final')::boolean then 'FINAL' else 'PROVISIONAL' end,'source_quote_at',q.source_quote_at,
  'fetched_at',q.fetched_at,'previous_close',prev,'datadelay_minutes',null));
end $$;
create or replace function market_scanner.project_yahoo_quote_trigger() returns trigger
language plpgsql security invoker set search_path='' as $$ begin
 perform market_scanner.project_yahoo_quote(new.ticker);return new;
end $$;
drop trigger if exists market_project_yahoo_quote on market_scanner.current_quotes;
create trigger market_project_yahoo_quote after insert or update on market_scanner.current_quotes
for each row execute function market_scanner.project_yahoo_quote_trigger();
create or replace function market_scanner.repair_live_quote_trigger() returns trigger
language plpgsql security invoker set search_path='' as $$ begin
 if new.status in ('pending','running','failed') then perform market_scanner.clear_live_quote(new.ticker);
 elsif new.status='completed' then perform market_scanner.project_yahoo_quote(new.ticker);end if;
 return new;
end $$;
drop trigger if exists market_repair_live_quote on market_scanner.repair_queue;
create trigger market_repair_live_quote after insert or update on market_scanner.repair_queue
for each row execute function market_scanner.repair_live_quote_trigger();

create or replace function public.market_ingest_sheet_quotes(p_batch jsonb) returns jsonb
language plpgsql security invoker set search_path='' set extra_float_digits=3 as $$
declare p jsonb;r jsonb;q jsonb;results jsonb:='[]';t text;prev float8;changed boolean;
 existing public.market_latest_quotes%rowtype;finished timestamptz;begin
 if jsonb_typeof(p_batch) is distinct from 'array' or jsonb_array_length(p_batch)>250 or octet_length(p_batch::text)>1048576 then
  raise exception 'Se requiere un lote de hasta 250 cotizaciones y 1 MB';end if;
 for p in select value from jsonb_array_elements(p_batch) order by value->>'ticker' loop
  t:=p->>'ticker';q:=null;
  begin
   q:=market_scanner.parse_sheet_quote(p);
   if q?'error' then r:=jsonb_build_object('ticker',t,'status',q->>'status','reason',q->>'error','current',null,'needs_replacement',false);
   else
    perform pg_advisory_xact_lock(hashtextextended('market_scanner:'||t,0));
    select close into prev from public.market_history where ticker=t and is_final and fecha<(q->>'fecha')::date order by fecha desc limit 1;
    select * into existing from public.market_latest_quotes where ticker=t;
    select finished_at into finished from market_scanner.repair_queue where ticker=t and status='completed';
    if exists(select 1 from market_scanner.repair_queue where ticker=t and status in ('pending','running','failed')) then
     perform market_scanner.clear_live_quote(t);
     r:=jsonb_build_object('ticker',t,'status','REEMPLAZO_PENDIENTE','reason','REPARACION_EN_CURSO','current',null,'needs_replacement',true);
    elsif existing.ticker is not null and ((existing.fecha,existing.source_quote_at,existing.fetched_at)>=
      ((q->>'fecha')::date,(q->>'source_quote_at')::timestamptz,(q->>'fetched_at')::timestamptz) or
      (existing.fecha=(q->>'fecha')::date and existing.is_final)) then
     r:=jsonb_build_object('ticker',t,'status','PROVISIONAL','reason','SE_CONSERVA_COTIZACION_PUBLICADA_MAS_RECIENTE_O_CONFIRMADA',
      'current',to_jsonb(existing),'needs_replacement',false);
    elsif (q->>'fetched_at')::timestamptz<=finished then
     r:=jsonb_build_object('ticker',t,'status','PENDIENTE_DE_ACTUALIZAR','reason','CAPTURA_ANTERIOR_A_REPARACION','current',null,'needs_replacement',false);
    elsif prev is not null and abs(prev-(p->>'previous_close')::float8)>greatest(0.02,abs(prev)*0.005) then
     perform market_scanner.queue_repair(t,'SHEET_PREVIOUS_CLOSE_DISCREPANCY');perform market_scanner.clear_live_quote(t);
     r:=jsonb_build_object('ticker',t,'status','REEMPLAZO_PENDIENTE','reason','CIERRE_PREVIO_EN_OTRA_ESCALA','current',null,'needs_replacement',true);
    else
     q:=q||jsonb_build_object('previous_close',coalesce(prev,(p->>'previous_close')::float8));
     changed:=market_scanner.store_live_quote(q);
     r:=jsonb_build_object('ticker',t,'status','PROVISIONAL','reason',case when changed then 'COTIZACION_GOOGLE_VALIDADA_NO_ES_CIERRE_CONFIRMADO'
      else 'SE_CONSERVA_COTIZACION_PUBLICADA_MAS_RECIENTE_O_CONFIRMADA' end,
      'current',(select to_jsonb(x) from public.market_latest_quotes x where ticker=t),'needs_replacement',false);
    end if;
   end if;
  exception when others then r:=jsonb_build_object('ticker',t,'status','RECHAZADO','reason','VALIDACION_SQL_'||sqlstate,'current',null,'needs_replacement',false);end;
  r:=jsonb_build_object('previous_close',(select close from public.market_history where ticker=t and is_final and fecha<coalesce((q->>'fecha')::date,(clock_timestamp() at time zone 'America/New_York')::date) order by fecha desc limit 1),
   'history_count',(select count(*) from public.market_history where ticker=t and is_final),
   'last_final_date',(select max(fecha) from public.market_history where ticker=t and is_final))||r;
  insert into market_scanner.ingest_events(ticker,status,reason,payload) values(t,r->>'status',coalesce(r->>'reason',''),p);
  results:=results||jsonb_build_array(r);
 end loop;
 return jsonb_build_object('version',3,'results',results);
end $$;

revoke all on function market_scanner.guard_live_quote_write(),market_scanner.clear_live_quote(text),market_scanner.store_live_quote(jsonb),
 market_scanner.parse_sheet_quote(jsonb,timestamptz),market_scanner.keep_newer_yahoo_quote(),market_scanner.project_yahoo_quote(text),
 market_scanner.project_yahoo_quote_trigger(),market_scanner.repair_live_quote_trigger() from public,anon,authenticated;
grant execute on function market_scanner.guard_live_quote_write(),market_scanner.clear_live_quote(text),market_scanner.store_live_quote(jsonb),
 market_scanner.parse_sheet_quote(jsonb,timestamptz),market_scanner.keep_newer_yahoo_quote(),market_scanner.project_yahoo_quote(text),
 market_scanner.project_yahoo_quote_trigger(),market_scanner.repair_live_quote_trigger() to service_role;
revoke all on function public.market_ingest_sheet_quotes(jsonb) from public,anon,authenticated;
grant execute on function public.market_ingest_sheet_quotes(jsonb) to service_role;

-- Seed only existing server-approved Yahoo observations. No quote is invented.
do $$ declare x record;begin
 for x in select ticker from market_scanner.current_quotes where status in ('FINAL','PROVISIONAL') order by ticker loop
  perform market_scanner.project_yahoo_quote(x.ticker);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
