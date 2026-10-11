import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { buildOpml, parseOpml } from '../lib/news/opml.mjs';
import { FeedStore, FeedError, normalizeFeedUrl, MAX_CUSTOM_FEEDS } from '../lib/news/feed-store.mjs';
import { installFeedRoutes } from '../lib/news/routes.mjs';

const feed = (source, url, extra = {}) => Object.freeze({ source, url, tier: 2, lang: 'en', state: false, ...extra });
const CORE = [feed('Alpha', 'https://alpha.example/rss'), feed('Beta', 'https://beta.example/rss', { lang: 'hu', country: 'HU' })];
const WORLD = [feed('Gamma', 'https://gamma.example/feed', { country: 'FR', lang: 'fr' }), feed('Delta', 'https://delta.example/feed', { country: 'JP' })];

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-feeds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new FeedStore(join(dir, 'feeds.json'), { core: CORE, world: WORLD }).load() };
}

test('OPML round trip keeps every feed, its group, language and country, and escapes markup', () => {
  const xml = buildOpml([
    { title: 'News & more', feeds: [{ source: 'A "quoted" <feed>', url: 'https://a.example/rss?x=1&y=2', lang: 'hu', country: 'HU' }] },
    { title: 'Empty', feeds: [] },
  ], { now: new Date('2026-10-11T00:00:00Z') });
  assert.match(xml, /&amp;y=2/);
  assert.doesNotMatch(xml, /Empty/);
  assert.deepEqual(parseOpml(xml), [{ source: 'A "quoted" <feed>', url: 'https://a.example/rss?x=1&y=2', lang: 'hu', country: 'HU', category: 'News & more' }]);
});

test('parseOpml reads nested outlines, drops repeats and refuses unsafe or foreign documents', () => {
  const xml = `<?xml version="1.0"?><opml version="1.0"><head/><body>
    <outline text="Tech"><outline text="Inner"><outline type="rss" text="One" xmlUrl="https://one.example/rss"/></outline></outline>
    <outline type="rss" title="Two" xmlUrl="https://two.example/rss"/>
    <outline type="rss" text="Again" xmlUrl="https://one.example/rss"/>
  </body></opml>`;
  const feeds = parseOpml(xml);
  assert.deepEqual(feeds.map(item => [item.source, item.category]), [['One', 'Inner'], ['Two', undefined]]);
  assert.throws(() => parseOpml('<!DOCTYPE x [<!ENTITY a "b">]><opml><body/></opml>'), /Unsafe/);
  assert.throws(() => parseOpml('<rss><channel/></rss>'), /Not an OPML document/);
});

test('normalizeFeedUrl accepts public http(s) feeds only', () => {
  assert.equal(normalizeFeedUrl(' https://example.com/feed#top '), 'https://example.com/feed');
  for (const bad of ['ftp://example.com/x', 'https://user:pw@example.com/', 'http://localhost:8080/rss', 'http://127.0.0.1/rss', 'http://192.168.1.1/rss',
    'http://10.0.0.5/rss', 'http://[::1]/rss', 'http://169.254.169.254/latest', 'not a url', '']) {
    assert.throws(() => normalizeFeedUrl(bad), FeedError, bad);
  }
});

test('the store switches registry feeds off and on, persists them and ignores unknown URLs in the file', t => {
  const { dir, store } = tempStore(t);
  assert.equal(store.activeNewsFeeds().length, 2);
  store.setEnabled('https://alpha.example/rss', false);
  store.setEnabled('https://gamma.example/feed', false);
  assert.deepEqual(store.activeNewsFeeds().map(item => item.source), ['Beta']);
  assert.deepEqual(store.activeWorldFeeds().map(item => item.source), ['Delta']);
  assert.throws(() => store.setEnabled('https://nope.example/rss', false), error => error.code === 'UNKNOWN_FEED');
  assert.throws(() => store.setEnabled('https://alpha.example/rss', 'no'), error => error.code === 'INVALID_ENABLED');

  const saved = JSON.parse(readFileSync(join(dir, 'feeds.json'), 'utf8'));
  saved.disabled.push('https://stale.example/removed-from-registry');
  writeFileSync(join(dir, 'feeds.json'), JSON.stringify(saved));
  const reloaded = new FeedStore(join(dir, 'feeds.json'), { core: CORE, world: WORLD }).load();
  assert.deepEqual([...reloaded.disabled].sort(), ['https://alpha.example/rss', 'https://gamma.example/feed']);
  const listed = reloaded.list();
  assert.equal(listed.counts.coreEnabled, 1);
  assert.equal(listed.counts.worldEnabled, 1);

  reloaded.setAllEnabled('world', false);
  assert.equal(reloaded.activeWorldFeeds().length, 0);
  reloaded.setAllEnabled('world', true);
  assert.equal(reloaded.activeWorldFeeds().length, 2);
});

test('custom feeds are validated, de-duplicated against the registry, capped and removable', t => {
  const { store } = tempStore(t);
  const added = store.addCustom({ source: '  My blog  ', url: 'https://blog.example/feed.xml', lang: 'DE', country: 'de', tier: '4' });
  assert.deepEqual({ source: added.source, lang: added.lang, country: added.country, tier: added.tier }, { source: 'My blog', lang: 'de', country: 'DE', tier: 4 });
  assert.equal(store.activeNewsFeeds().at(-1).url, 'https://blog.example/feed.xml');
  assert.throws(() => store.addCustom({ source: 'Dup', url: 'https://blog.example/feed.xml' }), error => error.code === 'DUPLICATE_FEED');
  assert.throws(() => store.addCustom({ source: 'Reg', url: 'https://alpha.example/rss' }), error => error.code === 'DUPLICATE_FEED');
  assert.throws(() => store.addCustom({ source: '', url: 'https://x.example/rss' }), error => error.code === 'INVALID_SOURCE');
  assert.throws(() => store.addCustom({ source: 'X', url: 'https://x.example/rss', tier: 9 }), error => error.code === 'INVALID_TIER');
  assert.throws(() => store.addCustom({ source: 'X', url: 'https://x.example/rss', country: 'Hungary' }), error => error.code === 'INVALID_COUNTRY');
  store.removeCustom('https://blog.example/feed.xml');
  assert.equal(store.custom.length, 0);
  assert.throws(() => store.removeCustom('https://blog.example/feed.xml'), error => error.code === 'UNKNOWN_FEED');
  for (let index = 0; index < MAX_CUSTOM_FEEDS; index++) store.custom.push({ url: `https://f${index}.example/rss` });
  assert.throws(() => store.addCustom({ source: 'One too many', url: 'https://last.example/rss' }), error => error.code === 'TOO_MANY_FEEDS');
});

test('OPML import re-enables registry feeds, adds new ones and reports what it skipped; export lists the active set', t => {
  const { store } = tempStore(t);
  store.setEnabled('https://beta.example/rss', false);
  const xml = buildOpml([{ title: 'Mine', feeds: [
    { source: 'Beta again', url: 'https://beta.example/rss' },
    { source: 'Fresh', url: 'https://fresh.example/rss', lang: 'es', country: 'ES' },
    { source: 'Private', url: 'http://192.168.0.10/rss' },
  ] }]);
  const result = store.importOpml(xml);
  assert.deepEqual({ added: result.added, enabled: result.enabled, skipped: result.skipped, total: result.total }, { added: 1, enabled: 1, skipped: 1, total: 3 });
  assert.equal(result.errors[0].url, 'http://192.168.0.10/rss');
  assert.ok(store.activeNewsFeeds().some(item => item.source === 'Fresh' && item.lang === 'es' && item.country === 'ES'));
  assert.throws(() => store.importOpml('<opml><body></body></opml>'), error => error.code === 'EMPTY_OPML');
  assert.throws(() => store.importOpml('garbage'), error => error.code === 'INVALID_OPML');

  store.setEnabled('https://delta.example/feed', false);
  const active = parseOpml(store.exportOpml()).map(item => item.url);
  assert.ok(active.includes('https://fresh.example/rss'));
  assert.ok(!active.includes('https://delta.example/feed'));
  assert.ok(parseOpml(store.exportOpml({ scope: 'all' })).some(item => item.url === 'https://delta.example/feed'));
  store.reset();
  assert.equal(store.activeNewsFeeds().length, 2);
  assert.equal(store.custom.length, 0);
});

test('groups switch together, feeds move between countries and custom feeds can be edited or paused', t => {
  const { dir, store } = tempStore(t);
  assert.deepEqual(store.setManyEnabled(['https://alpha.example/rss', 'https://gamma.example/feed', 'https://nope.example/rss'], false), { enabled: false, changed: 2, skipped: 1 });
  assert.deepEqual(store.setManyEnabled(['https://alpha.example/rss'], false).changed, 0, 'already off: nothing changed, no error');
  assert.throws(() => store.setManyEnabled(['https://nope.example/rss'], true), error => error.code === 'UNKNOWN_FEED');
  assert.throws(() => store.setManyEnabled([], true), error => error.code === 'INVALID_URLS');

  store.setCountry('https://gamma.example/feed', 'be');
  store.setCountry('https://alpha.example/rss', 'GLOBAL');
  store.setEnabled('https://gamma.example/feed', true);
  assert.equal(store.activeWorldFeeds().find(item => item.source === 'Gamma').country, 'BE');
  const gamma = store.list().world.find(row => row.source === 'Gamma');
  assert.deepEqual([gamma.country, gamma.defaultCountry, gamma.moved], ['BE', 'FR', true]);
  assert.throws(() => store.setCountry('https://gamma.example/feed', 'Belgium'), error => error.code === 'INVALID_COUNTRY');
  store.setCountry('https://gamma.example/feed', 'FR');
  assert.equal(store.list().world.find(row => row.source === 'Gamma').moved, false, 'moving it home drops the override');

  store.addCustom({ source: 'Mine', url: 'https://mine.example/rss', country: 'HU' });
  const edited = store.updateCustom('https://mine.example/rss', { source: 'Mine, renamed', tier: 2, country: '', url: 'https://other.example/rss' });
  assert.deepEqual([edited.source, edited.tier, edited.country, edited.url], ['Mine, renamed', 2, undefined, 'https://mine.example/rss']);
  assert.throws(() => store.updateCustom('https://mine.example/rss', { lang: 'english' }), error => error.code === 'INVALID_LANG');
  store.setEnabled('https://mine.example/rss', false);
  assert.ok(!store.activeNewsFeeds().some(item => item.url === 'https://mine.example/rss'), 'a paused custom feed is not read');

  const reloaded = new FeedStore(join(dir, 'feeds.json'), { core: CORE, world: WORLD }).load();
  const list = reloaded.list();
  assert.equal(list.core.find(row => row.source === 'Alpha').country, null);
  assert.equal(list.custom[0].enabled, false);
  assert.equal(list.counts.customEnabled, 0);
  reloaded.removeCustom('https://mine.example/rss');
  assert.ok(!reloaded.disabled.has('https://mine.example/rss'));
  reloaded.reset();
  assert.equal(reloaded.countries.size, 0);
});

test('the store reads an older runs/feeds.json until its own file exists, then writes only its own', t => {
  const { dir } = tempStore(t);
  const legacy = join(dir, 'runs-feeds.json');
  writeFileSync(legacy, JSON.stringify({ version: 1, disabled: ['https://alpha.example/rss'], custom: [] }));
  const file = join(dir, 'profile', 'feeds.json');
  const store = new FeedStore(file, { core: CORE, world: WORLD, legacyFile: legacy }).load();
  assert.deepEqual([...store.disabled], ['https://alpha.example/rss']);
  store.setEnabled('https://beta.example/rss', false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).disabled.sort(), ['https://alpha.example/rss', 'https://beta.example/rss']);
  assert.equal(JSON.parse(readFileSync(legacy, 'utf8')).disabled.length, 1, 'the old file is left alone');
});

test('a corrupt feeds.json falls back to the defaults and says so', t => {
  const { dir } = tempStore(t);
  writeFileSync(join(dir, 'feeds.json'), '{ not json');
  const store = new FeedStore(join(dir, 'feeds.json'), { core: CORE, world: WORLD }).load();
  assert.ok(store.loadError);
  assert.equal(store.activeNewsFeeds().length, 2);
  assert.ok(store.list().loadError);
});

test('the feed routes read, change, import and export through the same-origin JSON guard', async t => {
  const { store } = tempStore(t);
  let changes = 0;
  const app = express();
  installFeedRoutes(app, { store, onChange: () => { changes++; } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const listed = await (await fetch(`${base}/api/feeds`)).json();
  assert.equal(listed.counts.core, 2);
  assert.equal(listed.profile, process.env.CRUCIX_HOME);
  assert.equal(listed.envFile, join(process.env.CRUCIX_HOME, '.env'));
  assert.ok(listed.file, 'the store still names the feeds.json it writes');

  assert.equal((await post('/api/feeds/toggle', { url: 'https://alpha.example/rss', enabled: false })).status, 200);
  assert.equal((await post('/api/feeds/toggle', { url: 'https://nope.example/rss', enabled: false })).status, 404);
  assert.equal((await post('/api/feeds/toggle', { url: 'https://alpha.example/rss', enabled: true }, { Origin: 'https://evil.example' })).status, 403);
  const plain = await fetch(`${base}/api/feeds/toggle`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(plain.status, 415);

  const created = await post('/api/feeds/custom', { source: 'Route feed', url: 'https://route.example/rss' });
  assert.equal(created.status, 200);
  assert.equal((await post('/api/feeds/custom', { source: 'Route feed', url: 'https://route.example/rss' })).status, 409);
  assert.equal((await post('/api/feeds/custom/remove', { url: 'https://route.example/rss' })).status, 200);

  const opml = buildOpml([{ title: 'Big', feeds: Array.from({ length: 150 }, (_, index) => ({ source: `Feed number ${index}`, url: `https://big${index}.example/rss` })) }]);
  assert.ok(opml.length > 8 * 1024, 'the import body is larger than the default 8 KB cap');
  const imported = await (await post('/api/feeds/opml', { opml })).json();
  assert.equal(imported.added, 150);
  assert.equal((await post('/api/feeds/opml', { opml: 42 })).status, 400);

  const exported = await fetch(`${base}/api/feeds/opml`);
  assert.match(exported.headers.get('content-type'), /opml/);
  assert.match(exported.headers.get('content-disposition'), /attachment; filename="crucix-feeds-/);
  assert.equal(parseOpml(await exported.text()).filter(item => item.url.startsWith('https://big')).length, 150);
  assert.equal(changes, 4);

  const region = [...Array.from({ length: 150 }, (_, index) => `https://big${index}.example/rss`),
    ...Array.from({ length: 200 }, (_, index) => `https://removed-${index}.example/a/longer/path/to/the/feed.xml`)];
  assert.ok(JSON.stringify({ urls: region }).length > 8 * 1024, 'a region switch is larger than the default 8 KB cap');
  assert.deepEqual(await (await post('/api/feeds/toggle', { urls: region, enabled: false })).json(), { ok: true, enabled: false, changed: 150, skipped: 200 });
  assert.equal((await post('/api/feeds/country', { url: 'https://gamma.example/feed', country: 'BE' })).status, 200);
  assert.equal((await post('/api/feeds/country', { url: 'https://gamma.example/feed', country: 'Belgium' })).status, 400);
  const updated = await (await post('/api/feeds/custom/update', { url: 'https://big0.example/rss', source: 'Renamed' })).json();
  assert.equal(updated.feed.source, 'Renamed');
  assert.equal((await post('/api/feeds/custom/update', { url: 'https://unknown.example/rss', source: 'X' })).status, 404);
  assert.equal(changes, 7);
});
