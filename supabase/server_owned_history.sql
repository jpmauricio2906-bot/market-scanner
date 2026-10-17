-- Server-owned validation. Apply with Supabase migrations after reviewing the generated seed.
-- No market price is promoted by this installation. Existing data is backed up in a private schema.
begin;
create schema if not exists market_scanner;
revoke all on schema market_scanner from public, anon, authenticated;
grant usage on schema market_scanner to service_role;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table if not exists market_scanner.history_before_server as table public.market_history;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='market_scanner.history_before_server'::regclass and contype='p') then
  alter table market_scanner.history_before_server add primary key(fecha,ticker);
 end if;
end $$;
create table if not exists market_scanner.instruments (
 ticker text primary key, yahoo_symbol text not null, instrument_type text not null,
 exchange_name text not null, currency text not null default 'USD', first_trade_date date, active boolean not null default true
);
create table if not exists market_scanner.sessions (
 session_date date primary key, opens_at timestamptz not null, closes_at timestamptz not null,
 confirms_at timestamptz not null, check(opens_at<closes_at and closes_at<confirms_at)
);
create table if not exists market_scanner.current_quotes (
 ticker text primary key references market_scanner.instruments(ticker), current_bar jsonb,
 status text not null, reason text not null, fetched_at timestamptz, source_quote_at timestamptz, updated_at timestamptz not null default now()
);
create table if not exists market_scanner.ingest_events (
 id bigint generated always as identity primary key, ticker text, received_at timestamptz not null default now(),
 status text not null, reason text not null, payload jsonb not null
);
create index if not exists market_ingest_events_received_idx on market_scanner.ingest_events(received_at);
create table if not exists market_scanner.history_revisions (
 id bigint generated always as identity primary key, ticker text not null, fecha date not null,
 previous_bar jsonb not null, replacement_bar jsonb not null, reason text not null, revised_at timestamptz not null default now()
);
create index if not exists market_revisions_ticker_fecha_idx on market_scanner.history_revisions(ticker,fecha);
create table if not exists market_scanner.split_events (
 ticker text not null references market_scanner.instruments(ticker), event_date date not null,
 numerator numeric not null, denominator numeric not null, primary key(ticker,event_date)
);
create table if not exists market_scanner.repair_queue (
 id bigint generated always as identity primary key, ticker text not null unique references market_scanner.instruments(ticker),
 status text not null default 'pending' check(status in ('pending','running','completed','failed')),
 reason text not null, attempts integer not null default 0, requested_at timestamptz not null default now(),
 next_attempt_at timestamptz not null default now(), lease_token uuid, lease_until timestamptz,
 finished_at timestamptz, last_error text
);
create index if not exists market_repairs_pending_idx on market_scanner.repair_queue(next_attempt_at) where status in ('pending','failed','running');
create table if not exists market_scanner.worker_credentials (singleton boolean primary key default true check(singleton), token_hash bytea not null);

-- BEGIN GENERATED SERVER SEED
-- Generated universe and exchange calendar. Source files: data/universe.json; supabase/calendar.json.
insert into market_scanner.instruments(ticker,yahoo_symbol,instrument_type,exchange_name,first_trade_date) values
('NVDA','NVDA','STOCK','NASDAQ',null),
('AAPL','AAPL','STOCK','NASDAQ',null),
('GOOGL','GOOGL','STOCK','NASDAQ',null),
('MSFT','MSFT','STOCK','NASDAQ',null),
('AMZN','AMZN','STOCK','NASDAQ',null),
('TSM','TSM','STOCK','NYSE',null),
('SPCX','SPCX','STOCK','NASDAQ','2026-06-12'),
('META','META','STOCK','NASDAQ',null),
('AVGO','AVGO','STOCK','NASDAQ',null),
('TSLA','TSLA','STOCK','NASDAQ',null),
('BRK-B','BRK-B','STOCK','NYSE',null),
('LLY','LLY','STOCK','NYSE',null),
('SKHY','SKHY','STOCK','NASDAQ','2026-07-10'),
('MU','MU','STOCK','NASDAQ',null),
('AMD','AMD','STOCK','NASDAQ',null),
('WMT','WMT','STOCK','NASDAQ',null),
('JPM','JPM','STOCK','NYSE',null),
('XOM','XOM','STOCK','NYSE',null),
('V','V','STOCK','NYSE',null),
('ASML','ASML','STOCK','NASDAQ',null),
('JNJ','JNJ','STOCK','NYSE',null),
('MA','MA','STOCK','NYSE',null),
('INTC','INTC','STOCK','NASDAQ',null),
('ABBV','ABBV','STOCK','NYSE',null),
('PLTR','PLTR','STOCK','NASDAQ',null),
('CSCO','CSCO','STOCK','NASDAQ',null),
('CVX','CVX','STOCK','NYSE',null),
('COST','COST','STOCK','NASDAQ',null),
('ORCL','ORCL','STOCK','NYSE',null),
('KO','KO','STOCK','NYSE',null),
('PG','PG','STOCK','NYSE',null),
('MRK','MRK','STOCK','NYSE',null),
('BAC','BAC','STOCK','NYSE',null),
('LRCX','LRCX','STOCK','NASDAQ',null),
('UNH','UNH','STOCK','NYSE',null),
('AMAT','AMAT','STOCK','NASDAQ',null),
('CAT','CAT','STOCK','NYSE',null),
('DELL','DELL','STOCK','NYSE',null),
('HSBC','HSBC','STOCK','NYSE',null),
('PM','PM','STOCK','NYSE',null),
('GE','GE','STOCK','NYSE',null),
('PANW','PANW','STOCK','NASDAQ',null),
('HD','HD','STOCK','NYSE',null),
('NFLX','NFLX','STOCK','NASDAQ',null),
('SHEL','SHEL','STOCK','NYSE',null),
('MS','MS','STOCK','NYSE',null),
('NVS','NVS','STOCK','NYSE',null),
('SAP','SAP','STOCK','NYSE',null),
('BABA','BABA','STOCK','NYSE',null),
('RY','RY','STOCK','NYSE',null),
('MUFG','MUFG','STOCK','NYSE',null),
('TXN','TXN','STOCK','NASDAQ',null),
('GS','GS','STOCK','NYSE',null),
('CRWD','CRWD','STOCK','NASDAQ',null),
('ARM','ARM','STOCK','NASDAQ',null),
('RTX','RTX','STOCK','NYSE',null),
('AZN','AZN','STOCK','NYSE',null),
('GEV','GEV','STOCK','NYSE',null),
('TMO','TMO','STOCK','NYSE',null),
('ANET','ANET','STOCK','NYSE',null),
('TM','TM','STOCK','NYSE',null),
('WFC','WFC','STOCK','NYSE',null),
('KLAC','KLAC','STOCK','NASDAQ',null),
('AMGN','AMGN','STOCK','NASDAQ',null),
('LIN','LIN','STOCK','NASDAQ',null),
('SHOP','SHOP','STOCK','NASDAQ',null),
('MRVL','MRVL','STOCK','NASDAQ',null),
('IBM','IBM','STOCK','NYSE',null),
('BHP','BHP','STOCK','NYSE',null),
('AXP','AXP','STOCK','NYSE',null),
('C','C','STOCK','NYSE',null),
('SNDK','SNDK','STOCK','NASDAQ','2025-02-13'),
('APH','APH','STOCK','NYSE',null),
('TTE','TTE','STOCK','NYSE',null),
('ADI','ADI','STOCK','NASDAQ',null),
('CRM','CRM','STOCK','NYSE',null),
('SAN','SAN','STOCK','NYSE',null),
('TD','TD','STOCK','NYSE',null),
('GILD','GILD','STOCK','NASDAQ',null),
('DIS','DIS','STOCK','NYSE',null),
('VZ','VZ','STOCK','NYSE',null),
('QCOM','QCOM','STOCK','NASDAQ',null),
('ABT','ABT','STOCK','NYSE',null),
('PEP','PEP','STOCK','NASDAQ',null),
('DE','DE','STOCK','NYSE',null),
('COP','COP','STOCK','NYSE',null),
('UNP','UNP','STOCK','NYSE',null),
('TMUS','TMUS','STOCK','NASDAQ',null),
('NVO','NVO','STOCK','NYSE',null),
('MCD','MCD','STOCK','NYSE',null),
('SCCO','SCCO','STOCK','NYSE',null),
('SCHW','SCHW','STOCK','NYSE',null),
('WELL','WELL','STOCK','NYSE',null),
('PBR','PBR','STOCK','NYSE',null),
('PFE','PFE','STOCK','NYSE',null),
('BLK','BLK','STOCK','NYSE',null),
('NEE','NEE','STOCK','NYSE',null),
('STX','STX','STOCK','NASDAQ',null),
('ETN','ETN','STOCK','NYSE',null),
('DHR','DHR','STOCK','NYSE',null),
('SMFG','SMFG','STOCK','NYSE',null),
('T','T','STOCK','NYSE',null),
('TJX','TJX','STOCK','NYSE',null),
('BUD','BUD','STOCK','NYSE',null),
('ISRG','ISRG','STOCK','NASDAQ',null),
('UBS','UBS','STOCK','NYSE',null),
('BBVA','BBVA','STOCK','NYSE',null),
('BA','BA','STOCK','NYSE',null),
('NOW','NOW','STOCK','NYSE',null),
('SONY','SONY','STOCK','NYSE',null),
('ACN','ACN','STOCK','NYSE',null),
('UBER','UBER','STOCK','NYSE',null),
('UL','UL','STOCK','NYSE',null),
('MPC','MPC','STOCK','NYSE',null),
('WDC','WDC','STOCK','NASDAQ',null),
('CB','CB','STOCK','NYSE',null),
('FTNT','FTNT','STOCK','NASDAQ',null),
('VLO','VLO','STOCK','NYSE',null),
('MNST','MNST','STOCK','NASDAQ',null),
('BP','BP','STOCK','NYSE',null),
('MFG','MFG','STOCK','NYSE',null),
('VRTX','VRTX','STOCK','NASDAQ',null),
('PGR','PGR','STOCK','NYSE',null),
('PLD','PLD','STOCK','NYSE',null),
('BTI','BTI','STOCK','NYSE',null),
('MO','MO','STOCK','NYSE',null),
('GLW','GLW','STOCK','NYSE',null),
('BMY','BMY','STOCK','NYSE',null),
('BKNG','BKNG','STOCK','NASDAQ',null),
('PH','PH','STOCK','NYSE',null),
('MDT','MDT','STOCK','NYSE',null),
('LMT','LMT','STOCK','NYSE',null),
('SPGI','SPGI','STOCK','NYSE',null),
('COF','COF','STOCK','NYSE',null),
('PSX','PSX','STOCK','NYSE',null),
('SNOW','SNOW','STOCK','NYSE',null),
('NEM','NEM','STOCK','NYSE',null),
('HDB','HDB','STOCK','NYSE',null),
('PDD','PDD','STOCK','NASDAQ',null),
('CVS','CVS','STOCK','NYSE',null),
('NET','NET','STOCK','NYSE',null),
('RIO','RIO','STOCK','NYSE',null),
('MCK','MCK','STOCK','NYSE',null),
('BMO','BMO','STOCK','NYSE',null),
('EQNR','EQNR','STOCK','NYSE',null),
('ADP','ADP','STOCK','NASDAQ',null),
('BNS','BNS','STOCK','NYSE',null),
('SYK','SYK','STOCK','NYSE',null),
('SPOT','SPOT','STOCK','NYSE',null),
('CNQ','CNQ','STOCK','NYSE',null),
('ITUB','ITUB','STOCK','NYSE',null),
('SBUX','SBUX','STOCK','NASDAQ',null),
('LOW','LOW','STOCK','NYSE',null),
('TT','TT','STOCK','NYSE',null),
('ENB','ENB','STOCK','NYSE',null),
('SO','SO','STOCK','NYSE',null),
('CME','CME','STOCK','NASDAQ',null),
('HCA','HCA','STOCK','NYSE',null),
('IBN','IBN','STOCK','NYSE',null),
('CM','CM','STOCK','NYSE',null),
('ABNB','ABNB','STOCK','NASDAQ',null),
('FCX','FCX','STOCK','NYSE',null),
('CEG','CEG','STOCK','NASDAQ',null),
('ASX','ASX','STOCK','NYSE',null),
('EQIX','EQIX','STOCK','NASDAQ',null),
('PWR','PWR','STOCK','NYSE',null),
('ING','ING','STOCK','NYSE',null),
('SNY','SNY','STOCK','NASDAQ',null),
('MAR','MAR','STOCK','NASDAQ',null),
('GSK','GSK','STOCK','NYSE',null),
('DDOG','DDOG','STOCK','NASDAQ',null),
('ADBE','ADBE','STOCK','NASDAQ',null),
('BNY','BNY','STOCK','NYSE',null),
('DUK','DUK','STOCK','NYSE',null),
('MELI','MELI','STOCK','NASDAQ',null),
('ELV','ELV','STOCK','NYSE',null),
('JCI','JCI','STOCK','NYSE',null),
('SNPS','SNPS','STOCK','NASDAQ',null),
('HOOD','HOOD','STOCK','NASDAQ',null),
('E','E','STOCK','NYSE',null),
('CDNS','CDNS','STOCK','NASDAQ',null),
('RACE','RACE','STOCK','NYSE',null),
('GD','GD','STOCK','NYSE',null),
('MRNA','MRNA','STOCK','NASDAQ',null),
('EMR','EMR','STOCK','NYSE',null),
('AEM','AEM','STOCK','NYSE',null),
('CSX','CSX','STOCK','NASDAQ',null),
('WMB','WMB','STOCK','NYSE',null),
('SU','SU','STOCK','NYSE',null),
('BN','BN','STOCK','NYSE',null),
('APP','APP','STOCK','NASDAQ',null),
('USB','USB','STOCK','NYSE',null),
('ICE','ICE','STOCK','NYSE',null),
('HWM','HWM','STOCK','NYSE',null),
('WM','WM','STOCK','NYSE',null),
('PNC','PNC','STOCK','NYSE',null),
('VRT','VRT','STOCK','NYSE',null),
('MRSH','MRSH','STOCK','NYSE',null),
('MMM','MMM','STOCK','NYSE',null),
('HPE','HPE','STOCK','NYSE',null),
('SPY','SPY','ETF','NYSEARCA',null),
('VOO','VOO','ETF','NYSEARCA',null),
('IVV','IVV','ETF','NYSEARCA',null),
('VTI','VTI','ETF','NYSEARCA',null),
('QQQ','QQQ','ETF','NASDAQ',null),
('QQQM','QQQM','ETF','NASDAQ',null),
('DIA','DIA','ETF','NYSEARCA',null),
('IWM','IWM','ETF','NYSEARCA',null),
('RSP','RSP','ETF','NYSEARCA',null),
('SCHD','SCHD','ETF','NYSEARCA',null),
('VXUS','VXUS','ETF','NASDAQ',null),
('VEA','VEA','ETF','NYSEARCA',null),
('VWO','VWO','ETF','NYSEARCA',null),
('EFA','EFA','ETF','NYSEARCA',null),
('EEM','EEM','ETF','NYSEARCA',null),
('XLK','XLK','ETF','NYSEARCA',null),
('XLF','XLF','ETF','NYSEARCA',null),
('XLE','XLE','ETF','NYSEARCA',null),
('XLV','XLV','ETF','NYSEARCA',null),
('XLI','XLI','ETF','NYSEARCA',null),
('XLP','XLP','ETF','NYSEARCA',null),
('XLY','XLY','ETF','NYSEARCA',null),
('XLU','XLU','ETF','NYSEARCA',null),
('XLRE','XLRE','ETF','NYSEARCA',null),
('XLB','XLB','ETF','NYSEARCA',null),
('XLC','XLC','ETF','NYSEARCA',null),
('SOXX','SOXX','ETF','NASDAQ',null),
('SMH','SMH','ETF','NASDAQ',null),
('XBI','XBI','ETF','NYSEARCA',null),
('IBB','IBB','ETF','NASDAQ',null),
('ARKK','ARKK','ETF','CBOEBZX',null),
('MAGS','MAGS','ETF','CBOEBZX',null),
('TLT','TLT','ETF','NASDAQ',null),
('IEF','IEF','ETF','NASDAQ',null),
('SHY','SHY','ETF','NASDAQ',null),
('BND','BND','ETF','NASDAQ',null),
('HYG','HYG','ETF','NYSEARCA',null),
('LQD','LQD','ETF','NYSEARCA',null),
('GLD','GLD','ETF','NYSEARCA',null),
('SLV','SLV','ETF','NYSEARCA',null),
('TQQQ','TQQQ','ETF','NASDAQ',null),
('QLD','QLD','ETF','NYSEARCA',null),
('SQQQ','SQQQ','ETF','NASDAQ',null),
('UPRO','UPRO','ETF','NYSEARCA',null),
('SPXU','SPXU','ETF','NYSEARCA',null),
('SSO','SSO','ETF','NYSEARCA',null),
('USD','USD','ETF','NYSEARCA',null),
('SOXL','SOXL','ETF','NYSEARCA',null),
('SOXS','SOXS','ETF','NYSEARCA',null),
('LABU','LABU','ETF','NYSEARCA',null)
on conflict(ticker) do update set yahoo_symbol=excluded.yahoo_symbol,instrument_type=excluded.instrument_type,exchange_name=excluded.exchange_name,first_trade_date=coalesce(market_scanner.instruments.first_trade_date,excluded.first_trade_date);
insert into market_scanner.sessions(session_date,opens_at,closes_at,confirms_at)
select d::date,(d::date+time '09:30') at time zone 'America/New_York',
 (d::date+case when d::date=any(array['2024-07-03','2024-11-29','2024-12-24','2025-07-03','2025-11-28','2025-12-24','2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24']::date[]) then time '13:00' else time '16:00' end) at time zone 'America/New_York',
 ((d::date+case when d::date=any(array['2024-07-03','2024-11-29','2024-12-24','2025-07-03','2025-11-28','2025-12-24','2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24']::date[]) then time '13:00' else time '16:00' end) at time zone 'America/New_York')+interval '1 hour'
from generate_series(date '2024-01-01',date '2028-12-31',interval '1 day') s(d)
where extract(isodow from d) between 1 and 5 and not(d::date=any(array['2024-01-01','2024-01-15','2024-02-19','2024-03-29','2024-05-27','2024-06-19','2024-07-04','2024-09-02','2024-11-28','2024-12-25','2025-01-01','2025-01-09','2025-01-20','2025-02-17','2025-04-18','2025-05-26','2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25','2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25','2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24','2028-01-01','2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25']::date[]))
on conflict(session_date) do update set opens_at=excluded.opens_at,closes_at=excluded.closes_at,confirms_at=excluded.confirms_at;
-- END GENERATED SERVER SEED

do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='market_scanner' loop
  execute format('alter table market_scanner.%I enable row level security',t.tablename);
 end loop;
end $$;
revoke all on all tables in schema market_scanner from public,anon,authenticated;
grant select,insert,update,delete on all tables in schema market_scanner to service_role;
grant usage,select on all sequences in schema market_scanner to service_role;

create or replace function market_scanner.expected_session(p_clock timestamptz default clock_timestamp()) returns date
 language plpgsql stable security invoker set search_path='' as $$
declare d date; begin
 if (p_clock at time zone 'America/New_York')::date not between date '2024-01-01' and date '2028-12-31' then
  raise exception 'Revisar calendario bursátil: fuera del horizonte publicado 2024–2028';
 end if;
 select max(session_date) into d from market_scanner.sessions where confirms_at<=p_clock;
 if d is null then raise exception 'Calendario sin cierre confirmado'; end if;
 return d;
end $$;

create or replace function market_scanner.queue_repair(p_ticker text,p_reason text,p_reset boolean default false) returns void
 language sql security invoker set search_path='' as $$
 insert into market_scanner.repair_queue(ticker,reason) values(p_ticker,p_reason)
 on conflict(ticker) do update set
 status=case when market_scanner.repair_queue.status='running' then 'running' else 'pending' end,
 reason=excluded.reason,
 attempts=case when market_scanner.repair_queue.status='completed' or p_reset then 0 else market_scanner.repair_queue.attempts end,
 next_attempt_at=case when market_scanner.repair_queue.status='completed' or p_reset then now() else market_scanner.repair_queue.next_attempt_at end,
 requested_at=now(),finished_at=null;
$$;

create or replace function market_scanner.parse_payload(p jsonb,p_full boolean,p_clock timestamptz default clock_timestamp()) returns jsonb
 language plpgsql security invoker set search_path='' set extra_float_digits=3 as $$
declare i market_scanner.instruments%rowtype; r jsonb; b jsonb; bars jsonb:='[]'; seen jsonb:='{}';
 fetched timestamptz; requested timestamptz; stamp timestamptz; quote_at timestamptz; first_day date;
 d date; today date:=(p_clock at time zone 'America/New_York')::date; expected date; cutoff date;
 s market_scanner.sessions%rowtype; o float8; h float8; l float8; c float8; v numeric; n integer:=0; final_bar boolean;
begin
 if jsonb_typeof(p) is distinct from 'object' then return jsonb_build_object('error','PAYLOAD_INVALIDO'); end if;
 select * into i from market_scanner.instruments where ticker=p->>'ticker' and active;
 if not found then return jsonb_build_object('error','TICKER_FUERA_DEL_UNIVERSO'); end if;
 if p->>'source' is distinct from 'yahoo' or p->>'symbol' is distinct from i.yahoo_symbol or
 p->>'currency' is distinct from i.currency or p->>'exchange_timezone' is distinct from 'America/New_York' or
 coalesce(p->>'exchange_name','') not in ('NMS','NGM','NCM','NYQ','ASE','PCX','BTS','NASDAQ','NYSE','NYSEArca','NYSE American','Cboe US') then
  return jsonb_build_object('error','IDENTIDAD_MONEDA_O_ZONA_INVALIDA');
 end if;
 begin
  fetched:=(p->>'fetched_at')::timestamptz; requested:=(p->>'requested_at')::timestamptz;
  if jsonb_typeof(p->'regular_market_time') is distinct from 'number' then raise exception 'quote'; end if;
  quote_at:=to_timestamp((p->>'regular_market_time')::float8);
  if jsonb_typeof(p->'first_trade_epoch')='number' then first_day:=(to_timestamp((p->>'first_trade_epoch')::float8) at time zone 'America/New_York')::date; end if;
 exception when others then return jsonb_build_object('error','METADATOS_TEMPORALES_INVALIDOS'); end;
 if fetched is null or requested is null or fetched<requested or requested<p_clock-interval '15 minutes'
 or fetched>p_clock+interval '2 minutes' or requested>p_clock+interval '2 minutes' or quote_at>p_clock+interval '5 minutes'
 or quote_at< timestamptz '2024-01-01 00:00Z' or first_day>today then return jsonb_build_object('error','CAPTURA_ANTIGUA_O_FECHA_FUTURA'); end if;
 if jsonb_typeof(p->'rows') is distinct from 'array' or jsonb_array_length(p->'rows')<1 or
 jsonb_array_length(p->'rows')>(case when p_full then 1200 else 20 end) then return jsonb_build_object('error','TAMANO_DE_SERIE_INVALIDO'); end if;
 expected:=market_scanner.expected_session(p_clock);
 select session_date into cutoff from market_scanner.sessions where session_date<=expected order by session_date desc offset 499 limit 1;
 for r in select value from jsonb_array_elements(p->'rows') loop
  if jsonb_typeof(r->'timestamp') is distinct from 'number' then return jsonb_build_object('error','TIMESTAMP_NO_NUMERICO'); end if;
  begin stamp:=to_timestamp((r->>'timestamp')::float8); d:=(stamp at time zone 'America/New_York')::date;
  exception when others then return jsonb_build_object('error','TIMESTAMP_INVALIDO'); end;
  if d>today then return jsonb_build_object('error','FECHA_FUTURA'); end if;
  if p_full and (d<cutoff or d>expected) then continue; end if;
  if not p_full and d<today-14 then return jsonb_build_object('error','VENTANA_RECIENTE_EXCEDIDA'); end if;
  select * into s from market_scanner.sessions where session_date=d;
  if not found then return jsonb_build_object('error','FECHA_NO_BURSATIL'); end if;
  if d=today and p_clock<s.opens_at then return jsonb_build_object('error','SESION_AUN_NO_ABIERTA'); end if;
  if seen ? d::text then return jsonb_build_object('error','FECHA_DUPLICADA_EN_CAPTURA'); end if;
  seen:=seen||jsonb_build_object(d::text,true);
  if exists(select 1 from unnest(array['open','high','low','close','volume']) f where jsonb_typeof(r->f) is distinct from 'number') then
   return jsonb_build_object('error','OHLCV_NO_NUMERICO'); end if;
  begin o:=(r->>'open')::float8;h:=(r->>'high')::float8;l:=(r->>'low')::float8;c:=(r->>'close')::float8;v:=(r->>'volume')::numeric;
  exception when others then return jsonb_build_object('error','OHLCV_NO_NUMERICO'); end;
  if not(o>0 and o<'Infinity'::float8 and h>0 and h<'Infinity'::float8 and l>0 and l<'Infinity'::float8 and c>0 and c<'Infinity'::float8
   and l<=least(o,c) and h>=greatest(o,c) and l<=h and v>=0 and v<=9007199254740991 and v=trunc(v)) then
   return jsonb_build_object('error','OHLCV_INCOHERENTE'); end if;
  final_bar:=s.confirms_at<=fetched and s.confirms_at<=p_clock and
   ((quote_at at time zone 'America/New_York')::date>d or quote_at>=s.closes_at);
  b:=jsonb_build_object('fecha',d,'ticker',i.ticker,'open',o,'high',h,'low',l,'close',c,'volumen',v::bigint,'is_final',final_bar);
  bars:=bars||jsonb_build_array(b); n:=n+1;
 end loop;
 if n=0 then return jsonb_build_object('error','SIN_SESIONES_UTILIZABLES'); end if;
 select jsonb_agg(value order by value->>'fecha') into bars from jsonb_array_elements(bars);
 return jsonb_build_object('bars',bars,'fetched_at',fetched,'source_quote_at',quote_at,'first_trade_date',first_day,'expected',expected,'cutoff',cutoff);
end $$;

create or replace function market_scanner.guard_history_write() returns trigger
 language plpgsql security invoker set search_path='' as $$ begin
 if current_setting('market_scanner.validated_write',true) is distinct from 'on' then
  raise exception using errcode='42501',message='Escritura directa retirada: usar market_ingest_recent o el worker validado.';
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
drop trigger if exists market_history_server_guard on public.market_history;
create trigger market_history_server_guard before insert or update or delete on public.market_history for each row execute function market_scanner.guard_history_write();

create or replace function market_scanner.apply_payload(p jsonb,p_full boolean default false) returns jsonb
 language plpgsql security invoker set search_path='' set extra_float_digits=3 as $$
declare parsed jsonb; bars jsonb; current_bar jsonb; last_final date; first_final date; expected date;
 t text:=p->>'ticker'; status text; reason text; fetched timestamptz; first_trade date; count_before integer; count_after integer;
 min_before date; max_before date; repair boolean:=false; cutoff date; e jsonb; ed date; n numeric; den numeric;
 prior_write text:=coalesce(current_setting('market_scanner.validated_write',true),'off'); prior market_scanner.current_quotes%rowtype;
 quote_at timestamptz; new_listing boolean:=false;
begin
 parsed:=market_scanner.parse_payload(p,p_full);
 if parsed ? 'error' then return jsonb_build_object('ticker',t,'status','RECHAZADO','reason',parsed->>'error','current',null,'needs_replacement',false); end if;
 perform pg_advisory_xact_lock(hashtextextended('market_scanner:'||t,0));
 bars:=parsed->'bars';expected:=(parsed->>'expected')::date;fetched:=(parsed->>'fetched_at')::timestamptz;first_trade:=(parsed->>'first_trade_date')::date;
 quote_at:=(parsed->>'source_quote_at')::timestamptz;
 select * into prior from market_scanner.current_quotes where ticker=t;
 if fetched<prior.fetched_at or quote_at<prior.source_quote_at then
  return jsonb_build_object('ticker',t,'status','RECHAZADO','reason','CAPTURA_SUPERADA','current',null);end if;
 select value into current_bar from jsonb_array_elements(bars) order by value->>'fecha' desc limit 1;
 select min((value->>'fecha')::date),max((value->>'fecha')::date) into first_final,last_final from jsonb_array_elements(bars) where (value->>'is_final')::boolean;
 select count(*),min(fecha),max(fecha) into count_before,min_before,max_before from public.market_history where ticker=t and is_final;
 new_listing:=count_before=0 and first_trade>expected;
 if first_trade is not null then update market_scanner.instruments set first_trade_date=coalesce(first_trade_date,first_trade) where ticker=t; end if;
 if jsonb_typeof(coalesce(p->'splits','[]')) is distinct from 'array' then return jsonb_build_object('ticker',t,'status','RECHAZADO','reason','SPLITS_INVALIDOS'); end if;
 if jsonb_array_length(coalesce(p->'splits','[]'))>100 then return jsonb_build_object('ticker',t,'status','RECHAZADO','reason','DEMASIADOS_SPLITS');end if;
 for e in select value from jsonb_array_elements(coalesce(p->'splits','[]')) loop
  begin ed:=(to_timestamp((e->>'timestamp')::float8) at time zone 'America/New_York')::date; n:=(e->>'numerator')::numeric;den:=(e->>'denominator')::numeric;
  exception when others then return jsonb_build_object('ticker',t,'status','RECHAZADO','reason','SPLITS_INVALIDOS'); end;
  if ed is null or ed>(now() at time zone 'America/New_York')::date or n is null or den is null or n<=0 or den<=0 then
   return jsonb_build_object('ticker',t,'status','RECHAZADO','reason','SPLITS_INVALIDOS'); end if;
  if ed>=coalesce(min_before,first_final) and not exists(select 1 from market_scanner.split_events where ticker=t and event_date=ed and numerator=n and denominator=den) then repair:=true; end if;
 end loop;
 if p_full then
  if last_final is distinct from expected or first_final is null or
   exists(select 1 from market_scanner.sessions s where s.session_date between first_final and expected and
    not exists(select 1 from jsonb_array_elements(bars) b where (b->>'fecha')::date=s.session_date and (b->>'is_final')::boolean)) or
   ((select count(*) from jsonb_array_elements(bars) b where (b->>'is_final')::boolean)<500 and first_final is distinct from first_trade) then
   return jsonb_build_object('ticker',t,'status','RECHAZADO','reason','HISTORIAL_INCOMPLETO_O_ATRASADO'); end if;
 else
  repair:=repair or exists(select 1 from jsonb_array_elements(bars) b join public.market_history h on h.ticker=t and h.fecha=(b->>'fecha')::date and h.is_final
   where (b->>'is_final')::boolean and (abs(h.open-(b->>'open')::float8)>greatest(0.000001,abs(h.open)*1e-8) or abs(h.high-(b->>'high')::float8)>greatest(0.000001,abs(h.high)*1e-8)
    or abs(h.low-(b->>'low')::float8)>greatest(0.000001,abs(h.low)*1e-8) or abs(h.close-(b->>'close')::float8)>greatest(0.000001,abs(h.close)*1e-8)));
  repair:=repair or (not new_listing and count_before<500 and coalesce(min_before,first_final) is distinct from first_trade) or
   exists(select 1 from market_scanner.sessions s where s.session_date between coalesce(min_before,first_final,expected) and expected
    and not exists(select 1 from public.market_history h where h.ticker=t and h.fecha=s.session_date and h.is_final)
    and not exists(select 1 from jsonb_array_elements(bars) b where (b->>'fecha')::date=s.session_date and (b->>'is_final')::boolean));
 end if;
 if not p_full and repair then
  perform market_scanner.queue_repair(t,'SPLIT_REVISION_O_COBERTURA'); status:='REEMPLAZO_PENDIENTE';reason:='El backend reconstruirá la serie antes de publicar una mezcla de precios.';
 elsif new_listing then
  status:='PROVISIONAL';reason:='Primera sesión: todavía no existe un cierre confirmado.';
 elsif last_final is distinct from expected then
  status:='PENDIENTE_DE_ACTUALIZAR';reason:='Yahoo no incluye todavía el cierre esperado '||expected;
 else
  perform set_config('market_scanner.validated_write','on',true);
  if p_full then
   insert into market_scanner.history_revisions(ticker,fecha,previous_bar,replacement_bar,reason)
    select t,h.fecha,to_jsonb(h),'null'::jsonb,'FUERA_DE_SERIE_VALIDADA' from public.market_history h where h.ticker=t and not exists
     (select 1 from jsonb_array_elements(bars) b where (b->>'fecha')::date=h.fecha and (b->>'is_final')::boolean);
   delete from public.market_history h where h.ticker=t and not exists
    (select 1 from jsonb_array_elements(bars) b where (b->>'fecha')::date=h.fecha and (b->>'is_final')::boolean);
  end if;
  insert into market_scanner.history_revisions(ticker,fecha,previous_bar,replacement_bar,reason)
   select t,h.fecha,to_jsonb(h),b,case when p_full then 'RECONSTRUCCION' else 'REVISION_RECIENTE' end
   from jsonb_array_elements(bars) b join public.market_history h on h.ticker=t and h.fecha=(b->>'fecha')::date
   where (b->>'is_final')::boolean and row(h.open,h.high,h.low,h.close,h.volumen,h.is_final) is distinct from
    row((b->>'open')::float8,(b->>'high')::float8,(b->>'low')::float8,(b->>'close')::float8,(b->>'volumen')::bigint,true);
  insert into public.market_history(fecha,ticker,open,high,low,close,volumen,is_final)
   select (b->>'fecha')::date,t,(b->>'open')::float8,(b->>'high')::float8,(b->>'low')::float8,(b->>'close')::float8,(b->>'volumen')::bigint,true
   from jsonb_array_elements(bars) b where (b->>'is_final')::boolean
   on conflict(fecha,ticker) do update set open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volumen=excluded.volumen,is_final=true
   where row(market_history.open,market_history.high,market_history.low,market_history.close,market_history.volumen,market_history.is_final) is distinct from
    row(excluded.open,excluded.high,excluded.low,excluded.close,excluded.volumen,excluded.is_final);
  select fecha into cutoff from public.market_history where ticker=t and is_final order by fecha desc offset 499 limit 1;
  if cutoff is not null then delete from public.market_history where ticker=t and is_final and fecha<cutoff; end if;
  perform set_config('market_scanner.validated_write',prior_write,true);
  if p_full then
   for e in select value from jsonb_array_elements(coalesce(p->'splits','[]')) loop
    ed:=(to_timestamp((e->>'timestamp')::float8) at time zone 'America/New_York')::date;
    insert into market_scanner.split_events values(t,ed,(e->>'numerator')::numeric,(e->>'denominator')::numeric)
    on conflict(ticker,event_date) do update set numerator=excluded.numerator,denominator=excluded.denominator;
   end loop;
  end if;
  status:=case when (current_bar->>'is_final')::boolean then 'FINAL' else 'PROVISIONAL' end;reason:='OHLCV y cobertura validados en Supabase.';
 end if;
 -- A newly fetched stale intraday bar must not replace a confirmed day in Sheets either.
 if not (current_bar->>'is_final')::boolean and exists(select 1 from public.market_history where ticker=t and fecha=(current_bar->>'fecha')::date and is_final) then
  select to_jsonb(h) into current_bar from public.market_history h where ticker=t and fecha=(current_bar->>'fecha')::date and is_final;
 end if;
 insert into market_scanner.current_quotes(ticker,current_bar,status,reason,fetched_at,source_quote_at) values(t,current_bar,status,reason,fetched,quote_at)
 on conflict(ticker) do update set current_bar=excluded.current_bar,status=excluded.status,reason=excluded.reason,fetched_at=excluded.fetched_at,source_quote_at=excluded.source_quote_at,updated_at=now()
 where market_scanner.current_quotes.fetched_at is null or market_scanner.current_quotes.fetched_at<=excluded.fetched_at;
 select count(*) into count_after from public.market_history where ticker=t and is_final;
 return jsonb_build_object('ticker',t,'status',status,'reason',reason,'current',current_bar,
  'previous_close',(select close from public.market_history where ticker=t and is_final and fecha<(current_bar->>'fecha')::date order by fecha desc limit 1),
  'history_count',count_after,'last_final_date',(select max(fecha) from public.market_history where ticker=t and is_final),'needs_replacement',status='REEMPLAZO_PENDIENTE');
end $$;

create or replace function public.market_ingest_recent(p_batch jsonb) returns jsonb
 language plpgsql security invoker set search_path='' set extra_float_digits=3 as $$
declare p jsonb; r jsonb; results jsonb:='[]'; begin
 if jsonb_typeof(p_batch) is distinct from 'array' or jsonb_array_length(p_batch)>20 or octet_length(p_batch::text)>1048576 then raise exception 'Se requiere un lote de hasta 20 tickers y 1 MB'; end if;
 for p in select value from jsonb_array_elements(p_batch) order by value->>'ticker' loop
  begin r:=market_scanner.apply_payload(p,false);
  exception when others then r:=jsonb_build_object('ticker',p->>'ticker','status','RECHAZADO','reason','VALIDACION_SQL_'||sqlstate,'current',null); end;
  r:=jsonb_build_object('current',null,'previous_close',null,'history_count',(select count(*) from public.market_history where ticker=p->>'ticker' and is_final),
   'last_final_date',(select max(fecha) from public.market_history where ticker=p->>'ticker' and is_final),'needs_replacement',false)||r;
  insert into market_scanner.ingest_events(ticker,status,reason,payload) values(p->>'ticker',r->>'status',coalesce(r->>'reason',''),p);
  results:=results||jsonb_build_array(r);
 end loop;
 return jsonb_build_object('version',2,'results',results);
end $$;

create or replace function public.market_verify_worker_token(p_token text) returns boolean
 language sql stable security invoker set search_path='' as $$
 select coalesce(length(p_token)=64 and p_token~'^[a-f0-9]{64}$' and exists(select 1 from market_scanner.worker_credentials where token_hash=extensions.digest(p_token,'sha256')),false);
$$;
create or replace function public.market_claim_repairs(p_limit integer default 2) returns jsonb
 language plpgsql security invoker set search_path='' as $$
declare jobs jsonb; begin
 with candidates as(select id from market_scanner.repair_queue where next_attempt_at<=now()
  and (status in ('pending','failed') or (status='running' and lease_until<now())) order by requested_at,id for update skip locked limit least(greatest(p_limit,1),2)),
 claimed as(update market_scanner.repair_queue q set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes'
  from candidates c where q.id=c.id returning q.id,q.ticker,q.lease_token)
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'ticker',c.ticker,'yahoo_symbol',i.yahoo_symbol,'lease_token',c.lease_token)),'[]') into jobs
 from claimed c join market_scanner.instruments i using(ticker);
 return jobs;
end $$;
create or replace function public.market_fail_repair(p_job_id bigint,p_lease_token uuid,p_reason text) returns jsonb
 language plpgsql security invoker set search_path='' as $$ begin
 update market_scanner.repair_queue set status='failed',last_error=left(p_reason,200),lease_until=null,
 next_attempt_at=now()+make_interval(mins=>case when attempts>=5 then 60 else (2^greatest(attempts,1))::integer end)
 where id=p_job_id and lease_token=p_lease_token and status='running';
 return jsonb_build_object('status',case when found then 'failed' else 'lease_expired' end);
end $$;
create or replace function public.market_replace_history(p_job_id bigint,p_lease_token uuid,p_payload jsonb) returns jsonb
 language plpgsql security invoker set search_path='' set extra_float_digits=3 as $$
declare q market_scanner.repair_queue%rowtype; r jsonb; lock_ticker text; begin
 select ticker into lock_ticker from market_scanner.repair_queue where id=p_job_id;
 if lock_ticker is not null then perform pg_advisory_xact_lock(hashtextextended('market_scanner:'||lock_ticker,0));end if;
 select * into q from market_scanner.repair_queue where id=p_job_id and lease_token=p_lease_token and status='running' and lease_until>now() for update;
 if not found then return jsonb_build_object('status','rejected','reason','LEASE_INVALIDO'); end if;
 if q.ticker is distinct from p_payload->>'ticker' then
  perform public.market_fail_repair(p_job_id,p_lease_token,'IDENTIDAD_DEL_TRABAJO_INVALIDA');return jsonb_build_object('status','rejected');end if;
 begin r:=market_scanner.apply_payload(p_payload,true);
 exception when others then r:=jsonb_build_object('status','RECHAZADO','reason','VALIDACION_SQL_'||sqlstate);end;
 if r->>'status' not in ('FINAL','PROVISIONAL') then
  perform public.market_fail_repair(p_job_id,p_lease_token,coalesce(r->>'reason','SERIE_RECHAZADA'));
  return jsonb_build_object('status','rejected','result',r);
 end if;
 update market_scanner.repair_queue set status='completed',finished_at=now(),lease_until=null,last_error=null where id=q.id;
 return jsonb_build_object('status','completed','result',r);
end $$;

create or replace function market_scanner.audit_history(p_weekly boolean default false) returns jsonb
 language plpgsql security invoker set search_path='' as $$
declare i record; expected date:=market_scanner.expected_session(); total integer:=0; a date; b date; n bigint; begin
 for i in select ticker,first_trade_date from market_scanner.instruments where active order by ticker loop
  select count(*),min(fecha),max(fecha) into n,a,b from public.market_history where ticker=i.ticker and is_final;
  if i.first_trade_date>expected and n=0 then continue;end if;
  if p_weekly or n>500 or b is distinct from expected or (n<500 and a is distinct from i.first_trade_date) or
   exists(select 1 from public.market_history h left join market_scanner.sessions s on s.session_date=h.fecha where h.ticker=i.ticker and h.is_final and
    (s.session_date is null or not(h.open>0 and h.open<'Infinity'::float8 and h.high>0 and h.high<'Infinity'::float8 and h.low>0 and h.low<'Infinity'::float8 and h.close>0 and h.close<'Infinity'::float8
    and h.low<=least(h.open,h.close) and h.high>=greatest(h.open,h.close) and h.low<=h.high and h.volumen>=0 and h.volumen<=9007199254740991))) or
   exists(select 1 from market_scanner.sessions s where s.session_date between a and expected and not exists
    (select 1 from public.market_history h where h.ticker=i.ticker and h.fecha=s.session_date and h.is_final)) then
   perform market_scanner.queue_repair(i.ticker,case when p_weekly then 'REVISION_SEMANAL' else 'AUDITORIA_COBERTURA' end,p_weekly);total:=total+1;
  end if;
 end loop;
 delete from market_scanner.ingest_events where received_at<now()-interval '3 days';
 return jsonb_build_object('expected_session',expected,'queued',total);
end $$;

do $$ declare token text; begin
 if not exists(select 1 from vault.secrets where name='market_scanner_worker_token') then
  token:=encode(extensions.gen_random_bytes(32),'hex');
  perform vault.create_secret(token,'market_scanner_worker_token','Private token for this project maintenance worker');
 else select decrypted_secret into token from vault.decrypted_secrets where name='market_scanner_worker_token'; end if;
 insert into market_scanner.worker_credentials values(true,extensions.digest(token,'sha256')) on conflict(singleton) do update set token_hash=excluded.token_hash;
end $$;
create or replace function market_scanner.dispatch_worker() returns bigint
 language plpgsql security invoker set search_path='' as $$
declare request_id bigint; begin
 if not exists(select 1 from market_scanner.repair_queue where next_attempt_at<=now() and
  (status in ('pending','failed') or (status='running' and lease_until<now()))) then return null;end if;
 select net.http_post(url:='https://wpenzrjybvysvfaefkxh.supabase.co/functions/v1/market-history-worker',
  headers:=jsonb_build_object('Content-Type','application/json','X-Market-Worker-Token',(select decrypted_secret from vault.decrypted_secrets where name='market_scanner_worker_token')),
  body:='{}'::jsonb,timeout_milliseconds:=100000) into request_id;
 return request_id;
end $$;

revoke all on all functions in schema market_scanner from public,anon,authenticated;
grant execute on all functions in schema market_scanner to service_role;
revoke execute on function market_scanner.dispatch_worker() from service_role;
revoke execute on function public.market_ingest_recent(jsonb),public.market_verify_worker_token(text),public.market_claim_repairs(integer),
 public.market_fail_repair(bigint,uuid,text),public.market_replace_history(bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.market_ingest_recent(jsonb),public.market_verify_worker_token(text),public.market_claim_repairs(integer),
 public.market_fail_repair(bigint,uuid,text),public.market_replace_history(bigint,uuid,jsonb) to service_role;

-- Activate schedules only after deploying the private worker and running rollback-based SQL tests.
-- cron.schedule is installed separately by the reviewed deployment procedure.
notify pgrst,'reload schema';
commit;
