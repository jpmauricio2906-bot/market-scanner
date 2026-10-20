# Auditoría de la fuente histórica larga

Captura independiente del **20 de octubre de 2026, 21:11:44–21:11:55 UTC**. Esta auditoría verifica disponibilidad y calidad de la fuente; no calcula resultados de estrategias ni acredita por sí sola la carga en producción.

La solicitud abarca desde **2015-10-20 hasta 2026-10-20, fecha final excluida**: diez años de análisis y aproximadamente un año adicional para preparar los indicadores. El último cierre solicitado es **2026-10-19**. El proceso de producción determina su último cierre confirmado por separado y puede tener una sesión posterior.

| Comprobación | Resultado de esta captura |
| --- | ---: |
| Instrumentos solicitados | 250 |
| Respuestas de fuente válidas | 250 |
| Sesiones del calendario en el intervalo completo | 2.765 |
| Barras normalizadas, incluyendo el segmento incompleto de SHEL | 660.392 |
| Instrumentos con continuidad y calidad completas desde su cotización | 249 |
| Barras de esos 249 instrumentos completos | 657.629 |
| Instrumentos bloqueados | 1: SHEL |
| Instrumentos cuyo primer día de cotización es posterior a 2016-10-20 | 23 |

Una respuesta HTTP correcta no equivale a un historial utilizable. La auditoría exige identidad, moneda, valores OHLCV válidos, ausencia de duplicados, fechas bursátiles y continuidad desde el máximo entre la fecha solicitada y el inicio de cotización informado por el proveedor. No inventa precios anteriores a una salida a bolsa ni rellena huecos.

| Ejemplo | Primera fecha disponible | Última fecha | Barras | Cobertura |
| --- | --- | --- | ---: | --- |
| AAPL | 2015-10-20 | 2026-10-19 | 2.765 | Completa |
| VLO | 2015-10-20 | 2026-10-19 | 2.765 | Completa |
| DELL | 2016-08-17 | 2026-10-19 | 2.557 | Completa desde su cotización |
| MAGS | 2023-04-11 | 2026-10-19 | 885 | Completa desde su cotización |
| SHEL | 2015-10-20 | 2026-10-19 | 2.763 normalizadas | Bloqueada: dos sesiones incoherentes |

## Incidencia de SHEL

Yahoo entrega dos aperturas inferiores al mínimo de la misma sesión, con diferencias materiales:

| Fecha | Apertura | Mínimo | Máximo | Cierre |
| --- | ---: | ---: | ---: | ---: |
| 2021-05-05 | 39,0600 | 39,4450 | 39,8399 | 39,7800 |
| 2023-01-24 | 51,2600 | 56,2600 | 58,4000 | 57,9900 |

Una segunda consulta al host `query2.finance.yahoo.com`, realizada a las **21:12:37 UTC**, devolvió los mismos errores. No son diferencias de redondeo. El normalizador conserva la incidencia y omite esas barras en los archivos locales; la auditoría bloquea el instrumento completo. El cargador de producción debe rechazar la publicación de este historial y conservar cualquier versión previamente aceptada. No se han sustituido ni corregido manualmente esos precios.

## Precios, ajustes y límites

El archivo `price-only.json` conserva el OHLC del proveedor sin multiplicarlo por `adjclose/close`. Esta base mantiene la metodología de precios del scanner y excluye el rendimiento de los dividendos en efectivo. El archivo compañero `history.json` aplica la razón de cierre ajustado a todo el OHLC; se conserva por separado y no se mezcla con la base de producción. Yahoo documenta que el cierre ajustado incorpora distribuciones y splits: [explicación del proveedor](https://es-us.ayuda.yahoo.com/kb/finance-app-for-ios/%C2%BFQu%C3%A9-es-el-cierre-ajustado-sln28256.html).

Los datos son revisiones disponibles en la fecha de descarga, no una reconstrucción de lo conocido en cada fecha histórica. El universo es el actual: no incluye todas las empresas que dejaron de cotizar ni la composición histórica de los índices. La cobertura más larga no elimina esos sesgos y no constituye una validación fuera de muestra nueva.

El calendario [backtest-calendar.json](../data/backtest-calendar.json) incluye los cierres extraordinarios de duelo de 2018-12-05 y 2025-01-09, Juneteenth desde 2022 y sesiones con cierre anticipado. Estas últimas cuentan como sesiones completas para barras diarias. Las fuentes primarias de NYSE/ICE y la procedencia de cada tramo están dentro del archivo. Los calendarios de experimentos congelados y el calendario corto del scanner permanecen independientes.

## Reproducción y evidencia

Desde la raíz del proyecto:

```powershell
node tools/build-backtest-calendar.mjs --check
node tools/preflight-long-history.mjs --start 2015-10-20 --end-exclusive 2026-10-20 --output ../outputs/long-history --concurrency 4
node tools/preflight-long-history.mjs --audit-only --output ../outputs/long-history
node --test tests/long-history-source.test.mjs
```

La descarga rechaza reutilizar un directorio que ya contiene una captura. Para repetirla se debe elegir otro directorio; `--audit-only` verifica la evidencia existente. El proceso devuelve código 1 cuando encuentra calidad bloqueada, incluso si todas las solicitudes HTTP funcionaron. Cinco pruebas verifican calendarios, huecos, errores OHLCV, duplicados e inicios de cotización.

Los archivos originales y normalizados quedan en el directorio local ignorado `outputs/long-history`, fuera de GitHub. `availability.json` identifica cada consulta y su SHA-256; `coverage-audit.json` registra cobertura, errores, hashes del código y calendario. La consulta alternativa de SHEL se conserva en `query2-SHEL.json` y `query2-SHEL-audit.json`.

| Artefacto de esta captura | SHA-256 |
| --- | --- |
| `price-only.json` | `759f2b438aea0002875fc65b8f1e1a9c68f6a7238af59fe5e7fbe524a4481e49` |
| `history.json` | `2aff64991710da11392b3ab3366f20c230bed057d4a1720484c4921b9516443e` |
| Calendario | `b33f2cbdfe1e5af1dc7d7ab7b5c50e7159320e8e0aa4ef57299885e305a1d7e2` |

La base local de precios ocupa 112,4 MB y los originales 71,7 MB. Son evidencia de auditoría; la aplicación debe consultar solamente los instrumentos y fechas necesarios.
