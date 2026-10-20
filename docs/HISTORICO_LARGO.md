# Histórico independiente para Backtesting

El scanner y las fichas conservan su lectura de `public.market_history`: hasta 500 sesiones por instrumento. Backtesting consulta `public.backtest_history` únicamente para los instrumentos seleccionados. Abrir el scanner no descarga el archivo largo.

El archivo solicita once años naturales de precios diarios. El año adicional permite calcular indicadores como SMA200 antes de iniciar una simulación de los últimos diez años. La cobertura de cada acción comienza en su primera sesión real disponible; no se inventan datos anteriores a una IPO. Los parámetros personalizados que exijan más calentamiento pueden acortar el período elegible.

## Datos y validación

- Universo actual: 200 compañías y 50 ETF. No es un universo histórico libre de sesgo de supervivencia.
- Fuente: Yahoo Finance, OHLCV diarios ajustados por splits según el proveedor. Se excluyen los dividendos en efectivo; la comparación con comprar y mantener usa la misma base de precios.
- Solo se aceptan cierres confirmados. Las cotizaciones provisionales de Google Finance permanecen en el circuito del scanner.
- Un calendario separado y versionado cubre 2015–2028, incluidos cierres extraordinarios. No modifica los calendarios de los experimentos históricos congelados.
- La ingesta valida identidad, moneda, zona horaria, fechas, precios, volumen y continuidad. Un dato ausente o inválido no se convierte en cero ni se interpola.
- La sustitución se realiza por ticker, en una transacción, después de validar la descarga completa. Un fallo conserva el último archivo aceptado y registra el motivo.
- La cobertura pública incluye fechas, número de barras, versión, fuente y última actualización. El cliente comprueba la versión antes y después de descargar para evitar mezclar dos revisiones.

El proveedor puede corregir la historia. Por ello, se renueva la serie completa y se actualizan solo las filas que hayan cambiado; añadir exclusivamente el último cierre podría mezclar precios de antes y después de un split. Las exportaciones del backtest conservan los datos utilizados y sus huellas para poder reproducir esa ejecución. El archivo operativo no es una base de datos *point-in-time* de todas las revisiones históricas.

La [auditoría inicial de la fuente](HISTORICO_FUENTE_AUDIT.md) encontró cobertura completa en 249 de 250 instrumentos. SHEL entrega dos barras incoherentes en ambos servidores Yahoo comprobados y queda bloqueado hasta una corrección válida del proveedor. Veintitrés instrumentos comenzaron a cotizar hace menos de diez años.

## Operación y capacidad

El archivo utiliza su propia cola, RPC y Edge Function `backtest-history-worker`. Reutiliza el mecanismo privado de autenticación del servidor; la clave de escritura no llega al navegador. Las tablas públicas permiten lectura mediante RLS, y las tablas de control son privadas.

La actualización nocturna se programa por lotes después del cierre y respeta la hora de Nueva York. El proceso puede seguir trabajando con el ordenador apagado. La renovación de todos los activos tarda más que la actualización del scanner; cada ticker muestra la fecha que realmente tiene disponible.

Antes de la ampliación, la base ocupaba aproximadamente 181 MB en un plan Free con una cuota de base de datos de 500 MB. La nueva ingesta tiene un límite preventivo inferior a esa cuota: si falta espacio, detiene las escrituras del archivo largo y conserva los datos aceptados. No cambia el plan ni contrata capacidad adicional. La cuota incluye índices y el resto de las tablas del proyecto. [Límites y tamaño de base de datos de Supabase](https://supabase.com/docs/guides/platform/database-size).

## Instalación y verificación

1. Aplicar `supabase/backtest_history.sql` sobre la instalación existente.
2. Desplegar `supabase/functions/backtest-history-worker/` con autenticación privada obligatoria en el cuerpo de la función.
3. Ejecutar las pruebas SQL de rollback y las pruebas Node del repositorio.
4. Activar los horarios independientes del archivo y encolar la carga inicial.
5. Verificar la cobertura por ticker, los rechazos, el tamaño de la base y la lectura anónima; confirmar que el scanner mantiene su retención de 500 sesiones.

No se optimizan pesos ni reglas al ampliar los datos. Una futura optimización deberá separar entrenamiento, validación y prueba fuera de muestra, además de conservar costes y comparar contra comprar y mantener. Incorporar más años por sí solo no prueba que una estrategia mejore.
