-- Bounded prior-session bootstrap for empty archives only.
begin;
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

-- Re-arm only empty first-load failures created before bootstrap was available.
-- Audit records preserve prior attempts; no accepted history is changed.
update market_scanner.backtest_history_queue q set attempts=1,next_attempt_at=now()
where q.status='failed' and q.last_error='INCOHERENT_OHLCV'
 and q.requested_end=market_scanner.expected_session()
 and not exists(select 1 from public.backtest_history h where h.ticker=q.ticker)
 and coalesce((select c.row_count from public.backtest_history_coverage c where c.ticker=q.ticker),0)=0;
notify pgrst,'reload schema';
commit;
