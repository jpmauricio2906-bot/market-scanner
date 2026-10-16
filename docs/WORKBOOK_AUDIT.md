# Auditoría del libro original

Se revisó la copia Excel `original version/MarketScanner_NASDAQ100.xlsx` sin modificarla. El archivo contiene seis hojas: una hoja vacía, una hoja de depuración, dos hojas de precios, el historial y una hoja de configuración.

`Precios` contiene 100 filas de valores guardados. `Precios_extended` tiene 101 filas y 1.111 fórmulas exportadas de Google Sheets mediante `__xludf.DUMMYFUNCTION`; sus valores en Excel son resultados en caché. `_TEMP_DEBUG` conserva 48 fórmulas y una descarga de ejemplo. Ninguna de estas hojas se reproduce en el nuevo libro salvo la función operativa de `Precios`.

`Historial` contiene 44.212 filas con datos y aproximadamente 21.000 filas vacías con formato. Su esquema original de siete columnas se conserva: Fecha, Ticker, Open, High, Low, Close, Volumen.

## Historial original que supera controles

La auditoría identifica **16.630 barras diarias** utilizables de **38 empresas**, desde el **14 de enero de 2025** hasta el **14 de octubre de 2026**. Las 162 empresas restantes no tienen datos en el archivo original. Las empresas con datos utilizables tienen entre 433 y 440 sesiones; ninguna alcanza las 500 solicitadas en el archivo original.

Cada fila conservada tiene una fecha válida de sesión bursátil estadounidense, cuatro precios numéricos positivos, rango OHLC coherente, volumen entero no negativo y una clave única Fecha + Ticker. Se utiliza el calendario compartido del nuevo Apps Script, incluidos feriados y cierres extraordinarios contemplados por ese calendario. No se encontraron claves duplicadas ni conflictos entre claves repetidas.

Las exclusiones se aplicaron en este orden y son mutuamente excluyentes:

| Motivo | Filas excluidas |
|---|---:|
| Ticker fuera del universo nuevo de 200 empresas | 27.394 |
| Fecha que no corresponde a una sesión bursátil estadounidense | 75 |
| Rango OHLC incoherente | 75 |
| Sesión actual sin evidencia de cierre final en la copia original | 38 |
| **Total excluido** | **27.582** |

Algunas discrepancias OHLC son diferencias pequeñas entre valores redondeados y valores binarios de otro origen. No se corrigieron ni se redondearon precios para hacerlos pasar: el backfill de Yahoo debe reemplazarlos con barras del mismo proveedor. Las filas de la sesión del 15 de octubre de 2026 se excluyeron de esta migración conservadora; una descarga nueva podrá incorporarlas cuando el script confirme el cierre.

El historial original sigue siendo **heredado**, procedente de la mezcla original de GOOGLEFINANCE y snapshots. Superar los controles estructurales no verifica sus precios contra Yahoo. La descarga nueva descrita a continuación reemplaza todos los datos heredados en el libro final. La copia original se conserva como respaldo.

## Libro inicial de 200 empresas

El nuevo libro tiene dos hojas de trabajo: `Precios` y `Historial`. Incluye las 200 empresas del universo del 14 de octubre de 2026 y **99.076 barras descargadas de Yahoo Finance** el 15 de octubre de 2026. No usa precios heredados. La descarga declara `retrievedAt=2026-10-15T22:31:06.633Z`.

197 empresas tienen 500 sesiones. SPCX tiene 87, SKHY 69 y SNDK 420; el descargador comprueba que sus historiales cortos corresponden a las primeras sesiones publicadas por Yahoo. No se completan con datos ficticios.

190 empresas disponen del cierre del 15 de octubre de 2026 y aparecen con estado `FINAL`. Yahoo no devolvió el cierre esperado para diez valores: XOM, SHEL, TTE, ACN, VLO, EQNR, LOW, SO, IBN y PNC. Se guardan sus últimas 500 sesiones hasta el 14 de octubre de 2026, se mantiene esa fecha real y se muestra estado `ATRASADO`. Las actualizaciones posteriores deben volver a consultar estos valores; no se reutiliza el cierre anterior como si fuera el actual.

`Precios` muestra la última barra disponible por empresa, el cierre anterior y la hora real de la consulta. Las fórmulas de cambio absoluto y porcentual son locales y compatibles con Excel y Google Sheets. El recuento de sesiones lo mantiene el script al guardar cada empresa, evitando 200 búsquedas repetidas sobre 100.000 filas. La captura inicial utiliza los recuentos de las barras validadas.

Las fórmulas no realizan consultas remotas por celda. El Apps Script centraliza las descargas, escribe los datos, valida barras, respeta lotes y sube a Supabase. El timer y las credenciales se configuran en Google Sheets siguiendo las instrucciones del proyecto.

La copia original se mantiene como respaldo. El informe de auditoría detallado y la cobertura por ticker se generan en el directorio local de salida; no contienen credenciales.

## Ampliación a 250 instrumentos

La ampliación conserva las dos hojas `Precios` e `Historial` y las 200 empresas anteriores. Añade 50 ETF y 25.000 barras diarias de Yahoo Finance, con 500 sesiones reales para cada ETF. El historial combinado contiene **124.076 barras únicas**. Las 99.076 barras de acciones anteriores se comparan por clave y por valor contra la captura inicial y se conservan exactamente.

247 instrumentos tienen 500 sesiones. Las tres historias cortas y los diez cierres atrasados de acciones descritos arriba permanecen identificados. Los 50 ETF tienen cierre del 15 de octubre de 2026 y estado `FINAL`; el conjunto contiene 240 estados `FINAL` y diez `ATRASADO`.

Las consultas de acciones conservan `retrievedAt=2026-10-15T22:31:06.633Z`. La captura de ETF terminó a `2026-10-15T23:10:08.241Z`; cada fila conserva la hora individual de su diagnóstico. La hora mostrada corresponde a la consulta original; añadir ETF no presenta las acciones como si se hubieran descargado de nuevo.

`Precios` conserva A:P y agrega Q:U: Tipo, Categoria, Emisor, Apalancamiento diario e Inverso. Los factores negativos identifican exposición inversa; el múltiplo es el objetivo diario del ETF. Las notas y las fuentes oficiales de los emisores están en W:X. MAGS representa el ETF de las siete grandes tecnológicas solicitado como “mag7”.

J:K contienen 500 fórmulas de cambio, dos por instrumento. N contiene el recuento que mantiene el Apps Script. `Historial` conserva las siete columnas originales y la clave Fecha + Ticker. El verificador del archivo guardado contrastó todas las barras, los metadatos, las fechas de consulta y los resultados de las fórmulas con el JSON de Yahoo y el universo CSV/JSON. Se conservaron los paneles inmovilizados y los formatos condicionales; no hay errores de fórmulas. Las vistas de ambas hojas fueron revisadas, incluidos los ETF apalancados e inversos.

El paso de las fechas nativas por el formato numérico de Excel produjo un redondeo máximo de un milisegundo en las horas de consulta; los segundos mostrados no cambian. El informe registra ese máximo con una tolerancia de dos milisegundos. Los precios, volúmenes y fechas de sesión conservan sus valores de origen.

La exportación local no activa el timer, publica en GitHub ni cambia Supabase. El libro inicial de 200 empresas sigue disponible como respaldo.
