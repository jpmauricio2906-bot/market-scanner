# Optimización de backtesting

El modo **Optimización** explora pesos y parámetros dentro del historial cargado. Funciona para una acción, una cartera o una subcartera, con las mismas reglas de ejecución y costes del backtest normal. Los cambios son experimentos locales: no modifican el ranking del scanner, las carteras guardadas ni las reglas de producción.

## Preparar un experimento

1. Seleccionar los activos, sus pesos originales, fechas, capital y costes; cargar su historial.
2. Elegir Optimización y fijar las fechas que separan entrenamiento, validación y prueba final. La propuesta inicial reparte aproximadamente 60% / 20% / 20% de las sesiones. Los mínimos son 252 sesiones de entrenamiento y 126 en cada tramo posterior.
3. Decidir qué buscar: parámetros de las señales, pesos de los componentes de entrada y/o pesos iniciales de los activos. Los valores de búsqueda son listas explícitas; no se adaptan automáticamente a los resultados.
4. Fijar el criterio, el número máximo de candidatos, la preselección y la semilla reproducible. Revisar el protocolo antes de ejecutar.
5. Revisar por separado la selección histórica y el resultado de la prueba final. Descargar el JSON para conservar la búsqueda y los datos utilizados.

La búsqueda de parámetros genera variantes personalizadas que conservan el tipo de salida elegido: ruptura estructural v3 o pérdida de tendencia larga. Para priorizar esta última, seleccionar SMA200 o una estrategia personalizada con esa salida antes de buscar. Los presets v3 y SMA200 se conservan como reglas fijas; la configuración original también participa como candidato de referencia. La búsqueda de pesos de activos conserva el universo seleccionado, exige pesos positivos que sumen 100% y aplica los límites mínimo/máximo indicados, incluida la asignación original. Estos son pesos iniciales: no hay rebalanceo periódico ni transferencia del efectivo entre activos.

Los pesos del Entry Timing Score ponderan momentum, posición y volumen. La combinación original es 50% / 30% / 20%; los pesos elegidos no sustituyen los filtros de recuperación del precio, tendencia, volumen o distancia en ATR. La comisión y el deslizamiento son costes del experimento, no parámetros que el buscador pueda reducir para mejorar su puntuación.

Buscar parámetros o pesos del Entry Timing crea variantes **Personalizadas**, con su filtro de volumen mínimo aplicado a todas las compras. Por ello, incluso al buscar sólo pesos de componentes desde un preset, la variante no equivale al preset salvo por esos pesos. La referencia original permanece literal. Buscar únicamente pesos de activos sí conserva exactamente las señales del modelo elegido.

## Cómo se elige la configuración

La generación de candidatos usa una semilla fija y un presupuesto acotado: 40 candidatos por defecto, con un máximo de 100. No es una búsqueda exhaustiva ni garantiza encontrar un óptimo global. Se registran los candidatos realmente distintos que se evaluaron. La configuración original cuenta dentro de ese presupuesto.

Todos los candidatos se evalúan en entrenamiento. Los mejor clasificados pasan a validación; sólo los resultados de ese tramo eligen al ganador de la preselección. Una vez fijado el ganador, se evalúa en la prueba final. Los candidatos descartados no se prueban allí. Los empates se resuelven de forma determinista.

Los criterios disponibles son rentabilidad anualizada neta (CAGR), Sharpe y CAGR menos una penalización por la magnitud de la caída máxima. Este último permite expresar una preferencia por evitar caídas, pero no convierte esa preferencia en una garantía. Las métricas sin definición, por ejemplo un Sharpe sin variación suficiente, no se convierten en puntuaciones positivas ficticias.

Cada tramo comienza con el mismo capital en efectivo y liquida al cierre final, incluyendo costes. Las curvas de los tres tramos no se encadenan como si fueran una cartera que se mantiene sin interrupción. Las señales pueden usar datos anteriores al tramo para preparar indicadores; las órdenes se ejecutan en la apertura siguiente a la señal, sin conocer ese precio de apertura al decidirla.

Todos los candidatos y comparadores comparten el mayor calentamiento necesario entre las reglas evaluadas. Cada activo debe disponer de ese historial antes del inicio del entrenamiento. Si una IPO es demasiado reciente, se requiere reducir el universo o cambiar las fechas: el buscador no determina su peso a partir de resultados posteriores que no existían en entrenamiento.

## Comparación final

La prueba final muestra cuatro alternativas con las mismas fechas, capital, calentamiento, comisión y deslizamiento:

| Alternativa | Qué permite comprobar |
| --- | --- |
| Estrategia seleccionada, pesos seleccionados | Resultado de la combinación elegida |
| Comprar y mantener, pesos seleccionados | Efecto de las señales dentro de esa misma asignación |
| Estrategia original, pesos originales | Diferencia frente a la configuración de partida |
| Comprar y mantener, pesos originales | Diferencia frente a mantener la cartera inicial |

Los costes se cobran por compra y por venta, incluida la liquidación contable final. El valor inicial sigue siendo comisión **0%** y deslizamiento **0,05% por lado**. Los precios excluyen dividendos en efectivo; ambos comparadores comparten esa base. No hay impuestos, intereses, impacto de mercado dependiente del tamaño ni corrección del sesgo de supervivencia del universo actual.

## Qué significa «fuera de muestra»

La prueba final queda **fuera de la selección automatizada de esta ejecución**. Esto no acredita que el usuario, otra búsqueda o los estudios previos nunca hayan visto esas fechas. La validación participa en la selección y no debe confundirse con la prueba final.

El navegador registra los períodos examinados para advertir sobre solapamientos y repeticiones. Ese registro es local: otro navegador, borrar el almacenamiento o los análisis externos pueden impedir detectar exposiciones anteriores. Cambiar rangos, objetivo, semilla o fechas después de ver la prueba final convierte nuevas ejecuciones sobre ese período en exploración. El módulo no certifica independencia estadística ni rentabilidad futura.

Esta versión utiliza una división cronológica. No implementa walk-forward con múltiples ventanas, validación anidada, probabilidades de sobreajuste ni correcciones de significación por búsquedas múltiples. Para una comprobación más sólida, se deben fijar reglas y esperar datos posteriores aún no observados.

La separación de validación y prueba sigue el principio de evitar que la elección de parámetros use el conjunto de evaluación; para series temporales se conserva el orden cronológico. Véase [validación temporal y separación del test, scikit-learn](https://scikit-learn.org/stable/modules/cross_validation.html). La repetición de búsquedas sobre datos financieros puede sobreajustar incluso usando una partición reservada: [Bailey y otros, The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

## Reproducibilidad y rendimiento

La exportación conserva configuración original, rangos, semilla, candidatos, métricas de selección, ganador, divisiones, costes, resultados de los cuatro comparadores, fuente y copia de los datos. Una huella de selección permite comprobar que modificar los precios de la prueba final no altera la elección del ganador.

El cálculo se ejecuta en un Web Worker y puede cancelarse. Se reutilizan los componentes causales de las señales para evitar calcular todos los indicadores desde cero por candidato. El límite es 40 millones de barras × candidatos solicitados, además del límite de 800.000 barras de entrada; una cartera grande puede necesitar menos candidatos. Los datos largos sólo se descargan para la selección solicitada.

Las pruebas de causalidad modifican todos los precios y volúmenes de la prueba final y comprueban que candidatos, puntuaciones de selección, ganador y huella de selección permanecen idénticos. Otra prueba modifica la validación y exige conservar los candidatos y resultados de entrenamiento. Se comprueban también los costes, el calentamiento común, los límites de peso y el bloqueo de historias que no existían al comenzar el entrenamiento.

