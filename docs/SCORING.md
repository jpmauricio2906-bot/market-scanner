# Tendencia, momento de entrada y señales

La versión vigente del motor es **v3.0.0**. Conserva Composite, Trend y Entry de v2; cambia las salidas para mantener tendencias de varias semanas durante retrocesos normales. Las categorías antes mostradas como Strong Buy y Strong Sell se presentan como **Confirmed buy** y **Confirmed sell**: describen confirmación técnica adicional, sin atribuirles mayor probabilidad de éxito ni mayor rentabilidad esperada. Los identificadores internos `STRONG_BUY` y `STRONG_SELL` se conservan por compatibilidad.

Las reglas se fijaron antes de evaluar la muestra histórica reservada y están registradas en [exit-v3-protocol.json](../data/validation/exit-v3-protocol.json). El [estudio de validación de salidas](EXIT_VALIDATION.md) documenta la comparación económica y sus límites. Esta página describe el funcionamiento del motor, sin afirmar que sus señales superen a comprar y mantener.

## Por qué casi todo aparecía como Hold

El Composite anterior mezclaba tendencia y reversión. SMA, EMA y MACD aportaban solo ±0,3 mientras una tendencia continuaba; el valor ±1 se reservaba al día del cruce. RSI, Stochastic RSI, Williams %R y Bollinger votaban en sentido contrario por alcanzar un extremo, sin exigir recuperación. Con pesos totales de 22, comprar a partir de 70 requería una media ponderada de +0,4, mientras que vender a 30 requería −0,4. Las señales se cancelaban con frecuencia.

La sobreventa podía aportar hasta 8/22 del peso positivo aunque el precio siguiera cayendo. Tampoco existían categorías globales Strong Buy o Strong Sell: la antigua leyenda describía únicamente las celdas de indicadores.

## Qué significa cada puntuación

| Puntuación | Interpretación |
| --- | --- |
| Composite | Media ponderada configurable de los 14 indicadores. Conserva la fórmula y los pesos; corrige las contribuciones defectuosas. No determina la señal de entrada/salida. |
| Trend | Dirección y estructura de la tendencia, de 0 a 100. Alcista desde 55; bajista hasta 45. |
| Entry Timing | Calidad técnica de una entrada larga: recuperación del momentum, posición y volumen. Mayor es mejor. |
| Exit Pressure | Profundidad de la pérdida de SMA50, persistencia bajo esa media y pendiente de SMA50 para evaluar una salida de una posición larga. No es `100 − Entry` y no usa el momentum de v2 como condición de salida. |

Son reglas técnicas transparentes, no probabilidades de éxito ni recomendaciones personalizadas. Entry se calcula por separado del Composite y de sus presets, pero comparte datos de mercado con Trend: no es estadísticamente independiente. Un precio extendido en una tendencia alcista puede tener Entry bajo sin una señal de venta.

El ranking inicial ordena por Entry. Se puede ordenar por Trend, Exit o Composite. Los presets y pesos modifican exclusivamente Composite y se comparten entre la tabla y la ficha en el mismo navegador.

## Fórmulas y correcciones

El motor único es [js/scoring.js](../js/scoring.js). Ambas páginas usan las mismas funciones para puntajes e indicadores. No hay calibración por percentiles ni cuotas de compras/ventas.

- **Composite:** `round(50 × (1 + sum(weight × signal)/sum(weight)))`. Sin pesos activos devuelve 50. RSI, Stoch RSI, Williams y Bollinger necesitan que el oscilador se recupere desde un extremo reciente y que el precio se mueva en la misma dirección. Un cruce de salida del extremo recibe ±1; una recuperación parcial puede recibir ±0,5. Permanecer sobrevendido/sobrecomprado no genera un voto de reversión.
- **Neutralidad:** medias iguales e histograma MACD cero aportan cero; RSI de precios constantes vale 50. ATR mide riesgo y distancia, por lo que su contribución direccional al Composite es cero. Su peso se conserva por compatibilidad.
- **Volumen:** la contribución OBV usa el balance de volumen firmado de las últimas 20 sesiones, dividido por su volumen total. Evita depender del origen arbitrario del OBV acumulado. El gráfico conserva el OBV acumulado habitual.
- **Trend:** 70% estructura y 30% pendiente de SMA20 en cinco sesiones, normalizada por 1,5 ATR. La estructura promedia los signos de SMA5−SMA20, EMA12−EMA26 y cierre−SMA50. Las medias correlacionadas forman un solo bloque; no son tres confirmaciones independientes.
- **Momentum:** cambio en tres sesiones de RSI (35%, escala 10 puntos), histograma MACD (35%, escala 0,2 ATR) y precio (30%, escala 1,5 ATR). Cada cambio se limita a [−1,1] y el resultado se convierte a 0–100.
- **Posición de entrada:** `clamp(100 − 25 × abs(distanciaATR − 0,25), 0, 100)`, donde `distanciaATR = (cierre − EMA20)/ATR`.
- **Volumen direccional:** combina a partes iguales el balance firmado de 20 sesiones y la dirección del último cierre ponderada por volumen relativo. La media de volumen excluye la sesión evaluada. Sin una base de volumen utilizable, la contribución es neutral y no confirma señales fuertes.
- **Entry:** 50% momentum, 30% posición y 20% volumen. Se limita a 49 si falta tendencia alcista, momentum o avance de precio, o si la distancia a EMA20 está fuera de [−1,5, 3] ATR. Sus reglas de compra permanecen iguales a v2; si una salida estructural coincide con una entrada, la salida tiene prioridad.

ATR usa suavizado Wilder de 14 períodos. Para evitar divisiones inestables en series planas, la unidad de normalización es `U[t] = max(ATR14[t], 0,001 × cierre[t])`. Los componentes y puntajes se redondean a enteros y se limitan a 0–100. Composite es idéntico entre v2 y v3, aunque difiere del modelo original anterior a v2 por las correcciones descritas.

## Exit Pressure y salidas estructurales de v3

Sea `S[t]` la SMA50 en la sesión `t`, `d50 = (cierre[t] − S[t])/U[t]` y `n` el número de cierres consecutivos más recientes bajo su propia SMA50, con máximo tres. Cada cierre se compara con la media disponible en esa sesión, no con la media del último día. Con `R(x) = round(clamp(x, 0, 100))`:

- **Profundidad:** `R(50 − 25 × d50)`.
- **Persistencia:** `R(100 × n/3)`.
- **Pendiente:** `R(50 − 25 × (S[t] − S[t−5])/U[t])`; si no existe `S[t−5]`, el componente vale 50 y la salida persistente queda bloqueada.
- **Exit Pressure base:** `R(0,50 × profundidad + 0,30 × persistencia + 0,20 × pendiente)`.

El puntaje se limita a **59** si no se confirma ninguna de las dos rutas de salida. Si se confirma A o B, tiene un mínimo de **60**; la ruta B establece un mínimo de **80**. Un valor elevado, por sí solo, no elude las condiciones estructurales.

**A. Pérdida persistente de soporte.** Requiere simultáneamente:

1. Tres cierres consecutivos por debajo de su SMA50 contemporánea.
2. `S[t] ≤ S[t−5]`: la SMA50 ya no sube respecto de cinco sesiones antes.
3. `cierre[t] < S[t] − U[t]`: pérdida mayor que un ATR actual.

Esta ruta necesita al menos **55 barras**. No exige un cierre descendente en el último día, volumen elevado ni los antiguos filtros de Trend/momentum de salida: un pequeño rebote no cancela una ruptura persistente.

**B. Salida de emergencia.** Requiere simultáneamente:

1. `cierre[t] < mínimo(low[t−20 … t−1]) − U[t−1]`.
2. `cierre[t] < S[t] − 2 × U[t−1]`.
3. Volumen relativo actual ≥1,5 y `cierre[t] < cierre[t−1]`.

La emergencia utiliza el **ATR de la sesión anterior**, con el suelo del 0,1% de su cierre, y el mínimo de las 20 sesiones anteriores excluyendo la actual. Así, la caída de hoy no eleva su propio umbral de ATR. Está disponible desde **50 barras**. Sin una base de volumen utilizable no puede activar B; A sigue disponible con historia suficiente.

Ambas rutas exigen una **vela diaria confirmada**. Con 50–54 barras el motor sigue calculando puntuaciones y entradas; solo A está indisponible por falta de historia. El estado provisional bloquea ambas salidas y mantiene Exit Pressure por debajo de 60.

## Reglas de clasificación

| Señal | Condiciones |
| --- | --- |
| Buy | Entry ≥60, Trend ≥55, momentum de entrada ≥55, precio subiendo y posición dentro de [−1,5, 3] ATR de EMA20. |
| Confirmed buy (`STRONG_BUY`) | Buy y todos los filtros fuertes de v2: Entry ≥75, Trend ≥65, momentum ≥65 y confirmación de volumen alcista con componente direccional ≥65. Además, ruptura y mantenimiento del nivel congelado durante dos cierres, volumen relativo actual ≥1,5, anterior ≥1,2 y cierre actual sobre SMA50. Requiere vela confirmada. |
| Sell | Vela confirmada y ruta estructural A o B. Exit ≥60 queda garantizado por esas rutas. Tiene prioridad sobre una compra coincidente. |
| Confirmed sell (`STRONG_SELL`) | Sell por la ruta A y dos cierres por debajo del mismo soporte congelado, con volumen relativo actual ≥1,5 y anterior ≥1,2. No requiere los antiguos filtros de Trend, momentum ni Exit ≥75 de v2. Una emergencia de un solo día no basta. |
| Hold | No se cumplen las condiciones anteriores. Consultar los motivos y los puntajes, no interpretar como compra implícita. |
| Wait | Historia inferior a 50 sesiones, OHLC inválido o datos atrasados. |

Para **Confirmed buy**, el cierre anterior debe ser estrictamente mayor que el máximo de los `high` de las 20 barras que preceden a esa vela. El cierre actual debe mantenerse en ese nivel o por encima. Para **Confirmed sell**, ambos cierres deben ser estrictamente menores que el mínimo de los `low` de esas mismas 20 barras previas. El nivel se congela antes de ambas velas (`data.slice(-22, -2)`); no se recalcula incluyendo la ruptura anterior.

Cada volumen relativo divide el volumen de su sesión entre la media de sus **20 sesiones previas**, excluyéndose a sí misma. Confirmed buy conserva también el filtro alcista de v2 que exigía volumen relativo ≥1,2 y componente direccional ≥65; el nuevo mínimo actual de 1,5 es más exigente. Las dos confirmaciones de precio y volumen son condiciones técnicas, no observaciones estadísticamente independientes.

Una vela provisional puede generar **Buy**, identificada como provisional, pero nunca Sell ni las categorías Confirmed. Una cotización atrasada devuelve **Wait**, aunque conserve los puntajes para inspección. Los umbrales son decisiones de diseño; no se presentan como optimizados ni validados para obtener beneficios.

El análisis expone `exitPersistent`, `exitEmergency`, `exitConfirmed`, `distance50Atr`, `sma50`, `priorSma50` y `supportBreakStreak` en sus métricas. `technicalConfirmation` vale `BREAKOUT_HELD_TWO_CLOSES`, `BREAKDOWN_HELD_TWO_CLOSES` o `null`, según la clasificación final.

## Archivo histórico: auditoría v1 frente a v2 del 19 de octubre de 2026

Los datos siguientes pertenecen a la **auditoría original de v2**, anterior a las salidas estructurales de v3. No representan la distribución ni los puntajes del motor vigente. La lectura pública se hizo a las **21:09 de Nueva York**, con 124.082 barras confirmadas de 250 instrumentos. Se evaluaron hasta 500 barras por ticker. La fecha más reciente era el 19/10; seis instrumentos todavía terminaban el 16/10: CM, IBN, KO, MFG, MMM y WFC. Es una fotografía archivada, no una cotización en vivo.

| Clasificación histórica | Original v1 | Motor v2 |
| --- | ---: | ---: |
| Strong Buy | 0 | 1 |
| Buy | 0 | 18 |
| Hold | 250 | 199 |
| Sell | 0 | 24 |
| Strong Sell | 0 | 2 |
| Wait | 0 | 6 |

El Composite original estaba entre 36 y 62. En esa captura VLO tenía Composite 62 y Stoch RSI +1; con las correcciones de v2 pasaba a Composite 56 y Stoch RSI 0. Su Trend era **91**, Entry **36** y Exit **49**: **Hold**, con tendencia alcista y entrada sin recuperación confirmada. El Exit 49 pertenece a la fórmula de v2 y no debe interpretarse como un resultado actual de v3.

La herramienta de auditoría guarda hash del archivo de entrada, fecha de captura, fechas por ticker, versión y fórmulas legacy congeladas, distribuciones y resultados individuales. Ejecutarla ahora compara v1 con el **motor vigente**, por lo que no reproduce las etiquetas ni Exit de esta fotografía histórica de v2:

```sh
node tools/audit-scoring.mjs --input /ruta/history.json --output /ruta/audit.json
node --test tests/*.test.cjs tests/*.test.mjs
```

Los resultados de distribución no son un backtest de rentabilidad. El [primer backtest, archivado como v1 frente a v2](BACKTEST.md), redujo Hold del 99,999% al 70,02% de las observaciones elegibles, pero no demostró una mejora del timing frente a comprar y mantener. Las ventas de **v2**, incluidas sus categorías fuertes, tuvieron una ventaja media negativa a 5, 10 y 20 sesiones. `tools/backtest-signals.mjs` y `tools/backtest.mjs` mantienen esa comparación mediante la [copia congelada de v2](../tools/baselines/scoring-v2.cjs); no sustituyen retrospectivamente v2 por v3.

## Evaluación de v3 y costes

La [validación de salidas v3](EXIT_VALIDATION.md) y su [protocolo](../data/validation/exit-v3-protocol.json) separan el período ya examinado de 2025–2026 de una muestra histórica reservada de 2018–2023. El protocolo fija una sola candidata, sin búsqueda de parámetros ni selección de reglas después de examinar esa muestra. Al ser una muestra anterior a las observaciones que motivaron el diseño, constituye una validación histórica reservada, **no una validación cronológica o prospectiva fuera de muestra**. La selección del universo actual y posibles revisiones de datos siguen siendo limitaciones.

La comparación incorpora **comisión de $0**, conforme al bróker del usuario, y un deslizamiento principal supuesto de **0,05% por cada compra o venta**, con sensibilidad a 0%, 0,10% y 0,25%. Las órdenes se simulan en la apertura siguiente a una señal, y el cierre final fijado de antemano también incluye costes. Se comparan v2, v3, comprar y mantener y las entradas v2 sin salidas por señal. Menor rotación o caída máxima no bastan para declarar superioridad en rentabilidad frente a comprar y mantener.

Las categorías Confirmed se evalúan por separado de las ordinarias; un tamaño de muestra insuficiente no permite atribuirles superioridad económica. Una validación prospectiva requiere observaciones futuras posteriores a la congelación de las reglas. El informe conserva resultados adversos y distingue cambios en el comportamiento de las operaciones de una mejora de rentabilidad demostrada.

GitHub Actions ejecuta las pruebas sin credenciales ni acceso a mercado con [scanner-tests.yml](../.github/workflows/scanner-tests.yml). El flujo existente de revisión diaria de cierres sigue separado.

## Referencias de interpretación

La sobrecompra y la sobreventa pueden persistir durante una tendencia; por sí solas no prueban una reversión ([Charles Schwab](https://www.schwab.com/learn/story/how-to-tell-if-market-is-overbought-or-oversold)). Stoch RSI aplica la normalización estocástica a los valores RSI ([Fidelity](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/stochrsi)). Estas fuentes sustentan la interpretación de los indicadores; no validan los pesos ni umbrales de este motor.
