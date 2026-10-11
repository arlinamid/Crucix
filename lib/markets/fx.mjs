// Exchange rates as "US dollars per one unit" of each supported currency, from whichever source answered, and the
// crosses for every base currency the dashboard offers: the base is a per-user choice, so all of them are precomputed.

export const SUPPORTED_CURRENCIES = Object.freeze(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'HUF', 'CNY']);
export const DEFAULT_BASE_CURRENCY = 'USD';

// The market convention for which currency is quoted first in a pair (EUR/USD, USD/JPY, EUR/HUF).
const PAIR_ORDER = ['EUR', 'GBP', 'AUD', 'USD', 'CAD', 'CHF', 'CNY', 'JPY', 'HUF'];
// The counter currencies shown for a base, in order.
const COUNTERS = ['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD'];
// Benchmark pairs shown whatever the base.
export const BENCHMARK_PAIRS = Object.freeze(['EUR/USD', 'USD/JPY', 'GBP/USD', 'USD/CHF', 'USD/CAD', 'USD/CNY']);

// Yahoo quotes: XXXUSD=X is USD per XXX; XXX=X is XXX per USD.
export const YAHOO_FX = Object.freeze({
  EUR: { symbol: 'EURUSD=X', inverse: false },
  GBP: { symbol: 'GBPUSD=X', inverse: false },
  AUD: { symbol: 'AUDUSD=X', inverse: false },
  JPY: { symbol: 'JPY=X', inverse: true },
  CHF: { symbol: 'CHF=X', inverse: true },
  CAD: { symbol: 'CAD=X', inverse: true },
  CNY: { symbol: 'CNY=X', inverse: true },
  HUF: { symbol: 'HUF=X', inverse: true },
});

const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** The base currency for an env or browser value; anything unsupported is the fallback. */
export function parseBaseCurrency(value, fallback = DEFAULT_BASE_CURRENCY) {
  const code = String(value ?? '').trim().toUpperCase();
  return SUPPORTED_CURRENCIES.includes(code) ? code : fallback;
}

/** Decimals for a rate quoted in `quote`: two for the small-unit currencies, four otherwise. */
export function pairDecimals(quote) {
  return quote === 'JPY' || quote === 'HUF' ? 2 : 4;
}

/** { now, prev } USD-per-unit tables from Yahoo FX quotes ({ price, prevClose }). */
export function usdPerFromYahoo(quotes) {
  const now = { USD: 1 };
  const prev = { USD: 1 };
  for (const [code, { symbol, inverse }] of Object.entries(YAHOO_FX)) {
    const quote = quotes?.[symbol];
    if (!positive(quote?.price)) continue;
    now[code] = inverse ? 1 / quote.price : quote.price;
    if (positive(quote.prevClose)) prev[code] = inverse ? 1 / quote.prevClose : quote.prevClose;
  }
  return { now, prev };
}

/** USD-per-unit from ECB reference rates (units of each currency per one euro). */
export function usdPerFromEcb(rates) {
  const now = { USD: 1 };
  if (!positive(rates?.USD)) return { now, prev: {} };
  now.EUR = rates.USD;
  for (const code of SUPPORTED_CURRENCIES) if (code !== 'USD' && code !== 'EUR' && positive(rates[code])) now[code] = rates.USD / rates[code];
  return { now, prev: {} };
}

/** USD-per-unit from FMP forex rows ({ symbol: 'EURUSD', price, previousClose? | change? }). */
export function usdPerFromFmp(rows) {
  const now = { USD: 1 };
  const prev = { USD: 1 };
  const bySymbol = new Map((Array.isArray(rows) ? rows : []).map(row => [String(row?.symbol ?? '').replace('/', '').toUpperCase(), row]));
  const previous = row => positive(row.previousClose) ? row.previousClose
    : typeof row.change === 'number' && positive(row.price - row.change) ? row.price - row.change : null;
  for (const code of SUPPORTED_CURRENCIES) {
    if (code === 'USD') continue;
    const direct = bySymbol.get(`${code}USD`);
    const inverse = bySymbol.get(`USD${code}`);
    if (positive(direct?.price)) {
      now[code] = direct.price;
      const before = previous(direct);
      if (before) prev[code] = before;
    } else if (positive(inverse?.price)) {
      now[code] = 1 / inverse.price;
      const before = previous(inverse);
      if (before) prev[code] = 1 / before;
    }
  }
  return { now, prev };
}

/** Fills the gaps of the first table from the later ones, currency by currency; `sources` names who supplied what. */
export function mergeUsdPer(...tables) {
  const now = {};
  const prev = {};
  const sources = {};
  for (const { name, table } of tables) {
    if (!table) continue;
    for (const code of SUPPORTED_CURRENCIES) {
      if (now[code] !== undefined || !positive(table.now?.[code])) continue;
      now[code] = table.now[code];
      if (positive(table.prev?.[code])) prev[code] = table.prev[code];
      if (code !== 'USD') sources[code] = name;
    }
  }
  return { now, prev, sources };
}

function pairName(a, b) {
  return PAIR_ORDER.indexOf(a) <= PAIR_ORDER.indexOf(b) ? `${a}/${b}` : `${b}/${a}`;
}

/** One pair row: the price of one unit of the first currency in the second, with the day change when both closes are known. */
export function pairRow(pair, usdPer) {
  const [a, b] = pair.split('/');
  const { now, prev, sources = {} } = usdPer;
  if (!positive(now[a]) || !positive(now[b])) return null;
  const price = now[a] / now[b];
  const decimals = price < 10 ? 4 : pairDecimals(b);
  const before = positive(prev[a]) && positive(prev[b]) ? prev[a] / prev[b] : null;
  const changePct = before ? Math.round(((price - before) / before) * 10000) / 100 : null;
  return { pair, base: a, quote: b, price: Number(price.toFixed(decimals)), decimals, changePct, source: sources[a === 'USD' ? b : a] ?? null };
}

/** The pairs shown for one base currency: the base against the main counters, written the way the market quotes them. */
export function crossesFor(base, usdPer) {
  const code = parseBaseCurrency(base);
  return COUNTERS.filter(counter => counter !== code).slice(0, 5)
    .map(counter => pairRow(pairName(code, counter), usdPer)).filter(Boolean);
}

/** The FX block of the dashboard: benchmark pairs, the crosses for every base, and the server's default base. */
export function buildFx(usdPer, { baseCurrency = DEFAULT_BASE_CURRENCY, asOf = null } = {}) {
  const crosses = Object.fromEntries(SUPPORTED_CURRENCIES.map(code => [code, crossesFor(code, usdPer)]));
  return {
    baseCurrency: parseBaseCurrency(baseCurrency),
    currencies: [...SUPPORTED_CURRENCIES],
    asOf,
    benchmarks: BENCHMARK_PAIRS.map(pair => pairRow(pair, usdPer)).filter(Boolean),
    crosses,
    sources: { ...usdPer.sources },
  };
}
