# Instalación del flujo limpio

## 1. Credenciales y respaldo

Exportar una copia de `market_history` desde Supabase y conservar el Google Sheets anterior. Detener sus timers antes de cambiar la carga.

El original `marketscanner_supabase.gs` contiene una credencial privada incrustada. **Rotarla en Supabase antes de activar el flujo nuevo**. No copiarla al repositorio ni a celdas. El paquete limpio excluye esos scripts y esa credencial. Si llegó a GitHub, revisar el historial; borrar un archivo no revoca una clave.

La credencial anterior es una JWT `service_role`: crear una `sb_secret_…` no la revoca por sí solo. En **Settings → API Keys**, crear la clave nueva, sustituir y comprobar todos los componentes que la usan y después desactivar las claves heredadas comprometidas. La desactivación heredada es reversible. [Procedimiento oficial de Supabase](https://supabase.com/docs/guides/getting-started/api-keys#rotate-a-leaked-or-compromised-key).

La clave `sb_publishable_…` de `js/config.js` es pública y permite lectura bajo RLS. La clave de escritura va únicamente en Propiedades del script. Se admite una clave secreta nueva o una JWT `service_role` heredada. Las claves nuevas se envían como `apikey`, sin convertirlas en bearer JWT.

Antes de configurar la clave privada, restringir la edición de la hoja al propietario y a cuentas de confianza. Un script vinculado comparte los permisos de edición de su hoja; las Propiedades del script no ocultan secretos a sus editores. No dejar **Cualquier persona con el enlace → Editor** en la hoja de producción. [Google: permisos de scripts vinculados](https://developers.google.com/apps-script/guides/bound), [Propiedades del script](https://developers.google.com/apps-script/guides/properties).

## 2. Supabase

Ejecutar `supabase/001_market_history.sql` en SQL Editor. Mantiene la tabla, añade `is_final=false` a registros heredados y crea el índice único `(fecha,ticker)`. Los duplicados detienen la migración para que puedan revisarse; no se elige ni borra una versión automáticamente.

El CHECK OHLCV controla nuevas escrituras. `NOT VALID` deja auditar la historia anterior sin afirmar que ya es correcta. Anon/authenticated reciben SELECT y pierden concesiones de escritura; el proceso privado publica con su propia clave.

**No publicar todavía el frontend nuevo**: lee únicamente `is_final=true`. El backfill siguiente volverá a consultar y validar las barras antes de confirmarlas.

## 3. Hoja y scripts

Importar `MarketScanner_250.xlsx` en Google Drive y abrirlo como Google Sheets, conservando `Precios`, `Historial` y encabezados. Esta plantilla reúne las 200 empresas y los 50 ETF. Conserva A:P y añade metadatos en Q:U. Se puede guardar el Excel y la plantilla anterior de 200 como copias independientes.

En **Extensiones → Apps Script**, utilizar un proyecto limpio. Añadir `Code.gs`, `Yahoo.gs`, `Storage.gs` y `Universe.gs` del paquete. No mezclar los scripts viejos.

En Configuración del proyecto, activar el manifiesto y sustituir `appsscript.json` por el incluido. Zona horaria: `America/New_York`. No hace falta publicar un Web App.

En **Propiedades del script**, configurar:

| Propiedad | Valor |
| --- | --- |
| `SUPABASE_URL` | URL HTTPS del proyecto Supabase |
| `SUPABASE_WRITE_KEY` | Nueva clave privada de escritura, solo aquí |

Ejecutar `prepararMarketScanner` y aceptar los permisos de Google. Guarda `SPREADSHEET_ID`, comprueba encabezados y lista, conserva Historial y escribe las fórmulas. Amplía Historial a 125.001 filas para 250×500 sesiones más encabezados. La plantilla anterior de 16 columnas requiere importar esta nueva versión; no mezclarla con los scripts de 250.

Mantener el orden y tickers de `Precios`. Los cambios de universo deben aplicarse juntos a `data/universe.json`, `Universe.gs` y la plantilla.

## 4. Carga y comprobación

Ejecutar `comprobarConexion` (solo lectura) y `iniciarHistorial`. El Excel trae datos para revisar desde el principio, pero **Supabase se alimenta de una nueva consulta Yahoo**, no de confiar en las filas importadas.

Se procesan hasta 20 tickers por ejecución, descargando cinco a la vez, y se continúa cada cinco minutos. Son trece ejecuciones base si no se alcanza antes el límite de 210 segundos: aproximadamente 60–65 minutos, más descargas, retrasos de Google y reintentos. La hoja no tiene que permanecer abierta.

Consultar `verEstadoMarketScanner` y el registro de ejecución. Muestra cierre esperado, cobertura por ticker y fallos:

- `COMPLETADO`: sin fallos ni historia corta.
- `COMPLETADO CON HISTORIA CORTA`: toda la historia real de cotizaciones recientes, inferior a 500 sesiones.
- `INCOMPLETO`: quedan fallos. Corregir su causa y ejecutar `iniciarHistorial` de nuevo.

La captura entregada tiene 124.076 barras y 500 sesiones para cada uno de los 50 ETF. Entre las empresas, SPCX tiene 87, SKHY 69 y SNDK 420 sesiones. XOM, SHEL, TTE, ACN, VLO, EQNR, LOW, IBN, SO y PNC tenían su último cierre disponible al 14/10/2026; el resto llega al 15/10. La carga en vivo exige el cierre esperado: si Yahoo sigue atrasado, se informa del fallo y no se publica un provisional como sustituto.

No añadir barras ficticias para alcanzar 500. Revisar las ausencias antes de activar los análisis.

## 5. Timers

Ejecutar `instalarTemporizadores`. Crea actualización horaria 09–20 ET en sesiones de bolsa y reconstrucción cada sábado a las 02 ET. Los timers de continuación existen mientras haya trabajo pendiente.

`Precios` muestra `PROVISIONAL` durante la sesión. `Historial` y Supabase reciben barras terminadas; el día actual se confirma desde las 17 ET. La web muestra el último cierre, conservando la frecuencia diaria de sus indicadores.

`detenerTemporizadores` registra la parada incluso si hay una descarga activa, elimina timers y permite terminar ese lote. Conserva historia y cursor. Reanudar instalando timers o iniciando una actualización manual.

Solo se eliminan timers conocidos en **este proyecto**. Si el proyecto antiguo es distinto, detenerlos allí. Rotar la clave impide que scripts anteriores sigan escribiendo con la credencial revocada.

## 6. GitHub Pages

Revisar `js/config.js`: mismo Supabase y su clave pública. La raíz publicada debe contener `index.html`, `ticker.html`, `js/` y `data/universe.json`. No subir `original version`, credenciales ni dependencias locales.

Después de verificar la carga, actualizar la rama que utiliza Pages. También se pueden versionar scripts, SQL, herramientas, pruebas y documentación: no contienen secretos. La web sigue sin requerir compilación.

Comprobar la principal, un ticker NYSE como JPM, BRK-B y una empresa de historia corta. Confirmar 250 instrumentos (200 empresas y 50 ETF), los filtros por tipo y los avisos de cobertura. Revisar TQQQ, SOXS, USD y MAGS para comprobar las etiquetas de ETF y objetivos diarios. El sitio anterior permanece operativo hasta desplegar.

## Sustitución de scripts

| Original | Sustitución |
| --- | --- |
| `setup.gs` y resets | `prepararMarketScanner`, conserva historia |
| `YahooFinance.gs` | `Yahoo.gs`, barras diarias con fecha de bolsa |
| `snapchat_diario.gs` | Publicación integrada en la misma descarga validada |
| `backfill_encadenado.gs` | Cursor persistente y lotes en `Code.gs` |
| `marketscanner_supabase.gs` | `Storage.gs`, upsert explícito y clave privada |
| `SingleTicker.gs` | Universo regenerable, sin borrado manual por ticker |
| `limpiar_duplicados.gs` | Unicidad y validación al ingresar; conflictos heredados se reportan |
| `connect.gs`, `MarketScanner_WebApp.gs` | Retirados: la web consulta Supabase |
| `js/indicators.js` sin referencias | Retirado; se conservan los cálculos utilizados por ambas páginas |
