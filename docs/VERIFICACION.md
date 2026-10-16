# Verificación del flujo con historial en Supabase · 16/10/2026

El backend está desplegado. Google conserva la descarga reciente y `Precios`; la validación, el historial de 500 sesiones, la cola y las reparaciones se ejecutan en Supabase.

## Pruebas locales

**47 pruebas JavaScript aprobadas, cero fallos.** Cubren el emisor Google, reanudación y límites de ejecución, transporte de valores originales de Yahoo, contratos RPC, estados devueltos por el servidor y conservación de las propiedades privadas. La preparación, actualización y consulta de progreso no acceden a `Historial`.

El worker se verifica con dobles de red: autenticación previa a la cola, reclamación de hasta dos tareas, descarga completa, preservación de nulos para el validador SQL, leases, errores, limpieza y tiempos límite. No recibe tickers ni barras de su llamador y no escribe directamente las tablas.

El cliente del frontend se prueba con 125.000 barras y páginas limitadas por el servidor, detalle y comparación, validación de filas, renderizado de 250 instrumentos, filtros de acciones/ETF y metadatos de exposición. La comparación de calendario usa la semilla revisada del servidor, 2024–2028; el frontend mantiene su contrato `is_final=true`.

## PostgreSQL y permisos

**62 comprobaciones SQL aprobadas**, distribuidas en tres transacciones `BEGIN`/`ROLLBACK` que no dejan fixtures:

| Archivo | Comprobaciones |
| --- | ---: |
| [Permisos, calendario y parseo](../supabase/tests/server_owned_history_01_permissions_calendar_parse.sql) | 31 |
| [Ingesta reciente, caché y splits](../supabase/tests/server_owned_history_02_recent_ingest_cache_splits.sql) | 16 |
| [Reparación completa y leases](../supabase/tests/server_owned_history_03_full_repair_leases.sql) | 15 |

Incluyen calidad OHLCV, identidad, reloj y sesiones, aislamiento de provisionales, rechazo de escrituras directas, ingesta idempotente, correcciones, sustitución transaccional y recuperación de leases. La fixture procede de las barras actuales de AAPL y conserva la precisión de transporte; no congela volúmenes que Yahoo puede revisar.

Los roles `anon` y `authenticated` no pueden ejecutar las RPC privadas ni acceder a las tablas de control. Las tablas privadas tienen RLS sin políticas públicas intencionalmente. Los avisos informativos de esas tablas y de índices nuevos sin uso no equivalen a permisos públicos.

## Comprobaciones reales en Supabase

- Universo cargado: 250 instrumentos y 1.255 sesiones de calendario entre 2024 y 2028.
- Respaldo privado: 149.187 filas anteriores. La tabla conserva 124.076 barras confirmadas del universo activo y las 25.111 filas heredadas de otros 57 tickers con `is_final=false`.
- Descargas reales de Yahoo y reparaciones AAPL completadas por el worker mediante HTTP 200, sin fallos. Se conservaron las 500 filas y el volumen; las diferencias de precio frente al respaldo fueron de precisión numérica, como máximo `5e-13`.
- Otra ejecución real reclamó y completó dos tareas sin fallos: SOXS conservó 500 cierres y SPCX sus 87 sesiones reales de IPO. La auditoría posterior no encoló reparaciones y la cola quedó vacía.
- El endpoint del worker respondió 401 tanto sin token como con token incorrecto.
- Los tres trabajos Cron están activos. Se observó una ejecución natural correcta del despachador de reparaciones el 16/10/2026 a las 13:29 UTC; la cola quedó sin reparaciones pendientes.
- Una lectura REST real con la clave pública devolvió HTTP 200 y dos cierres finales de AAPL. Las RPC privadas siguen reservadas al backend.

El esquema está versionado en [server_owned_history.sql](../supabase/server_owned_history.sql), el worker en [su directorio](../supabase/functions/market-history-worker/README.md) y los tres horarios en [activate_schedules.sql](../supabase/activate_schedules.sql). Los detalles operativos están en [ARQUITECTURA_SUPABASE.md](ARQUITECTURA_SUPABASE.md).

## Reproducir verificaciones

Con Node.js 22 o posterior, desde la raíz del proyecto:

```powershell
node --test tests/*.test.cjs
node tools/update-universe.mjs --check
node tools/build-universe.mjs
node tools/build-server-schema.mjs
node tools/probe-yahoo.mjs AAPL BRK-B TSM
```

La sonda Yahoo solo consulta datos recientes y comprueba el transporte. No escribe Supabase ni valida por su cuenta un historial de 500 sesiones. Las comprobaciones de negocio corresponden al servidor. Ejecutar las tres pruebas SQL por separado dentro de sus transacciones revertidas, con un rol administrativo de pruebas y el backend instalado.

El generador del esquema usa fuentes versionadas, incluido `data/instrument-history-starts.json`; no depende de capturas ignoradas del directorio `outputs/`. Las exportaciones Excel anteriores se conservan como archivo, no como entrada obligatoria para la operación.

## Pendiente con la cuenta de Google

El propietario debe detener los timers anteriores, copiar los `.gs` y el manifiesto actuales, mantener sus propiedades privadas y ejecutar la secuencia de [INSTALACION.md](INSTALACION.md). Después debe comprobar una continuación y una ronda horaria en el panel de ejecuciones de Google.

La verificación del backend no confirma que esos nuevos temporizadores estén instalados o ejecutándose. No hace falta volver a importar un Excel ni reconstruir el historial desde Google.
