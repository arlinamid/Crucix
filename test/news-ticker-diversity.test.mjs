import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
// The news ranking block of the dashboard: NEWS_LIVE_HOURS, newsAgeBucket, rankNewsItem, diversifyByCountry, buildNewsTickerPanel.
const tickerSource = (() => {
  const start = html.indexOf('const NEWS_LIVE_HOURS');
  const panel = html.indexOf('function buildNewsTickerPanel(');
  assert.ok(start >= 0 && panel > start);
  return html.slice(start, html.indexOf('\nfunction ', panel + 1));
})();
const T0 = Date.parse('2026-10-18T10:00:00Z');
const at = minutes => new Date(T0 - minutes * 60000).toISOString();

function ticker(newsFeed, { region = 'world' } = {}) {
  return vm.runInNewContext(`${tickerSource}\nbuildNewsTickerPanel`, {
    D: { newsFeed }, currentRegion: region, currentCountry: null, lowPerfMode: true, reducedMotion: true, clockNow: () => T0,
    newsInScope: () => true, newsInLens: () => true, findEvent: () => null, getAge: () => '', cleanText: s => s, esc: s => String(s),
    tickerTags: () => '', t: (key, fallback) => fallback || key, REGION_DEFINITIONS: [{ id: 'europe', label: 'Europe' }],
  })();
}
const headlines = out => [...out.matchAll(/<div class="tk-head">([^<]*)<\/div>/g)].map(m => m[1]);

// The world ticker of 2026-10-18 10:40 had 20 Hungarian headlines in its first 50: seven tier-2 portals that publish every few minutes.
test('the world ticker lets one country hold at most four of the first places', () => {
  const feed = [];
  const hu = ['Telex', 'Index.hu', 'HVG', '444.hu', '24.hu', 'Portfolio.hu', 'ATV'];
  hu.forEach((source, i) => { for (let k = 0; k < 5; k++) feed.push({ headline: `HU ${source} ${k}`, source, tier: 2, lang: 'hu', country: 'HU', timestamp: at(i + k) }); });
  for (const [source, country] of [['BBC', 'GB'], ['NYT', 'US'], ['DW', 'DE'], ['France 24', 'FR'], ['CNA', 'SG'], ['Dawn', 'PK'], ['The Hindu', 'IN'], ['ABC Australia', 'AU'], ['Al Jazeera', 'QA'], ['ERR News', 'EE'], ['Meduza', 'LV'], ['The National', 'AE']]) {
    for (let k = 0; k < 5; k++) feed.push({ headline: `${source} ${k}`, source, tier: 2, country, timestamp: at(60 + k) });
  }
  feed.push({ headline: 'IAEA statement', source: 'IAEA', tier: 1, country: 'AT', timestamp: at(300) });
  const first = headlines(ticker(feed)).slice(0, 50);
  assert.equal(first.length, 50);
  assert.equal(first[0], 'IAEA statement', 'tier 1 still leads');
  assert.equal(first.filter(h => h.startsWith('HU ')).length, 4, 'Hungary keeps four places, not twenty');
  assert.equal(first.filter(h => h.startsWith('BBC ')).length, 4);
});

test('items without a country are capped per source, so urgent Telegram posts are not pooled', () => {
  const feed = [];
  for (const channel of ['A', 'B', 'C']) for (let k = 0; k < 3; k++) feed.push({ headline: `${channel}${k}`, source: channel, urgent: true, type: 'telegram', timestamp: at(k) });
  assert.deepEqual(headlines(ticker(feed)).slice(0, 9).sort(), ['A0', 'A1', 'A2', 'B0', 'B1', 'B2', 'C0', 'C1', 'C2']);
});

// Live on 2026-10-18: an undated IAEA item stamped with the fetch time led the ticker, and an 18-hour-old tier-2 item sat above fresh tier-3 news.
test('a tier ranks only live headlines: day-old and undated tier-1/2 items follow the latest tier-3 news', () => {
  const feed = [
    { headline: 'undated IAEA', source: 'IAEA', tier: 1, country: 'AT', timestamp: null },
    { headline: 'day-old ERR', source: 'ERR News', tier: 2, country: 'EE', timestamp: at(18 * 60) },
    { headline: 'fresh regional', source: 'Leral.net', tier: 3, country: 'SN', timestamp: at(5) },
    { headline: 'hour-old BBC', source: 'BBC', tier: 2, country: 'GB', timestamp: at(60) },
    { headline: 'two-hour-old UN', source: 'UN News', tier: 1, country: 'US', timestamp: at(120) },
  ];
  assert.deepEqual(headlines(ticker(feed)), ['two-hour-old UN', 'hour-old BBC', 'fresh regional', 'day-old ERR', 'undated IAEA']);
  assert.deepEqual(headlines(ticker(feed, { region: 'europe' })), ['two-hour-old UN', 'fresh regional', 'hour-old BBC', 'day-old ERR', 'undated IAEA']);
});

// crucix --live ranks with lib/news/ticker-rank.mjs; it must give the dashboard's world order.
test('the terminal ticker order equals the dashboard world order', async () => {
  const { rankTicker } = await import('../lib/news/ticker-rank.mjs');
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const countries = ['HU', 'GB', 'US', 'DE', 'JP', 'IN', undefined];
  const feed = Array.from({ length: 300 }, (_, i) => {
    const roll = random();
    return {
      headline: `item ${i}`, source: `src${Math.floor(random() * 25)}`, country: countries[Math.floor(random() * countries.length)],
      tier: roll < 0.1 ? undefined : 1 + Math.floor(random() * 4), urgent: roll < 0.05,
      timestamp: random() < 0.08 ? null : at(Math.floor(random() * 30 * 60)),
    };
  });
  const dashboard = headlines(ticker(feed));
  assert.equal(dashboard.length, 50);
  assert.deepEqual(rankTicker(feed, { now: T0 }).slice(0, 50).map(item => item.headline), dashboard);
});
