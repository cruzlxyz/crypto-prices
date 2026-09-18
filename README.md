# Crypto Prices for Hermes Desktop

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform: Hermes Desktop](https://img.shields.io/badge/Hermes%20Desktop-v0.21.3-blue)](https://github.com/NousResearch/hermes-agent)
[![Data: CoinGecko](https://img.shields.io/badge/Data-CoinGecko-orange)](https://www.coingecko.com/en/api)

A tiny [Hermes Desktop](https://github.com/NousResearch/hermes-agent) plugin that shows **live cryptocurrency prices** as a smooth scrolling ticker in the desktop **status bar**. Built on the official Desktop Plugin SDK — one plain ESM file, no build step, no API key.

<img width="1115" height="98" alt="image" src="https://github.com/user-attachments/assets/739022a2-5cce-47f8-a7ac-b943949f49b9" />


## Requirements

| | |
|---|---|
| **App** | Hermes Desktop (tested on **v0.21.3**, build `c661785`, Windows 11 x64) |
| **Runtime dependencies** | **None** — single ESM file, uses only the official `@hermes/plugin-sdk` + browser-standard `fetch`/`Intl` |
| **Network** | Internet access to `api.coingecko.com` (public API — **free, no API key**) |
| **Build step** | None. Nothing to compile, nothing to install globally. |

## Install

> The plugin is a **unified Hermes plugin package** (agent manifest + desktop half). It lives in the
> **plugins folder** of your Hermes home:
> - **macOS / Linux:** `~/.hermes/plugins/`
> - **Windows:** `%LOCALAPPDATA%\hermes\plugins\`
>
> Hermes automatically copies the desktop half into `desktop-plugins/` and manages that copy itself — never edit it by hand.

Pick **one** of these three ways:

**Option A — Git clone (recommended)**

```bash
# macOS / Linux
git clone https://github.com/cruzlxyz/crypto-prices "$HOME/.hermes/plugins/crypto-prices"
```

```powershell
# Windows (PowerShell)
git clone https://github.com/cruzlxyz/crypto-prices "$env:LOCALAPPDATA\hermes\plugins\crypto-prices"
```

**Option B — One-click install link**

Open this in your browser — Hermes shows a confirmation dialog, then installs for you:

```
hermes://plugin/install?repo=cruzlxyz/crypto-prices
```

**Option C — From inside the app**

Hermes Desktop → **Capabilities → Plugins → "Install from Git"** → enter `cruzlxyz/crypto-prices`.

After any option, the app watches the folder and **loads the plugin within a few seconds** — no restart needed.

## Enable & verify

1. Open **Capabilities → Plugins** in Hermes Desktop.
2. Find **Crypto Prices** (badges: `Desktop` · `on disk`) and make sure the toggle is **on**.
3. Look at the **bottom-right status bar** — you should see the ticker scrolling:
   `BTC … ▲ x.x% · ETH … · SOL …`

> **Not showing?** Press `Ctrl+K` → **"Reload desktop plugins"**, then re-check the toggle.

<img width="1258" height="578" alt="image" src="https://github.com/user-attachments/assets/cebaf14f-799a-4aba-856f-e003e28e886a" />


## Usage

Press `Ctrl+K` (command palette) → **"Crypto Prices: Open Settings"**. Everything lives in one place, split into three tabs:

| Tab | What you can do |
|---|---|
| **Coins** | See the current list (auto Top 10 by market cap), search & **add** any CoinGecko coin (type ≥ 2 letters), **remove** pinned coins, **Reset to Top 10** |
| **Currencies** | **Use** to set the active display currency, **add** from 60+ supported codes (USD, IDR, EUR, JPY, SGD, …), **remove**, **reset** to USD + IDR |
| **Ticker display** | Set the ticker box **width** with the slider (or `− Narrower` / `+ Wider` buttons); capped at 70% of the window width |

Quick actions outside Settings:

- **Click the ticker** → instant refresh
- **Hover the ticker** → pauses the animation so you can read it

Behavior notes:

- Prices **auto-refresh every 60 seconds** (one API request per minute, regardless of coin count).
- If a fetch fails (offline / rate-limited), the last prices stay visible and a small **red dot** marks the data as stale.
- Adding or removing a coin **pins** the list to your choice; **Reset** returns to the automatic Top 10.
- On HTTP 429 the plugin backs off for **5 minutes** instead of hammering the API.
- All changes apply **instantly** and are **saved automatically** (they survive app restarts).

## Disable & uninstall

- **Temporarily disable:** Capabilities → Plugins → toggle **Crypto Prices** off. The ticker disappears immediately; the files stay on disk and can be re-enabled any time.
- **Fully remove:**
  ```bash
  # macOS / Linux
  rm -rf "$HOME/.hermes/plugins/crypto-prices"
  ```
  ```powershell
  # Windows (PowerShell)
  Remove-Item -Recurse -Force "$env:LOCALAPPDATA\hermes\plugins\crypto-prices"
  ```
  Hermes removes the managed desktop copy automatically when the package folder disappears.
- Your settings are stored under the plugin's own namespace (`hermes.plugin.crypto-prices.*`) inside Hermes' plugin storage — they are not written into the plugin folder, so updating/re-cloning the folder never loses your coins, currency, or width preferences.

## Configuration reference

You normally configure everything through the Settings tab. These are the underlying storage keys (for reference / debugging):

| Key | Meaning |
|---|---|
| `vs` | Active display currency (member of `vsList`) |
| `vsList` | Enabled display currencies (default `['usd','idr']`; source of truth: CoinGecko `supported_vs_currencies`) |
| `coins` | `null` = auto Top 10 by market cap; or a pinned list `[{id, symbol}]` |
| `tickWidth` | Ticker box width in px (default `1360`; capped at 70% of window width) |
| `lastData` | Internal price cache (offline fallback) |

## How it works (for the curious)

- A unified package: `plugin.yaml` (agent manifest, `kind: standalone`) + a single `desktop/plugin.js` ESM file implementing the official `HermesPlugin` contract (`register(ctx)`) of the [Desktop Plugin SDK](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/desktop-plugin-sdk.md).
- Data endpoints: `/coins/markets` (live Top 10 / pinned quotes), `/search` (coin lookup), `/simple/supported_vs_currencies` (currency list).
- Seamless marquee via duplicated content + `translateX(-50%)` CSS animation; honors the OS **reduce-motion** setting.
- Colors use the app's theme tokens with guaranteed fallbacks (`--ui-green` / `--ui-red`), so it reskins with every theme.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Plugin not in the list | Check the folder is `<Hermes home>/plugins/crypto-prices/` (folder name must match the plugin `id`) and contains `plugin.yaml` + `desktop/plugin.js` |
| Loaded but no ticker | Toggle it on in Capabilities → Plugins; then `Ctrl+K` → "Reload desktop plugins" |
| Red dot / prices frozen | Last fetch failed (offline or rate-limited) — click the ticker to retry, or check `hermes logs gui -f` |
| Coin shows "⋯" | The pinned coin has no price for the active currency yet — wait for the next refresh or switch currency |

## Tested on

- **Hermes Desktop v0.21.3** (build `c661785`), Windows 11 x64
- Should work on any recent Hermes Desktop build with the Desktop Plugin SDK (disk plugins door)

## Attribution

Market data by [CoinGecko](https://www.coingecko.com/en/api).

## License

[MIT](LICENSE)
