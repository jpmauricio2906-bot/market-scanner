# Universo de 250 instrumentos: 200 empresas y 50 ETF

`universe.json` es el origen único de tickers para la aplicación, el libro y los scripts. `instruments` contiene 250 valores: las 200 empresas en `companies`, con tipo `STOCK`, seguidas por los 50 fondos/productos cotizados en `etfs`, con tipo `ETF`. `count=250`, `companyCount=200` y `etfCount=50`. El arreglo `companies` conserva las 200 empresas seleccionadas anteriormente. `universe.csv` contiene las mismas 250 filas y sus tipos para importarlas manualmente. Tickers con clases se escriben como Yahoo (`BRK-B`, no `BRK.B` ni `BRK/B`).

La selección incluye empresas de cualquier país con acciones o ADR cotizados en NASDAQ, NYSE o NYSE American. Se ordenan por capitalización en USD **reportada por el screener oficial de Nasdaq**, y se mantiene una sola empresa por CIK de SEC. No se suman clases de acciones; se elige la clase con mayor capitalización reportada, salvo `GOOGL` y `BRK-B`, elegidas expresamente. Se excluyen fondos, deuda, warrants y acciones preferentes; se aceptan ADR sobre capital no votante. El nombre legado de `BNS` en Nasdaq se corrige con evidencia de [Scotiabank](https://www.scotiabank.com/ca/en/about/investors-shareholders/frequently-asked-questions.html).

La fuente puede calcular la capitalización sobre las acciones asociadas al valor cotizado y no sobre todas las participaciones económicas del grupo. Este criterio reproducible puede diferir de rankings que usan capital total del grupo; por ejemplo, empresas con clases privadas. No es una lista fija de empresas conocidas ni un ranking de volumen.

La descarga se efectuó el **15 de octubre de 2026**. Nasdaq declara **14 de octubre de 2026** como fecha de los últimos precios. `asOf` conserva la fecha de la fuente, y `retrievedAt` registra la descarga en UTC. Las capturas originales completas, con URL y fecha de descarga, están en `sources/`. El JSON registra hashes SHA-256 de las capturas de Nasdaq.

## Los 50 ETF

`etfs.json` conserva la selección curada, verificada el **15 de octubre de 2026**, y es la fuente independiente de los ETF al reconstruir o actualizar el universo. Son fondos de uso extendido elegidos para cubrir las exposiciones solicitadas; **no son un ranking de los 50 mayores por patrimonio o volumen**. Cada fila registra emisor, categoría, bolsa, URL oficial y fecha de verificación. El orden agrupa exposiciones y no mide popularidad. La selección permanece fija hasta editar expresamente este archivo; `--refresh` solo renueva el ranking de empresas.

| Grupo | Tickers |
| --- | --- |
| Índices amplios y dividendos (10) | SPY, VOO, IVV, VTI, QQQ, QQQM, DIA, IWM, RSP, SCHD |
| Acciones internacionales (5) | VXUS, VEA, VWO, EFA, EEM |
| Once sectores de EE. UU. (11) | XLK, XLF, XLE, XLV, XLI, XLP, XLY, XLU, XLRE, XLB, XLC |
| Industrias y temáticos (6) | SOXX, SMH, XBI, IBB, ARKK, MAGS |
| Bonos (6) | TLT, IEF, SHY, BND, HYG, LQD |
| Metales preciosos (2) | GLD, SLV |
| Apalancados e inversos (10) | TQQQ, QLD, SQQQ, UPRO, SPXU, SSO, USD, SOXL, SOXS, LABU |

La referencia del usuario a **MAG7** se resolvió como **MAGS**, ticker estadounidense confirmado por [Roundhill](https://www.roundhillinvestments.com/etf/mags/). **USD** corresponde a [ProShares Ultra Semiconductors](https://www.proshares.com/our-etfs/leveraged-and-inverse/usd), con objetivo diario de +2x en semiconductores; no representa una cotización de divisas. GLD y SLV son trusts de metales preciosos agrupados como ETF para el escáner; el campo `legalStructure=commodity_trust` conserva esa distinción.

`dailyLeverage` usa un multiplicador con signo: `3` para +3x, `2` para +2x y `-3` para -3x. `inverse` indica la exposición inversa y `resetPeriod="daily"` el objetivo de un solo día. Los 40 productos convencionales tienen `dailyLeverage=1`, `inverse=false` y `resetPeriod=null`. Este multiplicador no describe la rentabilidad acumulada de varios días. Fuentes de objetivos: [ProShares](https://www.proshares.com/our-etfs/find-leveraged-and-inverse-etfs), [Direxion semiconductores](https://www.direxion.com/product/daily-semiconductor-bull-bear-3x-etfs), [Direxion biotecnología](https://www.direxion.com/product/daily-sp-biotech-bull-bear-3x-etfs).

Los ETF se validan y deduplican por ticker, nunca por el CIK ni el nombre de su emisor: distintos fondos pueden pertenecer al mismo trust o gestora. Las 200 empresas conservan la deduplicación por CIK.

Corrección de bolsa comprobada el **16 de octubre de 2026**: ARKK cotiza en Cboe BZX, según [ARK](https://helpcenter.ark-funds.com/how-do-i-invest-from-abroad). Su metadato es `CBOEBZX` y Google Finance usa `BATS:ARKK`. `exchangeCorrections` registra esta revisión por separado de la selección del 15/10; no cambia los 250 instrumentos ni sus posiciones. Para una base existente, aplicar únicamente `supabase/arkk_exchange_correction.sql`, que actualiza ese metadato sin tocar precios ni permisos.

## Actualizar o verificar

Desde la carpeta `market-scanner-main`, con Node.js 20 o posterior:

```powershell
# Regenera los archivos exactamente desde las capturas guardadas, sin red.
node tools/update-universe.mjs --from-snapshots

# Verifica que JSON/CSV coincidan con las capturas, sin modificar archivos.
node tools/update-universe.mjs --check

# Descarga cuatro fuentes públicas y sustituye el universo solo si es válido.
node tools/update-universe.mjs --refresh
```

La descarga consulta tres listados de Nasdaq y una tabla de SEC, sin pedir cada ticker por separado. Si SEC requiere un agente identificable, puede configurarse `SEC_USER_AGENT` con el nombre de la aplicación y un contacto real. Un error HTTP o una tabla incompleta interrumpe la actualización. La validación exige 200 empresas con ticker y CIK distintos, capitalizaciones positivas, orden descendente y la misma fecha en las tres bolsas; también impide que un ticker sin identidad SEC por encima del corte se omita silenciosamente. Después agrega los 50 ETF guardados, valida sus metadatos, los ejemplos pedidos y 250 tickers únicos entre ambos tipos.

`node tools/build-universe.mjs` genera `apps-script/Universe.gs` con los 250 instrumentos y sus tipos/metadatos de ETF. Al cambiar `etfs.json`, ejecutar primero `update-universe.mjs --from-snapshots` y luego `build-universe.mjs`.

Cambiar el universo exige volver a generar el libro y actualizar su hoja `Precios`. No se borran automáticamente precios históricos de empresas que salgan de la selección. Las nuevas empresas e IPO pueden tener menos de 500 sesiones; nunca deben inventarse barras para completar ese número.

Fuentes oficiales: [Nasdaq Stock Screener](https://www.nasdaq.com/market-activity/stocks/screener), [Nasdaq API](https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&exchange=nasdaq), [tabla de tickers y CIK de SEC](https://www.sec.gov/files/company_tickers_exchange.json).
