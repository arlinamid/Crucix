// Yahoo Finance — Live market quotes (no API key required)
// Provides real-time prices for stocks, ETFs, crypto, commodities, world indexes and FX
// Replaces the need for Alpaca or any paid market data provider

import { safeFetch } from '../utils/fetch.mjs';
import { YAHOO_FX } from '../../lib/markets/fx.mjs';

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const CONCURRENCY = 8;

const GROUPS = {
  indexes: { '^GSPC': 'S&P 500', '^IXIC': 'Nasdaq Composite', '^DJI': 'Dow Jones', '^RUT': 'Russell 2000' },
  worldIndexes: { '^GDAXI': 'DAX', '^FTSE': 'FTSE 100', '^N225': 'Nikkei 225', '^HSI': 'Hang Seng', '^BUX.BD': 'BUX' },
  rates: { TLT: '20Y+ Treasury', HYG: 'High Yield Corp', LQD: 'IG Corporate' },
  commodities: { 'GC=F': 'Gold', 'SI=F': 'Silver', 'CL=F': 'WTI Crude', 'BZ=F': 'Brent Crude', 'NG=F': 'Natural Gas' },
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
 * range=5d, meta.chartPreviousClose is the close before the five-day window, which turned a five-day move into
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
    const url = `${BASE}/${encodeURIComponent(symbol)}?range=5d&interval=1d&includePrePost=false`;
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

export async function collect({ fetch: fetchOne = fetchQuote } = {}) {
  const symbols = Object.keys(SYMBOLS);
  const results = await mapLimited(symbols, CONCURRENCY, fetchOne);

  const quotes = {};
  let ok = 0;
  let failed = 0;

  for (const [index, r] of results.entries()) {
    const q = r.status === 'fulfilled' ? r.value : null;
    if (q && !q.error) {
      quotes[q.symbol] = q;
      ok++;
    } else {
      failed++;
      const sym = q?.symbol || symbols[index];
      quotes[sym] = q || { symbol: sym, name: SYMBOLS[sym] || sym, error: 'fetch failed' };
    }
  }

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
