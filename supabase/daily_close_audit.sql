-- Apply AFTER cloud_close_audit.sql. Reuse its read-only builder and public
-- snapshot contract; only the review schedule becomes permanent.
begin;
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
