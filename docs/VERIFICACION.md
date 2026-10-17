# Verificación de v3.2: identidad, hora y antigüedad de cotizaciones

Verificación previa a publicación: **86 pruebas JavaScript aprobadas y 123 comprobaciones SQL acumuladas**. Las SQL incluyen 12 regresiones nuevas y las 111 aprobadas anteriormente el 16/10/2026. En esta revisión se repitieron 52 comprobaciones: las 12 nuevas y dos grupos de 26 y 14. Las otras 71 conservan la evidencia aprobada del 16/10 a las 18:24 UTC; su nuevo intento quedó pendiente por la conexión de la herramienta, sin un fallo SQL reportado. La comprobación del cliente en producción se realiza después de publicar. La cobertura y el recálculo real de las 250 fórmulas requieren la cuenta del propietario.

## Apps Script local

Las 38 pruebas verifican la instalación de fórmulas con bolsa y símbolo explícitos, migración de 21 a 24 columnas y conservación de `Historial`. Dos regresiones cubren la plantilla real con instrucciones en W:X: se preservan en Z:AA, una segunda preparación no vuelve a moverlas y una lista incompatible se rechaza antes de insertar columnas. C:I y V contienen datos del proveedor; J:K calculan cambios; L:M corresponden al envío rápido; N y W:X conservan la información del historial.

Cinco regresiones adicionales verifican la fórmula auxiliar de hora de SOXS: solo ese símbolo interpreta el reloj UTC del proveedor, usando la zona horaria del archivo y contemplando verano, invierno y cambios de horario de Nueva York. Las horas ausentes siguen ausentes, las realmente futuras no se recortan y la columna auxiliar se añade o reutiliza sin desplazar notas ni duplicarse. Los demás símbolos conservan su `tradetime` nativo. La identidad Google de ARKK pasa a `BATS:ARKK`, correspondiente a Cboe BZX. El procedimiento está en [COTIZACIONES_INTRADIA.md](COTIZACIONES_INTRADIA.md).

El envío rápido lee las 250 filas en un rango y realiza una sola RPC `market_ingest_sheet_quotes`. Sus pruebas comprueban que funciona con un bloqueo independiente de Yahoo, conserva datos ausentes para el validador, interpreta respuestas por ticker y no espera al recálculo en un bucle.

El trabajo Yahoo mantiene grupos de cinco, hasta 20 tickers por ejecución y continuaciones reanudables. Se comprueba que no sobrescribe las fórmulas ni L:M y que `comprobarConexion` prueba ambas RPC con lotes vacíos.

Estas pruebas usan dobles de servicios; no demuestran que Google Finance cubra todos los atributos de los 250 símbolos ni que un activador del propietario se haya ejecutado.

Las otras pruebas JavaScript son 33 de frontend y 15 de worker, para un total de 86 y cero fallos. Cubren la vela provisional en gráficos e indicadores, modo solo cierres, caché de 60 minutos, refresco de cotizaciones, estado `OUTDATED`, retraso Yahoo desconocido, calendario de cierres reducidos y los controles del worker.

Siete regresiones del frontend verifican la antigüedad al cerrar la sesión: un cierre regular o reducido conserva su vigencia al compararlo con la hora de cierre de Nueva York, en verano e invierno. Durante la sesión se mantienen las tolerancias existentes de Google y Yahoo; una captura de mediodía envejecida sigue marcada, las horas futuras se rechazan y una vela provisional no se reutiliza al cambiar el día. Los cierres confirmados no generan una alerta de antigüedad por el paso de las horas. Un instrumento sin el cierre esperado sigue indicando retraso de cobertura.

Dos regresiones adicionales verifican la coherencia de escala tras una reparación: una cotización cuyo cierre previo canónico ya no coincide con el historial en memoria provoca una sola recarga y elimina las referencias de caché anteriores. Si la discrepancia persiste, la vela provisional queda bloqueada sin un bucle de recargas; el modo solo cierres no vuelve a consultar por esa discrepancia.

## SQL: 12 regresiones nuevas y 111 comprobaciones de base

[arkk_exchange_correction.sql](../supabase/arkk_exchange_correction.sql) se aplicó únicamente a los metadatos de bolsa de ARKK. No modifica precios, historial, funciones de calidad, permisos ni RLS. Las 12 comprobaciones de [quote_source_corrections.sql](../supabase/tests/quote_source_corrections.sql) aprobaron en una transacción revertida: identidad `BATS:ARKK` aceptada y antigua `NYSEARCA:ARKK` rechazada, hora UTC válida de SOXS en verano/invierno, rechazo de horas futuras y OHLC inválido, permisos preservados y hashes intactos del historial, capturas Yahoo privadas y cotizaciones públicas.

[live_quotes.sql](../supabase/live_quotes.sql) está aplicado y añade la recepción de capturas Google y la proyección pública de cotizaciones aprobadas. Sus 111 comprobaciones de base aprobaron el 16/10/2026 en seis grupos con transacciones `BEGIN`/`ROLLBACK`: 49 de cotizaciones y 62 históricas. En esta revisión volvieron a aprobar los dos primeros grupos de cotizaciones, para 40 comprobaciones de base repetidas:

| Grupo v3 | Comprobaciones |
| --- | ---: |
| [Seguridad y calidad](../supabase/tests/live_quotes_01_security_quality.sql) | 26 |
| [Ingesta y orden de capturas](../supabase/tests/live_quotes_02_ingestion_out_of_order.sql) | 14 |
| [Reparación sin regresión](../supabase/tests/live_quotes_03_repair_no_regression.sql) | 9 |

Se comprobaron:

- Google siempre provisional, sin modificar el historial de cierres.
- Valores ausentes, OHLCV incoherente, símbolos y horas incorrectas, antigüedad y retraso declarado; conservación del último dato aprobado ante un rechazo.
- Prevención de regresiones por capturas antiguas y por reconstrucciones históricas; prioridad de una barra final sobre una provisional de igual fecha.
- Reparación por escala o split incompatible y ocultación de la cotización pendiente.
- Lectura pública de la proyección aprobada y denegación de RPC privadas y controles a roles públicos.

Las pruebas del frontend verificaron los 250 instrumentos, mezcla de 500 cierres más una vela provisional de hoy, cálculos y gráficos con esa vela, modo solo cierres y etiquetas de fuente, hora y antigüedad. La confirmación respeta los cierres reducidos y el horario normal.

Se comprobó mediante las pruebas del cliente que el refresco con historial vigente consulta únicamente la proyección de cotizaciones y que cambiar el modo intradiario utiliza los datos cargados. La inspección del navegador en producción se realiza después de publicar, sin presentar fixtures como cotizaciones reales.

## Lecturas reales posteriores a la corrección

La lectura de producción del 17/10/2026 a las 02:14 UTC, todavía 16/10 a las 22:14 en Nueva York, mostró 246 cotizaciones del 16/10, todas Yahoo y `FINAL`. ARKK cerraba en 81,65 USD y SOXS en 49,23 USD; ambas tenían hora de proveedor `20:00:00Z`, equivalente a las 16:00 de Nueva York. Esos cierres confirmados no deben mostrarse como `OUTDATED` por haber pasado varias horas desde el cierre.

DELL, LABU, MAGS y SPY no tenían una cotización aprobada de ese día y conservan el último cierre disponible con el aviso de cobertura retrasada. El historial contenía 124.079 barras finales del universo activo y 149.190 filas totales; los tres Cron y el worker seguían activos. Esta lectura no demuestra todavía una captura Google Finance corregida de producción ni cobertura completa de las 250 fórmulas; el propietario debe volver a preparar y comprobar su hoja.

## Evidencia del backend histórico anterior

La versión anterior del historial pasó 47 pruebas JavaScript. Sus 62 comprobaciones SQL se volvieron a ejecutar con v3 y forman parte de las 111 aprobadas, en estos tres grupos:

| Prueba histórica SQL | Comprobaciones |
| --- | ---: |
| [Permisos, calendario y parseo](../supabase/tests/server_owned_history_01_permissions_calendar_parse.sql) | 31 |
| [Ingesta reciente, caché y splits](../supabase/tests/server_owned_history_02_recent_ingest_cache_splits.sql) | 16 |
| [Reparación completa y leases](../supabase/tests/server_owned_history_03_full_repair_leases.sql) | 15 |

Se verificaron reparaciones reales AAPL y SOXS con 500 cierres, y SPCX con 87 sesiones de IPO, sin fallos. Se conservaron las filas y el volumen; las diferencias de precio frente al respaldo fueron de precisión numérica, como máximo `5e-13`. El historial activo quedó con 124.076 barras confirmadas de 250 instrumentos. Las 25.111 filas heredadas de otros 57 tickers se conservaron con `is_final=false`, para 149.187 filas totales y respaldadas.

También se comprobaron tokens de worker ausentes e incorrectos con respuesta 401, RPC privadas inaccesibles a roles públicos, una lectura REST pública HTTP 200 de cierres AAPL y una ejecución natural correcta del despachador Cron el 16/10/2026 a las 13:29 UTC. El calendario contiene 1.255 sesiones de 2024–2028. Las tres programaciones del backend histórico siguen siendo independientes de los timers de Google.

El esquema base está en [server_owned_history.sql](../supabase/server_owned_history.sql), el worker en [su directorio](../supabase/functions/market-history-worker/README.md) y los horarios en [activate_schedules.sql](../supabase/activate_schedules.sql). Los informes técnicos anteriores son evidencia histórica de esa versión, no una certificación del envío rápido ni de la interfaz v3.

## Reproducir y completar la instalación

Con Node.js 22 o posterior:

```powershell
node --test tests/*.test.cjs
node tools/update-universe.mjs --check
node tools/build-universe.mjs
node tools/build-server-schema.mjs
node tools/probe-yahoo.mjs AAPL BRK-B TSM
```

La sonda Yahoo solo consulta datos recientes; no escribe Supabase ni certifica la calidad por su cuenta. Las pruebas SQL deben conservar sus transacciones revertidas y utilizar fixtures explícitas. El generador del esquema usa fuentes versionadas, incluido `data/instrument-history-starts.json`.

Para Google, seguir [INSTALACION.md](INSTALACION.md): detener timers anteriores, reemplazar `.gs` y manifiesto, preparar las fórmulas sin reimportar, esperar el primer cálculo, comprobar ambas RPC, ejecutar un envío rápido y después instalar los timers. Conservar las propiedades privadas existentes. Revisar cobertura de los 250 tickers, hora del proveedor, estado del envío y ejecuciones de cinco minutos/horarias.

La comprobación del servidor y del navegador no demuestra que esos pasos ya se hayan completado en la cuenta de Google.
