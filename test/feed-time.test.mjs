import test from 'node:test';
import assert from 'node:assert/strict';
import { feedTimestamp, FUTURE_SLACK_MS } from '../lib/news/feed-time.mjs';
import { enrichNewsFeed } from '../lib/news/world-enrich.mjs';
import { buildNewsFeed } from '../dashboard/inject.mjs';

const NOW = Date.parse('2026-10-18T08:45:00Z');

test('feedTimestamp keeps readable past times and drops unreadable and future ones', () => {
  assert.equal(feedTimestamp('Sun, 18 Oct 2026 08:30:00 GMT', NOW), '2026-10-18T08:30:00.000Z');
  assert.equal(feedTimestamp(new Date(NOW + FUTURE_SLACK_MS).toISOString(), NOW), new Date(NOW + FUTURE_SLACK_MS).toISOString(), 'small clock skew is kept');
  // Banglanews24 labels local time (UTC+6) as UTC; the IAEA feed writes "YY-MM-DD HH:MM".
  assert.equal(feedTimestamp('2026-10-18T12:08:44Z', NOW), null);
  assert.equal(feedTimestamp('26-10-16  14:35', NOW), null);
  assert.equal(feedTimestamp('', NOW), null);
});

test('a world headline without a readable date is added without a time, never with the fetch time', () => {
  const snapshot = { newsFeed: [] };
  const added = enrichNewsFeed(snapshot, [
    { title: 'From Farm to Fork', source: 'IAEA', url: 'https://www.iaea.org/a', date: '26-10-16  14:35', country: 'AT', tier: 1 },
    { title: 'Future-dated report', source: 'Banglanews24.com', url: 'https://example.bd/b', date: '2026-10-18T12:08:44Z', country: 'BD', tier: 3 },
    { title: 'Dated report', source: 'ERR News', url: 'https://news.err.ee/c', date: '2026-10-18T07:00:00Z', country: 'EE', tier: 2 },
  ], { now: NOW });
  assert.equal(added, 3);
  assert.deepEqual(snapshot.newsFeed.map(n => n.timestamp), [null, null, '2026-10-18T07:00:00.000Z']);
  assert.deepEqual(snapshot.newsFeed.map(n => n.publishedAt), [null, null, '2026-10-18T07:00:00.000Z']);
});

test('the core news feed drops a future provider time', () => {
  const future = new Date(Date.now() + 6 * 3600000).toISOString();
  const past = new Date(Date.now() - 3600000).toISOString();
  const feed = buildNewsFeed([
    { title: 'Ahead', source: 'Jerusalem Post', date: future, country: 'IL', tier: 2 },
    { title: 'Behind', source: 'BBC', date: past, country: 'GB', tier: 2 },
  ], { allArticles: [] }, [], []);
  assert.equal(feed.find(n => n.headline === 'Ahead').timestamp, null);
  assert.equal(feed.find(n => n.headline === 'Behind').timestamp, past);
});
