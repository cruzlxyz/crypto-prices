/**
 * crypto-prices — Hermes DESKTOP plugin (status bar).
 *
 * Live cryptocurrency prices as a scrolling ticker in the bottom-right status
 * bar of the Hermes Desktop window. Data from the CoinGecko public API (free,
 * no API key), auto-refresh every 60 seconds, with the last prices cached to
 * plugin storage so the bar is never empty on launch (offline -> stale data +
 * warning dot).
 *
 * Features:
 *  - Default coins: Top 10 by market cap (fetched live from /coins/markets,
 *    so the list always follows current rankings - never a static list).
 *  - Marquee ticker: prices slide left inside a fixed-width box and re-enter
 *    from the right (seamless loop, duplicated content + CSS animation).
 *  - Click the status bar item to refresh; hover pauses the animation.
 *  - Up green / down red, with fallbacks to theme tokens that are always
 *    defined (--ui-green / --ui-red in styles.css).
 *  - HTTP 429 -> back off 5 minutes before the next refetch.
 *
 * Commands (Ctrl+K):
 *      - Open Settings (refresh now; coins: search/add/remove/reset;
 *        currencies: set active/add/remove/reset; ticker width slider)
 *
 * Config (stored under ctx.storage, keys namespaced hermes.plugin.crypto-prices.*):
 *  - vs        : active display currency (must be a member of vsList)
 *  - vsList    : currencies available for cycling/switching
 *                (default: ['usd','idr']; full list: /simple/supported_vs_currencies)
 *  - coins     : null = auto Top 10 by market cap; or a pinned list
 *                [{id, symbol}, ...] from the Settings tab.
 *                Empty (everything removed) -> back to auto Top 10.
 *  - tickWidth : ticker box width in px (default 1360, set from the Settings
 *                tab slider; still capped at 70% of the window width)
 *
 * Plain ESM, no build step. The desktop loader only allows imports from
 * '@hermes/plugin-sdk', 'react', and 'react/jsx-runtime'.
 */

import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import {
  STATUSBAR_AREAS,
  PALETTE_AREA,
  atom,
  useValue,
  useQuery,
  queryClient,
  haptic,
  host,
  Input,
  Button,
} from '@hermes/plugin-sdk'

const PLUGIN_ID = 'crypto-prices'
const QUERY_KEY = ['crypto-prices']
const REFRESH_MS = 60_000
const API_BASE = 'https://api.coingecko.com/api/v3'
const DEFAULT_VS_LIST = ['usd', 'idr']

// Ticker/marquee: fixed-width box, track holds two copies of the coin
// sequence, translateX(-50%) linear infinite → exits left, re-enters right.
const STYLE_ID = 'crypto-prices-styles'
const TICKER_CSS = `
@keyframes cp-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.cp-viewport { overflow: hidden; width: min(var(--cp-width, 1360px), 70vw); }
.cp-track { display: inline-flex; animation: cp-marquee 35s linear infinite; will-change: transform; }
.cp-btn:hover .cp-track { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) { .cp-track { animation: none; } }
`

/** Shared outside React so palette commands can switch the display currency. */
const vsAtom = atom('usd')
/** Active display currencies (customizable from the Settings tab). */
const vsListAtom = atom(DEFAULT_VS_LIST)
/** null = auto Top 10; array [{id, symbol}] = pinned list from the Settings tab. */
const coinsAtom = atom(null)
/** Ticker box width (px) — set from the Settings tab, applied via a CSS var. */
const widthAtom = atom(1360)

/** Set in register(): writes the coin list to the atom + storage at once. */
let setCoinsFn = null
let setVsListFn = null
let setTickWidthFn = null

/** Rate-limit (429) backoff timestamp — refetches are delayed until it passes. */
let backoffUntil = 0

async function fetchMarkets(vs, ids) {
  const params = ids
    ? `vs_currency=${vs}&ids=${encodeURIComponent(ids)}&price_change_percentage=24h`
    : `vs_currency=${vs}&order=market_cap_desc&per_page=10&page=1&price_change_percentage=24h`
  const resp = await fetch(`${API_BASE}/coins/markets?${params}`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) {
    if (resp.status === 429) backoffUntil = Date.now() + 5 * 60_000
    throw new Error(`CoinGecko HTTP ${resp.status}`)
  }
  return resp.json()
}

/** ids: 'a,b,c' string, or null (= Top 10). */
function useMarketRows(ids, vs, storage) {
  const query = useQuery({
    queryKey: [...QUERY_KEY, vs, ids || 'top10'],
    queryFn: () => fetchMarkets(vs, ids),
    refetchInterval: () => (Date.now() < backoffUntil ? 300_000 : REFRESH_MS),
    staleTime: 45_000,
    retry: 2,
    // Seed from the storage cache so the bar has data right after app launch.
    initialData: () => {
      const c = storage.get('lastData', null)
      return c && c.vs === vs && c.ids === ids && Array.isArray(c.rows) ? c.rows : undefined
    },
    initialDataUpdatedAt: () => storage.get('lastData', null)?.at || 0,
  })

  useEffect(() => {
    if (query.data) storage.set('lastData', { at: Date.now(), vs, ids, rows: query.data })
  }, [query.data, vs, ids, storage])

  return query
}

// Locale per currency: id-ID for Rp (1.443.243.621 formatting), en-US otherwise.
// en-US already yields native symbols for most codes (¥, €, £, ₩, HK$, CN¥);
// codes that render as ISO letters there (SGD, THB, ...) are left as-is on
// purpose so they never read as ambiguous "$" amounts.
const VS_LOCALE = { idr: 'id-ID' }

const _fmtCache = new Map()
function currencyFormatter(code, locale, bucket) {
  const key = `${code}:${locale}:${bucket}`
  if (!_fmtCache.has(key)) {
    const opts = { style: 'currency', currency: code }
    if (bucket === 0) Object.assign(opts, { maximumFractionDigits: 0 })
    else if (bucket === 2) Object.assign(opts, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    else if (bucket === 4) Object.assign(opts, { minimumFractionDigits: 4, maximumFractionDigits: 4 })
    else Object.assign(opts, { maximumSignificantDigits: 3 })
    _fmtCache.set(key, new Intl.NumberFormat(locale, opts))
  }
  return _fmtCache.get(key)
}

function fmtPrice(p, vs) {
  const key = (vs || 'usd').toLowerCase()
  const code = key.toUpperCase()
  const bucket = p >= 1000 ? 0 : p >= 1 ? 2 : p >= 0.01 ? 4 : 6
  try {
    return currencyFormatter(code, VS_LOCALE[key] || 'en-US', bucket).format(p)
  } catch {
    // Non-ISO code (e.g. a crypto vs) — show the code + number only.
    return `${code} ${bucket === 0 ? Math.round(p).toLocaleString('en-US') : p.toFixed(bucket === 2 ? 2 : 4)}`
  }
}

function fmtChange(ch) {
  const sign = ch >= 0 ? '▲' : '▼'
  const pct = Math.abs(ch)
  const body = pct >= 100 ? Math.round(pct).toLocaleString('en-US') : pct.toFixed(2)
  return `${sign} ${body}%`
}

function changeColor(ch) {
  // Fall back to --ui-red/--ui-green: these two are always defined
  // (styles.css); --ui-success/--ui-danger depend on the runtime theme.
  return ch >= 0 ? 'var(--ui-success, var(--ui-green))' : 'var(--ui-danger, var(--ui-red))'
}

function StatusPrices({ storage }) {
  const vs = useValue(vsAtom)
  const coins = useValue(coinsAtom)
  const ids = Array.isArray(coins) && coins.length ? coins.map((c) => c.id).join(',') : null
  const { data: rows, isFetching, isError, dataUpdatedAt } = useMarketRows(ids, vs, storage)

  const updatedAt = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    : null

  const refresh = () => {
    haptic('tap')
    queryClient.invalidateQueries({ queryKey: QUERY_KEY })
  }

  // One copy of the coin sequence — always ends with '·' so the loop seam
  // between copies looks identical to the middle.
  const chipRow = () =>
    (rows || []).flatMap((r) => {
      const price = r?.current_price
      const ch = r?.price_change_percentage_24h
      return [
        jsxs(
          'span',
          {
            key: r.id,
            style: { display: 'inline-flex', alignItems: 'baseline', gap: '4px' },
            children: [
              jsx('span', {
                style: { color: 'var(--ui-text-tertiary)', fontWeight: 600 },
                children: (r.symbol || '?').toUpperCase(),
              }),
              jsx('span', {
                style: { color: 'var(--ui-text-secondary)', fontVariantNumeric: 'tabular-nums' },
                children: typeof price === 'number' ? fmtPrice(price, vs) : '⋯',
              }),
              jsx('span', {
                style: {
                  color: typeof ch === 'number' ? changeColor(ch) : 'var(--ui-text-quaternary)',
                  fontVariantNumeric: 'tabular-nums',
                },
                children: typeof ch === 'number' ? fmtChange(ch) : '',
              }),
            ],
          }
        ),
        jsx('span', {
          key: `sep-${r.id}`,
          style: { color: 'var(--ui-text-quaternary)' },
          children: '·',
        }),
      ]
    })

  const copy = (key) =>
    jsx('div', {
      key,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        paddingRight: '10px',
        flexShrink: 0,
      },
      children: chipRow(),
    })

  return jsx(
    'button',
    {
      type: 'button',
      className: 'cp-btn',
      onClick: refresh,
      title: `Crypto Prices (CoinGecko) — click to refresh, hover to pause${
        updatedAt ? ` · updated ${updatedAt}` : ''
      }${isError ? ' · fetch failed — showing last data' : ''}`,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '0 6px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: '0.6875rem',
        opacity: isFetching ? 0.55 : 1,
      },
      children: [
        jsx('div', {
          className: 'cp-viewport',
          children: jsx('div', { className: 'cp-track', children: [copy('a'), copy('b')] }),
        }),
        jsx('span', {
          key: 'err-dot',
          style: {
            width: '5px',
            height: '5px',
            borderRadius: '50%',
            background: isError ? 'var(--ui-danger, var(--ui-red))' : 'transparent',
          },
        }),
      ],
    },
    PLUGIN_ID
  )
}

/** Settings tab — coin search/add/remove/reset, opened via host.openWorkspace. */
function ManageCoins({ storage }) {
  const coins = useValue(coinsAtom)
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)

  // Debounced /search requests.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setResults([])
      return undefined
    }
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const resp = await fetch(`${API_BASE}/search?query=${encodeURIComponent(term)}`, {
          signal: ctrl.signal,
        })
        if (resp.ok) {
          const json = await resp.json()
          setResults((json.coins || []).slice(0, 6))
        }
      } catch {
        // keep previous results
      } finally {
        setSearching(false)
      }
    }, 400)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [q])

  // In auto mode, the first pin locks the currently shown Top 10 plus the new coin.
  const baseList = () => {
    const current = coinsAtom.get()
    if (Array.isArray(current)) return current
    const c = storage.get('lastData', null)
    return Array.isArray(c?.rows) ? c.rows.map((r) => ({ id: r.id, symbol: (r.symbol || '?').toUpperCase() })) : []
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY })

  const doAdd = (r) => {
    const base = baseList()
    if (base.some((c) => c.id === r.id)) {
      host.notify({ kind: 'info', message: `${(r.symbol || r.name).toUpperCase()} is already in the list` })
      return
    }
    setCoinsFn([...base, { id: r.id, symbol: (r.symbol || r.id).toUpperCase() }])
    invalidate()
    host.notify({ kind: 'info', message: `${(r.symbol || r.id).toUpperCase()} (${r.name}) added` })
  }

  const doRemove = (id) => {
    const next = (coinsAtom.get() || []).filter((c) => c.id !== id)
    setCoinsFn(next.length ? next : null)
    invalidate()
  }

  const doReset = () => {
    setCoinsFn(null)
    invalidate()
    host.notify({ kind: 'info', message: 'Crypto Prices: back to the Top 10 by market cap' })
  }

  // ---- Currencies ----
  const vsList = useValue(vsListAtom)
  const vs = useValue(vsAtom)
  const tickWidth = useValue(widthAtom)
  const [q2, setQ2] = useState('')

  const vsSupported = useQuery({
    queryKey: [...QUERY_KEY, 'vscurrencies'],
    queryFn: async () => {
      const resp = await fetch(`${API_BASE}/simple/supported_vs_currencies`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`)
      return resp.json()
    },
    staleTime: 24 * 60 * 60 * 1000,
  })

  const doUseCurrency = (code) => {
    vsAtom.set(code)
    storage.set('vs', code)
    host.notify({ kind: 'info', message: `Crypto Prices: prices in ${code.toUpperCase()}` })
  }

  const doAddCurrency = (code) => {
    const list = vsListAtom.get() || DEFAULT_VS_LIST
    if (list.includes(code)) return
    setVsListFn([...list, code])
    host.notify({ kind: 'info', message: `Currency ${code.toUpperCase()} added` })
  }

  const doRemoveCurrency = (code) => {
    const list = vsListAtom.get() || DEFAULT_VS_LIST
    if (list.length <= 1) {
      host.notify({ kind: 'info', message: 'At least one currency must remain' })
      return
    }
    const next = list.filter((c) => c !== code)
    setVsListFn(next)
    if (vsAtom.get() === code) {
      vsAtom.set(next[0])
      storage.set('vs', next[0])
      host.notify({ kind: 'info', message: `Active currency switched to ${next[0].toUpperCase()}` })
    }
  }

  const doResetCurrency = () => {
    setVsListFn(DEFAULT_VS_LIST)
    vsAtom.set(DEFAULT_VS_LIST[0])
    storage.set('vs', DEFAULT_VS_LIST[0])
    host.notify({ kind: 'info', message: 'Currencies reset to USD + IDR' })
  }

  const term2 = q2.trim().toLowerCase()
  const vsCandidates = ((vsSupported.data || []).filter(
    (code) => !vsList.includes(code) && (!term2 || code.includes(term2))
  )).slice(0, 12)

  const pinned = Array.isArray(coins)
  const shown = pinned ? coins : (storage.get('lastData', null)?.rows || []).map((r) => ({ id: r.id, symbol: (r.symbol || '?').toUpperCase() }))

  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 0',
    borderBottom: '1px solid var(--ui-border)',
  }

  return jsxs('div', {
    style: {
      padding: '16px 18px',
      height: '100%',
      overflow: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      fontSize: '0.8rem',
      color: 'var(--ui-text-secondary)',
    },
    children: [
      jsxs('div', {
        key: 'head',
        style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' },
        children: [
          jsxs('div', {
            children: [
              jsx('div', { style: { fontWeight: 700, color: 'var(--ui-text-primary)', fontSize: '0.95rem' }, children: 'Crypto Prices — Settings' }),
              jsx('div', { style: { color: 'var(--ui-text-tertiary)' }, children: 'Data: CoinGecko · default mode: Top 10 by market cap' }),
            ],
          }),
          jsx(Button, {
            onClick: () => {
              haptic('tap')
              queryClient.invalidateQueries({ queryKey: QUERY_KEY })
            },
            children: 'Refresh now',
          }),
        ],
      }),

      jsxs('div', {
        key: 'current',
        children: [
          jsx('div', {
            style: { fontWeight: 600, marginBottom: '4px' },
            children: pinned ? `Pinned coins (${coins.length})` : 'Current coins: auto Top 10',
          }),
          ...(shown.length
            ? shown.map((c) =>
                jsxs('div', {
                  style: rowStyle,
                  children: [
                    jsx('span', { style: { fontWeight: 600, color: 'var(--ui-text-primary)', width: '64px' }, children: c.symbol }),
                    jsx('span', { style: { flex: 1, color: 'var(--ui-text-tertiary)', fontSize: '0.72rem' }, children: c.id }),
                    pinned
                      ? jsx(Button, { onClick: () => doRemove(c.id), children: 'Remove' })
                      : jsx('span', { style: { color: 'var(--ui-text-quaternary)', fontSize: '0.72rem' }, children: 'auto' }),
                  ],
                }, c.id)
              )
            : [jsx('div', { key: 'empty', style: { color: 'var(--ui-text-tertiary)' }, children: 'Loading list…' })]),
          pinned
            ? jsx('div', { style: { marginTop: '8px' }, children: jsx(Button, { onClick: doReset, children: 'Reset to Top 10' }) })
            : null,
        ],
      }),

      jsxs('div', {
        key: 'add',
        children: [
          jsx('div', { style: { fontWeight: 600, marginBottom: '4px' }, children: 'Add coins' }),
          jsx(Input, {
            value: q,
            onChange: (e) => setQ(e?.target?.value ?? e),
            placeholder: 'Search by name or symbol (e.g. bitcoin, hype, pepe)…',
            style: { width: '100%', marginBottom: '6px' },
          }),
          searching
            ? jsx('div', { style: { color: 'var(--ui-text-tertiary)' }, children: 'Searching…' })
            : null,
          ...results.map((r) =>
            jsxs('div', {
              style: rowStyle,
              children: [
                jsx('span', { style: { fontWeight: 600, color: 'var(--ui-text-primary)', width: '64px' }, children: (r.symbol || '').toUpperCase() }),
                jsx('span', { style: { flex: 1 }, children: r.name }),
                jsx(Button, { onClick: () => doAdd(r), children: 'Add' }),
              ],
            }, r.id)
          ),
          jsx('div', {
            style: { color: 'var(--ui-text-quaternary)', fontSize: '0.72rem', marginTop: '6px' },
            children: 'Type at least 2 letters. Adding a coin pins the list; use Reset to return to the auto Top 10.',
          }),
        ],
      }),

      jsxs('div', {
        key: 'currency',
        children: [
          jsx('div', {
            style: { fontWeight: 600, marginBottom: '4px' },
            children: `Currencies (${vsList.length}) — active: ${vs.toUpperCase()}`,
          }),
          ...vsList.map((code) =>
            jsxs('div', {
              style: rowStyle,
              children: [
                jsx('span', { style: { fontWeight: 600, color: 'var(--ui-text-primary)', width: '64px' }, children: code.toUpperCase() }),
                jsx('span', { style: { flex: 1, color: 'var(--ui-text-tertiary)', fontSize: '0.72rem' }, children: code === vs ? '● active' : '' }),
                code !== vs
                  ? jsx(Button, { onClick: () => doUseCurrency(code), children: 'Use' })
                  : null,
                jsx(Button, { onClick: () => doRemoveCurrency(code), disabled: vsList.length <= 1, children: 'Remove' }),
              ],
            }, code)
          ),
          jsx(Input, {
            value: q2,
            onChange: (e) => setQ2(e?.target?.value ?? e),
            placeholder: 'Filter currencies (e.g. eur, sgd, jpy)…',
            style: { width: '100%', marginTop: '8px', marginBottom: '6px' },
          }),
          vsSupported.isError
            ? jsx('div', { style: { color: 'var(--ui-danger, var(--ui-red))' }, children: 'Failed to load the currency list — try again later.' })
            : null,
          ...vsCandidates.map((code) =>
            jsxs('div', {
              style: rowStyle,
              children: [
                jsx('span', { style: { fontWeight: 600, color: 'var(--ui-text-primary)', width: '64px' }, children: code.toUpperCase() }),
                jsx('span', { style: { flex: 1 } }),
                jsx(Button, { onClick: () => doAddCurrency(code), children: 'Add' }),
              ],
            }, code)
          ),
          jsx('div', {
            style: { marginTop: '8px' },
            children: jsx(Button, { onClick: doResetCurrency, children: 'Reset currencies to USD + IDR' }),
          }),
        ],
      }),

      jsxs('div', {
        key: 'ticker',
        children: [
          jsx('div', {
            style: { fontWeight: 600, marginBottom: '4px' },
            children: 'Ticker display',
          }),
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '10px' },
            children: [
              jsx('input', {
                type: 'range',
                min: 300,
                max: 1600,
                step: 20,
                value: tickWidth,
                onChange: (e) => setTickWidthFn(Number(e?.target?.value ?? 1360)),
                style: { flex: 1, accentColor: 'var(--ui-accent)', cursor: 'pointer' },
              }),
              jsx('span', {
                style: { fontVariantNumeric: 'tabular-nums', color: 'var(--ui-text-primary)', width: '64px', textAlign: 'right' },
                children: `${tickWidth}px`,
              }),
            ],
          }),
          jsxs('div', {
            style: { display: 'flex', gap: '8px', marginTop: '8px' },
            children: [
              jsx(Button, { onClick: () => setTickWidthFn(Math.max(300, widthAtom.get() - 40)), children: '− Narrower' }),
              jsx(Button, { onClick: () => setTickWidthFn(Math.min(1600, widthAtom.get() + 40)), children: '+ Wider' }),
              jsx(Button, { onClick: () => setTickWidthFn(1360), children: 'Reset' }),
            ],
          }),
          jsx('div', {
            style: { color: 'var(--ui-text-quaternary)', fontSize: '0.72rem', marginTop: '6px' },
            children: 'Changes apply instantly to the bottom bar and are saved automatically. Always capped at 70% of the window width.',
          }),
        ],
      }),
    ],
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Crypto Prices',
  description:
    'Live crypto price ticker for the desktop status bar — Top 10 by market cap, marquee display, custom coins & currencies (CoinGecko, no API key).',
  register(ctx) {
    // Remove leftover keys from earlier experiments (no longer used).
    ctx.storage.remove('pane')
    ctx.storage.remove('pos')

    vsAtom.set(ctx.storage.get('vs', 'usd'))
    coinsAtom.set(ctx.storage.get('coins', null))
    vsListAtom.set(ctx.storage.get('vsList', DEFAULT_VS_LIST))

    setCoinsFn = (list) => {
      coinsAtom.set(list)
      if (list) ctx.storage.set('coins', list)
      else ctx.storage.remove('coins')
    }

    setVsListFn = (list) => {
      vsListAtom.set(list)
      ctx.storage.set('vsList', list)
    }

    const applyTickWidth = (px) => {
      widthAtom.set(px)
      document.documentElement.style.setProperty('--cp-width', `${px}px`)
    }
    applyTickWidth(ctx.storage.get('tickWidth', 1360))
    setTickWidthFn = (px) => {
      ctx.storage.set('tickWidth', px)
      applyTickWidth(px)
    }

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = TICKER_CSS
      document.head.appendChild(style)
    }

    ctx.register({
      id: 'status',
      area: STATUSBAR_AREAS.right,
      order: 140,
      render: () => jsx(StatusPrices, { storage: ctx.storage }),
    })

    ctx.register({
      id: 'manage-cmd',
      area: PALETTE_AREA,
      data: {
        id: 'crypto-prices.manage',
        label: 'Crypto Prices: Open Settings',
        keywords: ['crypto', 'coins', 'currencies', 'settings', 'add', 'remove', 'manage', 'refresh', 'currency'],
        run: () => {
          if (typeof host.openWorkspace !== 'function') {
            host.notifyError(new Error('host.openWorkspace unavailable'), 'Settings requires a newer Hermes Desktop')
            return
          }
          host.openWorkspace(`${PLUGIN_ID}:manage`, {
            title: 'Settings · Crypto Prices',
            minWidth: 380,
            render: () => jsx(ManageCoins, { storage: ctx.storage }),
          })
        },
      },
    })
  },
}
