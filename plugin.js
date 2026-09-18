/**
 * crypto-prices — Hermes DESKTOP plugin (status bar).
 *
 * Menampilkan harga crypto live di status bar bagian bawah kanan jendela
 * Hermes Desktop. Data dari CoinGecko public API (gratis, tanpa API key),
 * auto-refresh tiap 60 detik, dan harga terakhir di-cache ke storage plugin
 * supaya bar tetap menampilkan data saat app baru dibuka (offline → data
 * stale + titik peringatan).
 *
 * Fitur:
 *  - Koin default: Top 10 market cap (diambil live dari /coins/markets,
 *    jadi selalu ikut peringkat terbaru — bukan daftar statis).
 *  - Tampilan ticker: harga berjalan ke kiri dalam kotak selebar 1360px
 *    (menyusut otomatis di jendela sempit, max 70vw), pas mentok muncul
 *    lagi dari kanan (marquee mulus, konten diduplikasi + CSS loop).
 *  - Klik item status bar → refresh langsung; hover = jeda animasi.
 *  - Naik ▲ hijau / turun ▼ merah, dengan fallback ke token tema yang
 *    pasti terdefinisi (--ui-green / --ui-red di styles.css).
 *  - Kena rate-limit 429 → mundur 5 menit sebelum refetch berikutnya.
 *  - Perintah Ctrl+K:
 *      · Refresh now
 *      · Ganti mata uang (siklus daftar mata uang yang aktif)
 *      · Kelola Koin & Mata Uang (buka tab: koin — cari/tambah/hapus/reset;
 *        mata uang — pilih aktif/tambah/hapus/reset)
 *
 * Konfigurasi (tersimpan di ctx.storage, key namespace hermes.plugin.crypto-prices.*):
 *  - vs     : mata uang aktif (harus anggota vsList)
 *  - vsList : daftar mata uang yang bisa disiklus/dipilih
 *             (default: ['usd','idr']; sumber daftar lengkap:
 *             /simple/supported_vs_currencies)
 *  - coins  : null = otomatis Top 10 market cap; atau daftar pin
 *             [{id, symbol}, ...] dari tab Kelola Koin.
 *             Kosong (habis dihapus semua) → balik ke otomatis Top 10.
 *
 * Plain ESM, tanpa build step. Loader desktop hanya mengizinkan import
 * '@hermes/plugin-sdk', 'react', dan 'react/jsx-runtime'.
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

// Ticker/marquee: kotak lebar tetap, track berisi 2 salinan urutan koin,
// animasi translateX(-50%) linear infinite → keluar kiri, masuk lagi kanan.
const STYLE_ID = 'crypto-prices-styles'
const TICKER_CSS = `
@keyframes cp-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.cp-viewport { overflow: hidden; width: min(1360px, 70vw); }
.cp-track { display: inline-flex; animation: cp-marquee 35s linear infinite; will-change: transform; }
.cp-btn:hover .cp-track { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) { .cp-track { animation: none; } }
`

/** Shared di luar React supaya perintah palette bisa mengganti mata uang. */
const vsAtom = atom('usd')
/** Daftar mata uang aktif (bisa dikustom via tab Kelola). */
const vsListAtom = atom(DEFAULT_VS_LIST)
/** null = otomatis Top 10; array [{id, symbol}] = daftar pin dari Kelola Koin. */
const coinsAtom = atom(null)

/** Di-set di register(): menulis daftar koin ke atom + storage sekaligus. */
let setCoinsFn = null

/** Timestamp backoff rate-limit (429) — refetch ditunda sampai lewat. */
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

/** ids: string 'a,b,c' atau null (= Top 10). */
function useMarketRows(ids, vs, storage) {
  const query = useQuery({
    queryKey: [...QUERY_KEY, vs, ids || 'top10'],
    queryFn: () => fetchMarkets(vs, ids),
    refetchInterval: () => (Date.now() < backoffUntil ? 300_000 : REFRESH_MS),
    staleTime: 45_000,
    retry: 2,
    // Seed dari cache storage agar bar langsung berisi saat app baru dibuka.
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

function fmtPrice(p, vs) {
  if (vs === 'idr') {
    if (p >= 1000) return 'Rp ' + Math.round(p).toLocaleString('id-ID')
    return 'Rp ' + p.toFixed(2)
  }
  if (p >= 1000) return '$' + Math.round(p).toLocaleString('en-US')
  if (p >= 1) return '$' + p.toFixed(2)
  if (p >= 0.01) return '$' + p.toFixed(4)
  return '$' + p.toPrecision(3)
}

function fmtChange(ch) {
  const sign = ch >= 0 ? '▲' : '▼'
  const pct = Math.abs(ch)
  const body = pct >= 100 ? Math.round(pct).toLocaleString('en-US') : pct.toFixed(2)
  return `${sign} ${body}%`
}

function changeColor(ch) {
  // Fallback ke --ui-red/--ui-green: dua token ini pasti terdefinisi
  // (styles.css), --ui-success/--ui-danger tergantung tema runtime.
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

  // Satu salinan urutan koin — selalu diakhiri '·' supaya sambungan loop
  // antar salinan terlihat sama seperti bagian tengah.
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
      title: `Crypto Prices (CoinGecko) — klik untuk refresh, hover untuk jeda${
        updatedAt ? ` · update ${updatedAt}` : ''
      }${isError ? ' · fetch gagal, menampilkan data terakhir' : ''}`,
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

/** Tab "Kelola Koin" — cari/tambah/hapus/reset, dibuka via host.openWorkspace. */
function ManageCoins({ storage }) {
  const coins = useValue(coinsAtom)
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)

  // Debounce pencarian ke /search.
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
        // biarkan hasil sebelumnya
      } finally {
        setSearching(false)
      }
    }, 400)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [q])

  // Saat mode otomatis, pin pertama mengunci Top 10 yang sedang tampil + koin baru.
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
      host.notify({ kind: 'info', message: `${(r.symbol || r.name).toUpperCase()} sudah ada di daftar` })
      return
    }
    setCoinsFn([...base, { id: r.id, symbol: (r.symbol || r.id).toUpperCase() }])
    invalidate()
    host.notify({ kind: 'info', message: `${(r.symbol || r.id).toUpperCase()} ditambahkan (${r.name})` })
  }

  const doRemove = (id) => {
    const next = (coinsAtom.get() || []).filter((c) => c.id !== id)
    setCoinsFn(next.length ? next : null)
    invalidate()
  }

  const doReset = () => {
    setCoinsFn(null)
    invalidate()
    host.notify({ kind: 'info', message: 'Crypto Prices: kembali ke Top 10 market cap' })
  }

  // ---- Mata uang ----
  const vsList = useValue(vsListAtom)
  const vs = useValue(vsAtom)
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
    host.notify({ kind: 'info', message: `Crypto Prices: harga dalam ${code.toUpperCase()}` })
  }

  const doAddCurrency = (code) => {
    const list = vsListAtom.get() || DEFAULT_VS_LIST
    if (list.includes(code)) return
    setVsListFn([...list, code])
    host.notify({ kind: 'info', message: `Mata uang ${code.toUpperCase()} ditambahkan` })
  }

  const doRemoveCurrency = (code) => {
    const list = vsListAtom.get() || DEFAULT_VS_LIST
    if (list.length <= 1) {
      host.notify({ kind: 'info', message: 'Minimal harus ada satu mata uang' })
      return
    }
    const next = list.filter((c) => c !== code)
    setVsListFn(next)
    if (vsAtom.get() === code) {
      vsAtom.set(next[0])
      storage.set('vs', next[0])
      host.notify({ kind: 'info', message: `Mata uang aktif pindah ke ${next[0].toUpperCase()}` })
    }
  }

  const doResetCurrency = () => {
    setVsListFn(DEFAULT_VS_LIST)
    vsAtom.set(DEFAULT_VS_LIST[0])
    storage.set('vs', DEFAULT_VS_LIST[0])
    host.notify({ kind: 'info', message: 'Mata uang kembali ke USD + IDR' })
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
        children: [
          jsx('div', { style: { fontWeight: 700, color: 'var(--ui-text-primary)', fontSize: '0.95rem' }, children: 'Kelola Koin — Crypto Prices' }),
          jsx('div', { style: { color: 'var(--ui-text-tertiary)' }, children: 'Data: CoinGecko · mode default: Top 10 market cap' }),
        ],
      }),

      jsxs('div', {
        key: 'current',
        children: [
          jsx('div', {
            style: { fontWeight: 600, marginBottom: '4px' },
            children: pinned ? `Koin dipin (${coins.length})` : 'Koin saat ini: otomatis Top 10',
          }),
          ...(shown.length
            ? shown.map((c) =>
                jsxs('div', {
                  style: rowStyle,
                  children: [
                    jsx('span', { style: { fontWeight: 600, color: 'var(--ui-text-primary)', width: '64px' }, children: c.symbol }),
                    jsx('span', { style: { flex: 1, color: 'var(--ui-text-tertiary)', fontSize: '0.72rem' }, children: c.id }),
                    pinned
                      ? jsx(Button, { onClick: () => doRemove(c.id), children: 'Hapus' })
                      : jsx('span', { style: { color: 'var(--ui-text-quaternary)', fontSize: '0.72rem' }, children: 'otomatis' }),
                  ],
                }, c.id)
              )
            : [jsx('div', { key: 'empty', style: { color: 'var(--ui-text-tertiary)' }, children: 'Memuat daftar…' })]),
          pinned
            ? jsx('div', { style: { marginTop: '8px' }, children: jsx(Button, { onClick: doReset, children: 'Reset ke Top 10' }) })
            : null,
        ],
      }),

      jsxs('div', {
        key: 'add',
        children: [
          jsx('div', { style: { fontWeight: 600, marginBottom: '4px' }, children: 'Tambah koin' }),
          jsx(Input, {
            value: q,
            onChange: (e) => setQ(e?.target?.value ?? e),
            placeholder: 'Cari nama atau simbol (mis. bitcoin, hype, pepe)…',
            style: { width: '100%', marginBottom: '6px' },
          }),
          searching
            ? jsx('div', { style: { color: 'var(--ui-text-tertiary)' }, children: 'Mencari…' })
            : null,
          ...results.map((r) =>
            jsxs('div', {
              style: rowStyle,
              children: [
                jsx('span', { style: { fontWeight: 600, color: 'var(--ui-text-primary)', width: '64px' }, children: (r.symbol || '').toUpperCase() }),
                jsx('span', { style: { flex: 1 }, children: r.name }),
                jsx(Button, { onClick: () => doAdd(r), children: 'Tambah' }),
              ],
            }, r.id)
          ),
          jsx('div', {
            style: { color: 'var(--ui-text-quaternary)', fontSize: '0.72rem', marginTop: '6px' },
            children: 'Ketik minimal 2 huruf. Menambah koin akan mengunci daftar (pin); pakai Reset untuk balik ke Top 10 otomatis.',
          }),
        ],
      }),

      jsxs('div', {
        key: 'currency',
        children: [
          jsx('div', {
            style: { fontWeight: 600, marginBottom: '4px' },
            children: `Mata uang (${vsList.length}) — aktif: ${vs.toUpperCase()}`,
          }),
          ...vsList.map((code) =>
            jsxs('div', {
              style: rowStyle,
              children: [
                jsx('span', { style: { fontWeight: 600, color: 'var(--ui-text-primary)', width: '64px' }, children: code.toUpperCase() }),
                jsx('span', { style: { flex: 1, color: 'var(--ui-text-tertiary)', fontSize: '0.72rem' }, children: code === vs ? '● aktif' : '' }),
                code !== vs
                  ? jsx(Button, { onClick: () => doUseCurrency(code), children: 'Pakai' })
                  : null,
                jsx(Button, { onClick: () => doRemoveCurrency(code), disabled: vsList.length <= 1, children: 'Hapus' }),
              ],
            }, code)
          ),
          jsx(Input, {
            value: q2,
            onChange: (e) => setQ2(e?.target?.value ?? e),
            placeholder: 'Saring mata uang (mis. eur, sgd, jpy)…',
            style: { width: '100%', marginTop: '8px', marginBottom: '6px' },
          }),
          vsSupported.isError
            ? jsx('div', { style: { color: 'var(--ui-danger, var(--ui-red))' }, children: 'Gagal memuat daftar mata uang — coba lagi nanti.' })
            : null,
          ...vsCandidates.map((code) =>
            jsxs('div', {
              style: rowStyle,
              children: [
                jsx('span', { style: { fontWeight: 600, color: 'var(--ui-text-primary)', width: '64px' }, children: code.toUpperCase() }),
                jsx('span', { style: { flex: 1 } }),
                jsx(Button, { onClick: () => doAddCurrency(code), children: 'Tambah' }),
              ],
            }, code)
          ),
          jsx('div', {
            style: { marginTop: '8px' },
            children: jsx(Button, { onClick: doResetCurrency, children: 'Reset mata uang ke USD + IDR' }),
          }),
        ],
      }),
    ],
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Crypto Prices',
  register(ctx) {
    // Bersihkan sisa key eksperimen lama (tidak dipakai lagi).
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
      id: 'refresh-cmd',
      area: PALETTE_AREA,
      data: {
        id: 'crypto-prices.refresh',
        label: 'Crypto Prices: Refresh now',
        keywords: ['crypto', 'harga', 'refresh'],
        run: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
      },
    })

    ctx.register({
      id: 'currency-cmd',
      area: PALETTE_AREA,
      data: {
        id: 'crypto-prices.currency',
        label: 'Crypto Prices: Ganti mata uang (siklus daftar)',
        keywords: ['crypto', 'currency', 'ganti', 'mata uang', 'usd', 'idr', 'rupiah', 'eur'],
        run: () => {
          const list = vsListAtom.get() || DEFAULT_VS_LIST
          const cur = vsAtom.get()
          const idx = list.indexOf(cur)
          const next = list[(idx + 1) % list.length] || DEFAULT_VS_LIST[0]
          vsAtom.set(next)
          ctx.storage.set('vs', next)
          host.notify({ kind: 'info', message: `Crypto Prices: harga dalam ${next.toUpperCase()}` })
        },
      },
    })

    ctx.register({
      id: 'manage-cmd',
      area: PALETTE_AREA,
      data: {
        id: 'crypto-prices.manage',
        label: 'Crypto Prices: Kelola Koin & Mata Uang',
        keywords: ['crypto', 'koin', 'coin', 'tambah', 'hapus', 'kelola', 'mata uang', 'currency'],
        run: () => {
          if (typeof host.openWorkspace !== 'function') {
            host.notifyError(new Error('host.openWorkspace tidak tersedia'), 'Kelola Koin butuh Hermes Desktop versi terbaru')
            return
          }
          host.openWorkspace(`${PLUGIN_ID}:manage`, {
            title: 'Kelola Koin & Mata Uang · Crypto',
            minWidth: 380,
            render: () => jsx(ManageCoins, { storage: ctx.storage }),
          })
        },
      },
    })
  },
}
