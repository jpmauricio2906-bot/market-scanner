# Verificación de v3: cotizaciones y vela del día

Verificación previa a publicación: backend v3 desplegado, **74 pruebas JavaScript y 111 comprobaciones SQL aprobadas**. La comprobación del navegador en producción se realiza después de publicar. La cobertura y el recálculo real de las 250 fórmulas requieren la cuenta del propietario. No se declara activada esa instalación de Google.

## Apps Script local

Las 33 pruebas verifican la instalación de fórmulas con bolsa y símbolo explícitos, migración de 21 a 24 columnas y conservación de `Historial`. Dos regresiones cubren la plantilla real con instrucciones en W:X: se preservan en Z:AA, una segunda preparación no vuelve a moverlas y una lista incompatible se rechaza antes de insertar columnas. C:I y V contienen datos del proveedor; J:K calculan cambios; L:M corresponden al envío rápido; N y W:X conservan la información del historial.

El envío rápido lee las 250 filas en un rango y realiza una sola RPC `market_ingest_sheet_quotes`. Sus pruebas comprueban que funciona con un bloqueo independiente de Yahoo, conserva datos ausentes para el validador, interpreta respuestas por ticker y no espera al recálculo en un bucle.

El trabajo Yahoo mantiene grupos de cinco, hasta 20 tickers por ejecución y continuaciones reanudables. Se comprueba que no sobrescribe las fórmulas ni L:M y que `comprobarConexion` prueba ambas RPC con lotes vacíos.

Estas pruebas usan dobles de servicios; no demuestran que Google Finance cubra todos los atributos de los 250 símbolos ni que un activador del propietario se haya ejecutado.

Las otras pruebas JavaScript son 26 de frontend y 15 de worker, para un total de 74 y cero fallos. Cubren la vela provisional en gráficos e indicadores, modo solo cierres, caché de 60 minutos, refresco de cotizaciones, estado `OUTDATED`, retraso Yahoo desconocido, calendario de cierres reducidos y los controles del worker.

Dos regresiones adicionales verifican la coherencia de escala tras una reparación: una cotización cuyo cierre previo canónico ya no coincide con el historial en memoria provoca una sola recarga y elimina las referencias de caché anteriores. Si la discrepancia persiste, la vela provisional queda bloqueada sin un bucle de recargas; el modo solo cierres no vuelve a consultar por esa discrepancia.

## SQL v3: 111 comprobaciones aprobadas

[live_quotes.sql](../supabase/live_quotes.sql) está aplicado y añade la recepción de capturas Google y la proyección pública de cotizaciones aprobadas. Se aprobaron los seis grupos en transacciones `BEGIN`/`ROLLBACK`, con 49 comprobaciones nuevas y 62 históricas:

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

## Lecturas reales de v3

La lectura REST con clave pública devolvió HTTP 200 y 244 cotizaciones aprobadas del 16/10/2026, todas de Yahoo y provisionales. La última captura de esa comprobación fue `16:41:51Z`; por ejemplo AAPL tenía hora de proveedor `16:29:46Z`, QQQ `16:39:50Z` y SOXS `16:41:49Z`. A las 14:24 de Nueva York esas capturas estaban envejecidas, por lo que la interfaz debe mostrarlas como `OUTDATED` con sus horas originales.

Esta evidencia no demuestra todavía una captura Google Finance de producción ni cobertura completa de las 250 fórmulas. Los instrumentos sin cotización aprobada conservan sus cierres confirmados. El historial mantuvo 124.076 barras finales del universo activo y 149.187 filas totales; los tres Cron y el worker siguen activos. Los asesores no reportaron WARN/ERROR, solo informativos de tablas privadas y de un índice nuevo aún sin uso.

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
