-- Independent 11-year price archive: ten analysis years plus indicator warm-up.
-- Apply after server_owned_history.sql. This installation never modifies scanner history.
-- Schedule activation is separate, after worker deployment and rollback tests.
begin;

create table if not exists market_scanner.backtest_sessions (
 session_date date primary key
);
-- BEGIN BACKTEST CALENDAR SEED
-- Generated from data/backtest-calendar.json; early closes remain sessions.
insert into market_scanner.backtest_sessions(session_date)
select d::date from generate_series('2015-01-01'::date,'2028-12-31'::date,interval '1 day') d
where extract(isodow from d) between 1 and 5
 and d::date<>all(array['2015-01-01','2015-01-19','2015-02-16','2015-04-03','2015-05-25','2015-07-03','2015-09-07','2015-11-26','2015-12-25','2016-01-01','2016-01-18','2016-02-15','2016-03-25','2016-05-30','2016-07-04','2016-09-05','2016-11-24','2016-12-26','2017-01-02','2017-01-16','2017-02-20','2017-04-14','2017-05-29','2017-07-04','2017-09-04','2017-11-23','2017-12-25','2018-01-01','2018-01-15','2018-02-19','2018-03-30','2018-05-28','2018-07-04','2018-09-03','2018-11-22','2018-12-05','2018-12-25','2019-01-01','2019-01-21','2019-02-18','2019-04-19','2019-05-27','2019-07-04','2019-09-02','2019-11-28','2019-12-25','2020-01-01','2020-01-20','2020-02-17','2020-04-10','2020-05-25','2020-07-03','2020-09-07','2020-11-26','2020-12-25','2021-01-01','2021-01-18','2021-02-15','2021-04-02','2021-05-31','2021-07-05','2021-09-06','2021-11-25','2021-12-24','2022-01-17','2022-02-21','2022-04-15','2022-05-30','2022-06-20','2022-07-04','2022-09-05','2022-11-24','2022-12-26','2023-01-02','2023-01-16','2023-02-20','2023-04-07','2023-05-29','2023-06-19','2023-07-04','2023-09-04','2023-11-23','2023-12-25','2024-01-01','2024-01-15','2024-02-19','2024-03-29','2024-05-27','2024-06-19','2024-07-04','2024-09-02','2024-11-28','2024-12-25','2025-01-01','2025-01-09','2025-01-20','2025-02-17','2025-04-18','2025-05-26','2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25','2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25','2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24','2028-01-01','2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25']::date[])
on conflict(session_date) do nothing;
-- END BACKTEST CALENDAR SEED

create table if not exists public.backtest_history (
 ticker text not null references market_scanner.instruments(ticker), fecha date not null,
 open double precision not null, high double precision not null, low double precision not null,
 close double precision not null, volumen bigint not null, is_final boolean not null default true,
 primary key(ticker,fecha),
 constraint backtest_history_quality check(is_final and open>0 and open<'Infinity'::float8
  and high>0 and high<'Infinity'::float8 and low>0 and low<'Infinity'::float8
  and close>0 and close<'Infinity'::float8 and low<=least(open,close) and high>=greatest(open,close)
  and low<=high and volumen between 0 and 9007199254740991)
);
create table if not exists public.backtest_history_coverage (
 ticker text primary key references market_scanner.instruments(ticker),
 first_date date, last_date date, row_count integer not null default 0,
 requested_start date not null, requested_end date not null, updated_at timestamptz,
 status text not null default 'pending' check(status in ('pending','ready')),
 last_error text, price_basis text not null default 'yahoo_split_adjusted_ohlc_excluding_cash_dividends'
  check(price_basis='yahoo_split_adjusted_ohlc_excluding_cash_dividends'),
 source text not null default 'Yahoo Finance' check(source='Yahoo Finance'), snapshot_id uuid,
 check(requested_start<=requested_end and row_count>=0),
 check(status<>'ready' or (first_date is not null and last_date is not null and updated_at is not null
  and snapshot_id is not null and row_count>0 and first_date<=last_date))
);
create table if not exists market_scanner.backtest_history_queue (
 id bigint generated always as identity primary key,
 ticker text not null unique references market_scanner.instruments(ticker),
 status text not null default 'pending' check(status in ('pending','running','completed','failed')),
 reason text not null, attempts integer not null default 0,
 requested_at timestamptz not null default now(), next_attempt_at timestamptz not null default now(),
 requested_start date, requested_end date, lease_token uuid, lease_until timestamptz,
 finished_at timestamptz, last_error text
);
create index if not exists backtest_history_queue_pending_idx on market_scanner.backtest_history_queue(next_attempt_at,id)
 where status in ('pending','failed','running');
create table if not exists market_scanner.backtest_history_audit (
 id bigint generated always as identity primary key, ticker text not null,
 received_at timestamptz not null default now(), status text not null, reason text,
 snapshot_id uuid, source_sha256 text, payload_sha256 text,
 metadata jsonb not null default '{}'
);
create index if not exists backtest_history_audit_received_idx on market_scanner.backtest_history_audit(received_at);

alter table public.backtest_history enable row level security;
alter table public.backtest_history_coverage enable row level security;
alter table market_scanner.backtest_sessions enable row level security;
alter table market_scanner.backtest_history_queue enable row level security;
alter table market_scanner.backtest_history_audit enable row level security;
revoke all on public.backtest_history,public.backtest_history_coverage from public,anon,authenticated;
grant select on public.backtest_history,public.backtest_history_coverage to anon,authenticated;
grant select,insert,update,delete on public.backtest_history,public.backtest_history_coverage to service_role;
drop policy if exists backtest_history_public_read on public.backtest_history;
create policy backtest_history_public_read on public.backtest_history for select to anon,authenticated using(true);
drop policy if exists backtest_coverage_public_read on public.backtest_history_coverage;
create policy backtest_coverage_public_read on public.backtest_history_coverage for select to anon,authenticated using(true);
revoke all on market_scanner.backtest_sessions,market_scanner.backtest_history_queue,market_scanner.backtest_history_audit from public,anon,authenticated;
grant select,insert,update,delete on market_scanner.backtest_sessions,market_scanner.backtest_history_queue,market_scanner.backtest_history_audit to service_role;
grant usage,select on sequence market_scanner.backtest_history_queue_id_seq,market_scanner.backtest_history_audit_id_seq to service_role;

create or replace function market_scanner.guard_backtest_history_write() returns trigger
language plpgsql security invoker set search_path='' as $$ begin
 if current_setting('market_scanner.backtest_validated_write',true) is distinct from 'on' then
  raise exception using errcode='42501',message='Use the validated backtest history worker.';
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
drop trigger if exists backtest_history_server_guard on public.backtest_history;
create trigger backtest_history_server_guard before insert or update or delete on public.backtest_history
for each row execute function market_scanner.guard_backtest_history_write();

create or replace function market_scanner.queue_backtest_history(p_ticker text,p_reason text,p_reset boolean default false)
returns void language sql security invoker set search_path='' as $$
 insert into market_scanner.backtest_history_queue(ticker,reason) values(p_ticker,left(p_reason,120))
 on conflict(ticker) do update set
 status=case when backtest_history_queue.status='running' and backtest_history_queue.lease_until>now() then 'running' else 'pending' end,
 reason=excluded.reason,requested_at=now(),finished_at=null,
 attempts=case when p_reset or backtest_history_queue.status='completed' then 0 else backtest_history_queue.attempts end,
 next_attempt_at=case when p_reset or backtest_history_queue.status='completed' then now() else backtest_history_queue.next_attempt_at end;
$$;

create or replace function market_scanner.refresh_backtest_history(p_clock timestamptz default clock_timestamp()) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare expected date:=market_scanner.expected_session(p_clock);start_day date;i record;n integer:=0;
begin
 start_day:=(expected-interval '11 years')::date;
 if start_day<date '2015-01-01' or expected>date '2028-12-31' then raise exception 'BACKTEST_CALENDAR_OUT_OF_RANGE';end if;
 for i in select ticker from market_scanner.instruments where active order by ticker loop
  insert into public.backtest_history_coverage(ticker,requested_start,requested_end)
  values(i.ticker,start_day,expected) on conflict(ticker) do nothing;
  perform market_scanner.queue_backtest_history(i.ticker,'DAILY_FULL_HISTORY',true);n:=n+1;
 end loop;
 -- Compact provenance only. Never retain repeated raw JSON or duplicate bar snapshots.
 delete from market_scanner.backtest_history_audit where received_at<p_clock-interval '30 days';
 return jsonb_build_object('queued',n,'requested_start',start_day,'requested_end',expected);
end $$;

create or replace function public.backtest_claim_history(p_limit integer default 2) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare jobs jsonb;expected date:=market_scanner.expected_session();start_day date;previous_session date;available integer;
begin
 -- Serialize claims, not downloads. Even overlapping Cron/manual invocations
 -- may hold at most two live leases in the independent archive queue.
 perform pg_advisory_xact_lock(hashtextextended('backtest_history_claims',0));
 select greatest(0,2-count(*)) into available from market_scanner.backtest_history_queue
 where status='running' and lease_until>now();
 if available=0 then return '[]'::jsonb;end if;
 start_day:=(expected-interval '11 years')::date;
 select max(session_date) into previous_session from market_scanner.backtest_sessions where session_date<expected;
 if start_day<date '2015-01-01' or expected>date '2028-12-31' then raise exception 'BACKTEST_CALENDAR_OUT_OF_RANGE';end if;
 if pg_database_size(current_database())>=440401920 then
  update public.backtest_history_coverage set last_error='DATABASE_CAPACITY_GUARD_420_MIB'
  where ticker in(select ticker from market_scanner.backtest_history_queue where status in ('pending','failed','running'))
   and last_error is distinct from 'DATABASE_CAPACITY_GUARD_420_MIB';
  return '[]'::jsonb;
 end if;
 with candidates as(select q.id,
   case when q.attempts=1 and q.last_error='INCOHERENT_OHLCV'
    and coalesce((select c.row_count from public.backtest_history_coverage c where c.ticker=q.ticker),0)=0
    and not exists(select 1 from public.backtest_history h where h.ticker=q.ticker)
    then previous_session else expected end as target_end
  from market_scanner.backtest_history_queue q join market_scanner.instruments i using(ticker)
  where i.active and q.next_attempt_at<=now() and (q.status in ('pending','failed') or (q.status='running' and q.lease_until<now()))
  order by q.requested_at,q.id for update of q skip locked limit least(greatest(coalesce(p_limit,2),1),available)),
 claimed as(update market_scanner.backtest_history_queue q set status='running',attempts=attempts+1,
  requested_start=(c.target_end-interval '11 years')::date,requested_end=c.target_end,
  lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes'
  from candidates c where q.id=c.id returning q.id,q.ticker,q.lease_token,q.requested_start,q.requested_end)
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'ticker',c.ticker,'yahoo_symbol',i.yahoo_symbol,
  'lease_token',c.lease_token,'requested_start',c.requested_start,'requested_end',c.requested_end)),'[]') into jobs
 from claimed c join market_scanner.instruments i using(ticker);
 return jobs;
end $$;

create or replace function public.backtest_fail_history(p_job_id bigint,p_lease_token uuid,p_reason text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare t text;begin
 update market_scanner.backtest_history_queue set status='failed',last_error=left(p_reason,200),lease_until=null,
 next_attempt_at=now()+make_interval(mins=>case when attempts>=5 then 60 else (2^greatest(attempts,1))::integer end)
 where id=p_job_id and lease_token=p_lease_token and status='running' and lease_until>now() returning ticker into t;
 if t is null then return jsonb_build_object('status','lease_expired');end if;
 update public.backtest_history_coverage set last_error=left(p_reason,200) where ticker=t;
 insert into market_scanner.backtest_history_audit(ticker,status,reason) values(t,'failed',left(p_reason,200));
 return jsonb_build_object('status','failed');
end $$;

create or replace function market_scanner.parse_backtest_payload(p jsonb,p_start date,p_end date,p_clock timestamptz default clock_timestamp())
returns jsonb language plpgsql security invoker set search_path='' set extra_float_digits=3 as $$
declare i market_scanner.instruments%rowtype;fetched timestamptz;requested timestamptz;quote_at timestamptz;
 first_day date;first_required date;first_bar date;last_bar date;end_closes timestamptz;bars jsonb;
 expected date:=market_scanner.expected_session(p_clock);previous_session date;
 n integer;distinct_n integer;expected_n integer;rounding_n integer;valid boolean;bad_session boolean;
begin
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>4000000 then return jsonb_build_object('error','PAYLOAD_INVALID');end if;
 select * into i from market_scanner.instruments where ticker=p->>'ticker' and active;
 if not found then return jsonb_build_object('error','UNKNOWN_TICKER');end if;
 if p->>'source' is distinct from 'yahoo' or p->>'symbol' is distinct from i.yahoo_symbol or p->>'currency' is distinct from 'USD'
  or p->>'exchange_timezone' is distinct from 'America/New_York' or coalesce(p->>'exchange_name','') not in
  ('NMS','NGM','NCM','NYQ','ASE','PCX','BTS','NASDAQ','NYSE','NYSEArca','NYSE American','Cboe US') then
  return jsonb_build_object('error','INVALID_PROVIDER_IDENTITY');end if;
 select max(session_date) into previous_session from market_scanner.backtest_sessions where session_date<expected;
 if p_start is null or p_end is null or (p->>'requested_start')::date is distinct from p_start or (p->>'requested_end')::date is distinct from p_end
  or p_end not in (expected,previous_session) or p_start is distinct from (p_end-interval '11 years')::date
  or p_start<date '2015-01-01' or p_end>date '2028-12-31' then return jsonb_build_object('error','INVALID_HISTORY_WINDOW');end if;
 if jsonb_typeof(p->'regular_market_time') is distinct from 'number' or jsonb_typeof(p->'first_trade_epoch') is distinct from 'number'
  or coalesce(p->>'source_sha256','')!~'^[a-f0-9]{64}$' then return jsonb_build_object('error','INVALID_PROVIDER_METADATA');end if;
 fetched:=(p->>'fetched_at')::timestamptz;requested:=(p->>'requested_at')::timestamptz;
 quote_at:=to_timestamp((p->>'regular_market_time')::float8);
 first_day:=(to_timestamp((p->>'first_trade_epoch')::float8) at time zone 'America/New_York')::date;
 select closes_at into end_closes from market_scanner.sessions where session_date=p_end;
 if fetched is null or requested is null or fetched<requested or requested<p_clock-interval '15 minutes'
  or fetched>p_clock+interval '2 minutes' or requested>p_clock+interval '2 minutes'
  or quote_at>p_clock+interval '5 minutes' or quote_at<end_closes or first_day<date '1900-01-01'
  or first_day>(p_clock at time zone 'America/New_York')::date then return jsonb_build_object('error','STALE_OR_INVALID_CAPTURE');end if;
 if jsonb_typeof(p->'rows') is distinct from 'array' or jsonb_array_length(p->'rows') not between 1 and 4000 then
  return jsonb_build_object('error','INVALID_HISTORY_SIZE');end if;
 if exists(select 1 from jsonb_array_elements(p->'rows') r cross join unnest(array['timestamp','open','high','low','close','volume']) f
  where jsonb_typeof(r->f) is distinct from 'number') then return jsonb_build_object('error','NON_NUMERIC_OHLCV');end if;
 select min(session_date) into first_required from market_scanner.backtest_sessions
 where session_date>=greatest(p_start,first_day) and session_date<=p_end;
 if first_required is null then return jsonb_build_object('error','NO_CONFIRMED_HISTORY');end if;
 if exists(select 1 from public.backtest_history where ticker=i.ticker and fecha>=p_start and fecha<first_required)
  or (i.first_trade_date is not null and exists(select 1 from market_scanner.backtest_sessions
   where session_date>=greatest(p_start,i.first_trade_date) and session_date<first_required)) then
  return jsonb_build_object('error','LISTING_DATE_REGRESSION');end if;
 -- Validate every supplied row first. Only sub-millionth relative OHLC rounding
 -- is normalized; material errors, duplicates and dates outside the lease fail.
 with raw as(select (to_timestamp(r.timestamp) at time zone 'America/New_York')::date d,r.*
  from jsonb_to_recordset(p->'rows') r(timestamp float8,open float8,high float8,low float8,close float8,volume numeric))
 select count(*),count(distinct d),min(d),max(d),
  bool_and(open>0 and open<'Infinity'::float8 and high>0 and high<'Infinity'::float8 and low>0 and low<'Infinity'::float8
   and close>0 and close<'Infinity'::float8 and high>=greatest(open,close,low)-close*1e-6
   and low<=least(open,close,high)+close*1e-6 and volume>=0 and volume<=9007199254740991 and volume=trunc(volume)),
  bool_or(d<p_start or d>p_end or not exists(select 1 from market_scanner.backtest_sessions s where s.session_date=d)),
  count(*) filter(where high<greatest(open,close) or low>least(open,close)),
  jsonb_agg(jsonb_build_object('fecha',d,'open',open,'high',greatest(high,open,close),'low',least(low,open,close),
   'close',close,'volumen',volume,'is_final',true) order by d)
 into n,distinct_n,first_bar,last_bar,valid,bad_session,rounding_n,bars from raw;
 if valid is distinct from true then return jsonb_build_object('error','INCOHERENT_OHLCV');end if;
 if n<>distinct_n then return jsonb_build_object('error','DUPLICATE_SESSION');end if;
 if bad_session then return jsonb_build_object('error','INVALID_SESSION_DATE');end if;
 select count(*) into expected_n from market_scanner.backtest_sessions where session_date between first_required and p_end;
 if first_bar is distinct from first_required or last_bar is distinct from p_end or n<>expected_n then
  return jsonb_build_object('error','INCOMPLETE_HISTORY','first_required',first_required,'expected_rows',expected_n,'received_rows',n);end if;
 if jsonb_typeof(coalesce(p->'splits','[]')) is distinct from 'array' or jsonb_array_length(coalesce(p->'splits','[]'))>200 then
  return jsonb_build_object('error','INVALID_SPLITS');end if;
 if exists(select 1 from jsonb_array_elements(coalesce(p->'splits','[]')) e where
  jsonb_typeof(e->'timestamp') is distinct from 'number' or jsonb_typeof(e->'numerator') is distinct from 'number'
  or jsonb_typeof(e->'denominator') is distinct from 'number') then return jsonb_build_object('error','INVALID_SPLITS');end if;
 if exists(select 1 from jsonb_to_recordset(coalesce(p->'splits','[]')) e(timestamp float8,numerator numeric,denominator numeric)
  where numerator<=0 or denominator<=0 or (to_timestamp(timestamp) at time zone 'America/New_York')::date not between p_start and p_end) then
  return jsonb_build_object('error','INVALID_SPLITS');end if;
 return jsonb_build_object('bars',bars,'first_date',first_bar,'last_date',last_bar,'row_count',n,
  'rounding_envelope_rows',rounding_n,'first_trade_date',first_day,'fetched_at',fetched);
exception when others then return jsonb_build_object('error','INVALID_PAYLOAD_'||sqlstate);
end $$;

create or replace function public.backtest_replace_history(p_job_id bigint,p_lease_token uuid,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' set extra_float_digits=3 as $$
declare q market_scanner.backtest_history_queue%rowtype;parsed jsonb;bars jsonb;reason text;changed_n integer;deleted_n integer;
 expected date:=market_scanner.expected_session();previous_session date;fallback boolean;
 snapshot uuid;prior_write text:=coalesce(current_setting('market_scanner.backtest_validated_write',true),'off');
begin
 select * into q from market_scanner.backtest_history_queue where id=p_job_id and lease_token=p_lease_token
  and status='running' and lease_until>now() for update;
 if not found then return jsonb_build_object('status','rejected','reason','INVALID_LEASE');end if;
 perform pg_advisory_xact_lock(hashtextextended('backtest_history:'||q.ticker,0));
 select max(session_date) into previous_session from market_scanner.backtest_sessions where session_date<expected;
 fallback:=q.requested_end is distinct from expected;
 if q.ticker is distinct from p_payload->>'ticker' then reason:='JOB_IDENTITY_MISMATCH';
 elsif fallback and ((q.requested_end=previous_session and q.attempts=2 and q.last_error='INCOHERENT_OHLCV'
  and coalesce((select row_count from public.backtest_history_coverage where ticker=q.ticker),0)=0
  and not exists(select 1 from public.backtest_history where ticker=q.ticker)) is distinct from true)
  then reason:='INVALID_FALLBACK_WINDOW';
 elsif pg_database_size(current_database())>=440401920 then reason:='DATABASE_CAPACITY_GUARD_420_MIB';
 else parsed:=market_scanner.parse_backtest_payload(p_payload,q.requested_start,q.requested_end);reason:=parsed->>'error';end if;
 if reason is not null then
  perform public.backtest_fail_history(p_job_id,p_lease_token,reason);
  insert into market_scanner.backtest_history_audit(ticker,status,reason,source_sha256,payload_sha256,metadata)
   values(q.ticker,'rejected',reason,left(p_payload->>'source_sha256',64),encode(extensions.digest(p_payload::text,'sha256'),'hex'),
    coalesce(parsed-'bars','{}'::jsonb));
  return jsonb_build_object('status','rejected','reason',reason);
 end if;
 bars:=parsed->'bars';snapshot:=gen_random_uuid();
 -- The exception block makes the accepted publication atomic, including metadata.
 begin
  perform set_config('market_scanner.backtest_validated_write','on',true);
  insert into public.backtest_history(ticker,fecha,open,high,low,close,volumen,is_final)
  select q.ticker,r.fecha,r.open,r.high,r.low,r.close,r.volumen,true
  from jsonb_to_recordset(bars) r(fecha date,open float8,high float8,low float8,close float8,volumen bigint)
  on conflict(ticker,fecha) do update set open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volumen=excluded.volumen
  where row(backtest_history.open,backtest_history.high,backtest_history.low,backtest_history.close,backtest_history.volumen)
   is distinct from row(excluded.open,excluded.high,excluded.low,excluded.close,excluded.volumen);
  get diagnostics changed_n=row_count;
  delete from public.backtest_history where ticker=q.ticker and (fecha<(parsed->>'first_date')::date or fecha>q.requested_end);
  get diagnostics deleted_n=row_count;
  perform set_config('market_scanner.backtest_validated_write',prior_write,true);
  insert into public.backtest_history_coverage(ticker,first_date,last_date,row_count,requested_start,requested_end,updated_at,status,last_error,snapshot_id)
   values(q.ticker,(parsed->>'first_date')::date,(parsed->>'last_date')::date,(parsed->>'row_count')::integer,
    q.requested_start,q.requested_end,(parsed->>'fetched_at')::timestamptz,'ready',
    case when fallback then 'LATEST_SESSION_UNAVAILABLE' else null end,snapshot)
   on conflict(ticker) do update set first_date=excluded.first_date,last_date=excluded.last_date,row_count=excluded.row_count,
    requested_start=excluded.requested_start,requested_end=excluded.requested_end,updated_at=excluded.updated_at,status='ready',last_error=excluded.last_error,snapshot_id=excluded.snapshot_id;
  update market_scanner.backtest_history_queue set status='completed',finished_at=now(),lease_until=null,last_error=null where id=q.id;
  insert into market_scanner.backtest_history_audit(ticker,status,snapshot_id,source_sha256,payload_sha256,metadata)
   values(q.ticker,'completed',snapshot,p_payload->>'source_sha256',encode(extensions.digest(p_payload::text,'sha256'),'hex'),
    (parsed-'bars')||jsonb_build_object('changed_rows',changed_n,'deleted_rows',deleted_n,'previous_session_bootstrap',fallback,
     'split_events',jsonb_array_length(coalesce(p_payload->'splits','[]'))));
 exception when others then
  perform set_config('market_scanner.backtest_validated_write',prior_write,true);
  perform public.backtest_fail_history(p_job_id,p_lease_token,'PUBLICATION_FAILED_'||sqlstate);
  return jsonb_build_object('status','rejected','reason','PUBLICATION_FAILED');
 end;
 return jsonb_build_object('status','completed','ticker',q.ticker,'row_count',(parsed->>'row_count')::integer,
  'changed_rows',changed_n,'deleted_rows',deleted_n,'snapshot_id',snapshot);
end $$;

create or replace function market_scanner.dispatch_backtest_history_worker() returns bigint
language plpgsql security invoker set search_path='' as $$
declare request_id bigint;begin
 if pg_database_size(current_database())>=440401920 then
  update public.backtest_history_coverage set last_error='DATABASE_CAPACITY_GUARD_420_MIB'
   where last_error is distinct from 'DATABASE_CAPACITY_GUARD_420_MIB';
  return null;
 end if;
 if (select count(*) from market_scanner.backtest_history_queue where status='running' and lease_until>now())>=2 then return null;end if;
 if not exists(select 1 from market_scanner.backtest_history_queue where next_attempt_at<=now() and
  (status in ('pending','failed') or (status='running' and lease_until<now()))) then return null;end if;
 select net.http_post(url:='https://wpenzrjybvysvfaefkxh.supabase.co/functions/v1/backtest-history-worker',
  headers:=jsonb_build_object('Content-Type','application/json','X-Market-Worker-Token',
   (select decrypted_secret from vault.decrypted_secrets where name='market_scanner_worker_token')),
  body:='{}'::jsonb,timeout_milliseconds:=100000) into request_id;
 return request_id;
end $$;

revoke all on function market_scanner.guard_backtest_history_write(),market_scanner.queue_backtest_history(text,text,boolean),
 market_scanner.refresh_backtest_history(timestamptz),market_scanner.parse_backtest_payload(jsonb,date,date,timestamptz),
 market_scanner.dispatch_backtest_history_worker() from public,anon,authenticated;
grant execute on function market_scanner.guard_backtest_history_write(),market_scanner.queue_backtest_history(text,text,boolean),
 market_scanner.refresh_backtest_history(timestamptz),market_scanner.parse_backtest_payload(jsonb,date,date,timestamptz) to service_role;
revoke all on function market_scanner.dispatch_backtest_history_worker() from service_role;
revoke all on function public.backtest_claim_history(integer),public.backtest_fail_history(bigint,uuid,text),public.backtest_replace_history(bigint,uuid,jsonb)
 from public,anon,authenticated;
grant execute on function public.backtest_claim_history(integer),public.backtest_fail_history(bigint,uuid,text),public.backtest_replace_history(bigint,uuid,jsonb) to service_role;

notify pgrst,'reload schema';
commit;
