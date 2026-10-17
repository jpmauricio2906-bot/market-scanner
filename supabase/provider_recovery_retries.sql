-- Keep provider-recovery jobs retryable after five failed attempts.
-- Validation, leases, batch size, credentials, history and quote policy stay intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
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

revoke execute on function public.market_claim_repairs(integer),public.market_fail_repair(bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.market_claim_repairs(integer),public.market_fail_repair(bigint,uuid,text) to service_role;
revoke execute on function market_scanner.dispatch_worker() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
