# Instalación del flujo con historial en Supabase

Estado al 16/10/2026: Supabase, el worker y los tres trabajos Cron ya están desplegados y verificados. El propietario debe actualizar y verificar Apps Script con su cuenta. Esta guía no afirma que sus nuevos temporizadores de Google estén instalados o ejecutándose.

## 1. Conservar datos y detener la carga anterior

Guardar una copia del Google Sheets y un respaldo de `market_history`. En el proyecto Google actual, ejecutar `detenerTemporizadores` y comprobar que no quedan ejecuciones anteriores trabajando. Si hay varios proyectos vinculados al archivo, detener también sus timers.

Conservar la pestaña `Historial` como archivo. El flujo nuevo no la utiliza y no exige corregir sus fechas, reservar bloques, construir índices ni importar otro Excel. No borrar esa pestaña para instalar el cambio.

## 2. Desplegar y verificar Supabase

En el proyecto actual este paso ya se completó. Para reproducir la instalación, aplicar [server_owned_history.sql](../supabase/server_owned_history.sql), desplegar el worker, ejecutar las tres pruebas SQL de [ARQUITECTURA_SUPABASE.md](ARQUITECTURA_SUPABASE.md) y activar [activate_schedules.sql](../supabase/activate_schedules.sql), conservando la tabla `public.market_history` y su contrato de lectura. El backend contiene:

- El universo de 250 instrumentos y el calendario de sesiones.
- La RPC privada `market_ingest_recent`, que recibe respuestas recientes de Yahoo y devuelve estados por ticker.
- Validación del servidor, almacenamiento privado de provisionales, auditoría, retención y cola de reparaciones.
- El worker `market-history-worker` y los trabajos Cron que lo invocan y mantienen los datos.

Los nombres y parámetros de las RPC se describen en [ARQUITECTURA_SUPABASE.md](ARQUITECTURA_SUPABASE.md). Comprobar una ingesta reciente real y una reparación completa antes del cambio en Google. Confirmar que el rol público puede leer los cierres y no puede ejecutar RPC de ingesta, reclamar reparaciones ni acceder a provisionales.

El worker exige su token privado de servidor, generado y almacenado en Vault por la configuración del backend. Su autenticación se valida antes de reclamar trabajo. Ese token no se copia a Google Sheets ni a GitHub. La clave privada de plataforma que usa internamente la función permanece en el entorno de Supabase.

Se verificaron reparaciones reales de AAPL y la autenticación del worker; las tres programaciones están activas. Para una instalación nueva, comprobar también sus ejecuciones y que los errores de reparación queden visibles antes de actualizar Google.

## 3. Copiar Apps Script y su manifiesto

En **Extensiones → Apps Script**, sustituir los archivos antiguos por los archivos `.gs` de esta versión y conservar una sola definición de cada función. Si se entrega un archivo único, reemplazar el contenido completo por ese archivo en vez de añadirlo al final del anterior.

Activar la visualización del manifiesto en Configuración del proyecto y sustituir `appsscript.json` por el incluido. El proyecto usa `America/New_York` para el horario de los activadores. No hace falta publicar un Web App.

Mantener las propiedades privadas existentes:

| Propiedad | Contenido |
| --- | --- |
| `SUPABASE_URL` | URL HTTPS del mismo proyecto Supabase |
| `SUPABASE_WRITE_KEY` | Clave privada vigente para las RPC de escritura |
| `SPREADSHEET_ID` | Se guarda automáticamente al preparar la hoja |

La nueva arquitectura no exige crear otra clave para una instalación que ya tiene estas propiedades correctas. No pegar credenciales en celdas, código ni repositorio. La clave pública de `js/config.js` continúa siendo solo de lectura bajo RLS.

La edición de la hoja y del script debe limitarse a cuentas de confianza: las Propiedades del script no son una barrera frente a sus editores. Si alguna clave se expuso, revocarla; eliminarla de un archivo no la invalida. [Google: scripts vinculados](https://developers.google.com/apps-script/guides/bound), [Supabase: claves](https://supabase.com/docs/guides/getting-started/api-keys).

## 4. Preparar únicamente Precios y probar

Ejecutar `prepararMarketScanner` y aceptar los permisos con la cuenta propietaria. Comprueba o crea `Precios`, coloca los 250 instrumentos y guarda la referencia al archivo. No lee ni ordena el historial local y conserva la zona horaria del archivo.

Ejecutar `comprobarConexion`. Si falla, revisar primero la migración del servidor, la URL y la clave de Propiedades del script; no reutilizar el escritor antiguo como alternativa.

Ejecutar `actualizarMarketScanner`. Google consulta los últimos cinco días de Yahoo en grupos de cinco y envía cada grupo a Supabase. El servidor devuelve el estado que se muestra en `Precios`. Durante la sesión puede haber datos provisionales; su presencia en la hoja no los publica como cierres para la web.

| Estado del servidor | Significado |
| --- | --- |
| `FINAL` | Cierre confirmado y aceptado |
| `PROVISIONAL` | Cotización de una sesión sin cierre confirmado; permanece privada |
| `PENDIENTE_DE_ACTUALIZAR` | Yahoo todavía no incluye el cierre esperado; revisar una consulta posterior |
| `REEMPLAZO_PENDIENTE` | El backend ha encolado la reconstrucción de la serie |
| `RECHAZADO` | Los datos no superan la validación; el motivo aparece en el estado |

Cada ejecución procesa hasta 20 instrumentos con un objetivo de unos 60 segundos y deja una continuación de un minuto mientras haya trabajo. Consultar `verEstadoMarketScanner` y el registro de ejecuciones para ver el avance y los errores. La hoja no tiene que estar abierta.

Una reparación histórica pendiente se ejecuta en Supabase. No ejecutar un backfill desde Google ni volver a importar las 500 sesiones para resolverla. Comprobar el estado del servidor y el worker si esa reparación no progresa.

## 5. Activar los temporizadores de Google

Después de una prueba manual correcta, ejecutar `instalarTemporizadores` con la cuenta propietaria. La actualización horaria se limita a lunes a viernes, entre 09 y 20 ET. La continuación de un minuto procesa los instrumentos pendientes. El calendario de bolsa y la confirmación de cierres pertenecen al servidor.

No se instala una reconstrucción semanal en Google. Las funciones antiguas `iniciarHistorial`, `continuarHistorial` e `iniciarHistorialSemanal` se retiran; las reconstrucciones y auditorías pasan al backend.

`detenerTemporizadores` detiene el emisor Google y conserva su avance. No desactiva los trabajos Cron independientes de Supabase. Para una pausa completa de mantenimiento, detener ambos componentes de forma explícita.

Verificar en el panel de ejecuciones de Google que la primera continuación se completó y que la siguiente ronda horaria se inicia. No considerar activado el sistema únicamente porque se hayan copiado los archivos.

## 6. Comprobar la aplicación

El frontend mantiene su configuración y lee `market_history` con `is_final=true`. Comprobar 250 instrumentos, los filtros de acciones/ETF, una empresa NYSE, una IPO con historia corta y los ETF TQQQ, SOXS, USD y MAGS.

Confirmar que las barras de la sesión abierta no aparecen como cierres en los charts. Si Yahoo falla o una reparación está pendiente, conservar el último cierre válido y revisar el estado del servidor.

La selección de instrumentos debe mantenerse sincronizada entre `data/universe.json`, `Universe.gs` y el universo del servidor. Los cambios de selección no se hacen editando manualmente una fila de `Precios`.
