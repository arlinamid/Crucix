import test from 'node:test';
import assert from 'node:assert/strict';
import { NEWS_FEEDS, WORLD_FEEDS, feedBySource, unmatchedWorldReview } from '../apis/utils/news-feeds.mjs';
import { enrichNewsFeed } from '../lib/news/world-enrich.mjs';

const world = name => WORLD_FEEDS.filter(item => item.source === name);

test('every entry of the world tier review names a catalog feed', () => {
  assert.deepEqual(unmatchedWorldReview(), []);
});

test('of the Hungarian outlets only Telex, HVG and Portfolio stay tier 2', () => {
  const hungarian = NEWS_FEEDS.filter(item => item.lang === 'hu');
  assert.deepEqual(hungarian.filter(item => item.tier === 2).map(item => item.source).sort(), ['HVG', 'Portfolio.hu', 'Telex']);
  for (const name of ['Index.hu', '444.hu', '24.hu', 'ATV', 'Világgazdaság']) assert.equal(feedBySource(name).tier, 3, name);
});

test('the world catalog takes the core entry of a shared name and the review for the rest', () => {
  for (const item of WORLD_FEEDS) {
    const core = feedBySource(item.source);
    if (core) assert.deepEqual([item.tier, item.state], [core.tier, core.state], item.source);
  }
  assert.equal(world('24.hu')[0].tier, 3);
  assert.equal(world('DW')[0].state, true);
  assert.deepEqual(world('Japan Wire by Kyodo News').map(item => [item.tier, item.state]), [[1, false]]);
  assert.deepEqual(world('Yonhap News').map(item => [item.tier, item.state]), [[1, true]]);
  assert.deepEqual(world('Washington Post World').map(item => item.tier), [2]);
  assert.deepEqual(world('BBC Africa').map(item => [item.tier, item.state]), [[2, true]]);
  for (const name of ['TASS', 'CGTN', 'RT International', 'Mehr News Agency', 'Juventud Rebelde', 'Vatican News']) {
    assert.deepEqual(world(name).map(item => [item.tier, item.state]), [[3, true]], name);
  }
  // Two catalog feeds share the name: the review targets the Tanzanian state daily only.
  assert.equal(WORLD_FEEDS.find(item => item.source === 'Daily News' && item.country === 'TZ').state, true);
  assert.equal(WORLD_FEEDS.find(item => item.source === 'DailyNews').state, false);
});

test('a world headline of a state outlet keeps its STATE mark in the news feed', () => {
  const snapshot = { newsFeed: [] };
  enrichNewsFeed(snapshot, [
    { title: 'Agency report', source: 'TASS', url: 'https://tass.com/a', date: '2026-10-18T07:00:00Z', country: 'RU', tier: 3, state: true },
    { title: 'Independent report', source: 'Meduza', url: 'https://meduza.io/b', date: '2026-10-18T07:00:00Z', country: 'LV', tier: 2 },
  ], { now: Date.parse('2026-10-18T08:00:00Z') });
  assert.deepEqual(snapshot.newsFeed.map(item => item.state), [true, undefined]);
});
