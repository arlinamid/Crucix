// Finnhub (free key, 60 calls/minute): a second opinion for the US-listed equities when FMP is missing or refuses.
// One call per symbol, eight per sweep; the key travels in a header, never in the URL.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://finnhub.io/api/v1/quote';
export const FINNHUB_SYMBOLS = Object.freeze(['LMT', 'RTX', 'XOM', 'SHEL', 'TTE', 'TSM', 'NVDA', 'ASML']);

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** A Finnhub /quote body ({c, d, dp, h, l, o, pc, t}) as a quote; an unknown symbol answers c = 0 and gives null. */
export function normalizeFinnhubQuote(symbol, body) {
  const price = num(body?.c);
  if (price === null || price <= 0) return null;
  const t = num(body.t);
  return {
    symbol, name: symbol, price,
    prevClose: num(body.pc), change: num(body.d), changePct: num(body.dp),
    dayLow: num(body.l), dayHigh: num(body.h),
    timestamp: t ? new Date(t * 1000).toISOString() : null,
    currency: 'USD', source: 'Finnhub',
  };
}

export async function briefing({ apiKey = process.env.FINNHUB_API_KEY, symbols = FINNHUB_SYMBOLS, fetchImpl = safeFetch, now = Date.now() } = {}) {
  if (!apiKey) return { status: 'no_key', message: 'Set FINNHUB_API_KEY (free at finnhub.io) for a second equity quote source' };
  const results = await Promise.all(symbols.map(async symbol => {
    const body = await fetchImpl(`${BASE}?symbol=${encodeURIComponent(symbol)}`, { timeout: 8000, retries: 0, headers: { 'X-Finnhub-Token': apiKey } });
    return { symbol, quote: body?.error ? null : normalizeFinnhubQuote(symbol, body), status: body?.status ?? null };
  }));
  const quotes = Object.fromEntries(results.filter(row => row.quote).map(row => [row.symbol, row.quote]));
  const failed = results.filter(row => !row.quote);
  const denied = failed.find(row => row.status === 401 || row.status === 403 || row.status === 429);
  return {
    source: 'Finnhub',
    timestamp: new Date(now).toISOString(),
    quotes,
    missing: failed.map(row => row.symbol),
    ...(Object.keys(quotes).length === 0 ? { error: denied ? `Finnhub refused the key (HTTP ${denied.status})` : 'Finnhub returned no quotes' } : {}),
  };
}
