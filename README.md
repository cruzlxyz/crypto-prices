# Crypto Prices for Hermes Desktop

A tiny [Hermes Desktop](https://github.com/NousResearch/hermes-agent) plugin that shows live cryptocurrency prices as a smooth scrolling ticker in the desktop status bar. Data from the CoinGecko public API — free, no API key.

<!-- Screenshot: drop a PNG of your status bar here, e.g. ![ticker](docs/screenshot.png) -->

## Features

- **Top 10 by market cap** by default — fetched live from `/coins/markets`, so the list always follows current rankings (never a stale hard-coded list)
- **Marquee ticker**: slides left, wraps seamlessly from the right; hover to pause; respects the OS reduce-motion setting
- **Manage coins**: search any CoinGecko coin, pin/remove coins, or reset to the live Top 10 — all from the command palette
- **Custom currencies**: pick from 60+ CoinGecko-supported display currencies (USD, IDR, EUR, JPY, SGD, …) — add, remove, and switch in the same manage tab
- **USD ⇄ IDR** display switch, persisted across restarts
- Click the ticker to refresh instantly; a small dot marks stale data when a fetch fails
- Rate-limit friendly: 1 request/minute, backs off 5 minutes on HTTP 429
- Theme-aware colors via the app's design tokens (with guaranteed red/green fallbacks); last prices are cached so the bar is never empty on startup

## Install

```bash
git clone https://github.com/cruzlxyz/crypto-prices "$HOME/.hermes/desktop-plugins/crypto-prices"
```

- Default Hermes home is `~/.hermes`; on Windows it is commonly `%LOCALAPPDATA%\hermes`.
- The desktop app watches `desktop-plugins/` and loads the plugin within seconds — manage it under **Capabilities → Plugins**.
- Or use a one-click install link: `hermes://plugin/install?repo=cruzlxyz/crypto-prices`

## Usage

Press `Ctrl+K` (command palette) and type "crypto":

| Command | What it does |
|---|---|
| **Refresh now** | Force a refetch |
| **Ganti mata uang (siklus daftar)** | Cycle through your enabled display currencies |
| **Kelola Koin & Mata Uang** | Open the manage tab — coins: search (≥ 2 letters) → add, remove pinned coins, reset to the live Top 10; currencies: set active, add from the supported list, remove, reset |

Once you add or remove a coin, the list locks to your choice; **Reset** returns to the automatic Top 10.

## Config

State lives in the plugin's storage namespace (`hermes.plugin.crypto-prices.*`):

| Key | Meaning |
|---|---|
| `vs` | Active display currency (member of `vsList`) |
| `vsList` | Enabled display currencies (default `['usd','idr']`; source of truth: CoinGecko `supported_vs_currencies`) |
| `coins` | `null` = auto Top 10 by market cap; or a pinned list `[{id, symbol}]` |
| `lastData` | Internal price cache (offline fallback) |

## Attribution

Market data by [CoinGecko](https://www.coingecko.com/en/api).

## License

[MIT](LICENSE)
