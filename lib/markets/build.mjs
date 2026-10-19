// The dashboard's markets block from the market sources of one sweep. Each symbol takes the freshest quote among
// FMP, Finnhub and Yahoo (FMP first on a tie, for its extra fields); gaps are filled from the others, and the
// five-day history always comes from Yahoo. FX: FMP forex, then Yahoo, then the ECB reference rates.

import { buildFx, mergeUsdPer, usdPerFromEcb, usdPerFromFmp, usdPerFromYahoo } from './fx.mjs';

const FIELDS = ['name', 'price', 'prevClose', 'change', 'changePct', 'dayLow', 'dayHigh', 'yearLow', 'yearHigh', 'volume',
  'avgVolume', 'marketCap', 'priceAvg50', 'priceAvg200', 'currency', 'exchange', 'timestamp'];
const RANK = { FMP: 0, Finnhub: 1, Yahoo: 2 };

const usable = quote => quote && !quote.error && typeof quote.price === 'number' && Number.isFinite(quote.price) && quote.price > 0;

/** One merged quote from the candidates for a symbol; null when none has a price. */
export function mergeQuote(symbol, candidates) {
  const list = candidates.filter(usable)
    .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0) || (RANK[a.source] ?? 9) - (RANK[b.source] ?? 9));
  if (!list.length) return null;
  const out = { symbol, source: list[0].source ?? null };
  for (const field of FIELDS) {
    const value = list.find(quote => quote[field] !== undefined && quote[field] !== null && quote[field] !== '')?.[field];
    if (value !== undefined) out[field] = value;
  }
  const yahoo = candidates.find(quote => quote?.source === 'Yahoo' || Array.isArray(quote?.history));
  out.history = Array.isArray(yahoo?.history) ? yahoo.history : [];
  // The trend figures of the stored daily series (apis/sources/yfinance.mjs, lib/markets/series.mjs).
  if (yahoo?.stats && typeof yahoo.stats === 'object') out.stats = yahoo.stats;
  return out;
}

function group(yahooGroup, extra) {
  return (Array.isArray(yahooGroup) ? yahooGroup : [])
    .map(quote => mergeQuote(quote.symbol, [extra.fmp[quote.symbol], extra.finnhub[quote.symbol], quote]))
    .filter(Boolean);
}

const brief = quote => ({ symbol: quote.symbol, name: quote.name, price: quote.price, change: quote.change, changePct: quote.changePct, ...(quote.stats ? { stats: quote.stats } : {}) });

/** The markets block; `sources` is the sweep's data.sources. */
export function buildMarkets(sources = {}, { baseCurrency } = {}) {
  const yf = sources.YFinance || {};
  const extra = { fmp: sources.FMP?.quotes || {}, finnhub: sources.Finnhub?.quotes || {} };
  const yfQuotes = yf.quotes || {};
  const usdPer = mergeUsdPer(
    { name: 'FMP', table: usdPerFromFmp(sources.FMP?.fx) },
    { name: 'Yahoo', table: usdPerFromYahoo(yfQuotes) },
    { name: 'ECB', table: usdPerFromEcb(sources.ECB?.rates) },
  );
  const withHistory = quote => ({ ...brief(quote), history: quote.history });
  const detailed = quote => ({
    ...brief(quote), currency: quote.currency ?? null, dayLow: quote.dayLow ?? null, dayHigh: quote.dayHigh ?? null,
    yearLow: quote.yearLow ?? null, yearHigh: quote.yearHigh ?? null, volume: quote.volume ?? null, avgVolume: quote.avgVolume ?? null,
    marketCap: quote.marketCap ?? null, priceAvg50: quote.priceAvg50 ?? null, priceAvg200: quote.priceAvg200 ?? null,
    source: quote.source, history: quote.history,
  });
  return {
    indexes: group(yf.indexes, extra).map(withHistory),
    worldIndexes: group(yf.worldIndexes, extra).map(detailed),
    sectors: group(yf.sectors, extra).map(withHistory),
    rates: group(yf.rates, extra).map(brief),
    commodities: group(yf.commodities, extra).map(withHistory),
    crypto: group(yf.crypto, extra).map(brief),
    equities: group(yf.equities, extra).map(detailed),
    fx: buildFx(usdPer, { baseCurrency, asOf: sources.FMP?.timestamp || yf.summary?.timestamp || null }),
    vix: usable(yfQuotes['^VIX']) ? { value: yfQuotes['^VIX'].price, change: yfQuotes['^VIX'].change, changePct: yfQuotes['^VIX'].changePct } : null,
    providers: {
      fmp: sources.FMP ? (sources.FMP.disabled ? 'no_key' : sources.FMP.error ? 'error' : 'ok') : 'absent',
      finnhub: sources.Finnhub ? (sources.Finnhub.disabled ? 'no_key' : sources.Finnhub.error ? 'error' : 'ok') : 'absent',
    },
    timestamp: yf.summary?.timestamp || null,
  };
}
