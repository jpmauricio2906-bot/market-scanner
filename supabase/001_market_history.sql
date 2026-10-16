-- Run in Supabase SQL Editor AFTER exporting a backup of market_history.
-- Existing duplicate keys stop this migration: inspect them; no automatic deletion.
begin;

create table if not exists public.market_history (
  fecha date not null,
  ticker text not null,
  open double precision not null,
  high double precision not null,
  low double precision not null,
  close double precision not null,
  volumen bigint not null,
  is_final boolean not null default false,
  primary key (fecha, ticker)
);

-- Legacy snapshots have no proof of a final close. Only the new validated writer sets true.
alter table public.market_history add column if not exists is_final boolean not null default false;

-- REST on_conflict needs a unique key. Reuse an existing PK/unique index.
do $$ begin
  if not exists (
    select 1 from pg_index i
    where i.indrelid='public.market_history'::regclass
      and i.indisunique and i.indisvalid and i.indpred is null
      and i.indexprs is null and i.indnkeyatts=2
      and (select array_agg(a.attname::text order by a.attname)
           from unnest(i.indkey) with ordinality k(attnum,position)
           join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
           where k.position<=i.indnkeyatts)=array['fecha','ticker']
  ) then
    create unique index if not exists market_history_fecha_ticker_uq
      on public.market_history (fecha, ticker);
  end if;
end $$;
create index if not exists market_history_ticker_fecha_idx
  on public.market_history (ticker, fecha desc);

-- NOT VALID permits the legacy data to be audited; PostgreSQL checks all new writes.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.market_history'::regclass and conname='market_history_quality_v2') then
    alter table public.market_history add constraint market_history_quality_v2 check (
      fecha is not null and ticker is not null and ticker ~ '^[A-Z][A-Z0-9-]{0,9}$'
      and extract(isodow from fecha) between 1 and 5
      and open is not null and high is not null and low is not null and close is not null
      and open > 0 and high > 0 and low > 0 and close > 0
      and open < 'Infinity'::float8 and high < 'Infinity'::float8
      and low < 'Infinity'::float8 and close < 'Infinity'::float8
      and low <= least(open,close) and high >= greatest(open,close) and low <= high
      and volumen is not null and volumen >= 0 and volumen <= 9007199254740991
    ) not valid;
  end if;
end $$;

alter table public.market_history enable row level security;
revoke all on public.market_history from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.market_history to anon, authenticated;
grant all on public.market_history to service_role;
-- Replace the old SELECT policy rather than evaluating two equivalent ones.
drop policy if exists public_read on public.market_history;
drop policy if exists market_history_public_read_v2 on public.market_history;
create policy market_history_public_read_v2 on public.market_history
  for select to anon, authenticated using (true);

commit;

-- Read-only diagnostics; old rows are deliberately preserved until reviewed.
select fecha, ticker, count(*) from public.market_history
group by fecha,ticker having count(*) > 1;
select ticker, count(*) as sesiones, min(fecha) as primera, max(fecha) as ultima
from public.market_history group by ticker order by ticker;

-- Once backfill has corrected legacy rows, optionally validate the constraint:
-- alter table public.market_history validate constraint market_history_quality_v2;
