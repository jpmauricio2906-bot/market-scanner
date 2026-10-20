# Historial y validación en Supabase

Estado de v3: backend desplegado, 86 pruebas JavaScript aprobadas y 140 comprobaciones SQL acumuladas. La recuperación del 16/10 se comprobó con 43 SQL ejecutadas en esta revisión y con 250 cierres confirmados en el cliente publicado. La validación de las capturas Google se observa en Supabase; la inspección directa de las celdas y los activadores requiere acceso a la cuenta propietaria. Alcance y fechas en [VERIFICACION.md](VERIFICACION.md).

## Responsabilidades y datos

| Componente | Responsabilidad |
| --- | --- |
| Fórmulas de `Precios` | Obtener cotizaciones actuales de Google Finance para 250 instrumentos |
| Envío rápido de Apps Script | Leer las 250 filas y enviarlas juntas por una RPC |
| Yahoo en segundo plano | Aportar barras recientes para cierres y continuidad |
| RPC de ingesta | Validar por separado Google Finance y Yahoo, y devolver el estado de cada ticker |
| Almacenamiento privado | Provisionales, control de calidad, auditorías y cola de reparaciones |
| `public.market_history` | Hasta 500 barras diarias confirmadas por activo para el scanner y las fichas |
| `public.backtest_history` | Archivo independiente de once años para Backtesting, descargado por activos seleccionados |
| `public.backtest_history_coverage` | Cobertura, versión y estado del archivo largo por ticker |
| `public.market_latest_quotes` | Proyección pequeña y pública de cotizaciones aprobadas, con fuente, hora y condición provisional/final |
| Worker privado | Descargar historia de los tickers reclamados y solicitar su sustitución validada |
| Cron | Auditorías, retención e invocación del worker |

El universo mantiene 200 empresas y 50 ETF. El frontend conserva la selección en `data/universe.json` y la clave pública de lectura. Los cierres siguen filtrados con `is_final=true`; v3 añade una lectura de las cotizaciones aprobadas. El navegador no necesita acceso a RPC de escritura, payloads ni cola.

El archivo de Backtesting tiene su propia cola y worker. Su ampliación no cambia la retención, la descarga ni el cálculo del scanner. [Alcance, calidad y mantenimiento del histórico largo](HISTORICO_LARGO.md).

## Fórmulas y captura rápida de Google

`prepararMarketScanner` instala fórmulas actuales `GOOGLEFINANCE` en C:I y V, conserva J:K y amplía `Precios` de 21 a 24 columnas sin importar otro Excel. C contiene `tradetime`; L:M registran el envío rápido; N conserva la cobertura histórica; W:X registran el trabajo de Yahoo. No accede a la pestaña `Historial`.

`actualizarCotizacionesAhora` lee las 250 filas en un rango y realiza un único POST a `market_ingest_sheet_quotes(p_batch)`. Usa un bloqueo de documento independiente del bloqueo del trabajo Yahoo, por lo que no espera su cursor. La preparación y el envío no esperan en un bucle al recálculo de Google.

Supabase comprueba ticker y símbolo de bolsa, fecha de sesión, captura y hora del proveedor, precios, volumen y coherencia OHLC. La captura debe ser reciente; el retraso declarado admitido está entre cero y 20 minutos. Durante la sesión, la edad permitida de la cotización no supera el menor de 30 minutos y el retraso declarado más diez minutos. Fuera de sesión solo se acepta información de la última sesión aplicable. No se convierte un dato ausente en cero.

Una captura incompleta devuelve un resultado pendiente y conserva la última cotización aprobada. Una discrepancia de cierre anterior que sugiera escala o split encola una reparación y evita mezclar esa cotización con un historial incompatible. Google Finance siempre entra como `PROVISIONAL` e `is_final=false`: esta RPC no escribe cierres en `market_history`.

## Proyección pública y análisis del día

`market_latest_quotes` expone únicamente estos campos aprobados:

| Campos | Significado |
| --- | --- |
| `ticker`, `fecha` | Instrumento y fecha de sesión |
| `open`, `high`, `low`, `close`, `volumen` | Vela diaria disponible en la captura |
| `is_final`, `status` | Condición confirmada o provisional y estado |
| `source`, `source_quote_at`, `fetched_at` | Fuente, hora de cotización y hora de captura |
| `previous_close`, `datadelay_minutes` | Cierre anterior y retraso declarado; Yahoo puede devolver retraso desconocido (`null`), que no se presenta como cero |

La proyección admite la cotización aprobada más reciente de Google Finance o Yahoo; solo Yahoo puede aportar la condición final. Sus guardas evitan que una captura antigua o una reparación histórica hagan retroceder la fecha/hora publicada. Una vela confirmada de `market_history` conserva prioridad sobre una provisional de la misma fecha.

La vista intradiaria está activada por defecto. Añade hasta una vela de hoy a los 500 cierres, y esa vela participa en gráficos e indicadores mientras se identifica como provisional. No se escribe esa combinación en el historial. Desactivar la opción muestra solo cierres confirmados.

La web muestra `PROVISIONAL`, `CONFIRMED` o `OUTDATED`, además de fuente y hora. El precio puede cambiar durante la sesión. La última cotización aprobada de hoy puede permanecer en el análisis cuando envejece, identificada con `OUTDATED` y su hora original. Los 500 cierres se reutilizan en memoria hasta 60 minutos o hasta un cambio de sesión esperada; `Refresh` consulta la proyección de cotizaciones cuando esa caché sigue vigente. Cambiar la opción intradiaria utiliza los datos cargados, sin otra descarga.

La confirmación respeta el calendario y los cierres reducidos: después de un cierre a las 13 ET el margen de una hora termina a las 14 ET; en una sesión normal termina a las 17 ET. La hora del refresco web no confirma una barra ni ejecuta el emisor Google.

## Yahoo reciente y cierres

Google solicita `range=5d&interval=1d` a Yahoo y envía metadatos, timestamps y valores OHLCV originales, en grupos de hasta cinco, mediante `market_ingest_recent(p_batch)`. Solo adapta el formato de transporte; no descarta valores nulos ni decide su calidad. El servidor reconoce cada ticker frente a su universo y verifica la identidad de Yahoo, moneda y zona horaria.

La validación exige fechas de sesiones reales, valores numéricos finitos, precios positivos, volumen entero no negativo y relaciones OHLC coherentes. No se convierte un dato ausente en cero. El reloj y calendario del servidor determinan la vigencia y cuándo puede confirmarse una barra; la fecha enviada por Google no se toma como prueba de un cierre. El calendario revisado cubre 2024–2028 y debe ampliarse antes de agotar ese horizonte; fuera de él se detiene la confirmación.

Los payloads y el control de calidad permanecen privados. Las cotizaciones aprobadas pueden proyectarse en `market_latest_quotes`; las barras de una sesión abierta siguen siendo provisionales. La RPC devuelve el estado y la cobertura de cada instrumento. Apps Script escribe el resultado de Yahoo en N y W:X, sin sustituir las fórmulas ni L:M.

Las barras confirmadas se guardan por `(fecha,ticker)` de forma idempotente. Un reintento puede corregir o repetir una barra sin crear duplicados. El cliente Google no escribe directamente las tablas históricas.

## Reparaciones de series

El servidor compara las nuevas barras con el historial y audita cobertura, continuidad y correcciones, incluidos splits. Si una serie necesita reconstrucción, crea o actualiza una tarea en la cola; la recepción reciente no obliga a Google a descargar tres años.

El worker `market-history-worker` reclama hasta dos tareas mediante `market_claim_repairs(p_limit)`. Cada reclamación tiene un token de lease y una vigencia de diez minutos para evitar que dos ejecuciones sustituyan la misma tarea a la vez. El objetivo de trabajo del worker es de 90 segundos.

Por ticker, descarga tres años de barras diarias de Yahoo y envía el resultado completo a `market_replace_history(p_job_id,p_lease_token,p_payload)`. El servidor vuelve a validar identidad, calidad, continuidad y último cierre esperado. Una IPO puede tener menos de 500 sesiones solo cuando su primera fecha de cotización justifica esa cobertura.

La sustitución se realiza en una transacción: se conserva la serie anterior hasta que la nueva ha superado todas las comprobaciones y la operación puede confirmarse. Se retienen las últimas 500 sesiones reales de ese ticker. La cola no autoriza a publicar una descarga parcial ni a fabricar días de bolsa.

Los errores de transporte se comunican con `market_fail_repair(p_job_id,p_lease_token,p_reason)`. Un rechazo de calidad de `market_replace_history` registra su resultado en el servidor; el worker no registra además un segundo fallo sobre la misma respuesta. Una tarea fallida o una lease vencida debe quedar visible y seguir la política de reintentos del backend.

Desde la recuperación del 16/10, cinco fallos no bloquean permanentemente un trabajo. Las esperas son 2, 4, 8 y 16 minutos tras los primeros cuatro fallos, y una hora desde el quinto. El worker conserva el límite de dos reclamaciones y las leases vigentes; un dato rechazado sigue sin publicarse. Esta espera permite recuperar correcciones tardías de Yahoo, fuera del horario de los emisores Google. [Caso y operación](RECUPERACION_PROVEEDOR.md).

## Cron y autenticación del worker

Cron ejecuta las auditorías y la retención mediante SQL e invoca el worker por HTTP. Estas tres programaciones están activas:

| Trabajo | Programación |
| --- | --- |
| `market-scanner-repair-worker` | Cada minuto; el worker reclama hasta dos tareas por llamada |
| `market-scanner-daily-audit` | 20:15 de Nueva York, de lunes a viernes, con el calendario de bolsa del servidor |
| `market-scanner-weekly-history` | Sábado a las 02 de Nueva York |

La configuración está versionada en [activate_schedules.sql](../supabase/activate_schedules.sql). Los despachos UTC aplican guardas con la hora de Nueva York para respetar sus cambios de horario. Comprobar sus ejecuciones al reproducir la instalación. [Supabase Cron](https://supabase.com/docs/guides/cron) permite programar SQL y [llamar Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions).

El endpoint del worker utiliza `verify_jwt=false` porque valida su propia credencial de servidor obligatoria: `X-Market-Worker-Token`. La configuración genera un token aleatorio, lo guarda en Vault y conserva su hash privado. Antes de reclamar tareas, el worker comprueba ese token mediante `market_verify_worker_token(p_token)`, usando internamente la credencial privada de plataforma de su entorno. Una cabecera ausente o incorrecta devuelve 401. Un JWT externo por sí solo no autoriza la ejecución.

El token del worker no se entrega a Google ni al navegador. La misma clave privada de Propiedades del script autoriza las dos rutas de ingesta bajo el modelo de permisos del backend. El frontend conserva únicamente una clave pública de lectura de cierres y cotizaciones aprobadas. Las tablas de control y las RPC internas no se conceden a `anon` o `authenticated`.

## Operación y observabilidad

Comprobar por separado:

- Google: envío rápido en L:M, cobertura en N, historial en W:X, cursor Yahoo, continuaciones y errores HTTP; `verEstadoMarketScanner` consulta ese resumen.
- Ingesta: estado y fecha de cada ticker, último cierre esperado y rechazos de calidad.
- Reparación: tareas pendientes, reclamadas, vencidas o fallidas y motivo del último resultado.
- Cron y worker: ejecuciones recientes, respuestas HTTP y tareas completadas.
- Aplicación: 250 instrumentos, fuente/hora del precio, estados provisionales y comparación entre vista intradiaria y solo cierres.

Parar los temporizadores de Google no detiene Cron. Durante mantenimiento, detener cada emisor o trabajo correspondiente. La hoja puede permanecer cerrada durante la operación normal.

## Migración de la instalación anterior

Conservar el historial validado que ya existe en Supabase y respaldar la hoja anterior. Desplegar primero los nuevos objetos y permisos del servidor, luego el worker y su programación, y por último actualizar Google con los `.gs` y el manifiesto nuevos.

La pestaña `Historial` sigue fuera de la ejecución: puede conservarse como copia histórica o exportación. V3 instala fórmulas y amplía las columnas de `Precios`; no exige otro Excel ni una lectura, ordenación o reconstrucción de las filas históricas.

## Verificación v3 y evidencia histórica

La aceptación v3 pasó 70 pruebas JavaScript: 31 Apps Script, 24 frontend y 15 worker. Se aprobaron también 111 comprobaciones SQL: 49 nuevas y las 62 históricas, todas en seis transacciones `BEGIN`/`ROLLBACK` sin dejar fixtures. Las regresiones históricas corresponden a estos grupos:

| Prueba SQL | Comprobaciones |
| --- | ---: |
| [Permisos, calendario y parseo](../supabase/tests/server_owned_history_01_permissions_calendar_parse.sql) | 31 |
| [Ingesta reciente, caché y splits](../supabase/tests/server_owned_history_02_recent_ingest_cache_splits.sql) | 16 |
| [Reparación completa y leases](../supabase/tests/server_owned_history_03_full_repair_leases.sql) | 15 |

Se verificaron reparaciones reales de AAPL, SOXS (500 cierres) y SPCX (87 sesiones de IPO) mediante el worker, respuestas 401 ante token ausente o incorrecto y la denegación de las RPC privadas a `anon` y `authenticated`. Las comprobaciones SQL cubren calidad, provisionales privados, reintentos, reemplazo transaccional y leases. La comprobación final dejó la cola vacía y la auditoría sin reparaciones por encolar.

El respaldo privado conserva 149.187 filas. La tabla mantiene 124.076 barras confirmadas del universo activo de 250 instrumentos y conserva las 25.111 filas heredadas de otros 57 tickers con `is_final=false`. Las reparaciones de AAPL conservaron número de filas y volumen; las diferencias de precios frente al respaldo fueron de precisión numérica, como máximo `5e-13`. El calendario contiene 1.255 sesiones entre 2024 y 2028.

V3 aplica [live_quotes.sql](../supabase/live_quotes.sql). Sus tres grupos de pruebas cubren seguridad/calidad (26 comprobaciones), ingesta y orden de capturas (14) y reparación sin regresión (9). La lectura REST pública devolvió 244 cotizaciones Yahoo aprobadas del 16/10/2026, todas provisionales; las capturas estaban envejecidas y deben identificarse como `OUTDATED`. El historial conserva 124.076 cierres del universo y 149.187 filas totales.

Las tablas privadas usan RLS sin políticas públicas de forma intencional. Los asesores no reportaron avisos WARN/ERROR; permanecen informativos de esas tablas e índices nuevos. [VERIFICACION.md](VERIFICACION.md) distingue estas comprobaciones de la inspección de producción posterior y de la cobertura real de las 250 fórmulas, que requiere la cuenta de Google del propietario.
