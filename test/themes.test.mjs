import test from 'node:test';
import assert from 'node:assert/strict';
import { themeAnalysis, titleWords } from '../lib/intelligence/themes.mjs';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const DAY = 86400000;
// A history stand-in: range() pages over the records by first sighting, as both stores do.
function history(records) {
  const sorted = records.map((r, n) => ({ id: `event-${String(n).padStart(32, '0')}`, ...r })).sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  return { range(from, to, { after = null, limit = 500 } = {}) {
    return sorted.filter(r => r.firstSeenAt >= from && r.firstSeenAt <= to && (!after || r.firstSeenAt > after.firstSeenAt || (r.firstSeenAt === after.firstSeenAt && r.id > after.id))).slice(0, limit);
  } };
}
const at = days => new Date(NOW - days * DAY).toISOString();

test('title words: folded, in order, without stop words of several languages, numbers and short words', () => {
  assert.deepEqual(titleWords('Árvíz a Strait of Hormuz térségében: 3 halott, que pasa'), ['arviz', 'strait', 'hormuz', 'tersegeben', 'halott', 'pasa']);
  assert.deepEqual(titleWords('Les prix du pétrole pour 2026 sur le marché'), ['prix', 'petrole', 'marche']);
});

test('themes: phrases per topic, "none" for records no topic word matches, the kind filter and the words rising today', async () => {
  const records = [
    ...Array.from({ length: 4 }, (_, n) => ({ kind: 'news', title: `Houthi missile attack on Saudi Arabia ${n}`, firstSeenAt: at(0.1 + n / 100) })),
    { kind: 'news', title: 'Pope Leo visits Lebanon', firstSeenAt: at(3) },
    { kind: 'news', title: 'Pope Leo calls for peace', firstSeenAt: at(0.2) },
    { kind: 'weather', title: 'SIGMET thunderstorm over Bangkok', firstSeenAt: at(0.3) },
    { kind: 'news', title: 'Saudi Arabia oil output', firstSeenAt: at(5) },
    { kind: 'news', title: 'Too old to count', firstSeenAt: at(9) },
  ];
  const all = await themeAnalysis(history(records), { days: 7, now: NOW });
  assert.equal(all.records, 8, 'the record nine days old is outside the 7-day window');
  assert.equal(all.kinds.weather, 1);
  assert.deepEqual(all.phrases[0], ['saudi arabia', 5]);
  assert.ok(all.byTopic.conflict.phrases.some(([phrase]) => phrase === 'missile attack'));
  assert.deepEqual(all.byTopic.none.phrases.find(([phrase]) => phrase === 'pope leo'), ['pope leo', 2]);
  const news = await themeAnalysis(history(records), { days: 7, now: NOW, kinds: ['news'] });
  assert.equal(news.records, 7); assert.equal(news.kinds.weather, undefined);
  // houthi: 4 today, 0 on the earlier days -> rising; saudi: 4 today vs 1 earlier day out of 2 -> rising too.
  assert.ok(all.rising.some(row => row.word === 'houthi' && row.today === 4 && row.usual === 0));
});
