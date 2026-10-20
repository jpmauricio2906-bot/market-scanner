# Tendencia, momento de entrada y señales

## Por qué casi todo aparecía como Hold

El Composite anterior mezclaba tendencia y reversión. SMA, EMA y MACD aportaban solo ±0,3 mientras una tendencia continuaba; el valor ±1 se reservaba al día del cruce. RSI, Stochastic RSI, Williams %R y Bollinger votaban en sentido contrario por alcanzar un extremo, sin exigir recuperación. Con pesos totales de 22, comprar a partir de 70 requería una media ponderada de +0,4, mientras que vender a 30 requería −0,4. Las señales se cancelaban con frecuencia.

La sobreventa podía aportar hasta 8/22 del peso positivo aunque el precio siguiera cayendo. Tampoco existían categorías globales Strong Buy o Strong Sell: la antigua leyenda describía únicamente las celdas de indicadores.

## Qué significa cada puntuación

| Puntuación | Interpretación |
| --- | --- |
| Composite | Media ponderada configurable de los 14 indicadores. Conserva la fórmula y los pesos; corrige las contribuciones defectuosas. No determina la señal de entrada/salida. |
| Trend | Dirección y estructura de la tendencia, de 0 a 100. Alcista desde 55; bajista hasta 45. |
| Entry Timing | Calidad técnica de una entrada larga: recuperación del momentum, posición y volumen. Mayor es mejor. |
| Exit Pressure | Deterioro de tendencia, momentum y soporte para evaluar una salida/reducción de una posición larga. Mayor implica más presión de salida. No es `100 − Entry`. |

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
- **Entry:** 50% momentum, 30% posición y 20% volumen. Se limita a 49 si falta tendencia alcista, momentum o avance de precio, o si la distancia a EMA20 está fuera de [−1,5, 3] ATR.
- **Exit:** 50% momentum bajista, 30% pérdida de soporte y 20% volumen bajista. La pérdida de soporte es `clamp(50 − 25 × distanciaATR, 0, 100)`. Se limita a 49 sin tendencia bajista, caída de precio o deterioro de momentum.

ATR usa suavizado Wilder de 14 períodos. Para evitar divisiones inestables en series planas, la unidad de normalización tiene un mínimo del 0,1% del precio. Los puntajes se redondean a enteros y se limitan a 0–100. Los cambios corrigen errores del modelo anterior; por eso el Composite no es numéricamente idéntico al anterior.

## Reglas de clasificación

| Señal | Condiciones |
| --- | --- |
| Buy | Entry ≥60, Trend ≥55, momentum de entrada ≥55, precio subiendo y posición dentro de [−1,5, 3] ATR de EMA20. |
| Strong Buy | Todo lo anterior, Entry ≥75, Trend ≥65, momentum ≥65 y volumen relativo ≥1,2 con volumen direccional ≥65. Requiere vela confirmada. |
| Sell | Exit ≥60, Trend ≤45, momentum de salida ≥55 y precio cayendo. |
| Strong Sell | Todo lo anterior, Exit ≥75, Trend ≤35, momentum de salida ≥65 y volumen relativo ≥1,2 con volumen bajista ≥65. Requiere vela confirmada. |
| Hold | No se cumplen las condiciones anteriores. Consultar los motivos y los puntajes, no interpretar como compra implícita. |
| Wait | Historia inferior a 50 sesiones, OHLC inválido o datos atrasados. |

Una vela provisional puede generar Buy/Sell, siempre identificados como provisionales, pero nunca Strong Buy/Strong Sell. Una cotización atrasada no se convierte en señal vigente. Los umbrales son decisiones de diseño; no se presentan como optimizados ni validados para obtener beneficios.

## Auditoría reproducible del 19 de octubre de 2026

Lectura pública a las **21:09 de Nueva York**, con 124.082 barras confirmadas de 250 instrumentos. Se evaluaron hasta 500 barras por ticker. La fecha más reciente es el 19/10; seis instrumentos todavía terminaban el 16/10: CM, IBN, KO, MFG, MMM y WFC. Esta es una fotografía de esa captura, no una cotización en vivo.

| Clasificación | Lógica anterior | Nuevo motor |
| --- | ---: | ---: |
| Strong Buy | 0 | 1 |
| Buy | 0 | 18 |
| Hold | 250 | 199 |
| Sell | 0 | 24 |
| Strong Sell | 0 | 2 |
| Wait | 0 | 6 |

El Composite anterior estaba entre 36 y 62. VLO tenía Composite 62 y Stoch RSI +1; con las correcciones pasa a Composite 56 y Stoch RSI 0. Su Trend es **91**, Entry **36** y Exit **49**: **Hold**, con tendencia alcista y entrada sin recuperación confirmada. Esto responde al problema planteado sin convertir automáticamente un Entry bajo en venta.

La herramienta guarda hash del archivo de entrada, fecha de captura, fechas por ticker, versión y fórmulas legacy congeladas, distribuciones y resultados individuales:

```sh
node tools/audit-scoring.mjs --input /ruta/history.json --output /ruta/audit.json
node --test tests/*.test.cjs tests/*.test.mjs
```

Los resultados de distribución no son un backtest de rentabilidad. Faltan evaluación temporal fuera de muestra, costes, deslizamiento y análisis de resultados posteriores antes de concluir que una señal tiene ventaja económica. No se han ajustado los umbrales para obtener un número deseado de señales.

GitHub Actions ejecuta las pruebas sin credenciales ni acceso a mercado con [scanner-tests.yml](../.github/workflows/scanner-tests.yml). El flujo existente de revisión diaria de cierres sigue separado.

## Referencias de interpretación

La sobrecompra y la sobreventa pueden persistir durante una tendencia; por sí solas no prueban una reversión ([Charles Schwab](https://www.schwab.com/learn/story/how-to-tell-if-market-is-overbought-or-oversold)). Stoch RSI aplica la normalización estocástica a los valores RSI ([Fidelity](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/stochrsi)). Estas fuentes sustentan la interpretación de los indicadores; no validan los pesos ni umbrales de este motor.
