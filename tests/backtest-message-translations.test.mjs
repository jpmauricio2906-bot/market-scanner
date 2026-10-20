import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {localizeMessage, MESSAGE_TRANSLATIONS} from '../js/backtest/message-translations.mjs';
import {inspectHistory, PRESET_STRATEGIES} from '../js/backtest/lab.mjs';
import {validateStrategy} from '../js/backtest/strategies.mjs';

test('fixed diagnostics translate in either direction and remain stable when rendered again', () => {
  for (const {es,en} of MESSAGE_TRANSLATIONS) {
    assert.equal(localizeMessage(es,'en'),en);
    assert.equal(localizeMessage(en,'es'),es);
    assert.equal(localizeMessage(es,'es'),es);
    assert.equal(localizeMessage(en,'en'),en);
  }
});

test('every literal validation error from the lab, storage, strategy, execution and data client is covered', async () => {
  for (const [path,target] of [
    ['js/backtest/lab.mjs','en'], ['js/backtest/storage.mjs','en'],
    ['js/backtest/strategies.mjs','es'], ['js/backtest/execution.mjs','es'], ['js/data.js','es']
  ]) {
    const source=await readFile(new URL(`../${path}`,import.meta.url),'utf8');
    for (const match of source.matchAll(/throw new Error\((?:'([^']*)'|"([^"]*)")\)/g)) {
      const message=match[1]??match[2];
      assert.notEqual(localizeMessage(message,target),message,`${path}: untranslated error: ${message}`);
    }
  }
});

const dynamicMessages = [
  ['Fechas fuera del calendario revisado (2024–2028).','Dates outside the reviewed calendar (2024–2028).'],
  ['Barra inválida o no confirmada: BRK.B 2026-10-19.','Invalid or unconfirmed bar: BRK.B 2026-10-19.'],
  ['Barra duplicada: BRK.B 2026-10-19. Actualiza el historial.','Duplicate bar: BRK.B 2026-10-19. Refresh history.'],
  ['VLO: no hay cierres disponibles; la ejecución se bloqueará.','VLO: no closing bars are available; execution will be blocked.'],
  ['VLO: 25 barras; necesita 203 para ejecutar. Su asignación permanece en efectivo.','VLO: 25 bars; 203 are required to run. Its allocation remains in cash.'],
  ['VLO: no hay historial confirmado en el período. No se sustituye una descarga ausente por efectivo.','VLO: no confirmed history is available in this period. A missing download is not replaced with cash.'],
  ['VLO: último cierre 2026-10-15, anterior al final 2026-10-19. Actualiza datos o reduce la fecha final.','VLO: last close 2026-10-15, before the end date 2026-10-19. Refresh data or choose an earlier end date.'],
  ['VLO: faltan sesiones entre 2026-10-15 y 2026-10-19. Actualiza o repara el historial antes de ejecutar.','VLO: missing sessions between 2026-10-15 and 2026-10-19. Refresh or repair history before running.'],
  ['No hay aperturas elegibles: se necesitan 202 cierres anteriores más una sesión de ejecución.','No eligible opens: 202 previous closing bars plus an execution session are required.'],
  ['El historial disponible comienza el 2025-01-02; selecciona un inicio dentro de su cobertura.','Available history begins on 2025-01-02; select a start within its coverage.'],
  ['VLO: no alcanza 202 cierres previos; su asignación queda en efectivo en ambas estrategias.','VLO: fewer than 202 previous closing bars; its allocation stays in cash in both strategies.'],
  ['VLO: primera apertura elegible 2026-03-19; mantiene efectivo hasta disponer de historial.','VLO: first eligible open 2026-03-19; cash is held until sufficient history is available.'],
  ['Precios OHLC no válidos el 2026-10-19.','Invalid OHLC prices on 2026-10-19.'],
  ['Las barras de BRK.B deben ser una lista.','Bars must be an array for BRK.B.'],
  ['Las señales deben coincidir con las barras de VLO.','Signals must align with bars for VLO.'],
  ['Las barras de VLO deben tener fechas ISO únicas y ordenadas.','Bars must have unique ascending ISO dates for VLO.'],
  ['Precios de ejecución no válidos para VLO el 2026-10-19.','Invalid execution prices for VLO on 2026-10-19.'],
  ['La fecha de la señal no coincide para VLO.','Signal date is misaligned for VLO.'],
  ['Señal new no válida para VLO el 2026-10-19.','Invalid new signal for VLO on 2026-10-19.'],
  ['2 ticker(s) tienen un historial explícitamente vacío; sus asignaciones iniciales personalizadas permanecen siempre en efectivo.','2 ticker(s) have explicitly empty history; their custom initial allocations remain in cash throughout.'],
  ['1 ticker(s) tienen un historial explícitamente vacío; sus asignaciones iniciales iguales permanecen siempre en efectivo.','1 ticker(s) have explicitly empty history; their equal initial allocations remain in cash throughout.'],
  ['La solicitud de datos falló (HTTP 503).','Data request failed (HTTP 503).'],
  ['El universo de empresas debe contener 225 empresas.','The company universe must contain 225 companies.'],
  ['El universo de ETF debe contener 25 ETF.','The ETF universe must contain 25 ETFs.'],
  ['El universo de mercado debe contener 250 instrumentos.','The market universe must contain 250 instruments.'],
  ['Metadatos de ETF no válidos para SPY.','Invalid ETF metadata for SPY.']
];

test('dynamic diagnostics preserve ticker identifiers, dates, counts and statuses across language switches', () => {
  for (const [es,en] of dynamicMessages) {
    assert.equal(localizeMessage(es,'en'),en);
    assert.equal(localizeMessage(en,'es'),es);
    assert.equal(localizeMessage(es,'es'),es);
    assert.equal(localizeMessage(en,'en'),en);
  }
});

test('actual coverage warnings translate without changing the engine result or input history', () => {
  const rows=[['2026-01-02','VLO',100,102,99,101,1000],['2026-01-05','VLO',101,103,100,102,1000]];
  const before=JSON.stringify(rows);
  const result=inspectHistory(rows,{weights:{VLO:1},strategy:PRESET_STRATEGIES.sma200});
  const original=JSON.stringify(result);
  assert.equal(localizeMessage(result.warnings[0],'en'),'VLO: 2 bars; 203 are required to run. Its allocation remains in cash.');
  assert.equal(JSON.stringify(result),original);
  assert.equal(JSON.stringify(rows),before);
  assert.match(result.warnings[0],/Su asignación permanece en efectivo/);
});

test('strategy validation gets readable Spanish labels without changing parameters or underlying diagnostics', () => {
  const invalid={preset:'custom',entryScore:101};
  assert.throws(()=>validateStrategy(invalid),error=>{
    assert.equal(error.message,'entryScore must be between 0 and 100.');
    assert.equal(localizeMessage(error.message),'La puntuación de entrada debe estar entre 0 y 100.');
    assert.equal(localizeMessage(error.message,'en'),error.message);
    return true;
  });
  assert.deepEqual(invalid,{preset:'custom',entryScore:101});
  assert.equal(localizeMessage('Minimum entry distance must not exceed maximum entry extension.','es'),
    'La distancia mínima de entrada no puede superar la extensión máxima de entrada.');
});

test('unknown diagnostics and markup-like text remain visible verbatim for the caller to escape', () => {
  for (const text of ['Unexpected provider failure: trace=abc123', '<img src=x onerror=alert(1)>', 'prefix: Data request timed out. Please retry.']) {
    assert.equal(localizeMessage(text,'es'),text);
    assert.equal(localizeMessage(text,'en'),text);
  }
  assert.equal(localizeMessage(undefined),'');
  assert.equal(localizeMessage('Failed to fetch','fr'),'No se pudo conectar para descargar los datos.');
});
