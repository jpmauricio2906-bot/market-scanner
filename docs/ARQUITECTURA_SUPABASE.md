# Historial y validación en Supabase

Estado al 16/10/2026: esquema, RPC, worker y Cron desplegados y verificados en Supabase. La copia y autorización del nuevo Apps Script y sus temporizadores siguen siendo pasos manuales del propietario de Google.

## Responsabilidades y datos

| Componente | Responsabilidad |
| --- | --- |
| Apps Script | Descargar datos recientes de Yahoo, enviarlos y mostrar el estado del servidor |
| `Precios` | Resumen visible de 250 instrumentos; no es la autoridad del historial |
| RPC de ingesta | Autenticar la escritura, validar los datos y guardar cotización/estado |
| Almacenamiento privado | Provisionales, control de calidad, auditorías y cola de reparaciones |
| `public.market_history` | Barras diarias confirmadas que consume la aplicación |
| Worker privado | Descargar historia de los tickers reclamados y solicitar su sustitución validada |
| Cron | Auditorías, retención e invocación del worker |

El universo mantiene 200 empresas y 50 ETF. El frontend conserva la selección en `data/universe.json`, la clave pública de lectura y el filtro `is_final=true`. No necesita acceso a las RPC de escritura ni a la cola.

## Ingesta reciente

Google solicita `range=5d&interval=1d` a Yahoo y envía metadatos, timestamps y valores OHLCV originales, en grupos de hasta cinco, mediante `market_ingest_recent(p_batch)`. Solo adapta el formato de transporte; no descarta valores nulos ni decide su calidad. El servidor reconoce cada ticker frente a su universo y verifica la identidad de Yahoo, moneda y zona horaria.

La validación exige fechas de sesiones reales, valores numéricos finitos, precios positivos, volumen entero no negativo y relaciones OHLC coherentes. No se convierte un dato ausente en cero. El reloj y calendario del servidor determinan la vigencia y cuándo puede confirmarse una barra; la fecha enviada por Google no se toma como prueba de un cierre. El calendario revisado cubre 2024–2028 y debe ampliarse antes de agotar ese horizonte; fuera de él se detiene la confirmación.

Las cotizaciones de una sesión abierta permanecen privadas. La RPC devuelve por instrumento el resultado de la recepción y su estado para `Precios`. Una barra intradía visible en la hoja no se convierte por ello en una fila final de la aplicación.

Las barras confirmadas se guardan por `(fecha,ticker)` de forma idempotente. Un reintento puede corregir o repetir una barra sin crear duplicados. El cliente Google no escribe directamente las tablas históricas.

## Reparaciones de series

El servidor compara las nuevas barras con el historial y audita cobertura, continuidad y correcciones, incluidos splits. Si una serie necesita reconstrucción, crea o actualiza una tarea en la cola; la recepción reciente no obliga a Google a descargar tres años.

El worker `market-history-worker` reclama hasta dos tareas mediante `market_claim_repairs(p_limit)`. Cada reclamación tiene un token de lease y una vigencia de diez minutos para evitar que dos ejecuciones sustituyan la misma tarea a la vez. El objetivo de trabajo del worker es de 90 segundos.

Por ticker, descarga tres años de barras diarias de Yahoo y envía el resultado completo a `market_replace_history(p_job_id,p_lease_token,p_payload)`. El servidor vuelve a validar identidad, calidad, continuidad y último cierre esperado. Una IPO puede tener menos de 500 sesiones solo cuando su primera fecha de cotización justifica esa cobertura.

La sustitución se realiza en una transacción: se conserva la serie anterior hasta que la nueva ha superado todas las comprobaciones y la operación puede confirmarse. Se retienen las últimas 500 sesiones reales de ese ticker. La cola no autoriza a publicar una descarga parcial ni a fabricar días de bolsa.

Los errores de transporte se comunican con `market_fail_repair(p_job_id,p_lease_token,p_reason)`. Un rechazo de calidad de `market_replace_history` registra su resultado en el servidor; el worker no registra además un segundo fallo sobre la misma respuesta. Una tarea fallida o una lease vencida debe quedar visible y seguir la política de reintentos del backend.

## Cron y autenticación del worker

Cron ejecuta las auditorías y la retención mediante SQL e invoca el worker por HTTP. Estas tres programaciones están activas:

| Trabajo | Programación |
| --- | --- |
| `market-scanner-repair-worker` | Cada minuto; el worker reclama hasta dos tareas por llamada |
| `market-scanner-daily-audit` | 20:15 de Nueva York, de lunes a viernes, con el calendario de bolsa del servidor |
| `market-scanner-weekly-history` | Sábado a las 02 de Nueva York |

La configuración está versionada en [activate_schedules.sql](../supabase/activate_schedules.sql). Los despachos UTC aplican guardas con la hora de Nueva York para respetar sus cambios de horario. Comprobar sus ejecuciones al reproducir la instalación. [Supabase Cron](https://supabase.com/docs/guides/cron) permite programar SQL y [llamar Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions).

El endpoint del worker utiliza `verify_jwt=false` porque valida su propia credencial de servidor obligatoria: `X-Market-Worker-Token`. La configuración genera un token aleatorio, lo guarda en Vault y conserva su hash privado. Antes de reclamar tareas, el worker comprueba ese token mediante `market_verify_worker_token(p_token)`, usando internamente la credencial privada de plataforma de su entorno. Una cabecera ausente o incorrecta devuelve 401. Un JWT externo por sí solo no autoriza la ejecución.

El token del worker no se entrega a Google ni al navegador. La clave privada de Google autoriza su llamada de ingesta bajo el modelo de permisos del backend. El frontend conserva únicamente una clave pública de lectura. Las tablas de control y las RPC internas no se conceden a `anon` o `authenticated`.

## Operación y observabilidad

Comprobar por separado:

- Google: última ejecución, cursor, continuaciones y errores HTTP; `verEstadoMarketScanner` consulta el resumen de `Precios` y su avance.
- Ingesta: estado y fecha de cada ticker, último cierre esperado y rechazos de calidad.
- Reparación: tareas pendientes, reclamadas, vencidas o fallidas y motivo del último resultado.
- Cron y worker: ejecuciones recientes, respuestas HTTP y tareas completadas.
- Aplicación: 250 instrumentos, lecturas públicas de cierres y cobertura real por ticker.

Parar los temporizadores de Google no detiene Cron. Durante mantenimiento, detener cada emisor o trabajo correspondiente. La hoja puede permanecer cerrada durante la operación normal.

## Migración de la instalación anterior

Conservar el historial validado que ya existe en Supabase y respaldar la hoja anterior. Desplegar primero los nuevos objetos y permisos del servidor, luego el worker y su programación, y por último actualizar Google con los `.gs` y el manifiesto nuevos.

La pestaña `Historial` deja de ser un componente de ejecución: puede conservarse como copia histórica o exportación bajo decisión del propietario. El cambio no exige otro Excel ni una lectura, ordenación o reconstrucción de sus filas. Las funciones de backfill Google y la reconstrucción semanal se retiran.

## Verificación del despliegue

Se aplicó [server_owned_history.sql](../supabase/server_owned_history.sql) y se desplegó el [worker](../supabase/functions/market-history-worker/README.md). La revisión pasó 47 pruebas JavaScript y 62 comprobaciones SQL en estas tres transacciones `BEGIN`/`ROLLBACK`, sin dejar datos de prueba:

| Prueba SQL | Comprobaciones |
| --- | ---: |
| [Permisos, calendario y parseo](../supabase/tests/server_owned_history_01_permissions_calendar_parse.sql) | 31 |
| [Ingesta reciente, caché y splits](../supabase/tests/server_owned_history_02_recent_ingest_cache_splits.sql) | 16 |
| [Reparación completa y leases](../supabase/tests/server_owned_history_03_full_repair_leases.sql) | 15 |

Se verificaron reparaciones reales de AAPL, SOXS (500 cierres) y SPCX (87 sesiones de IPO) mediante el worker, respuestas 401 ante token ausente o incorrecto y la denegación de las RPC privadas a `anon` y `authenticated`. Las comprobaciones SQL cubren calidad, provisionales privados, reintentos, reemplazo transaccional y leases. La comprobación final dejó la cola vacía y la auditoría sin reparaciones por encolar.

El respaldo privado conserva 149.187 filas. La tabla mantiene 124.076 barras confirmadas del universo activo de 250 instrumentos y conserva las 25.111 filas heredadas de otros 57 tickers con `is_final=false`. Las reparaciones de AAPL conservaron número de filas y volumen; las diferencias de precios frente al respaldo fueron de precisión numérica, como máximo `5e-13`. El calendario contiene 1.255 sesiones entre 2024 y 2028.

Las tablas privadas usan RLS sin políticas públicas de forma intencional. Los avisos informativos correspondientes no conceden acceso. La comprobación del backend no certifica que el propietario haya copiado el nuevo Apps Script o instalado sus temporizadores: debe completar y verificar esos pasos en Google.
