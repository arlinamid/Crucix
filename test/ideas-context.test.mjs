import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compactSweepForLLM } from '../lib/llm/ideas.mjs';
import { parseIdeasResult } from '../lib/llm/idea-schema.mjs';
import { resolveIdeas } from '../lib/llm/rule-ideas.mjs';
import { IdeaCadence } from '../lib/llm/cadence.mjs';

// The live sweep of 2026-10-19: ideas built on "216 records, 89 sources", heat detections, a CPI index level and crude stocks read as
// barrels, while a 2 % Nasdaq fall never reached the model.
const sweep = () => ({
  markets: {
    indexes: [{ symbol: '^IXIC', name: 'Nasdaq Composite', price: 26140.03, changePct: -2.15, history: [{ close: 27245.9 }, { close: 27204.38 }, { close: 26692.87 }, { close: 26713.03 }, { close: 26140.03 }] }],
    commodities: [{ symbol: 'BZ=F', name: 'Brent Crude', price: 107.71, changePct: -1.96 }],
    equities: [{ symbol: 'RHM.DE', name: 'Rheinmetall', price: 1090.2, changePct: 6.26 }],
    vix: { value: 19.99, changePct: 21.45 },
    fx: { benchmarks: [{ pair: 'USD/JPY', price: 158.08, changePct: -0.04 }] },
  },
  threads: { topicCounts: { politics: 161 }, top: [
    { status: 'active', topic: 'economy', title: 'Iran Says Supertanker Hit Mine In Strait of Hormuz', memberCount: 216, reports: 142, observations: 74, sources: 89, countries: [{ iso3: 'IRN' }] },
    { status: 'active', topic: 'disaster', title: 'Brazíliától Csehországig világszerte megemlékeznek az 1956-os forradalomról', memberCount: 79, reports: 1, observations: 78, sources: 8 },
  ] },
  fred: [{ id: 'DGS10', value: 5.1, date: '2026-10-15', recent: [5.1, 5.19, 5.21, 5.24] }, { id: 'VIXCLS', value: 16.46, date: '2026-10-15', recent: [16.46, 15] }],
  energy: { wti: 97.28, brent: 107.71, natgas: 3.09, crudeStocks: 415577, signals: ['Large crude inventory draw: -8.6M barrels'] },
  bls: [{ id: 'CUUR0000SA0', label: 'CPI-U All Items', value: 336.94, date: '2026-09', momChange: 1.96, momChangePct: 0.5851 },
    { id: 'LNS14000000', label: 'Unemployment Rate', value: 4.2, date: '2026-09', momChange: 0.1, momChangePct: 2.439 }],
  thermal: [{ region: 'Middle East', det: 1795, hc: 24 }], air: [{ region: 'Middle East', total: 295 }],
  treasury: { totalDebt: 40388317675071.91 }, defense: [{ amount: 2754e6, recipient: 'THE BOEING COMPANY' }],
});

test('the ideas context leads with the market moves and carries the energy signals in million barrels', () => {
  const text = compactSweepForLLM(sweep());
  assert.ok(text.indexOf('MARKETS') < text.indexOf('STORY_THREADS'), 'price action before the stories');
  assert.match(text, /Nasdaq Composite \[\^IXIC\] 26140\.03 \(d -2\.15%, 5d -4\.1\)/, 'without stored trend figures: the move over the shown history');
  assert.match(text, /VOLATILITY: VIX 19\.99 \(\+21\.45%\)/);
  assert.match(text, /Rheinmetall \[RHM\.DE\] 1090\.2 \(d \+6\.26%\)/);
  assert.match(text, /USD\/JPY 158\.08 \(-0\.04%\)/);
  assert.match(text, /US crude stocks 415\.6M bbl/);
  assert.doesNotMatch(text, /415577/);
  assert.match(text, /Large crude inventory draw: -8\.6M barrels/);
});

test('threads are told by their reports, a one-report thread is left out, and counts without a baseline are gone', () => {
  const text = compactSweepForLLM(sweep());
  assert.match(text, /Strait of Hormuz \(142 reports, 89 sources, IRN\)/);
  assert.doesNotMatch(text, /216 records/);
  assert.doesNotMatch(text, /1956/, 'a single report with routine observations is no corroborated story');
  for (const gone of [/THERMAL/, /AIR_ACTIVITY/, /totalDebt/, /DEFENSE_CONTRACTS/, /THREAD_TOPICS/, /336\.94/]) assert.doesNotMatch(text, gone);
});

test('FRED rows carry their date and recent move; the stale FRED VIX gives way to the live quote', () => {
  const text = compactSweepForLLM(sweep());
  assert.match(text, /DGS10=5\.1 \(2026-10-15, -0\.14\)/);
  assert.doesNotMatch(text, /VIXCLS/);
  assert.match(text, /CPI-U All Items \+0\.59% m\/m 2026-09/);
  assert.match(text, /Unemployment Rate 4\.2% \(\+0\.1 pp m\/m\) 2026-09/);
  const { markets, ...withoutMarkets } = sweep();
  assert.match(compactSweepForLLM(withoutMarkets), /VIXCLS=16\.46/, 'without live quotes FRED keeps the VIX');
});

test('the system prompt allows 0-8 ideas and asks for a market data point in every language', () => {
  for (const code of ['en', 'hu', 'fr']) {
    const prompt = JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8')).llm.systemPrompt;
    assert.match(prompt, /0-8/, code);
    assert.doesNotMatch(prompt, /5-8/, code);
    assert.match(prompt, /MARKETS/, code);
    assert.match(prompt, /\[\]/, code);
  }
});

test('an empty answer is a valid "no idea" result: not the rule ideas, cached with its time', async () => {
  assert.deepEqual(parseIdeasResult('[]'), { ideas: [], empty: true, reason: null, accepted: 0, dropped: 0 });
  assert.equal(parseIdeasResult('nothing here').empty, undefined);
  const provider = { isConfigured: true, name: 'test', config: {}, complete: async () => ({ text: '```json\n[]\n```' }) };
  const resolved = await resolveIdeas(provider, sweep(), null, [], 'en');
  assert.deepEqual(resolved, { ideas: [], ideasSource: 'llm' });
  const cadence = new IdeaCadence({ now: () => Date.parse('2026-10-19T08:00:00Z') });
  const fresh = await cadence.generate(provider, sweep(), null, [], 'en');
  assert.deepEqual([fresh.ideas, fresh.ideasSource, fresh.ideasGeneratedAt], [[], 'llm', '2026-10-19T08:00:00.000Z']);
  assert.deepEqual((await cadence.current(sweep())).ideas, [], 'the next sweep keeps the empty model answer, not the rules');
});

test('the ideas panel says the model found nothing, not that it is not configured', async () => {
  const vm = await import('node:vm');
  const html = readFileSync(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
  const start = html.indexOf('function buildTradeIdeasPanel(');
  const source = html.slice(start, html.indexOf('\nfunction ', start + 1));
  const hu = JSON.parse(readFileSync(new URL('../locales/hu.json', import.meta.url), 'utf8'));
  const t = (path, fallback) => { let value = hu; for (const key of path.split('.')) value = value?.[key]; return typeof value === 'string' ? value : fallback; };
  const out = vm.runInNewContext(`${source}\nbuildTradeIdeasPanel`, { D: { ideas: [], ideasSource: 'llm', ideasGeneratedAt: '2026-10-19T08:00:00Z' }, t, esc: String, getAge: () => '1 perce', ideaTypeClass: String })();
  assert.match(out, /A modell nem talált a jelenlegi adatokkal alátámasztott ötletet/);
  assert.doesNotMatch(out, /NINCS BEÁLLÍTVA/);
});
