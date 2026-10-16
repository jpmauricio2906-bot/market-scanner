# Instalación v3: fórmulas, cotizaciones y análisis del día

Estado de v3: backend desplegado, 70 pruebas JavaScript y 111 comprobaciones SQL aprobadas. La comprobación de la interfaz en producción se realiza después de publicar. El propietario debe instalar las fórmulas y comprobar su cobertura en Google; no se afirma que sus nuevos temporizadores estén ejecutándose.

## 1. Conservar datos y detener la carga anterior

Guardar una copia del Google Sheets y un respaldo de `market_history`. En el proyecto Google actual, ejecutar `detenerTemporizadores` y comprobar que no quedan ejecuciones anteriores trabajando. Si hay varios proyectos vinculados al archivo, detener también sus timers.

Conservar la pestaña `Historial` como archivo. El flujo nuevo no la utiliza y no exige corregir sus fechas, reservar bloques, construir índices ni importar otro Excel. No borrar esa pestaña para instalar el cambio.

## 2. Desplegar y verificar Supabase

El backend del proyecto ya está desplegado. Para reproducir la instalación se aplica [server_owned_history.sql](../supabase/server_owned_history.sql), el worker y [activate_schedules.sql](../supabase/activate_schedules.sql), seguido de [live_quotes.sql](../supabase/live_quotes.sql). La aceptación integral v3 debe quedar registrada antes de sustituir el script de Google. El conjunto contiene:

- El universo de 250 instrumentos y el calendario de sesiones.
- La RPC privada `market_ingest_recent`, para Yahoo, y `market_ingest_sheet_quotes`, para una captura de las 250 filas calculadas en Google.
- `market_latest_quotes`, una proyección pública de cotizaciones aprobadas, separada del historial de cierres.
- Validación del servidor, almacenamiento privado de provisionales, auditoría, retención y cola de reparaciones.
- El worker `market-history-worker` y los trabajos Cron que lo invocan y mantienen los datos.

Los contratos se describen en [ARQUITECTURA_SUPABASE.md](ARQUITECTURA_SUPABASE.md). El rol público puede leer cierres y la proyección de cotizaciones aprobadas; no puede ejecutar RPC de ingesta, reclamar reparaciones ni acceder a payloads y controles privados.

El worker exige su token privado de servidor, generado y almacenado en Vault por la configuración del backend. Su autenticación se valida antes de reclamar trabajo. Ese token no se copia a Google Sheets ni a GitHub. La clave privada de plataforma que usa internamente la función permanece en el entorno de Supabase.

Las pruebas v3, las regresiones históricas y la lectura pública real de 244 cotizaciones aprobadas de Yahoo están registradas en [VERIFICACION.md](VERIFICACION.md). Esa lectura no comprueba todavía la cobertura de las fórmulas Google ni la instalación del propietario.

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

## 4. Instalar las fórmulas y enviar una captura

Ejecutar esta secuencia con la cuenta propietaria:

1. Detener los timers anteriores y sustituir los `.gs` y el manifiesto.
2. Ejecutar `prepararMarketScanner`. Instala las fórmulas para los 250 instrumentos y migra `Precios` de 21 a 24 columnas sin importar otro Excel. No lee ni ordena `Historial` y conserva la zona horaria del archivo.
3. Esperar el primer cálculo de las fórmulas. Revisar que aparezcan hora de cotización y precios numéricos; no hace falta ejecutar bucles de espera.
4. Ejecutar `comprobarConexion`. Comprueba ambas RPC con lotes vacíos, sin cargar cotizaciones.
5. Ejecutar `actualizarCotizacionesAhora` una vez. Lee las 250 filas en un solo rango y realiza un único envío a Supabase, sin esperar los lotes Yahoo.
6. Revisar la columna M y el informe de aceptados, pendientes y rechazados. Después instalar los temporizadores del apartado siguiente.

Las fórmulas `GOOGLEFINANCE` calculan C:I y V; J:K mantienen el cambio absoluto y porcentual. La bolsa y el símbolo son explícitos, por ejemplo `NASDAQ:AAPL` y `NYSE:BRK.B`. El script envía sus valores actuales sin convertir celdas ausentes en cero.

| Columnas | Contenido |
| --- | --- |
| C:I | Hora del proveedor, OHLCV y cierre anterior calculados por Google |
| L:M | Hora del envío rápido y resultado devuelto por Supabase |
| N | Número de cierres del historial en el servidor |
| V | Retraso declarado por Google Finance, en minutos |
| W:X | Estado de la sincronización histórica y hora de su comprobación |

Supabase valida cada captura. Una cotización Google aprobada sigue siendo provisional incluso después del cierre de mercado: no se convierte en cierre de `market_history`. La app puede usarla para la vela y los indicadores del día mientras no exista una barra confirmada de esa fecha.

| Estado del servidor | Significado |
| --- | --- |
| `FINAL` | Cierre confirmado y aceptado |
| `PROVISIONAL` | Cotización aprobada para el análisis del día, identificada como provisional; no es un cierre histórico |
| `PENDIENTE_DE_ACTUALIZAR` | Faltan datos utilizables o una captura vigente; Yahoo puede seguir esperando el cierre |
| `REEMPLAZO_PENDIENTE` | El backend ha encolado la reconstrucción de la serie |
| `RECHAZADO` | Los datos no superan la validación; el motivo aparece en el estado |

Google puede demorar la cotización hasta 20 minutos y no ofrece todos los atributos para todos los símbolos. El propietario debe comprobar la cobertura de las 250 fórmulas. La hora de envío en L no demuestra que el precio de C:I se haya actualizado. [Documentación de GOOGLEFINANCE](https://support.google.com/docs/answer/3093281?hl=es).

`actualizarMarketScanner` conserva Yahoo como trabajo independiente en segundo plano: hasta 20 instrumentos por ejecución, en grupos de cinco, con objetivo de unos 60 segundos y continuación cada minuto. Solo actualiza N y W:X; no sustituye las fórmulas ni el estado del envío rápido. `verEstadoMarketScanner` muestra ambos resultados.

Una reparación histórica pendiente se ejecuta en Supabase. No ejecutar un backfill desde Google ni volver a importar las 500 sesiones para resolverla. Comprobar el estado del servidor y el worker si esa reparación no progresa.

## 5. Activar los temporizadores de Google

Después de una prueba manual correcta, ejecutar `instalarTemporizadores` con la cuenta propietaria:

| Función | Frecuencia |
| --- | --- |
| `actualizarCotizacionesAhora` | Cada cinco minutos |
| `actualizarMarketScanner` | Cada hora, para Yahoo y cierres |
| `continuarActualizacion` | Cada minuto mientras exista trabajo Yahoo pendiente |

Los disparos programados se limitan a lunes a viernes, entre 09 y 20 de Nueva York. Una petición manual puede ejecutarse fuera de esa ventana. El calendario de bolsa, la vigencia de cotizaciones y la confirmación de cierres pertenecen al servidor.

No se instala una reconstrucción semanal en Google. Las funciones antiguas `iniciarHistorial`, `continuarHistorial` e `iniciarHistorialSemanal` se retiran; las reconstrucciones y auditorías pasan al backend.

`detenerTemporizadores` detiene el emisor Google y conserva su avance. No desactiva los trabajos Cron independientes de Supabase. Para una pausa completa de mantenimiento, detener ambos componentes de forma explícita.

Verificar en el panel de ejecuciones de Google el envío de cinco minutos, la sincronización horaria y una continuación cuando haya trabajo pendiente. No considerar activado el sistema únicamente porque se hayan copiado los archivos.

## 6. Comprobar la aplicación

La aplicación carga cierres de `market_history` con `is_final=true` y consulta las cotizaciones aprobadas de `market_latest_quotes`. La opción intradiaria está activada por defecto: añade la vela provisional de hoy a gráficos e indicadores, hasta 501 barras contando los 500 cierres. Si ya existe un cierre confirmado de esa fecha, lo conserva.

Comprobar los distintivos `PROVISIONAL`, `CONFIRMED` y `OUTDATED`, la fuente y hora disponibles, y la opción de usar solo cierres. `Refresh` consulta las cotizaciones y reutiliza el historial en memoria mientras siga vigente; no ejecuta Apps Script ni fuerza el recálculo de Google Finance. Desmarcar la opción intradiaria usa los cierres ya cargados.

Comprobar 250 instrumentos, filtros de acciones/ETF, una empresa NYSE, una IPO corta y TQQQ, SOXS, USD y MAGS. La hora real del proveedor y la antigüedad deben ser visibles. Las comprobaciones del navegador y de cobertura Google siguen pendientes hasta registrarlas en [VERIFICACION.md](VERIFICACION.md).

La selección de instrumentos debe mantenerse sincronizada entre `data/universe.json`, `Universe.gs` y el universo del servidor. Los cambios de selección no se hacen editando manualmente una fila de `Precios`.
