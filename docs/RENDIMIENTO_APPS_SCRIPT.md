# Google descarga datos recientes; Supabase mantiene la historia

Estado al 16/10/2026: backend desplegado y probado, con Cron activo. Falta actualizar y probar el emisor Google con la cuenta propietaria siguiendo [INSTALACION.md](INSTALACION.md).

Apps Script deja de procesar el historial local. Solicita a Yahoo `range=5d`, agrupa cinco respuestas y las envía a `market_ingest_recent`. Los estados de calidad, cierre y reparación los decide Supabase. `Precios` muestra esa respuesta.

Una ejecución admite hasta cuatro grupos de cinco instrumentos, con un objetivo de unos 60 segundos y continuación automática cada minuto. Para 250 instrumentos hacen falta al menos 13 ejecuciones si todos los grupos se completan. El tiempo total depende de Yahoo, Supabase, reintentos y la programación de Google; ese recuento no es una promesa de duración.

El tiempo objetivo deja de iniciar trabajo adicional cuando falta margen. Una petición externa ya iniciada puede excederlo. El cursor se conserva para repetir el grupo pendiente; la ingesta del servidor admite reintentos sin duplicar la clave `(fecha,ticker)`.

## Trabajo que sale de Google

| Responsabilidad | Lugar de ejecución |
| --- | --- |
| Descargar las últimas barras diarias | Apps Script, grupos de cinco |
| Mostrar cotización y estado por ticker | `Precios` |
| Validar identidad, mercado, fecha y OHLCV | RPC de Supabase |
| Decidir si una barra es provisional o final | Supabase, con su reloj y calendario |
| Revisar cobertura, continuidad y correcciones | Auditorías del servidor |
| Descargar y sustituir 500 sesiones | Worker y transacción del servidor |
| Mantener la cola y la retención | SQL y Cron de Supabase |

La pestaña `Historial` queda como archivo opcional. No se lee al preparar, actualizar o consultar progreso; tampoco se ordena ni se construye un índice de sus filas. Los antiguos errores de importación de fechas en esa pestaña no forman parte del nuevo proceso de ingesta.

## Actualizar una instalación existente

1. Detener los temporizadores anteriores y esperar a que termine cualquier ejecución activa.
2. Verificar la migración, RPC, worker y Cron del backend.
3. Sustituir los `.gs` y el manifiesto, manteniendo `SUPABASE_URL` y `SUPABASE_WRITE_KEY` en Propiedades del script.
4. Ejecutar `prepararMarketScanner`, `comprobarConexion` y una actualización manual.
5. Revisar los estados devueltos por Supabase y activar los nuevos temporizadores con la cuenta propietaria.

No es necesario importar otro Excel. La instalación no activa temporizadores por el hecho de copiar el código. Consultar el panel de ejecuciones de Google para comprobar el tiempo real y las continuaciones.

Google conserva sus [cuotas de ejecución y activadores](https://developers.google.com/apps-script/guides/services/quotas). El [activador de un minuto](https://developers.google.com/apps-script/reference/script/clock-trigger-builder) permite continuar trabajos, pero no garantiza puntualidad ni elimina la cuota diaria. Las reparaciones históricas no consumen tiempo de Apps Script.
