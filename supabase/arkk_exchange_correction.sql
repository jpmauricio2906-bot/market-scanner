-- ARKK is listed on Cboe BZX. GOOGLEFINANCE identifies this venue as BATS.
-- Metadata only: no quote, history, function, grant or RLS policy is changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
do $correction$
declare instrument market_scanner.instruments%rowtype;
begin
 select * into instrument from market_scanner.instruments where ticker='ARKK' for update;
 if not found or not instrument.active or instrument.instrument_type<>'ETF'
    or instrument.currency<>'USD' or instrument.yahoo_symbol<>'ARKK'
    or instrument.exchange_name not in ('NYSEARCA','CBOEBZX') then
  raise exception 'ARKK exchange correction aborted: unexpected instrument metadata.';
 end if;
 update market_scanner.instruments set exchange_name='CBOEBZX'
 where ticker='ARKK' and exchange_name='NYSEARCA';
 if not exists(select 1 from market_scanner.instruments
               where ticker='ARKK' and active and instrument_type='ETF' and exchange_name='CBOEBZX') then
  raise exception 'ARKK exchange correction did not produce the expected metadata.';
 end if;
end $correction$;
commit;

select ticker,instrument_type,exchange_name,currency,active
from market_scanner.instruments where ticker='ARKK';
