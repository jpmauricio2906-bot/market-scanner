-- Daily cloud review at 20:30 New York, starting 2026-10-19. Does not change prices.
-- Apply as the database owner, after the existing market-scanner migrations.
begin;
create table if not exists public.market_close_audits (
 session_date date primary key, captured_at timestamptz not null, report jsonb not null,
 check(jsonb_typeof(report)='object' and report->>'session_date'=session_date::text)
);
alter table public.market_close_audits enable row level security;
revoke all on public.market_close_audits from public,anon,authenticated,service_role;
grant select on public.market_close_audits to anon,authenticated;
drop policy if exists market_close_audits_read on public.market_close_audits;
create policy market_close_audits_read on public.market_close_audits for select to anon,authenticated using(true);

create or replace function market_scanner.close_audit_bar_valid(o float8,h float8,l float8,c float8,v bigint)
returns boolean language sql immutable security invoker set search_path='' as $$
 select coalesce(o>0 and o<'Infinity'::float8 and h>0 and h<'Infinity'::float8 and l>0 and l<'Infinity'::float8
 and c>0 and c<'Infinity'::float8 and l<=least(o,c) and h>=greatest(o,c) and l<=h and v>=0 and v<=9007199254740991,false);
$$;
revoke all on function market_scanner.close_audit_bar_valid(float8,float8,float8,float8,bigint) from public,anon,authenticated,service_role;

-- Private rows keep the builder below the migration transport limit.
create or replace function market_scanner.close_audit_rows(p_session date,p_clock timestamptz)
returns table(ticker text,expected_days integer,actual_days integer,bad_days integer,final_date date,final_valid boolean,
 quote_date date,quote_status text,quote_final boolean,quote_source text,projection_valid boolean,last_final_date date,
 bad_stored_days bigint,private_status text,event_status text,repair_status text,next_attempt_at timestamptz,retained_days bigint)
language plpgsql stable security invoker set search_path='' as $$
declare cutoff date;retention_session date;session_opens timestamptz;begin
 select session_date into cutoff from market_scanner.sessions where session_date<=p_session order by session_date desc offset 499 limit 1;
 retention_session:=market_scanner.expected_session(p_clock);
 select opens_at into session_opens from market_scanner.sessions where session_date=p_session;
 return query
  with instrument_bounds as (
   select i.*,greatest(cutoff,coalesce((select d.session_date from market_scanner.sessions d
    where d.session_date<=greatest(p_session,(select max(z.fecha) from public.market_history z
     where z.ticker=i.ticker and z.is_final and z.fecha<=retention_session))
    order by d.session_date desc offset 499 limit 1),cutoff)) retained_cutoff
   from market_scanner.instruments i where i.active
  ), coverage as (
   select i.ticker,count(d.session_date)::integer expected_days,count(h.fecha)::integer actual_days,
    count(h.fecha) filter(where not market_scanner.close_audit_bar_valid(h.open,h.high,h.low,h.close,h.volumen))::integer bad_days
   from instrument_bounds i
   left join market_scanner.sessions d on d.session_date between greatest(i.retained_cutoff,coalesce(i.first_trade_date,i.retained_cutoff)) and p_session
   left join public.market_history h on h.ticker=i.ticker and h.fecha=d.session_date and h.is_final
   where i.active group by i.ticker
  ), history_stats as (
   select h.ticker,max(h.fecha) last_final_date,count(*) retained_days,
    count(*) filter(where d.session_date is null or not market_scanner.close_audit_bar_valid(h.open,h.high,h.low,h.close,h.volumen)
     or h.fecha<coalesce(i.first_trade_date,h.fecha)) bad_stored_days
   from public.market_history h join market_scanner.instruments i on i.ticker=h.ticker and i.active
   left join market_scanner.sessions d on d.session_date=h.fecha
   where h.is_final and h.fecha<=p_session group by h.ticker
  ), latest_event as (
   select distinct on(e.ticker) e.ticker,e.status,e.received_at
   from market_scanner.ingest_events e join market_scanner.instruments i on i.ticker=e.ticker and i.active
   where e.received_at>=session_opens and e.received_at<=p_clock
    and e.received_at<((p_session+1)::timestamp at time zone 'America/New_York')
   order by e.ticker,e.received_at desc,e.id desc
  )
  select i.ticker,c.expected_days,c.actual_days,c.bad_days,
   h.fecha final_date,market_scanner.close_audit_bar_valid(h.open,h.high,h.low,h.close,h.volumen) final_valid,
   q.fecha quote_date,q.status quote_status,q.is_final quote_final,q.source quote_source,
   case when q.fecha>p_session then market_scanner.close_audit_bar_valid(q.open,q.high,q.low,q.close,q.volumen)
    else q.fecha=p_session and q.is_final and q.status='FINAL' and q.source='yahoo'
     and market_scanner.close_audit_bar_valid(q.open,q.high,q.low,q.close,q.volumen)
     and row(q.open,q.high,q.low,q.close,q.volumen)=row(h.open,h.high,h.low,h.close,h.volumen) end projection_valid,
   hs.last_final_date,hs.bad_stored_days,
   pq.status private_status,e.status event_status,j.status repair_status,j.next_attempt_at,
   coalesce(hs.retained_days,0) retained_days
  from market_scanner.instruments i join coverage c on c.ticker=i.ticker
  left join history_stats hs on hs.ticker=i.ticker
  left join public.market_history h on h.ticker=i.ticker and h.fecha=p_session and h.is_final
  left join public.market_latest_quotes q on q.ticker=i.ticker
  left join market_scanner.current_quotes pq on pq.ticker=i.ticker
  left join latest_event e on e.ticker=i.ticker
  left join market_scanner.repair_queue j on j.ticker=i.ticker
  where i.active order by i.ticker;
end $$;
revoke all on function market_scanner.close_audit_rows(date,timestamptz) from public,anon,authenticated,service_role;

create or replace function market_scanner.close_audit_automatic(p_session date,p_clock timestamptz)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare gf_n integer;gf_t integer;gf_last timestamptz;y_n integer;y_t integer;y_last timestamptz;
 worker_active boolean;worker_ok integer;worker_bad integer;worker_last timestamptz;automatic jsonb;begin
 -- Receipt counts demonstrate server arrivals, not the private Google trigger
 -- identity: Apps Script does not currently send triggerUid in its payload.
 select count(*) filter(where e.payload->>'source'='googlefinance'),count(distinct e.ticker) filter(where e.payload->>'source'='googlefinance'),
  max(e.received_at) filter(where e.payload->>'source'='googlefinance'),
  count(*) filter(where e.payload->>'source'='yahoo'),count(distinct e.ticker) filter(where e.payload->>'source'='yahoo'),
  max(e.received_at) filter(where e.payload->>'source'='yahoo')
 into gf_n,gf_t,gf_last,y_n,y_t,y_last from market_scanner.ingest_events e
 join market_scanner.instruments i on i.ticker=e.ticker and i.active
 where e.received_at>=(p_session::timestamp at time zone 'America/New_York') and e.received_at<=p_clock
 and e.received_at<((p_session+1)::timestamp at time zone 'America/New_York');
 select coalesce(bool_or(active),false) into worker_active from cron.job where jobname='market-scanner-repair-worker';
 select count(*) filter(where d.status='succeeded'),count(*) filter(where d.status='failed'),
  max(d.end_time) filter(where d.status='succeeded') into worker_ok,worker_bad,worker_last
 from cron.job_run_details d join cron.job j on j.jobid=d.jobid and j.jobname='market-scanner-repair-worker'
 where d.start_time>=p_clock-interval '2 hours' and d.start_time<=p_clock;
 automatic:=jsonb_build_object('googlefinance',jsonb_build_object('received',gf_n,'distinct_tickers',gf_t,'last_received_at',gf_last,'execution_origin_recorded',false),
  'yahoo',jsonb_build_object('received',y_n,'distinct_tickers',y_t,'last_received_at',y_last,'execution_origin_recorded',false),
  'worker',jsonb_build_object('active',worker_active,'recent_successes',worker_ok,'recent_failures',worker_bad,'last_success_at',worker_last));
 return automatic;
end $$;
revoke all on function market_scanner.close_audit_automatic(date,timestamptz) from public,anon,authenticated,service_role;

-- Read-only builder: explicit clock permits honest historical dry runs, without
-- creating a production snapshot or changing a market price or repair job.
create or replace function market_scanner.build_close_audit(p_session date,p_clock timestamptz default clock_timestamp())
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare s market_scanner.sessions%rowtype;cutoff date;r record;codes text[];code text;
 issues jsonb:='[]'::jsonb;checks jsonb;automatic jsonb;universe jsonb;expected integer;complete integer:=0;
 active_repairs integer:=0;rejected integer:=0;bad_final integer:=0;bad_projection integer:=0;bad_coverage integer:=0;
 gf_n integer;gf_t integer;y_n integer;y_t integer;
 worker_active boolean;worker_ok integer;worker_bad integer;calendar_ok boolean;
begin
 if p_clock is null or p_session is null then raise exception 'Audit date and clock are required';end if;
 select * into s from market_scanner.sessions where session_date=p_session;
 if not found then raise exception 'Audit date is not a reviewed market session';end if;
 calendar_ok:=p_clock>=s.confirms_at;
 select session_date into cutoff from market_scanner.sessions where session_date<=p_session order by session_date desc offset 499 limit 1;
 if cutoff is null then raise exception 'Audit calendar has fewer than 500 sessions';end if;
 select count(*),coalesce(jsonb_agg(ticker order by ticker),'[]'::jsonb) into expected,universe
 from market_scanner.instruments where active;
 for r in select * from market_scanner.close_audit_rows(p_session,p_clock)
 loop
  codes:=array[]::text[];
  if r.final_date is null then codes:=array_append(codes,'MISSING_FINAL_CLOSE');bad_final:=bad_final+1;
  elsif not r.final_valid then codes:=array_append(codes,'INVALID_FINAL_OHLCV');bad_final:=bad_final+1;end if;
  if r.projection_valid is distinct from true then
   codes:=array_append(codes,case when r.quote_date=p_session and not coalesce(r.quote_final,false)
    then 'PROVISIONAL_CLOSE' when r.quote_date is null or r.quote_date<p_session then 'STALE_OR_MISSING_PUBLIC_QUOTE'
    else 'PUBLIC_HISTORY_MISMATCH' end);bad_projection:=bad_projection+1;
  end if;
  if r.actual_days<>r.expected_days or r.bad_days>0 or coalesce(r.bad_stored_days,0)>0 or r.retained_days>500 then
   codes:=array_append(codes,'HISTORY_COVERAGE_OR_QUALITY');bad_coverage:=bad_coverage+1;end if;
  if r.repair_status in('pending','running','failed') then
   codes:=array_append(codes,'ACTIVE_REPAIR');active_repairs:=active_repairs+1;end if;
  -- A rejected provider response does not invalidate an already validated final
  -- close. Only unresolved rejections are actionable; no free-form reason leaks.
  if (r.event_status='RECHAZADO' or r.private_status='RECHAZADO')
   and not (r.final_valid and coalesce(r.projection_valid,false)) then
   codes:=array_append(codes,'LATEST_CAPTURE_REJECTED');rejected:=rejected+1;end if;
  if cardinality(codes)=0 then complete:=complete+1;end if;
  foreach code in array codes loop
   issues:=issues||jsonb_build_array(jsonb_build_object('ticker',r.ticker,'code',code,
    'status',case when r.repair_status in('pending','running','failed') then r.repair_status
     when code='LATEST_CAPTURE_REJECTED' then 'RECHAZADO'
     when r.quote_status in('FINAL','PROVISIONAL') then r.quote_status else 'PENDIENTE' end,
    'last_final_date',r.last_final_date,'next_retry_at',case when r.repair_status in('pending','running','failed') then r.next_attempt_at end,
    'expected_history_days',r.expected_days,'actual_history_days',r.actual_days));
  end loop;
 end loop;
 automatic:=market_scanner.close_audit_automatic(p_session,p_clock);
 gf_n:=(automatic#>>'{googlefinance,received}')::integer;gf_t:=(automatic#>>'{googlefinance,distinct_tickers}')::integer;
 y_n:=(automatic#>>'{yahoo,received}')::integer;y_t:=(automatic#>>'{yahoo,distinct_tickers}')::integer;
 worker_active:=(automatic#>>'{worker,active}')::boolean;
 worker_ok:=(automatic#>>'{worker,recent_successes}')::integer;worker_bad:=(automatic#>>'{worker,recent_failures}')::integer;
 checks:=jsonb_build_object('universe_count',expected,'calendar_confirmed',calendar_ok,'final_history_valid',bad_final=0,
  'projection_consistent',bad_projection=0,'history_coverage_valid',bad_coverage=0,'no_active_repairs',active_repairs=0,
  'no_current_rejections',rejected=0,'googlefinance_received',gf_t=expected and expected>0,'yahoo_received',y_t=expected and expected>0,
  'worker_active',worker_active,'worker_recent_success',worker_ok>0 and worker_bad=0);
 foreach code in array array['UNIVERSE_COUNT','SESSION_NOT_CONFIRMED','GOOGLEFINANCE_RECEIPTS_INCOMPLETE','YAHOO_RECEIPTS_INCOMPLETE','WORKER_NOT_ACTIVE','WORKER_EXECUTION_FAILED_OR_MISSING'] loop
  if (case code when 'UNIVERSE_COUNT' then expected<>250 when 'SESSION_NOT_CONFIRMED' then not calendar_ok
   when 'GOOGLEFINANCE_RECEIPTS_INCOMPLETE' then gf_t<>expected or expected=0 when 'YAHOO_RECEIPTS_INCOMPLETE' then y_t<>expected or expected=0
   when 'WORKER_NOT_ACTIVE' then not worker_active else worker_ok=0 or worker_bad>0 end) then
   issues:=issues||jsonb_build_array(jsonb_build_object('ticker',null,'code',code,'status','REVISAR','last_final_date',null,'next_retry_at',null));
  end if;
 end loop;
 return jsonb_build_object('schema_version',1,'session_date',p_session,'captured_at',p_clock,'expected',expected,'complete',complete,
  'ok',expected=250 and complete=250 and jsonb_array_length(issues)=0,'universe',universe,'checks',checks,'automatic',automatic,
  'issues',issues,'summary',jsonb_build_object('expected',expected,'complete',complete,'issues',jsonb_array_length(issues),
   'active_repairs',active_repairs,'latest_rejected',rejected,'googlefinance_received',gf_n,'yahoo_received',y_n));
end $$;
revoke all on function market_scanner.build_close_audit(date,timestamptz) from public,anon,authenticated,service_role;

-- Owner-only explicit clock is for rollback tests. Cron supplies the real clock.
-- Keep this wrapper identical to daily_close_audit.sql for fresh installations.
create or replace function market_scanner.capture_close_audit(p_clock timestamptz default clock_timestamp())
returns boolean language plpgsql security invoker set search_path='' as $$
declare local_clock timestamp:=p_clock at time zone 'America/New_York';d date;r jsonb;begin
 if p_clock is null then return false;end if;
 d:=local_clock::date;
 if d<date '2026-10-19' or local_clock::time<time '20:30:00' then return false;end if;
 if extract(year from d)>2028 then raise exception 'Revisar calendario bursatil: fuera del horizonte publicado 2024-2028';end if;
 -- The reviewed session table handles holidays and reduced sessions. Every
 -- review still starts at 20:30 New York, irrespective of the actual close.
 if not exists(select 1 from market_scanner.sessions where session_date=d and confirms_at<=p_clock) then return false;end if;
 perform pg_advisory_xact_lock(250,to_char(d,'YYYYMMDD')::integer);
 if not exists(select 1 from public.market_close_audits where session_date=d) then
  r:=market_scanner.build_close_audit(d,p_clock);
  insert into public.market_close_audits(session_date,captured_at,report) values(d,p_clock,r) on conflict(session_date) do nothing;
 end if;
 -- Keep the permanent Cron installed. SQL failures roll back the snapshot,
 -- so a later five-minute invocation can retry until this NY day ends.
 return true;
end $$;
revoke all on function market_scanner.capture_close_audit(timestamptz) from public,anon,authenticated,service_role;
do $$declare j bigint;begin
 for j in select jobid from cron.job where jobname='market-scanner-close-review-20261019' loop perform cron.unschedule(j);end loop;
 perform cron.schedule('market-scanner-daily-close-review','*/5 * * * *',$job$select market_scanner.capture_close_audit();$job$);
end$$;
commit;
