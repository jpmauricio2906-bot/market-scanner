# Recuperación de DELL, LABU, MAGS y SPY

El 16/10/2026 Yahoo publicó temporalmente velas diarias incompletas o incoherentes para estos cuatro instrumentos. Supabase las rechazó y conservó el historial confirmado hasta el 15/10. La descarga histórica también devolvía valores `close=null`, por lo que sus trabajos de reparación agotaron cinco intentos. Las cotizaciones Google válidas quedaron bloqueadas mientras esas reparaciones seguían pendientes.

A las 22:36–22:37 de Nueva York se comprobaron respuestas Yahoo corregidas, tanto de cinco días como de tres años. Cada respuesta histórica contenía 753 sesiones, con las últimas 500 completas y sin valores nulos, fechas duplicadas ni OHLCV incoherentes. No se reconstruyó el cierre a partir de precios intradiarios: ese contraste no reproducía exactamente el cierre ni el volumen diario.

Se reabrieron los cuatro trabajos mediante `market_scanner.queue_repair(..., true)` y se invocó el worker privado existente. Los cuatro terminaron entre las 22:38 y las 22:39. `market_replace_history` validó y sustituyó cada serie en su transacción normal, conservando 500 cierres reales, registrando las revisiones y publicando el cierre del 16/10.

| Ticker | Cierre del 16/10 | Estado |
| --- | ---: | --- |
| DELL | 451,71 | FINAL |
| LABU | 198,86 | FINAL |
| MAGS | 71,28 | FINAL |
| SPY | 763,25 | FINAL |

El backend quedó con **250 cotizaciones finales del 16/10**. Google sigue aportando cotizaciones provisionales; no se convirtió ninguna en cierre confirmado ni se corrigió manualmente una vela rechazada.

## Reintentos cuando el proveedor se corrige tarde

La política anterior impedía reclamar trabajos con cinco intentos aunque Yahoo corrigiera después sus datos. `provider_recovery_retries.sql` sustituye ese bloqueo permanente por reintentos con espera: tras los cuatro primeros fallos se esperan 2, 4, 8 y 16 minutos; desde el quinto se espera una hora entre intentos. El despachador solo llama al worker cuando existe trabajo cuyo plazo ya venció.

Cada reclamación sigue limitada a dos trabajos. Conserva las leases de diez minutos, sus tokens y la recuperación de leases vencidas; los trabajos completados no se vuelven a reclamar. Un error nuevo conserva su motivo y vuelve a programarse sin publicar datos rechazados. Los reintentos son independientes de la ventana de los timers de Google, por lo que pueden recuperar una corrección tardía del proveedor.

El cambio afecta únicamente a `market_claim_repairs`, `market_fail_repair` y `dispatch_worker`. Mantiene identidad, moneda, zona horaria, calendario, antigüedad, OHLCV, continuidad, splits, confirmación de cierres, escrituras protegidas y RLS. No abre permisos a roles públicos ni modifica el worker, Apps Script o el frontend.

## Operación

No es necesario copiar otro Apps Script para esta recuperación. Recargar la aplicación consulta los cierres actualizados. Los estados de envío que ya estuvieran escritos en Google se renuevan cuando se ejecuta la siguiente captura o sincronización; no son un registro en tiempo real del trabajo independiente del servidor.

Para una instalación existente, aplicar `supabase/provider_recovery_retries.sql` y ejecutar sus pruebas en `supabase/tests/provider_recovery_retries.sql` conservando `BEGIN`/`ROLLBACK`. Para una instalación nueva, el esquema base contiene las mismas definiciones. La evidencia y el alcance de las comprobaciones están en [VERIFICACION.md](VERIFICACION.md).
