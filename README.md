# Wil’s Trading Desk

A personal trading dashboard for higher-timeframe crypto trades.

- Any Binance coin with a USDT pair, on 4H, 1D, 1W and 1M charts, log or linear scale
- Live prices while the page is open (Binance stream, with a 20-second refresh fallback)
- Gann fan, arcs and level lines, placed automatically with three presets, or from your own picked low and high:
  - **Last cycle** (default): all-time low to the biggest confirmed cycle high other than the all-time high
  - **All-time**: all-time low to the all-time high
  - **Latest cycle**: most recent major low (lowest point 26 weeks either side) to the highest point since
- SMA 20/50/100/200, EMA 21, Bollinger Bands (20, 2), Fibonacci retracement on the swing in view, volume, RSI 14, MACD 12/26/9
- Full and new moons (Meeus algorithm, accurate to minutes)
- Crypto Fear & Greed Index from [Alternative.me](https://alternative.me/crypto/fear-and-greed-index/)

Settings, the last coin and your custom anchors are saved in your browser.

## How the Gann anchors work

The app loads the coin's full daily history, groups it into weeks, and finds confirmed swing
points: a cycle high is the highest point for 52 weeks on each side. The 1x1 line runs from the
origin low through the chosen high; every other angle is a ratio of that slope in log price, so
the fan is straight on a log chart. Arcs are quarter-ellipses centred on the origin. Their sizes are
set in `src/gann.ts` (`ARCS`, `ARC_STRETCH`) if you want to tune them.

## Deploy on Netlify

1. Push this folder to a GitHub repository.
2. In Netlify: **Add new site → Import an existing project → GitHub**, pick the repository.
3. The settings come from `netlify.toml` (build `npm run build`, publish `public`). Deploy.

No API keys are needed for this version. `netlify/functions/proxy.mjs` is a small fallback that
fetches Binance or Alternative.me data server-side if your browser can't reach them directly.

## Develop locally

```sh
npm install
npm run build        # compiles src/*.ts into public/js
npx serve public     # or any static server
```

## Not yet built

- Phase 2: Telegram alerts, watchlist, reaction test for lines
- Phase 3: stocks (delayed quotes) and our own stock fear and greed index

Prices come from Binance spot markets, so history starts when a coin listed on Binance.
This is a charting tool, not financial advice.
