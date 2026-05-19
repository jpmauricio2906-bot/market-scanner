// ============================================================
// MarketScanner — Web App v1.2
// Supports optional ?ticker=AAPL parameter
// When provided, returns only that ticker's rows (much faster
// for the ticker detail page — 137 rows instead of 13,000+)
//
// After pasting this code:
// Deploy → Manage deployments → Edit (pencil) → New version → Deploy
// ============================================================

function doGet(e) {
  var ss         = SpreadsheetApp.getActiveSpreadsheet();
  var hHistorial = ss.getSheetByName("Historial");

  if (!hHistorial) {
    return jsonResponse({ error: "Hoja Historial no encontrada" });
  }

  var lastRow = hHistorial.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ data: [], total: 0, schema: SCHEMA });
  }

  // Optional ticker filter (case-insensitive)
  var tickerFilter = null;
  if (e && e.parameter && e.parameter.ticker) {
    tickerFilter = String(e.parameter.ticker).trim().toUpperCase();
  }

  var datos = hHistorial.getRange(2, 1, lastRow - 1, 7).getValues();
  var rows  = [];

  for (var i = 0; i < datos.length; i++) {
    var fecha   = datos[i][0];
    var ticker  = String(datos[i][1]).trim().toUpperCase();
    var open    = datos[i][2];
    var high    = datos[i][3];
    var low     = datos[i][4];
    var close   = datos[i][5];
    var volumen = datos[i][6];

    if (!ticker || !close || close === "" || isNaN(close)) continue;

    // Apply ticker filter if provided
    if (tickerFilter && ticker !== tickerFilter) continue;

    // Normalize fecha
    var fechaStr = "";
    if (fecha instanceof Date) {
      fechaStr = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "yyyy-MM-dd");
    } else if (typeof fecha === "number") {
      var jsDate = new Date(Math.floor(fecha - 25569) * 86400 * 1000);
      fechaStr   = Utilities.formatDate(jsDate, "UTC", "yyyy-MM-dd");
    } else {
      fechaStr = String(fecha).substring(0, 10);
    }

    rows.push([
      fechaStr,
      ticker,
      Number(open)    || 0,
      Number(high)    || 0,
      Number(low)     || 0,
      Number(close),
      Number(volumen) || 0
    ]);
  }

  return jsonResponse({
    data:    rows,
    total:   rows.length,
    updated: new Date().toISOString(),
    schema:  ["fecha","ticker","open","high","low","close","volumen"],
    filter:  tickerFilter || "all"
  });
}

var SCHEMA = ["fecha","ticker","open","high","low","close","volumen"];

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
