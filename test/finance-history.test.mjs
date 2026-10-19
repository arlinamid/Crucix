import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSeries, saveSeries, mergeSeries, seriesStats, MAX_DAYS } from '../lib/markets/series.mjs';
import { collect as collectYahoo } from '../apis/sources/yfinance.mjs';
import { buildMarkets } from '../lib/markets/build.mjs';
import { IdeaJournal, quoteIndex, instrumentOf } from '../lib/llm/idea-journal.mjs';
import { compactSweepForLLM } from '../lib/llm/ideas.mjs';

const DAY = 86400000;
const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'crucix-finance-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const dateOf = (start, i) => new Date(Date.parse(start) + i * DAY).toISOString().slice(0, 10);
const bars = (start, closes) => closes.map((close, i) => ({ date: dateOf(start, i), close }));

test('series: merging keeps one close per date (the newer wins), sorted, at most MAX_DAYS, and survives a broken file', t => {
  const dir = tempDir(t);
  const path = join(dir, 'market-series.json');
  const store = loadSeries(path);
  assert.deepEqual(store, { version: 1, symbols: {} });
  mergeSeries(store, 'SMH', bars('2026-07-01', [100, 101, 102]));
  mergeSeries(store, 'SMH', [{ date: '2026-07-03', close: 103 }, { date: '2026-07-04', close: 104 }, { date: 'bad', close: 1 }, { date: '2026-07-05', close: -1 }]);
  assert.deepEqual(store.symbols.SMH, { d: ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'], c: [100, 101, 103, 104] });
  mergeSeries(store, 'LONG', bars('2025-01-01', Array.from({ length: MAX_DAYS + 30 }, (_, i) => 50 + i)));
  assert.equal(store.symbols.LONG.c.length, MAX_DAYS);
  assert.equal(store.symbols.LONG.c[0], 80, 'the oldest days go first');
  assert.ok(saveSeries(store, path));
  assert.deepEqual(loadSeries(path).symbols.SMH.c, [100, 101, 103, 104]);
  writeFileSync(path, '{broken');
  writeFileSync(`${path}.bak`, '{broken');
  assert.deepEqual(loadSeries(path).symbols, {});
});

test('series stats: week, month, quarter and year changes, averages, 52-week range and volatility from the closes', () => {
  const closes = Array.from({ length: 260 }, (_, i) => 100 + i);
  const stats = seriesStats(closes, { price: 359, yearHigh: 400, yearLow: 0 });
  assert.equal(stats.sessions, 260);
  assert.equal(stats.w1, Number(((359 / 354 - 1) * 100).toFixed(2)));
  assert.equal(stats.m1, Number(((359 / 338 - 1) * 100).toFixed(2)));
  assert.equal(stats.m3, Number(((359 / 296 - 1) * 100).toFixed(2)));
  assert.equal(stats.y1, Number(((359 / 107 - 1) * 100).toFixed(2)));
  assert.equal(stats.fromHigh, Number(((359 / 400 - 1) * 100).toFixed(2)));
  assert.equal(stats.fromLow, Number(((359 / 108 - 1) * 100).toFixed(2)), "Yahoo's 0 low is ignored: the series low");
  assert.ok(stats.ma50 > 0 && stats.ma200 > stats.ma50);
  assert.ok(stats.vol20 > 0 && stats.vol20 < 10, 'a steady climb is barely volatile');
  const short = seriesStats([10, 11, 12], { price: 12 });
  assert.deepEqual([short.m1, short.m3, short.ma50, short.vol20, short.fromHigh], [null, null, null, null, null]);
  assert.equal(seriesStats([], { price: 5 }), null);
});

test('Yahoo: the three-month chart feeds the stored series and the trend figures; the quote keeps five days for the dashboard', async t => {
  const saved = [];
  const memory = { version: 1, symbols: { SMH: { d: bars('2026-05-01', Array(40).fill(400)).map(b => b.date), c: Array(40).fill(400) } } };
  const chart = symbol => ({ symbol, name: symbol, price: 540, prevClose: 530, changePct: 1.89, yearHigh: 671.83, yearLow: 315.05,
    history: bars('2026-07-20', Array.from({ length: 65 }, (_, i) => 480 + i)) });
  const data = await collectYahoo({ fetch: async symbol => chart(symbol), series: { load: () => memory, save: store => saved.push(store) } });
  const smh = data.quotes.SMH;
  assert.equal(smh.history.length, 5);
  assert.equal(smh.stats.sessions, 105, '40 stored days and 65 new ones');
  assert.equal(smh.stats.fromHigh, Number(((540 / 671.83 - 1) * 100).toFixed(2)));
  assert.equal(saved.length, 1, 'one save per sweep');
  assert.ok(data.sectors.length >= 13 && data.sectors.every(quote => quote.stats));
  const markets = buildMarkets({ YFinance: data });
  assert.ok(markets.sectors.find(quote => quote.symbol === 'SMH').stats);
  assert.ok(markets.rates.find(quote => quote.symbol === '^TNX').stats, 'the brief groups carry the trend too');
});

test('idea journal: entry prices, one entry per idea a day, results in the idea direction, untracked tickers', t => {
  const now = Date.parse('2026-10-19T09:00:00Z');
  const markets = { sectors: [{ symbol: 'SMH', name: 'Semiconductors', price: 540 }], commodities: [{ symbol: 'BZ=F', name: 'Brent', price: 107 }] };
  const journal = new IdeaJournal(tempDir(t), { now: () => now }).load();
  assert.equal(instrumentOf('BNO/BZ=F', quoteIndex(markets)).symbol, 'BZ=F');
  const added = journal.record([
    { title: 'Chips short', type: 'SHORT', ticker: 'SMH', confidence: 'HIGH', horizon: 'Days' },
    { title: 'Brent long', type: 'LONG', ticker: 'BZ=F', confidence: 'MEDIUM' },
    { title: 'Homebuilders short', type: 'SHORT', ticker: 'XHB', confidence: 'MEDIUM' },
  ], markets, now);
  assert.equal(added, 3);
  assert.equal(journal.record([{ title: 'Chips short again', type: 'SHORT', ticker: 'SMH' }], markets, now + 3600000), 0, 'the same idea within a day');
  assert.ok(journal.save());
  const later = { sectors: [{ symbol: 'SMH', price: 513 }], commodities: [{ symbol: 'BZ=F', price: 110.21 }] };
  const reloaded = new IdeaJournal(journal.path.replace(/[\\/]intelligence[\\/]idea-journal\.json$/, ''), { now: () => now + 2 * DAY }).load();
  const { rows, summary } = reloaded.track(later);
  const bySymbol = Object.fromEntries(rows.map(row => [row.symbol, row]));
  assert.equal(bySymbol.SMH.result, 5, 'a 5 % fall is a 5 % gain for a short');
  assert.equal(bySymbol['BZ=F'].result, 3);
  assert.equal(bySymbol.XHB.entry, undefined);
  assert.equal(bySymbol.XHB.result, null);
  assert.deepEqual(summary, { ideas: 2, winners: 2, averageResult: 4 });
});

test('the ideas context carries the trend figures, the wider FRED set and the track record in place of the bare previous list', () => {
  const text = compactSweepForLLM({
    markets: { sectors: [{ symbol: 'SMH', name: 'Semiconductors (SMH)', price: 539.79, changePct: -2.1, stats: { w1: -4.2, m1: -9.8, m3: 6.1, y1: 41.3, ma50: -6.5, ma200: 12.4, fromHigh: -19.7, vol20: 38.4 } }] },
    fred: [{ id: 'ICSA', label: 'Initial Jobless Claims', value: 231000, date: '2026-10-11', recent: [231000, 226000] }, { id: 'T10Y3M', label: '10Y-3M Spread', value: 1.02, date: '2026-10-16' }],
    ideaTrack: { summary: { ideas: 4, winners: 3, averageResult: 1.85 }, rows: [{ type: 'SHORT', ticker: 'SMH', confidence: 'HIGH', title: 'Chips short', entry: 551.2, price: 539.79, move: -2.07, result: 2.07, ageDays: 1.1 },
      { type: 'WATCH', ticker: 'BNO', confidence: 'LOW', title: 'Spread watch', ageDays: 0.4 }] },
  }, null, [{ title: 'Old idea', type: 'LONG' }]);
  assert.match(text, /Semiconductors \(SMH\) \[SMH\] 539\.79 \(d -2\.1%, 1w -4\.2, 1m -9\.8, 3m \+6\.1, 1y \+41\.3, MA50 -6\.5, MA200 \+12\.4, 52wH -19\.7, vol 38\)/);
  assert.match(text, /SECTOR_REGION_ETFS/);
  assert.match(text, /ICSA Initial Jobless Claims=231000 \(2026-10-11, \+5000\)/);
  assert.match(text, /T10Y3M 10Y-3M Spread=1\.02/);
  assert.match(text, /IDEA_TRACK_RECORD[^\n]*\n4 directional ideas older than a day: 3 in profit, average \+1\.85%/);
  assert.match(text, /1\.1d ago SHORT SMH \(HIGH\) "Chips short": 551\.2 -> 539\.79, result \+2\.07%/);
  assert.match(text, /WATCH BNO \(LOW\) "Spread watch": no quote, not tracked/);
  assert.doesNotMatch(text, /PREVIOUS_IDEAS/, 'the track record already holds the last ideas');
});
