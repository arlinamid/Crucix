// Yahoo Finance — Live market quotes (no API key required)
// Provides real-time prices for stocks, ETFs, crypto, commodities, world indexes and FX
// Replaces the need for Alpaca or any paid market data provider

import { safeFetch } from '../utils/fetch.mjs';
import { YAHOO_FX } from '../../lib/markets/fx.mjs';
import { loadSeries, mergeSeries, saveSeries, seriesStats } from '../../lib/markets/series.mjs';

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const CONCURRENCY = 8;
// A three-month chart per symbol (one request, as the five-day chart was): its bars feed the stored daily series (lib/markets/series.mjs)
// and the trend figures; the quote keeps only the last HISTORY_DAYS bars for the dashboard.
const RANGE = '3mo';
const HISTORY_DAYS = 5;

const GROUPS = {
  indexes: { '^GSPC': 'S&P 500', '^IXIC': 'Nasdaq Composite', '^DJI': 'Dow Jones', '^RUT': 'Russell 2000' },
  worldIndexes: {
    '^GDAXI': 'DAX', '^FTSE': 'FTSE 100', '^N225': 'Nikkei 225', '^HSI': 'Hang Seng', '^BUX.BD': 'BUX',
    // Europe (since 2.52.4)
    '^STOXX50E': 'Euro Stoxx 50', '^STOXX': 'STOXX Europe 600', '^FCHI': 'CAC 40', 'FTSEMIB.MI': 'FTSE MIB', '^IBEX': 'IBEX 35',
    '^AEX': 'AEX', '^SSMI': 'SMI',
    // Americas and Asia-Pacific (since 2.52.4)
    '^GSPTSE': 'S&P/TSX', '^BVSP': 'Bovespa', '^MXX': 'IPC Mexico', '^AXJO': 'ASX 200', '^KS11': 'KOSPI', '^TWII': 'Taiwan Weighted',
    '000001.SS': 'Shanghai Composite', '^BSESN': 'BSE Sensex',
  },
  // Sector and regional ETFs (since 2.52.4): instruments an idea can name and the idea journal can follow.
  sectors: {
    XLE: 'Energy (XLE)', XLF: 'Financials (XLF)', XLK: 'Technology (XLK)', XLI: 'Industrials (XLI)', XLU: 'Utilities (XLU)',
    XLV: 'Health Care (XLV)', ITA: 'US Aerospace & Defense (ITA)', SMH: 'Semiconductors (SMH)', KRE: 'Regional Banks (KRE)',
    VGK: 'Europe (VGK)', EZU: 'Eurozone (EZU)', EUFN: 'Europe Financials (EUFN)', EEM: 'Emerging Markets (EEM)',
  },
  rates: {
    TLT: '20Y+ Treasury', HYG: 'High Yield Corp', LQD: 'IG Corporate',
    // The US curve in percent and the dollar index (since 2.52.4)
    '^IRX': 'US 13W yield %', '^FVX': 'US 5Y yield %', '^TNX': 'US 10Y yield %', '^TYX': 'US 30Y yield %',
    IEF: '7-10Y Treasury', SHY: '1-3Y Treasury', 'DX-Y.NYB': 'US Dollar Index (DXY)',
  },
  commodities: {
    'GC=F': 'Gold', 'SI=F': 'Silver', 'CL=F': 'WTI Crude', 'BZ=F': 'Brent Crude', 'NG=F': 'Natural Gas',
    // Since 2.52.4
    'HG=F': 'Copper', 'ZW=F': 'Wheat', 'ZC=F': 'Corn', URA: 'Uranium (URA)', BDRY: 'Dry Bulk Shipping (BDRY)', GDX: 'Gold Miners (GDX)',
    XOP: 'Oil & Gas E&P (XOP)',
  },
  crypto: { 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum' },
  volatility: { '^VIX': 'VIX' },
  // Defense, energy and semiconductors: the sectors the OSINT signals move first.
  equities: {
    LMT: 'Lockheed Martin', 'RHM.DE': 'Rheinmetall', RTX: 'RTX', XOM: 'ExxonMobil', SHEL: 'Shell',
    TTE: 'TotalEnergies', TSM: 'TSMC', NVDA: 'NVIDIA', ASML: 'ASML',
  },
  fx: Object.fromEntries(Object.entries(YAHOO_FX).map(([code, { symbol, inverse }]) => [symbol, inverse ? `USD/${code}` : `${code}/USD`])),
};

const SYMBOLS = Object.fromEntries(Object.values(GROUPS).flatMap(group => Object.entries(group)));
export const YAHOO_SYMBOLS = Object.freeze({ ...SYMBOLS });
const FX_SYMBOLS = new Set(Object.keys(GROUPS.fx));

const round = (value, decimals) => (Number.isFinite(value) ? Number(value.toFixed(decimals)) : null);

/**
 * The quote from one Yahoo chart response. The previous close is the daily bar before the latest one: with
 * a multi-day range, meta.chartPreviousClose is the close before the window, which turned a five-day move into
 * the "daily" change.
 */
export function parseChart(symbol, data) {
  const result = data?.chart?.result?.[0];
  if (!result) return { symbol, name: SYMBOLS[symbol] || symbol, error: data?.error || 'Yahoo returned no chart data' };
  const meta = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];
  const bars = timestamps.map((t, i) => ({ t, close: closes[i] })).filter(bar => Number.isFinite(bar.close));

  const price = meta.regularMarketPrice ?? bars.at(-1)?.close;
  if (!Number.isFinite(price)) return { symbol, name: SYMBOLS[symbol] || symbol, error: 'Yahoo returned no valid price' };
  const prevClose = bars.length >= 2 ? bars.at(-2).close : (meta.previousClose ?? meta.chartPreviousClose ?? null);
  const change = Number.isFinite(prevClose) ? price - prevClose : 0;
  const changePct = Number.isFinite(prevClose) && prevClose ? (change / prevClose) * 100 : 0;
  const decimals = FX_SYMBOLS.has(symbol) ? 6 : 2;

  return {
    symbol,
    name: SYMBOLS[symbol] || meta.shortName || symbol,
    price: round(price, decimals),
    prevClose: round(prevClose ?? 0, decimals),
    change: round(change, decimals),
    changePct: round(changePct, 2),
    dayLow: round(meta.regularMarketDayLow, decimals),
    dayHigh: round(meta.regularMarketDayHigh, decimals),
    yearLow: round(meta.fiftyTwoWeekLow, decimals),
    yearHigh: round(meta.fiftyTwoWeekHigh, decimals),
    volume: Number.isFinite(meta.regularMarketVolume) ? meta.regularMarketVolume : null,
    currency: meta.currency || 'USD',
    exchange: meta.exchangeName || '',
    marketState: meta.marketState || 'UNKNOWN',
    timestamp: Number.isFinite(meta.regularMarketTime) ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    source: 'Yahoo',
    history: bars.map(bar => ({ date: new Date(bar.t * 1000).toISOString().split('T')[0], close: round(bar.close, decimals) })),
  };
}

export async function fetchQuote(symbol) {
  try {
    const url = `${BASE}/${encodeURIComponent(symbol)}?range=${RANGE}&interval=1d&includePrePost=false`;
    const data = await safeFetch(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    return parseChart(symbol, data);
  } catch (e) {
    return { symbol, name: SYMBOLS[symbol] || symbol, error: e.message };
  }
}

export async function briefing() {
  return collect();
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try { out[index] = { status: 'fulfilled', value: await fn(items[index]) }; }
      catch (reason) { out[index] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// `series`: the stored daily series ({load, save}, lib/markets/series.mjs by default; null leaves it out, as in a test without a profile).
export async function collect({ fetch: fetchOne = fetchQuote, series = { load: loadSeries, save: saveSeries } } = {}) {
  const symbols = Object.keys(SYMBOLS);
  const results = await mapLimited(symbols, CONCURRENCY, fetchOne);
  let store = null;
  try { store = series ? series.load() : null; } catch { store = null; }

  const quotes = {};
  let ok = 0;
  let failed = 0;

  for (const [index, r] of results.entries()) {
    const q = r.status === 'fulfilled' ? r.value : null;
    if (q && !q.error) {
      // The full chart extends the stored series; the trend figures come from the series; the quote keeps the last days only.
      const bars = Array.isArray(q.history) ? q.history : [];
      const stored = store ? mergeSeries(store, q.symbol, bars) : null;
      const stats = seriesStats(stored ? stored.c : bars.map(bar => bar.close), { price: q.price, yearHigh: q.yearHigh, yearLow: q.yearLow });
      quotes[q.symbol] = { ...q, history: bars.slice(-HISTORY_DAYS), ...(stats ? { stats } : {}) };
      ok++;
    } else {
      failed++;
      const sym = q?.symbol || symbols[index];
      quotes[sym] = q || { symbol: sym, name: SYMBOLS[sym] || sym, error: 'fetch failed' };
    }
  }

  if (store && ok) { try { series.save(store); } catch { /* the series is a convenience: a failed save never fails the sweep */ } }

  // Categorize for easy dashboard consumption
  return {
    quotes,
    summary: {
      totalSymbols: symbols.length,
      ok,
      failed,
      timestamp: new Date().toISOString(),
    },
    ...Object.fromEntries(Object.entries(GROUPS).map(([group, members]) => [group, pickGroup(quotes, Object.keys(members))])),
  };
}

function pickGroup(quotes, symbols) {
  return symbols.map(s => quotes[s]).filter(Boolean);
}
