# Revisión diaria de cierres en la nube

Supabase revisa los 250 instrumentos **cada día bursátil a las 20:30 de
Nueva York**, desde el 19 de octubre de 2026. GitHub consulta el informe y
avisa solamente si hay tickers pendientes, rechazados o desactualizados.
El equipo personal y Codex pueden estar apagados.

## Horario y calendario

La función privada `market_scanner.capture_close_audit()` interpreta el reloj
en `America/New_York`. El Cron permanente
`market-scanner-daily-close-review` la invoca cada cinco minutos. Antes de
las 20:30 no captura nada; después puede reintentar hasta el final de ese día
si una transacción falla. Solo captura fechas presentes en el calendario de
sesiones revisado de Supabase. Omite fines de semana y feriados; una sesión
con cierre anticipado también se revisa a las 20:30.

El informe de cada fecha es único e inmutable, con bloqueo transaccional y
clave primaria por sesión. Una captura correcta conserva su Cron para el
siguiente día bursátil. Se retira el antiguo trabajo puntual
`market-scanner-close-review-20261019`.

GitHub Actions consulta a las **20:35, 20:50 y 21:20** de lunes a viernes,
usando también la zona IANA `America/New_York`. El lector comprueba
`supabase/calendar.json` y descarta feriados. Revisa exclusivamente el día
actual de Nueva York, entre 20:30 y 22:30; nunca reutiliza el viernes durante
el fin de semana. Los cambios de horario se resuelven con la zona IANA,
sin fijar un desplazamiento UTC.

El calendario actual cubre 2024–2028. El lector y la captura rechazan un
año fuera de ese horizonte; la renovación del calendario debe actualizar
el archivo y las sesiones de Supabase antes de ampliar esa cobertura.
GitHub puede retrasar una ejecución; los horarios de las lecturas no alteran
la hora efectiva de la captura conservada.

Para evitar la desactivación de programaciones tras 60 días de inactividad
del repositorio público, el monitor conserva un registro operativo en
`.github/close-audit-activity.json`, con un commit como máximo cada 28 días.
Contiene únicamente la hora de ejecución y la fecha local de la sesión;
no afirma que los precios estén correctos ni genera incidencias o avisos.
El helper solo puede escribir esa ruta fija en este repositorio y usa el SHA
actual para evitar sobrescribir cambios concurrentes. La comprobación de CI
usa `--dry-run`, que no escribe nada.

## Qué se comprueba

- Universo exacto de 250 tickers.
- Cierre FINAL de la sesión, con OHLCV finitos y coherentes.
- Correspondencia del historial con la proyección pública que consume la aplicación.
- Cobertura de 500 sesiones, ajustada a la fecha de salida a bolsa y la retención.
- Reparaciones pendientes, en curso o fallidas, con su próximo reintento.
- Rechazos que siguen sin resolver; un rechazo antiguo recuperado no invalida un cierre válido.
- Recepción de datos de Google Finance y Yahoo y funcionamiento del worker.

Los recibos demuestran la llegada al servidor. No identifican el origen
manual o automático de cada envío de Google porque el payload no incluye
`triggerUid`. La instalación de los activadores se comprobó separadamente
con las capturas de Google y `MS_PAUSED=false`.

## Avisos de GitHub

Solo las incidencias asociadas a tickers válidos generan un aviso:
`MISSING_FINAL_CLOSE`, `INVALID_FINAL_OHLCV`, `PROVISIONAL_CLOSE`,
`STALE_OR_MISSING_PUBLIC_QUOTE`, `PUBLIC_HISTORY_MISMATCH`,
`HISTORY_COVERAGE_OR_QUALITY`, `ACTIVE_REPAIR` y
`LATEST_CAPTURE_REJECTED`.

Se crea una sola incidencia por sesión, asignada a `jpmauricio2906-bot`,
con tickers, códigos, último cierre válido y próximo reintento. Las lecturas
posteriores reutilizan únicamente incidencias de `github-actions[bot]`;
no editan incidencias humanas. Si todo está correcto no se crea una incidencia.

Los errores de API, informes ausentes o malformados y avisos globales de
infraestructura se registran en el resumen y los artefactos de Actions,
sin abrir incidencias. Un resultado técnico incompleto nunca se presenta
como 250 cierres verificados. El paso lector conserva su resultado en el
informe aunque el workflow termine para guardar los artefactos.

El informe corresponde a la hora de captura. Los reintentos de lectura no
vuelven a calcularlo ni confirman que un ticker se haya recuperado después.
Los workers de reparación siguen operando de forma independiente.

Los avisos son notificaciones de GitHub según las preferencias de la cuenta.
Los archivos JSON y Markdown se conservan como artefactos durante 30 días;
el informe de Supabase permanece en `public.market_close_audits`.

## Permisos e instalación

La tabla mantiene RLS y SELECT para `anon` y `authenticated`. Los roles de la
API no pueden escribir informes ni ejecutar las funciones privadas.
Las funciones usan SECURITY INVOKER y `search_path=''`. Cron las ejecuta
como propietario. El informe omite payloads, credenciales y errores libres.

El lector utiliza la clave publicable de la aplicación; su acceso a Supabase
es únicamente GET. Los avisos usan el `GITHUB_TOKEN` temporal. Solo el job
de revisión tiene escritura de incidencias y contenido, esta última para el
registro periódico; el job de pruebas conserva acceso de lectura. No se necesita una clave
privada nueva de Supabase ni un temporizador local.

Una instalación nueva usa `supabase/cloud_close_audit.sql`, cuyo tramo final
ya contiene la programación permanente. Una instalación que tenía la revisión
puntual aplica `supabase/daily_close_audit.sql`. Ambos comparten exactamente
la función de captura y el Cron; no cambian precios ni validadores existentes.

Pruebas: `node --test tests/cloud-close-audit.test.mjs tests/close-audit-activity.test.mjs`.
Las pruebas SQL de la programación permanente están en
`supabase/tests/daily_close_audit.sql` y
`supabase/tests/daily_close_audit_02_calendar_permissions.sql`: usan reportes de prueba y ROLLBACK,
sin modificar precios, reparaciones ni proveedores. Las pruebas de los
constructores de precios y estados permanecen en
`supabase/tests/cloud_close_audit.sql` y
`supabase/tests/cloud_close_audit_02_states.sql`.

Referencias: [programación de Actions con zona horaria](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule)
y [desactivación por inactividad](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
y [configuración de notificaciones](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications).
