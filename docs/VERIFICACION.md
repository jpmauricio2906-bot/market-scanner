# Verificación de la entrega · 15/10/2026

## Ejecutado

- **36 pruebas aprobadas; cero fallos.** Incluyen cinco pruebas de integración para la ampliación a 250: metadatos, preparación de filas y capacidad, continuación de lotes por los 50 ETF y progreso final `250/250`.
- Pruebas Node: calendario NYSE y zona de Nueva York, retención por empresa, rechazo de OHLCV inválido, prevención de provisionales, claves públicas/privadas, reintentos y checkpoints.
- Regresiones de backend: interrupción superior a un mes, reparación de huecos, splits y correcciones, publicación remota antes del commit local, fallos de descarga y de Supabase, IPO con historia corta y parada de timers bajo bloqueo.
- Frontend mediante Node/VM: 125.000 filas, 250×500 sesiones con paginación limitada por servidor, detalle y comparaciones, fechas, errores de migración, renderizado de 250 filas, filtros por tipo y escape HTML. Se verifican el contrato JSON real y las etiquetas de USD (+2×), MAGS (sin apalancamiento diario) y SOXS (−3×, inverso). Calendarios frontend/backend coinciden en todas las fechas 2024–2030.
- Adaptador de vista previa mediante Node/VM, sin abrir sockets: TQQQ, USD, SOXS y MAGS devuelven 500 barras confirmadas cada uno, con `is_final=true` explícito en la respuesta local.
- Universo: reproducción desde capturas oficiales y verificación de 200 tickers/CIK únicos, capitalizaciones positivas ordenadas y fecha común de las fuentes. Se preservan las 200 empresas y se añaden 50 ETF distintos, con metadatos y enlaces oficiales de emisores. Los generadores validan la composición 200+50 y el total de 250.
- Consultas de solo lectura a Yahoo: se preserva la captura de 99.076 barras de las 200 empresas (22:31:06 UTC) y se añaden 25.000 barras de los 50 ETF (23:10:08 UTC), ambas del 15/10/2026. Cada ETF tiene 500 sesiones válidas. El libro combinado tiene 124.076 barras, con diez series de empresas atrasadas y tres historias cortas; conserva la procedencia y hora por instrumento.
- Consulta de solo lectura a Supabase actual: 44.074 filas y 100 tickers, con 416–441 sesiones por ticker. Se observaron 8 filas con algún OHLC no positivo y 350 con rangos OHLC incoherentes. Es una captura del servicio, distinta de la copia Excel original.

Comandos desde la raíz del proyecto:

```powershell
node --test tests/*.test.cjs
node tools/update-universe.mjs --check
node tools/build-universe.mjs
node tools/probe-yahoo.mjs AAPL BRK-B TSM
node tools/probe-yahoo.mjs --etfs
node tools/merge-history.mjs
```

## Pendiente en las cuentas de producción

No se ejecutó la migración SQL ni ninguna escritura remota. Tampoco se instalaron los timers en Google ni se publicó en GitHub. Hace falta conectar el Google Sheets y aplicar la configuración de instalación con una clave privada nueva.

Las pruebas del backend usan dobles de los servicios Google/Supabase; las consultas públicas Yahoo sí son reales. El timer y la escritura deben verificarse en el proyecto vinculado después de configurar credenciales. El SQL se preparó para PostgreSQL/Supabase, pero no se ejecutó contra una base de pruebas en esta sesión.

La inspección visual de la web local no pudo completarse: el navegador integrado no alcanzó el servidor localhost de Windows. La verificación funcional del frontend sí se ejecutó mediante Node/VM. La herramienta opcional `node tools/preview-server.mjs --snapshot` permite revisar en un navegador local los datos descargados, sin enviar escrituras a Supabase. Utiliza `outputs/yahoo/history-250.json` si existe; de lo contrario utiliza `outputs/yahoo/history.json`, generado con `node tools/probe-yahoo.mjs --all`.
