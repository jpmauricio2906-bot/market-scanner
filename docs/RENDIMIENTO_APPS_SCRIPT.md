# Ejecuciones cortas de Apps Script

La actualización anterior leía las 124.076 filas completas al iniciar cada ejecución y no limitaba la cantidad de tickers en modo diario. El control de 210 segundos se comprobaba antes de un grupo de cinco, por lo que después podían acumularse descargas correctivas, publicaciones y escrituras hasta superar el límite de Google.

Ahora cada ejecución procesa como máximo cinco tickers y lee solo sus bloques: hasta 2.500 filas del historial. La preparación construye el índice una vez; conserva dos hojas y reserva capacidad para las IPO. Los datos de cada bloque se validan antes de publicarse. Un índice incorrecto produce un error que pide ejecutar la preparación, sin recurrir silenciosamente a una lectura completa.

El objetivo es 90 segundos por ejecución y la continuación se registra previamente cada minuto. Se comprueba el margen antes de empezar más trabajo; una descarga correctiva puede aplazarse con su ticker y cursor guardados. Una petición externa lenta puede exceder el objetivo. Primero se publica en Supabase, después se escriben las hojas y se confirma `flush()`, y solo entonces se avanza el cursor. Un corte permite repetir ese ticker sin duplicar su clave.

## Instalar sobre la hoja que ya funciona

1. Ejecutar `detenerTemporizadores` en el script actual.
2. Sustituir todo el archivo `.gs` por la versión actualizada y guardar. Mantener las propiedades privadas existentes.
3. Ejecutar `prepararMarketScanner` una vez para crear el índice y comprobar el historial existente. No hace falta reimportar el Excel si ya se recuperaron las fechas.
4. Ejecutar `comprobarConexion` y `actualizarMarketScanner`. La primera ejecución debe procesar hasta cinco instrumentos y dejar el resto `EN CURSO`.
5. Ejecutar `instalarTemporizadores`: mantiene la actualización horaria y reconstrucción semanal y crea la continuación cada minuto si hay trabajo pendiente.
6. Consultar `verEstadoMarketScanner` para ver cómo aumenta `completed`; `Precios` muestra el estado de cada ticker. La consulta de progreso no lee el historial completo.

El ciclo completo de 250 instrumentos requiere al menos 50 ejecuciones; los intervalos suman unos 49 minutos, más red, retrasos y reintentos. El cambio reduce el trabajo de cada llamada; no promete terminar los 250 en una única llamada. Las pruebas locales comprueban los límites de filas y tickers, reserva de IPO, pausas, reanudación y orden de escrituras. El tiempo real debe comprobarse en las ejecuciones del proyecto Google del propietario.

No ordenar ni insertar/eliminar filas manualmente mientras los timers trabajan. Tras cambiar la estructura del historial, detener timers y ejecutar `prepararMarketScanner` de nuevo.

Google documenta un límite de seis minutos por ejecución, además de cuotas diarias de activadores. El tiempo de espera entre activadores no equivale a tiempo de ejecución; la frecuencia de continuación no elimina la cuota diaria. [Cuotas oficiales](https://developers.google.com/apps-script/guides/services/quotas). El activador de un minuto es un intervalo admitido por [ClockTriggerBuilder](https://developers.google.com/apps-script/reference/script/clock-trigger-builder).
