# Revisión del cierre del 19 de octubre de 2026

La revisión se ejecuta en Supabase y su aviso en GitHub. El equipo personal,
Google Sheets abierto y Codex no son necesarios para esos dos procesos.
Los temporizadores de Apps Script existentes siguen descargando y enviando
cotizaciones; esta revisión los observa sin sustituirlos ni ejecutar cargas.

## Captura en Supabase

`supabase/cloud_close_audit.sql` instala una captura única del cierre de
**2026-10-19**, con inicio a las **20:30 de Nueva York**
(`2026-10-20T00:30:00Z`). Un trabajo de pg_cron llama cada cinco minutos a
`market_scanner.capture_close_audit()`. Antes de esa hora devuelve `false` y no
crea ningún informe. Si hay un fallo SQL, toda la transacción revierte y la
siguiente ejecución puede reintentar. Se permite recuperar una ejecución
atrasada durante el 20 de octubre, hasta las 23:59:59 de Nueva York.

La captura persistida es idempotente: no reemplaza un informe existente, usa
un bloqueo transaccional para evitar carreras y elimina solamente su propio
trabajo `market-scanner-close-review-20261019` después de guardar el resultado.
No modifica precios, historial, validación, cola de reparación ni los otros
temporizadores. Un resultado con incidencias también se conserva: indica qué
se observó en la hora efectiva de captura; no promete que el proveedor ya haya
corregido un rechazo en ese momento.

## Qué se comprueba

- Universo activo de exactamente 250 tickers únicos.
- Cierre diario confirmado de la sesión objetivo en el historial, con OHLCV
  finitos y coherentes; una cotización provisional nunca cuenta como cierre.
- Correspondencia entre el cierre del historial y la proyección pública que
  consume la aplicación. En una recuperación al día siguiente, una proyección
  que ya avanzó legítimamente a una sesión posterior no invalida el cierre anterior.
- Cobertura de 500 sesiones, ajustada a la fecha de salida a bolsa de los
  instrumentos nuevos. Si la retención ya avanzó al día siguiente, se ajusta el
  inicio de la ventana para no confundir una purga normal con un hueco.
- Reparaciones pendientes, en curso o fallidas y su próximo reintento.
- Rechazos todavía sin resolver. Un rechazo de una respuesta del proveedor no
  invalida un cierre final válido que ya está conservado y publicado.
- Recepción de capturas de Google Finance y Yahoo para los 250 tickers durante
  el día de Nueva York de la sesión objetivo. Los recibos del martes no se cuentan
  como cargas del lunes.
- Activación del worker y sus ejecuciones de pg_cron durante las dos horas
  anteriores a la captura, sin publicar comandos ni mensajes de error libres.

Los recibos prueban que los datos llegaron a Supabase. No identifican si cada
envío de Google se inició por temporizador o manualmente: el payload actual no
incluye `triggerUid`. La configuración automática se comprobó separadamente con
las capturas de Activadores/Ejecuciones del usuario y `MS_PAUSED=false`; esta
revisión no puede demostrar que nadie pulse un botón manual en el futuro.

## Informe y permisos

La tabla pública `market_close_audits` contiene `session_date`, `captured_at` y
`report`. RLS permite únicamente SELECT a `anon` y `authenticated`; se revocan
las escrituras y la ejecución de las funciones de auditoría a los roles de la API,
incluido `service_role`. Las funciones nuevas son privadas, SECURITY INVOKER y
tienen `search_path=''`. Las ejecuta el propietario de la base mediante Cron.

El informe publica únicamente el universo ya público, fechas, contadores y
códigos controlados. Nunca incluye payloads, tokens, `last_error` ni razones de
error libres. `report.issues` contiene objetos con `ticker` (null para incidencias
globales), `code`, `status`, `last_final_date` y `next_retry_at`; las incidencias
por instrumento también incluyen los días esperados y disponibles de historial.
`expected`, `complete`, `ok`, `checks` y `automatic` permiten validar el contrato
sin confiar solamente en una bandera de éxito.

GitHub Actions lee el informe con la misma clave publicable utilizada por la
aplicación y genera el aviso autorizado con su `GITHUB_TOKEN`; no necesita una
clave privada de Supabase. Los horarios y la política de notificación se definen
en el workflow de GitHub. Un inicio tardío de Actions no cambia la captura que
ya quedó guardada en Supabase.

El workflow `close-audit-20261019.yml` consulta el informe el lunes 19 a las
**20:35, 20:50 y 21:20 de Nueva York**. Las dos últimas lecturas permiten
recuperar un retraso de GitHub o un fallo de conexión. Una condición de fecha
impide auditar o enviar avisos en años posteriores. GitHub puede retrasar un
inicio programado; el resultado conserva la hora de captura de Supabase.

Si hay problemas, abre una única incidencia asignada a `jpmauricio2906-bot`,
con los tickers, códigos, último cierre y próximo reintento disponibles. Si no
puede leer o validar el informe, avisa de ese fallo en lugar de dar la revisión
por correcta. Los reintentos reutilizan la misma incidencia del bot. Una lectura
posterior conforme cierra una incidencia previa de fallo de comprobación; no
modifica incidencias humanas. Un informe de Supabase con problemas conserva lo
observado a las 20:30, aunque los precios se recuperen más tarde.

Si todo está correcto, no abre una incidencia. El informe queda en Supabase y
en el resumen de Actions; los archivos JSON y Markdown se conservan también
como artefactos durante 30 días. Los avisos son notificaciones de GitHub, según
las preferencias de la cuenta; no dependen de un chat de Codex abierto.

Referencias: [programación y posibles retrasos de Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
y [configuración de notificaciones](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications).

## Comprobación antes del lunes

El constructor `market_scanner.build_close_audit(fecha, reloj)` es de solo
lectura. Puede revisarse la sesión del 16 de octubre usando el reloj real del
momento, sin persistir una captura de prueba. No reconstruye el estado AS OF de
la base: pasarle un reloj antiguo limita los recibos, pero no retrocede los
precios, los trabajos ni el historial. `captured_at` siempre debe interpretarse
como la hora efectiva de observación, no como una reconstrucción histórica.

Los tres archivos `supabase/tests/cloud_close_audit*.sql` usan transacciones
independientes con fixtures sintéticos y ROLLBACK para
comprobar 250 cierres correctos, fallos, cobertura de IPO, rechazo recuperado,
permisos, horario, captura idempotente y recuperación al día siguiente. Ningún
informe de prueba ni precio sintético debe confirmarse con COMMIT. Ejecutar los
tres grupos: precios, estados y programación/permisos. Cada grupo es autónomo
y tiene menos de 7,5 KB para admitir conexiones con límites de solicitud.
