# Cotizaciones y análisis del día

La versión 3 recupera las fórmulas `GOOGLEFINANCE` de la hoja `Precios` y añade una ruta de envío rápido. El botón **Actualizar cotizaciones ahora** lee los 250 instrumentos calculados en un rango y los envía juntos a Supabase. No espera a que termine el trabajo histórico por lotes.

La aplicación combina los cierres confirmados con una vela provisional de la sesión actual. Esa vela participa en los gráficos y en los indicadores mientras la vista intradiaria está activa. La interfaz identifica que el análisis puede cambiar durante la sesión y muestra la fuente y hora disponibles. El historial de cierres conserva su carácter confirmado.

## Dos rutas con responsabilidades distintas

| Ruta | Fuente | Escritura | Uso |
| --- | --- | --- | --- |
| Cotización rápida | Fórmulas actuales de Google Finance | `market_ingest_sheet_quotes` a `market_latest_quotes` | Precios, vela e indicadores provisionales del día |
| Cierres e historial | Yahoo y mantenimiento del servidor | `market_ingest_recent` y worker a `market_history` | Cierres confirmados, continuidad, revisiones y splits |

Google Finance nunca convierte una cotización en cierre oficial del historial. Supabase valida ambas rutas y mantiene una proyección pública pequeña con las cotizaciones aprobadas. Los eventos, payloads, credenciales y la cola siguen privados.

## Fórmulas de Precios

`prepararMarketScanner` instala las fórmulas para `tradetime`, `priceopen`, `high`, `low`, `price`, `volume`, `closeyest` y `datadelay`. Usa bolsa y símbolo explícitos: por ejemplo, `NASDAQ:AAPL`, `NYSE:BRK.B` y `NYSEARCA:USD`. Los nombres y metadatos del universo son estáticos; J:K conservan las fórmulas de cambio.

Las columnas nuevas son V, retraso del proveedor; W, estado del historial; X, momento de su comprobación. C refleja la hora de la cotización; L refleja el envío a Supabase. Una fecha de envío reciente no demuestra que el proveedor haya actualizado el precio.

La primera instalación puede mostrar celdas pendientes mientras Google calcula las fórmulas. La subida rápida no espera en un bucle a ese cálculo y no reemplaza datos ausentes por cero. Supabase devuelve un resultado por ticker y conserva el último dato aprobado cuando una nueva captura es incompleta o incoherente.

## Uso diario

Con los activadores activos no hay funciones manuales obligatorias. Para enviar los valores calculados de la hoja, ejecutar `actualizarCotizacionesAhora` una vez. Para consultar el estado, usar `verEstadoMarketScanner`.

`instalarTemporizadores` instala la cotización rápida cada cinco minutos y la sincronización Yahoo cada hora; la continuación histórica de un minuto solo existe mientras queda trabajo. Los disparos programados respetan la ventana de lunes a viernes, 09 a 20 de Nueva York. Una petición manual puede ejecutarse fuera de esa ventana.

`actualizarMarketScanner` conserva el trabajo de Yahoo por lotes para los cierres; no es el botón rápido que hace falta para enviar la hoja completa. No se ejecuta un backfill de 500 sesiones en Google.

## Actualizar la aplicación

El refresco rápido de la web consulta las cotizaciones publicadas y reutiliza los cierres cargados cuando siguen vigentes. No fuerza el recálculo de Google Finance ni ejecuta Apps Script desde el navegador. Para publicar una captura nueva primero debe producirse un envío desde Google, manual o programado.

Una cotización provisional no sobrescribe una barra confirmada de la misma fecha. Si hay una revisión de escala o un split por reparar, esa cotización no se mezcla con un historial incompatible. Una reconstrucción histórica tampoco debe hacer retroceder la cotización del día a la fecha anterior.

La aplicación también comprueba que su historial en memoria corresponda a la escala del cierre previo canónico que devuelve el servidor. Si la diferencia supera la tolerancia —el mayor valor entre 0,02 USD y el 0,5 % del cierre canónico—, renueva el historial una vez antes de combinar la cotización provisional. Si la discrepancia persiste, mantiene los cierres sin añadir esa vela y muestra el aviso correspondiente.

## Límites del proveedor

La rapidez del envío no garantiza una cotización bursátil instantánea. Google documenta retrasos de hasta 20 minutos y atributos no disponibles para algunos símbolos. La interfaz conserva información de antigüedad/fuente; los símbolos sin datos utilizables continúan dependiendo de la captura Yahoo aprobada cuando existe. La cobertura real de las 250 fórmulas debe comprobarse en la hoja del propietario.

El histórico de Google Finance no puede recuperarse mediante Apps Script o la API de Sheets; por eso esta ruta utiliza únicamente atributos actuales. El historial sigue en Yahoo/Supabase. [Documentación de GOOGLEFINANCE](https://support.google.com/docs/answer/3093281?hl=es).
