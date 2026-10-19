// The track record of the model's trade ideas (since 2.52.4): each new idea is kept with the price of its instrument when it was made, and
// the next prompt sees how each one has done since (IDEA_TRACK_RECORD in lib/llm/ideas.mjs), so the model can drop a thesis the market has
// rejected and not repeat it in other words. Prices come from the sweep's markets block; an idea on an instrument the sweep does not quote
// is kept without an entry price and shown as untracked. In <runsDir>/intelligence/idea-journal.json; a broken file starts an empty journal.

import { join } from 'node:path';
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.mjs';

const MAX_ENTRIES = 300;
const KEEP_DAYS = 90;
const DAY = 86400000;
// The same instrument and direction again within this time is the same idea told again: it keeps its first entry.
const SAME_IDEA_MS = DAY;
const DIRECTIONS = { LONG: 1, SHORT: -1 };
const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Every quoted instrument of a markets block: upper-case symbol -> {symbol, name, price}. */
export function quoteIndex(markets) {
  const index = new Map();
  if (!markets || typeof markets !== 'object') return index;
  for (const [key, rows] of Object.entries(markets)) {
    if (!Array.isArray(rows) || key === 'providers') continue;
    for (const row of rows) if (typeof row?.symbol === 'string' && finite(row.price) && row.price > 0) index.set(row.symbol.toUpperCase(), { symbol: row.symbol, name: row.name, price: row.price });
  }
  if (finite(markets.vix?.value)) index.set('^VIX', { symbol: '^VIX', name: 'VIX', price: markets.vix.value });
  return index;
}

/** The quoted instrument an idea's ticker names ("SMH", "BZ=F", "BNO/USO" -> the first quoted one); null when none is quoted. */
export function instrumentOf(ticker, index) {
  for (const part of str(ticker, 60).split(/[\s/,;+|]+/).filter(Boolean)) {
    const hit = index.get(part.toUpperCase()) ?? index.get(`^${part.toUpperCase()}`);
    if (hit) return hit;
  }
  return null;
}

export class IdeaJournal {
  constructor(runsDir, { now = Date.now } = {}) {
    this.path = join(String(runsDir), 'intelligence', 'idea-journal.json');
    this._now = now;
    this.entries = [];
  }

  load() {
    const { value } = readJsonWithBackup(this.path, { validate: data => data && data.version === 1 && Array.isArray(data.entries) });
    this.entries = (value?.entries ?? []).filter(entry => entry && typeof entry.at === 'string' && typeof entry.title === 'string').slice(-MAX_ENTRIES);
    return this;
  }

  save() {
    try { writeJsonAtomic(this.path, { version: 1, entries: this.entries }); return true; } catch { return false; }
  }

  /** Records the model ideas of one run with the current price of their instruments. Returns how many were new. */
  record(ideas, markets, now = this._now()) {
    const index = quoteIndex(markets);
    let added = 0;
    for (const idea of Array.isArray(ideas) ? ideas : []) {
      const type = str(idea?.type, 10).toUpperCase();
      const ticker = str(idea?.ticker, 40);
      if (!ticker || !str(idea?.title, 160)) continue;
      const quote = instrumentOf(ticker, index);
      const symbol = quote?.symbol ?? ticker.toUpperCase();
      if (this.entries.some(entry => entry.symbol === symbol && entry.type === type && now - Date.parse(entry.at) < SAME_IDEA_MS)) continue;
      this.entries.push({
        at: new Date(now).toISOString(), title: str(idea.title, 160), type, ticker, symbol, confidence: str(idea.confidence, 10).toUpperCase(),
        horizon: str(idea.horizon, 12), ...(quote ? { entry: quote.price } : {}),
      });
      added++;
    }
    const cutoff = now - KEEP_DAYS * DAY;
    this.entries = this.entries.filter(entry => Date.parse(entry.at) >= cutoff).slice(-MAX_ENTRIES);
    return added;
  }

  /**
   * How the recent ideas have done: `{rows, summary}`. A row's `move` is the instrument's change since the idea, `result` that change in
   * the idea's direction (LONG +, SHORT -; null for HEDGE, WATCH and AVOID). The summary counts the directional ideas older than a day.
   */
  track(markets, { now = this._now(), limit = 12 } = {}) {
    const index = quoteIndex(markets);
    const rows = this.entries.slice(-limit).reverse().map(entry => {
      const price = index.get(String(entry.symbol).toUpperCase())?.price;
      const move = finite(entry.entry) && finite(price) ? Number(((price / entry.entry - 1) * 100).toFixed(2)) : null;
      const direction = DIRECTIONS[entry.type];
      return { ...entry, price: price ?? null, move, result: move === null || !direction ? null : Number((move * direction).toFixed(2)), ageDays: Number(((now - Date.parse(entry.at)) / DAY).toFixed(1)) };
    });
    const settled = this.entries.map(entry => {
      const price = index.get(String(entry.symbol).toUpperCase())?.price;
      const direction = DIRECTIONS[entry.type];
      if (!direction || !finite(entry.entry) || !finite(price) || now - Date.parse(entry.at) < DAY) return null;
      return { confidence: entry.confidence, result: (price / entry.entry - 1) * 100 * direction };
    }).filter(Boolean);
    const summary = settled.length ? {
      ideas: settled.length, winners: settled.filter(item => item.result > 0).length,
      averageResult: Number((settled.reduce((sum, item) => sum + item.result, 0) / settled.length).toFixed(2)),
    } : null;
    return { rows, summary };
  }
}
