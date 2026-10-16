# Envío rápido de cotizaciones e historial en segundo plano

Estado de v3: backend desplegado, 70 pruebas JavaScript y 111 comprobaciones SQL aprobadas. La interfaz en producción se comprueba después de publicar. El propietario debe instalar y probar las fórmulas en la hoja existente según [INSTALACION.md](INSTALACION.md).

## Cotizaciones: 250 instrumentos en un envío

`prepararMarketScanner` instala fórmulas actuales `GOOGLEFINANCE` para los 250 instrumentos. Se calculan hora del proveedor, OHLCV, cierre anterior y retraso. La hoja pasa de 21 a 24 columnas sin importar otro Excel; `Historial` queda intacto.

`actualizarCotizacionesAhora` lee un único rango con las 250 filas y envía un POST a `market_ingest_sheet_quotes`. Supabase valida y devuelve un resultado por instrumento. L:M muestran el momento del envío y su estado; N muestra la cobertura histórica. No hay 250 peticiones individuales ni un cursor de descarga en esta ruta.

El envío utiliza un bloqueo de documento independiente del trabajo Yahoo. Puede ejecutarse mientras ese trabajo conserva su propio bloqueo. La subida no espera en un bucle a que Google termine de calcular las fórmulas: si faltan datos, el servidor conserva la última cotización aprobada y devuelve el estado correspondiente.

La rapidez del envío no determina la hora del precio. C muestra la hora del proveedor y V su retraso declarado; L muestra la hora del envío. Google documenta retrasos de hasta 20 minutos y atributos no disponibles para algunos símbolos. La cobertura de las 250 fórmulas debe comprobarse con la cuenta del propietario. [GOOGLEFINANCE](https://support.google.com/docs/answer/3093281?hl=es).

## Yahoo e historial

`actualizarMarketScanner` solicita a Yahoo cinco días de barras diarias. Procesa hasta cuatro grupos de cinco instrumentos, con un objetivo de unos 60 segundos y continuación automática cada minuto. Para recorrer 250 instrumentos hacen falta al menos 13 ejecuciones si todos los grupos se completan; la actualización rápida de la hoja funciona de forma independiente.

El margen de ejecución deja de iniciar trabajo adicional cuando falta tiempo. Una petición externa ya iniciada puede exceder el objetivo. El cursor se conserva y la RPC del servidor admite reintentos idempotentes.

Esta ruta solo escribe la cobertura en N y su estado en W:X. Conserva las fórmulas C:K y V y el resultado rápido de L:M. Supabase valida los cierres y el worker privado descarga las reconstrucciones de 500 sesiones. Google no lee, compara ni ordena la pestaña histórica.

## Temporizadores y refresco de la aplicación

| Operación | Frecuencia o alcance |
| --- | --- |
| Envío rápido de la hoja | Cada cinco minutos |
| Inicio del trabajo Yahoo | Cada hora |
| Continuación Yahoo | Cada minuto mientras exista trabajo pendiente |
| Worker y auditorías del historial | Cron de Supabase, independiente de Google |

Los disparos programados de Google respetan lunes a viernes, 09–20 de Nueva York; una ejecución manual puede hacerse fuera de esa ventana. La instalación de timers sigue requiriendo la cuenta propietaria y una comprobación en su panel de ejecuciones.

El botón `Refresh` de la web consulta `market_latest_quotes` y reutiliza los cierres en memoria durante su vigencia, hasta 60 minutos o un cambio de sesión esperada. Cambiar entre análisis intradiario y solo cierres usa la caché. Ese refresco no fuerza el recálculo de Google Finance ni ejecuta Apps Script desde el navegador.

La vista intradiaria añade hasta una vela provisional de hoy a los 500 cierres. Puede cambiar precios, gráficos e indicadores durante la sesión y aparece identificada con fuente y hora. Una fecha ya confirmada conserva su barra final. La última cotización aprobada de hoy puede permanecer en el análisis cuando envejece, marcada `OUTDATED` con su hora original. Una captura incompleta no se convierte en una vela nueva y una cotización pendiente de reparación no se mezcla con una serie incompatible.

La actualización no exige otro Excel ni nuevas claves. Conservar `SUPABASE_URL` y `SUPABASE_WRITE_KEY`, sustituir script y manifiesto, preparar las fórmulas, esperar el primer cálculo y probar `actualizarCotizacionesAhora` antes de instalar los timers.

Las [cuotas de Google](https://developers.google.com/apps-script/guides/services/quotas) siguen aplicándose. Programar un activador no garantiza su puntualidad ni elimina el límite de ejecución. Los límites del envío rápido, del proveedor y de las reparaciones son independientes.
