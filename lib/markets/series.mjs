// The daily close series of every Yahoo symbol, kept in CRUCIX_HOME/cache/market-series.json: each sweep merges the bars of its
// three-month chart, so the series grows past Yahoo's window to MAX_DAYS sessions. The trend figures of a quote (1 week / 1 month /
// 3 months / 1 year change, 20-day volatility, distance from the 50- and 200-day averages and from the 52-week range) come from it, so the
// trade ideas can tell a fresh move from a long trend. Bounded and defensive: a broken file starts an empty store, never a failed sweep.

import { join } from 'node:path';
import { crucixHome } from '../user-paths.mjs';
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.mjs';

export const MAX_DAYS = 400;
const MAX_SYMBOLS = 200;
const MAX_BYTES = 4 * 1024 * 1024;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL = /^[\w.^=\-/]{1,24}$/;

export const seriesPath = (options = {}) => join(crucixHome(options), 'cache', 'market-series.json');

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** The stored series `{version, symbols: {SYM: {d: [dates], c: [closes]}}}`; an empty store when nothing usable is on disk. */
export function loadSeries(path = seriesPath()) {
  const { value } = readJsonWithBackup(path, { maxBytes: MAX_BYTES, validate: data => data && typeof data === 'object' && data.version === 1 && data.symbols && typeof data.symbols === 'object' });
  const symbols = {};
  for (const [symbol, row] of Object.entries(value?.symbols ?? {}).slice(0, MAX_SYMBOLS)) {
    if (!SYMBOL.test(symbol) || !Array.isArray(row?.d) || !Array.isArray(row?.c) || row.d.length !== row.c.length) continue;
    const d = [], c = [];
    for (let i = 0; i < row.d.length; i++) if (DATE.test(row.d[i]) && finite(row.c[i]) && row.c[i] > 0) { d.push(row.d[i]); c.push(row.c[i]); }
    symbols[symbol] = { d: d.slice(-MAX_DAYS), c: c.slice(-MAX_DAYS) };
  }
  return { version: 1, symbols };
}

/** Writes the store; false (never a throw) when the file cannot be written. */
export function saveSeries(store, path = seriesPath()) {
  try { writeJsonAtomic(path, store); return true; } catch { return false; }
}

/** Merges daily bars (`[{date, close}]`) into the store: a date already held takes the newer close; at most MAX_DAYS, oldest dropped. */
export function mergeSeries(store, symbol, bars) {
  if (!SYMBOL.test(symbol) || !Array.isArray(bars)) return store.symbols[symbol] ?? null;
  const byDate = new Map();
  const known = store.symbols[symbol];
  if (known) for (let i = 0; i < known.d.length; i++) byDate.set(known.d[i], known.c[i]);
  for (const bar of bars) if (DATE.test(bar?.date) && finite(bar?.close) && bar.close > 0) byDate.set(bar.date, bar.close);
  if (!byDate.size) return known ?? null;
  if (!known && Object.keys(store.symbols).length >= MAX_SYMBOLS) return null;
  const dates = [...byDate.keys()].sort().slice(-MAX_DAYS);
  store.symbols[symbol] = { d: dates, c: dates.map(date => byDate.get(date)) };
  return store.symbols[symbol];
}

const pct = (a, b) => (finite(a) && finite(b) && b > 0 ? Number(((a / b - 1) * 100).toFixed(2)) : null);
const mean = list => list.reduce((sum, value) => sum + value, 0) / list.length;

/**
 * The trend figures of a symbol from its closes (oldest first, the last one today's), with the live price and Yahoo's 52-week range.
 * Each figure is null when the series is too short for it. Changes and distances are percentages.
 */
export function seriesStats(closes, { price, yearHigh, yearLow } = {}) {
  const list = (Array.isArray(closes) ? closes : []).filter(value => finite(value) && value > 0);
  const last = finite(price) && price > 0 ? price : list.at(-1);
  if (!finite(last) || list.length < 2) return null;
  const ago = sessions => (list.length > sessions ? list[list.length - 1 - sessions] : null);
  const window = list.slice(-21);
  const returns = window.slice(1).map((value, i) => Math.log(value / window[i]));
  const vol20 = returns.length >= 10 ? Math.sqrt(returns.reduce((sum, r) => sum + (r - mean(returns)) ** 2, 0) / (returns.length - 1)) * Math.sqrt(252) * 100 : null;
  const average = sessions => (list.length >= sessions ? mean(list.slice(-sessions)) : null);
  const year = list.slice(-252);
  const high = finite(yearHigh) && yearHigh > 0 ? Math.max(yearHigh, ...year) : (list.length >= 120 ? Math.max(...year) : null);
  const low = finite(yearLow) && yearLow > 0 ? Math.min(yearLow, ...year) : (list.length >= 120 ? Math.min(...year) : null);
  return {
    sessions: list.length,
    w1: pct(last, ago(5)), m1: pct(last, ago(21)), m3: pct(last, ago(63)), y1: pct(last, ago(252)),
    vol20: vol20 === null ? null : Number(vol20.toFixed(1)),
    ma50: pct(last, average(50)), ma200: pct(last, average(200)),
    fromHigh: pct(last, high), fromLow: pct(last, low),
  };
}
