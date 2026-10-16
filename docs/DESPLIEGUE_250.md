# Carga verificada de 250 instrumentos

Verificación del 16 de octubre de 2026 (UTC), con cierre de mercado del 15 de octubre de 2026.

## Supabase

- Universo: 200 empresas y 50 ETF.
- 124.076 barras diarias confirmadas, únicas y válidas; 250 instrumentos con el cierre esperado.
- 247 instrumentos tienen 500 sesiones. SPCX conserva 87, SKHY 69 y SNDK 420, correspondientes a sus historias reales de IPO.
- Las diez empresas atrasadas de la captura Excel inicial se volvieron a consultar y ahora incluyen el cierre del 15/10/2026.
- Se conservaron intactas 25.111 filas de los 57 tickers antiguos fuera del universo, con `is_final=false`; el frontend no las utiliza.

El cliente real del frontend leyó todas las páginas y comparó cada fecha y valor OHLCV con la carga validada: cero diferencias, duplicados, valores inválidos, provisionales, instrumentos faltantes o atrasados. Pasaron los 14 controles del verificador. Hash SHA-256 canónico esperado y remoto: `ea680abc0b24b632af720bf584ce5a9ab18116beca90ff73ca0b29cf52206486`.

Se aplicaron las migraciones `market_history_quality_and_final_closes_250` y `market_history_remove_redundant_read_policy_and_index`. Se reutiliza la clave primaria para el upsert y queda una sola política pública de lectura, sin permisos públicos de escritura. Los asesores de seguridad y rendimiento de Supabase no reportaron incidencias al finalizar.

## GitHub y respaldo

GitHub Pages utiliza `main` desde la raíz. La versión anterior se conserva en la rama `backup/before-250-20261015`, commit `f2853b054b6fceab8e64f6fca0dfd37667ab4254`. También se guardaron respaldos locales completos del Google Sheets y de la tabla antes de modificar servicios.

La versión de 250 pasó 36 pruebas de Node y comprobación del universo. El navegador debe mostrar 250 instrumentos, filtros por tipo y metadatos de ETF apalancados e inversos.

## Google Sheets

El propietario eligió importar el Excel y copiar el script/manifiesto manualmente. Confirmó que eliminó los scripts y temporizadores antiguos. La autorización del proyecto Google y la instalación de los nuevos temporizadores deben completarse con su cuenta, siguiendo `INSTALACION.md`. La clave privada nueva se guarda solo en Propiedades del script, con la edición del archivo restringida a cuentas de confianza.

La carga inicial en Supabase está verificada; esta comprobación no certifica que los temporizadores de Google estén instalados o ejecutándose. Su estado requiere la confirmación del propietario y una ejecución correcta del nuevo Apps Script.
