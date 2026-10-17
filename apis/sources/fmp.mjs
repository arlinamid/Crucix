// Financial Modeling Prep (free key, 250 calls/day): the richest free quotes for equities and indexes, and all forex
// pairs in one call. Two batch calls per sweep (quotes, forex) = 192 calls/day at the 15-minute sweep. A daily budget
// keeps headroom; an endpoint the plan refuses (402/403) rests for a day instead of spending calls, and Yahoo covers it.
// Since October 2026 FMP's free plan refuses both batch endpoints (HTTP 402 "Restricted Endpoint"; single-symbol `quote` still works,
// but 16 symbols a sweep would need ~1,500 calls a day of the 250): with both refused by the plan the source is disabled, not failing.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://financialmodelingprep.com/stable';
const DAY_MS = 86_400_000;
export const FMP_SYMBOLS = Object.freeze([
  '^GSPC', '^IXIC', '^DJI', '^GDAXI', '^FTSE', '^N225', '^HSI',
  'LMT', 'RHM.DE', 'RTX', 'XOM', 'SHEL', 'TTE', 'TSM', 'NVDA', 'ASML',
]);

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** One FMP quote (stable or legacy v3 field names) in the shape of a Yahoo quote, plus FMP's extra fields. */
export function normalizeFmpQuote(row) {
  const price = num(row?.price);
  if (!row?.symbol || price === null || price <= 0) return null;
  const change = num(row.change);
  const previous = num(row.previousClose) ?? (change !== null ? price - change : null);
  const timestamp = num(row.timestamp);
  return {
    symbol: String(row.symbol),
    name: typeof row.name === 'string' ? row.name.slice(0, 80) : String(row.symbol),
    price,
    prevClose: previous,
    change,
    changePct: num(row.changePercentage) ?? num(row.changesPercentage),
    dayLow: num(row.dayLow), dayHigh: num(row.dayHigh),
    yearLow: num(row.yearLow), yearHigh: num(row.yearHigh),
    volume: num(row.volume), avgVolume: num(row.avgVolume),
    marketCap: num(row.marketCap),
    priceAvg50: num(row.priceAvg50), priceAvg200: num(row.priceAvg200),
    exchange: typeof row.exchange === 'string' ? row.exchange : '',
    timestamp: timestamp ? new Date(timestamp * 1000).toISOString() : null,
    source: 'FMP',
  };
}

function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Per-process state: calls spent today, and when each refused endpoint may be tried again. */
export function createFmpState() {
  return { day: null, used: 0, restUntil: {}, refusedByPlan: {} };
}
const sharedState = createFmpState();

function spend(state, now, limit) {
  const day = utcDay(now);
  if (state.day !== day) { state.day = day; state.used = 0; }
  if (state.used >= limit) return false;
  state.used++;
  return true;
}

async function call(endpoint, params, { apiKey, state, now, limit, fetchImpl }) {
  if ((state.restUntil[endpoint] ?? 0) > now) return { skipped: 'resting' };
  if (!spend(state, now, limit)) return { skipped: 'budget' };
  const query = new URLSearchParams({ ...params, apikey: apiKey });
  const data = await fetchImpl(`${BASE}/${endpoint}?${query}`, { timeout: 12000, retries: 0, maxBytes: 4 * 1024 * 1024 });
  if (Array.isArray(data)) return { rows: data };
  const status = data?.status;
  // 401: wrong key; 402/403: not in this plan; 429: the daily quota is spent. None of them improves within the sweep.
  if (status === 401) state.restUntil[endpoint] = now + DAY_MS / 24;
  if (status === 402 || status === 403) { state.restUntil[endpoint] = now + DAY_MS; (state.refusedByPlan ??= {})[endpoint] = true; }
  if (status === 429) state.restUntil[endpoint] = Date.parse(`${utcDay(now + DAY_MS)}T00:00:00Z`);
  const reason = status === 401 ? 'invalid API key' : status === 402 || status === 403 ? 'not available on this FMP plan'
    : status === 429 ? 'daily FMP quota reached' : data?.error || data?.['Error Message'] || 'unexpected FMP response';
  return { error: String(reason).slice(0, 160), status };
}

export async function briefing({
  apiKey = process.env.FMP_API_KEY,
  dailyLimit = Number(process.env.FMP_DAILY_LIMIT) || 250,
  symbols = FMP_SYMBOLS,
  now = Date.now(),
  state = sharedState,
  fetchImpl = safeFetch,
} = {}) {
  if (!apiKey) return { status: 'no_key', message: 'Set FMP_API_KEY (free at financialmodelingprep.com) for richer quotes' };
  const opts = { apiKey, state, now, limit: dailyLimit, fetchImpl };
  const [quotes, forex] = await Promise.all([
    call('batch-quote', { symbols: symbols.join(',') }, opts),
    call('batch-forex-quotes', {}, opts),
  ]);
  const byQuote = {};
  for (const row of quotes.rows ?? []) {
    const quote = normalizeFmpQuote(row);
    if (quote) byQuote[quote.symbol] = quote;
  }
  const fx = (forex.rows ?? [])
    .filter(row => typeof row?.symbol === 'string' && /^[A-Z]{6}$/.test(row.symbol.replace('/', '')) && num(row.price) > 0)
    .map(row => ({ symbol: row.symbol.replace('/', ''), price: row.price, change: num(row.change), previousClose: num(row.previousClose) }));
  const endpoints = { quotes: quotes.error ?? quotes.skipped ?? 'ok', forex: forex.error ?? forex.skipped ?? 'ok' };
  const failures = [quotes.error, forex.error].filter(Boolean);
  const refused = state.refusedByPlan ?? {};
  if (refused['batch-quote'] && refused['batch-forex-quotes'] && !Object.keys(byQuote).length && !fx.length) {
    return { source: 'FMP', status: 'disabled', timestamp: new Date(now).toISOString(), quotes: {}, fx: [], endpoints,
      budget: { day: state.day, used: state.used, limit: dailyLimit },
      message: 'The FMP plan of this key refuses the batch quote and forex endpoints (HTTP 402); Yahoo covers these quotes. Optional source, skipped.' };
  }
  return {
    source: 'FMP',
    timestamp: new Date(now).toISOString(),
    quotes: byQuote,
    fx,
    endpoints,
    budget: { day: state.day, used: state.used, limit: dailyLimit },
    // Both refused: a source error; one refused: the other still delivers, and Yahoo covers the gap.
    ...(failures.length === 2 ? { error: failures[0] } : {}),
  };
}
