# Módulo de Backtesting

Abrir **Backtesting** desde el scanner, o **Backtest** desde la ficha de una acción para seleccionarla directamente. El cálculo se ejecuta en un Web Worker del navegador. La pestaña debe permanecer abierta; Cancelar detiene el cálculo.

## Selección de activos y carteras

Seleccionar uno o varios instrumentos del universo, escribir sus pesos iniciales y hacer que sumen 100%. Igualar reparte el capital por igual; Normalizar conserva la proporción introducida y la convierte explícitamente a 100%. No se normalizan errores de asignación de forma silenciosa.

Una cartera guarda su nombre y sus pesos en este navegador. Una subcartera guarda un subconjunto de una cartera padre, con sus propios pesos sumando 100%. Se simula como una cartera independiente con el capital indicado, no como una contribución proporcional al capital del padre. Los guardados no se sincronizan entre dispositivos. El módulo no necesita posiciones ni credenciales del bróker.

Cada activo recibe su asignación inicial y utiliza sólo ese capital. Al vender, conserva el efectivo para su próxima entrada. No hay rebalanceo, redistribución entre activos, posiciones cortas, nuevas aportaciones ni interés sobre el efectivo. Los pesos efectivos cambian con la rentabilidad. Los ETF apalancados mantienen el apalancamiento ya incorporado en sus precios.

## Estrategias y parámetros

| Estrategia | Reglas |
| --- | --- |
| v3 | Preset fijo que reproduce las señales actuales: entrada por recuperación y salida estructural de SMA50, incluida la salida de emergencia definida por v3. |
| SMA200 · tres cierres | Compras literales de v3 y venta sólo tras tres cierres consecutivos bajo su SMA200 contemporánea. La venta prevalece sobre una compra coincidente. |
| Personalizada | Umbrales de entrada, tendencia, momentum, volumen y distancia en ATR editables; salida estructural v3 con umbral de Exit Pressure, o pérdida de una media de 20–250 sesiones durante 1–10 cierres. |

Los presets fijos no aceptan cambios de parámetros: seleccionar Personalizada para experimentar. Los archivos originales de las evaluaciones publicadas y el scorer de producción permanecen separados de este módulo.

En Personalizada, el Entry Score se reconstruye a partir de los componentes originales: 50% momentum, 30% posición y 20% volumen. Se aplican después los filtros elegidos, evitando que los límites internos de v3 impidan relajar un parámetro. El precio debe estar recuperándose. El volumen relativo mínimo se exige a **todas** las compras personalizadas, por lo que los valores iniciales de Personalizada no equivalen exactamente a v3.

“Sólo compras confirmadas” añade dos cierres sosteniendo una ruptura, el volumen mínimo configurado en ambas velas y mínimos de 65 en tendencia/momentum, 75 en entrada y 65 en componente de volumen. No modifica las ventas ni afirma una mayor rentabilidad esperada. El umbral de salida v3 no elimina su requisito de ruptura estructural; un umbral bajo no fabrica ventas sin ruptura.

La media configurable sólo controla la salida de largo plazo. Las medias y demás períodos internos de los componentes de entrada de v3 mantienen su definición original. Los controles que no corresponden a la modalidad elegida se desactivan.

## Historial y ejecución

Esta versión utiliza las **últimas 500 sesiones confirmadas** que proporciona el scanner; las IPO pueden tener menos. Muestra las fechas realmente disponibles por activo y la primera apertura elegible. No incluye las capturas de décadas utilizadas en los estudios anteriores ni rellena precios anteriores al historial disponible.

Ambos comparadores usan idénticos pesos, fechas, capital, costes y calentamiento. V3 necesita 50 cierres anteriores; SMA200 con tres confirmaciones necesita 202. Una acción sin suficientes barras conserva su asignación en efectivo en ambas estrategias. Esto puede retrasar la inversión del benchmark; se muestra explícitamente, y no equivale a comprar desde una fecha anterior para la que no hay historial suficiente.

La señal se calcula con los datos disponibles al cierre de cada sesión, con un máximo de 500 barras anteriores. Se ejecuta en la **apertura siguiente** y sólo si corresponde a la siguiente sesión del calendario revisado. La vela provisional queda excluida. El último cierre del período liquida las posiciones a efectos contables y cobra sus costes; esta liquidación no es una señal de venta.

Los costes se indican por cada compra y venta. El valor inicial es comisión **0%** y deslizamiento **0,05%** por lado. El deslizamiento empeora el precio de ejecución y la comisión reduce el capital disponible; no se descuentan sólo al final del informe. No se modelan tarifas fijas por orden, spreads observados, impuestos o impacto de mercado dependiente del tamaño.

Los resultados son **rentabilidad de precios, sin dividendos**, bajo la representación histórica que entrega el proveedor. No incorporan un libro separado de ajustes corporativos ni sustituyen una base de retornos totales. Se utiliza el universo actual, con posible sesgo de supervivencia. El módulo rechaza barras inválidas, duplicadas, huecos internos o falta del cierre final en un activo seleccionado; no presenta una valoración desactualizada como una venta ejecutable.

## Lectura y conservación del resultado

Se comparan capital final, rentabilidad acumulada y anualizada, caída máxima al cierre, Sharpe con efectivo al 0%, exposición, costes y ciclos completos de compra/venta. Las curvas muestran capital y caída desde el máximo; las tablas permiten revisar las operaciones y el resultado de cada activo. La anualización en períodos cortos puede exagerar su representatividad.

Exportar JSON conserva configuración efectiva, versión del motor, huellas SHA-256, barras utilizadas y ambos libros de resultados. Las exportaciones CSV permiten revisar curvas y operaciones. Los resultados no se guardan automáticamente al cerrar la pestaña: descargar el JSON para conservar cada experimento. Si cambian los controles, el resultado anterior sigue identificado como correspondiente a su configuración original hasta volver a ejecutar.

Cada ejecución es **exploración histórica**. No busca automáticamente la combinación ganadora ni denomina fuera de muestra a un rango elegido en el formulario. Cambiar reglas tras mirar un período consume su independencia; una validación nueva requiere fijar previamente el experimento y reservar datos que no se hayan utilizado para decidirlo.

## Implementación y verificación

`js/backtest/lab.mjs` valida y recorta los datos antes de generar señales. `strategies.mjs` conserva presets y parámetros; `execution.mjs` adapta el motor de ejecución congelado a asignaciones ponderadas. `worker.mjs` realiza el cálculo fuera del hilo de interfaz. Las carteras y la interfaz se encuentran en `storage.mjs` y `ui.mjs`.

Las pruebas comprueban igualdad de los presets con v3/SMA200 originales, causalidad al añadir datos futuros, eficacia de los parámetros, reconciliación de carteras ponderadas con sus subcarteras independientes, costes por ambos lados, calendarios, datos ausentes y conservación de asignaciones en efectivo. Ejecutar `node --test tests/*.test.cjs tests/*.test.mjs` desde la raíz.
