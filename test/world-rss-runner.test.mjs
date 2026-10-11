import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getWorldNews, getWorldNewsByCountry, getWorldRssStats, loadWorldRssCache, resolveCacheFile, runWorldRssSweep } from '../lib/world-rss-runner.mjs';

test('world-rss-runner exports query functions and default stats', () => {
  const stats = getWorldRssStats();
  assert.ok(Number.isInteger(stats.totalFeeds));
  assert.equal(typeof stats.isFetching, 'boolean');
  assert.ok(Array.isArray(getWorldNews()));
  assert.ok(Array.isArray(getWorldNewsByCountry('HU')));
  assert.deepEqual(getWorldNewsByCountry('NON_EXISTENT_COUNTRY_XYZ'), []);
});

test('a world sweep that gets no headlines keeps the last good cache', async () => {
  const file = resolveCacheFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    timestamp: '2026-10-11T12:00:00.000Z',
    stats: { ok: 1, failed: 0, totalItems: 1 },
    items: [{ title: 'Kept headline', source: 'Telex', country: 'HU', date: '2026-10-11T11:00:00.000Z' }],
  }));
  assert.equal(loadWorldRssCache(), true);
  assert.equal(getWorldNews()[0].title, 'Kept headline');
  const result = await runWorldRssSweep({ feeds: [{ source: 'Dead', url: 'http://127.0.0.1:1/', country: 'ZZ' }] });
  assert.equal(result.stats.keptCache, true);
  assert.equal(getWorldNews()[0].title, 'Kept headline');
});
