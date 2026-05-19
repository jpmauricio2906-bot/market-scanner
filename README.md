# NASDAQ Market Scanner

Static web app hosted on GitHub Pages, backed by Google Apps Script.

## File structure

```
market-scanner/
├── index.html          ← Main scanner (heatmap of 100 tickers)
├── ticker.html         ← Ticker detail page (charts + indicators)
├── js/
│   ├── config.js       ← API URL (edit this when you redeploy the WebApp)
│   └── indicators.js   ← All math (RSI, MACD, BB, OBV, etc.)
└── README.md
```

## Deploy to GitHub Pages

1. Create a new GitHub repository (e.g. `market-scanner`)
2. Push all files maintaining the folder structure above
3. Go to **Settings → Pages → Source → Deploy from branch → main → / (root)**
4. Your app is live at `https://yourusername.github.io/market-scanner/`

## Configuration

The only file you need to edit is `js/config.js`:

```javascript
const API_URL = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec";
```

Change this URL whenever you redeploy the Google Apps Script WebApp.

## Google Apps Script WebApp

The backend is a published Google Apps Script that serves the Historial sheet as JSON.

**Endpoints:**
- `GET /exec` → all tickers (used by main scanner)
- `GET /exec?ticker=AAPL` → single ticker only (used by detail page, ~100× faster)

**How to redeploy after code changes:**
1. Open Apps Script project
2. Deploy → Manage deployments → Edit (pencil icon)
3. Version → New version
4. Deploy
5. URL stays the same — no need to update `config.js`

## Navigation

- Click any ticker row in `index.html` → opens `ticker.html?ticker=AAPL`
- Back button in `ticker.html` → returns to `index.html`

## Libraries used (all via CDN, no build step)

| Library | Version | Use |
|---|---|---|
| Lightweight Charts (TradingView) | 4.1.3 | Candlestick + Bollinger chart |
| Chart.js | 4.4.0 | RSI, MACD, Volume, OBV, ROC, ATR charts |
| IBM Plex Mono/Sans | — | Typography |

## Updating tickers

Use the `MarketScanner_SingleTicker.gs` script in Apps Script:
- `replaceTicker()` → swap one ticker for another (e.g. WBA → CVS)
- `addSingleTicker()` → add a new ticker
- `removeTickerHistory()` → remove a ticker from Historial
