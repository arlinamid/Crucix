import test from 'node:test';
import assert from 'node:assert/strict';

const modelUrl = new URL('../lib/intelligence/events.mjs', import.meta.url);
let model;
try { model = await import(modelUrl); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

test('event provenance model exposes its pure public functions', () => {
  assert.equal(typeof model?.buildEvents, 'function', 'buildEvents must exist');
  assert.equal(typeof model?.clusterEvents, 'function', 'clusterEvents must exist');
});

const behavior = (name, fn) => test(name, { skip: !model }, fn);
const collectedAt = '2026-10-01T12:00:00.000Z';
const snapshot = extra => ({ meta: { timestamp: collectedAt }, ...extra });
const report = (extra = {}) => ({
  title: 'Odessa port explosion closes shipping routes', source: 'First News',
  url: 'https://first.example/story', date: '2026-10-01T09:00:00Z',
  lat: 46.5, lon: 30.7, region: 'Odessa', locationMethod: 'headline-keyword', ...extra,
});

behavior('news separates provider publication from sweep collection and keeps unknown observation null', () => {
  const [event] = model.buildEvents(snapshot({ news: [report()] }));
  assert.equal(event.publishedAt, '2026-10-01T09:00:00.000Z');
  assert.equal(event.observedAt, null);
  assert.equal(event.collectedAt, collectedAt);
  assert.equal(event.location.method, 'headline-keyword');
  assert.equal(event.location.precision, 'approximate');
  assert.ok(event.quality.explanationCodes.includes('inferred-location'));
});

behavior('missing and invalid provider dates stay unknown instead of borrowing sweep or source health times', () => {
  const events = model.buildEvents(snapshot({ health: [{ n: 'First News', timestamp: collectedAt }], news: [
    report({ url: 'https://first.example/unknown', date: undefined }),
    report({ url: 'https://first.example/impossible', date: '2026-02-30T12:00:00Z' }),
    report({ url: 'https://first.example/bad', date: 'not a date' }),
  ] }));
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.equal(event.publishedAt, null);
    assert.equal(event.observedAt, null);
    assert.equal(event.quality.checks.providerTime, false);
    assert.ok(event.quality.explanationCodes.includes('unknown-provider-time'));
  }
});

behavior('event URL identity survives changed sweep time, title and coordinates', () => {
  const [first] = model.buildEvents(snapshot({ news: [report()] }));
  const [second] = model.buildEvents({ meta: { timestamp: '2026-10-02T12:00:00Z' }, news: [report({ title: 'Updated title', lat: 46.6 })] });
  assert.match(first.id, /^event-[a-f0-9]{32}$/);
  assert.equal(first.id, second.id);
  assert.notEqual(first.collectedAt, second.collectedAt);
});

behavior('provider identifiers and fallback title/provider time/location remain stable across sweeps', () => {
  const build = timestamp => model.buildEvents({ meta: { timestamp }, earthquakes: [
    { id: 'us7000abcd', place: 'Offshore', mag: 5, time: '2026-10-01T08:00:00Z', lat: 0, lon: 0 },
  ], news: [report({ url: undefined })] });
  const first = build(collectedAt);
  const second = build('2026-10-02T12:00:00Z');
  assert.deepEqual(first.map(event => event.id), second.map(event => event.id));
  assert.notEqual(first[0].id, first[1].id);
});

behavior('duplicate map/feed and urgent/top post representations become one record each', () => {
  const events = model.buildEvents(snapshot({ news: [report()], newsFeed: [
    { headline: report().title, source: 'First News', url: report().url, timestamp: report().date, type: 'rss' },
  ], tg: { urgent: [{ channel: 'channel', text: 'Local report', date: '2026-10-01T09:00:00Z', url: 'https://t.me/channel/1' }],
    topPosts: [{ channel: 'channel', text: 'Local report', date: '2026-10-01T09:00:00Z', url: 'https://t.me/channel/1' }] } }));
  assert.equal(events.length, 2);
  assert.equal(events.find(event => event.kind === 'news').location.lat, 46.5);
  assert.equal(events.find(event => event.kind === 'osint').severity, 'high');
});

behavior('credential, executable, malformed and oversized source URLs are rejected', () => {
  const urls = ['javascript:alert(1)', 'data:text/html,payload', 'https://user:secret@example.com/story', '//example.com/story', 'broken', `https://example.com/${'a'.repeat(3000)}`];
  const events = model.buildEvents(snapshot({ news: urls.map((url, index) => report({ title: `Unsafe link ${index}`, url })) }));
  assert.equal(events.length, urls.length);
  for (const event of events) {
    assert.equal(event.source.url, null);
    assert.equal(event.source.hostname, null);
    assert.equal(event.quality.checks.sourceUrl, false);
  }
});

behavior('source hostname comes from the safe URL and fragment does not duplicate event identity', () => {
  const events = model.buildEvents(snapshot({ news: [
    report({ url: 'https://WWW.First.Example/story#one', hostname: 'spoof.example' }),
    report({ url: 'https://www.first.example/story#two' }),
  ] }));
  assert.equal(events.length, 1);
  assert.equal(events[0].source.hostname, 'first.example');
  assert.equal(events[0].source.url, 'https://www.first.example/story#one');
});

behavior('coordinates require a complete finite in-range numeric pair and zero is valid', () => {
  const invalid = [{ lat: Infinity }, { lon: NaN }, { lat: 91 }, { lon: -181 }, { lat: '46.5' }, { lat: null }, { lon: undefined }];
  const events = model.buildEvents(snapshot({ news: invalid.map((extra, index) => report({ ...extra, url: `https://first.example/${index}` }))
    .concat(report({ url: 'https://first.example/zero', lat: 0, lon: 0, locationMethod: 'provider' })) }));
  for (const event of events.slice(0, -1)) {
    assert.equal(event.location.lat, null);
    assert.equal(event.location.lon, null);
    assert.equal(event.location.method, 'unknown');
  }
  const zero = events.at(-1);
  assert.equal(zero.location.lat, 0);
  assert.equal(zero.location.lon, 0);
  assert.equal(zero.location.method, 'provider');
});

behavior('legacy coordinates without provenance retain unknown method and precision', () => {
  const [event] = model.buildEvents(snapshot({ news: [report({ locationMethod: undefined })] }));
  assert.equal(event.location.lat, 46.5);
  assert.equal(event.location.method, 'unknown');
  assert.equal(event.location.precision, 'unknown');
});

behavior('source health status and quality describe traceability without a confidence score', () => {
  const [event] = model.buildEvents(snapshot({ health: [{ n: 'First News', err: false, stale: true }], news: [report()] }));
  assert.equal(event.source.status, 'stale');
  assert.equal(event.quality.checks.sourceStatus, false);
  assert.ok(event.quality.explanationCodes.includes('source-stale'));
  assert.equal(event.confidence, undefined);
  assert.equal(event.quality.confidence, undefined);
  assert.deepEqual(Object.keys(event).sort(), ['id', 'kind', 'title', 'summary', 'source', 'observedAt', 'publishedAt', 'collectedAt', 'location', 'severity', 'quality', 'relatedSources'].sort());
});

behavior('distinct-origin similar reports relate only when provider time and geography agree', () => {
  const events = model.buildEvents(snapshot({ news: [
    report(),
    report({ title: 'Odessa port explosion shuts shipping routes', source: 'Second News', url: 'https://second.example/report', date: '2026-10-01T10:00:00Z', lat: 46.6 }),
    report({ source: 'Same host section', url: 'https://www.first.example/another' }),
    report({ title: 'Odessa port celebrates new museum exhibition', source: 'Culture', url: 'https://culture.example/story' }),
    report({ source: 'Old report', url: 'https://old.example/story', date: '2026-09-20T09:00:00Z' }),
    report({ source: 'Remote', url: 'https://remote.example/story', lat: -30, lon: 100 }),
    report({ source: 'Unknown time', url: 'https://unknown.example/story', date: undefined }),
  ] }));
  const first = events.find(event => event.source.name === 'First News');
  assert.equal(first.relatedSources.length, 1);
  assert.equal(first.relatedSources[0].hostname, 'second.example');
  assert.equal(first.relatedSources[0].relationship, 'related-report');
  assert.ok(first.quality.explanationCodes.includes('related-reports-not-corroboration'));
});

behavior('reports attributed to a shared syndication source are not independent related origins', () => {
  const events = model.buildEvents(snapshot({ news: [
    report({ syndicatedFrom: 'Wire Agency' }),
    report({ source: 'Second News', url: 'https://second.example/report', syndicatedFrom: 'Wire Agency' }),
  ] }));
  assert.deepEqual(events.map(event => event.relatedSources), [[], []]);
});

behavior('news relations discover near reports across cell and midnight boundaries', () => {
  const events = model.buildEvents(snapshot({ news: [
    report({ lat: 47.99, lon: 31.99, date: '2026-09-30T23:50:00Z' }),
    report({ lat: 48.01, lon: 32.01, date: '2026-10-01T00:10:00Z', source: 'Second News', url: 'https://second.example/report' }),
  ] }));
  assert.equal(events[0].relatedSources.length, 1);
  assert.equal(events[1].relatedSources.length, 1);
});

behavior('all requested provider arrays and delta categories normalize with meaningful provider times', () => {
  const events = model.buildEvents(snapshot({
    newsFeed: [{ headline: 'Indexed report', source: 'GDELT', type: 'gdelt', timestamp: '20261001T080000Z', url: 'https://indexed.example/story' }],
    who: [{ title: 'Outbreak report', date: '2026-09-30', url: 'https://who.int/item/1' }],
    supplementalHealth: [{ title: 'Health response', date: '2026-09-29', source: 'HDX', url: 'https://data.humdata.org/item/1' }],
    earthquakes: [{ id: 'quake1', place: 'Offshore', mag: 6, time: '2026-10-01T07:00:00Z', lat: 0, lon: 0, locationMethod: 'provider' }],
    noaa: { alerts: [{ id: 'weather1', event: 'Flood Warning', headline: 'Flood near river', onset: '2026-10-01T08:30:00Z', sent: '2026-10-01T08:00:00Z', lat: 40, lon: -80 }] },
    ioda: { recentEvents: [{ country: 'Hungary', start: '2026-10-01T06:00:00Z', active: true }], countries: [{ country: 'Kenya', lastStart: '2026-10-01T05:00:00Z', lat: -1, lon: 38, locationMethod: 'country-centroid' }] },
    acled: { recentEvents: [{ id: 'conflict1', type: 'Protest', country: 'Country', date: '2026-09-30', lat: 10, lon: 10 }], deadliestEvents: [{ id: 'conflict2', type: 'Battle', country: 'Country', date: '2026-09-29' }] },
    delta: { timestamp: collectedAt, signals: { new: [{ key: 'new', reason: 'New signal' }], escalated: [{ key: 'up', label: 'Rising', from: 1, to: 2 }], deescalated: [{ key: 'down', label: 'Falling', from: 2, to: 1 }], resolved: [{ key: 'gone', label: 'Resolved' }] } },
  }));
  assert.equal(events.length, 13);
  assert.equal(events.find(event => event.title === 'Indexed report').observedAt, '2026-10-01T08:00:00.000Z');
  assert.equal(events.find(event => event.kind === 'earthquake').observedAt, '2026-10-01T07:00:00.000Z');
  assert.equal(events.find(event => event.kind === 'weather').publishedAt, '2026-10-01T08:00:00.000Z');
  assert.equal(events.filter(event => event.kind === 'signal').length, 4);
  for (const signal of events.filter(event => event.kind === 'signal')) assert.equal(signal.observedAt, null);
});

behavior('normalization is bounded, pure and does not retain unknown fields or unbounded strings', () => {
  const input = snapshot({ news: Array.from({ length: 6000 }, (_, index) => report({ title: `Headline ${index} ${'x'.repeat(1000)}`, summary: 's'.repeat(10000), url: `https://first.example/${index}`, secret: 'not retained' })) });
  const original = structuredClone(input);
  const events = model.buildEvents(input);
  assert.equal(events.length, 2000);
  assert.deepEqual(input, original);
  assert.ok(events.every(event => event.title.length <= 300 && event.summary.length <= 2000 && event.secret === undefined && event.relatedSources.length <= 8));
  assert.deepEqual(model.buildEvents(null), []);
  assert.deepEqual(model.buildEvents({ news: 'not an array', tg: null }), []);
});

behavior('geographical clustering groups only news and osint in the same cell and provider-time bin', () => {
  const events = model.buildEvents(snapshot({ news: [
    report({ lat: 46.5, lon: 30.7 }),
    report({ lat: 46.6, lon: 30.8, source: 'Second News', url: 'https://second.example/report' }),
    report({ lat: 46.5, lon: 30.7, source: 'Yesterday', url: 'https://yesterday.example/report', date: '2026-09-30T09:00:00Z' }),
    report({ lat: null, lon: null, source: 'Unknown', url: 'https://unknown.example/report' }),
    report({ source: 'Undated', url: 'https://undated.example/report', date: undefined }),
  ], earthquakes: [{ id: 'q', place: 'Same place', time: '2026-10-01T09:00:00Z', lat: 46.5, lon: 30.7 }] }));
  const clusters = model.clusterEvents(events);
  assert.equal(clusters.length, 1);
  assert.deepEqual(Object.keys(clusters[0]).sort(), ['id', 'eventIds', 'lat', 'lon', 'count', 'sourceCount', 'label'].sort());
  assert.equal(clusters[0].count, 2);
  assert.equal(clusters[0].sourceCount, 2);
  assert.ok(Math.abs(clusters[0].lat - 46.55) < 0.000001);
  assert.ok(Math.abs(clusters[0].lon - 30.75) < 0.000001);
  assert.match(clusters[0].label, /related reports/i);
});

behavior('clusters are stable across input order and count a hostname only once', () => {
  const events = model.buildEvents(snapshot({ news: [report(), report({ url: 'https://www.first.example/another' })] }));
  const first = model.clusterEvents(events);
  const second = model.clusterEvents(events.slice().reverse());
  assert.deepEqual(first, second);
  assert.equal(first[0].sourceCount, 1);
});

behavior('clustering option validation prevents zero, infinite and oversized bins from collapsing reports', () => {
  const events = model.buildEvents(snapshot({ news: [report(), report({ source: 'Second News', url: 'https://second.example/report' })] }));
  const expected = model.clusterEvents(events);
  for (const options of [{ cellDegrees: 0 }, { cellDegrees: Infinity }, { cellDegrees: 999 }, { windowHours: -1 }, { windowHours: Infinity }]) {
    assert.deepEqual(model.clusterEvents(events, options), expected);
  }
  assert.deepEqual(model.clusterEvents(null), []);
});

behavior('normalization does not enumerate irrelevant provider fields or coerce object identifiers', () => {
  const item = report({ id: { nested: 'not a provider identifier' }, url: undefined });
  Object.defineProperty(item, 'unusedPrivateField', { enumerable: true, get() { throw new Error('irrelevant field was read'); } });
  const [event] = model.buildEvents(snapshot({ news: [item] }));
  const [withoutId] = model.buildEvents(snapshot({ news: [report({ url: undefined })] }));
  assert.equal(event.id, withoutId.id);
});

behavior('URL bounds apply after unicode encoding and provider severity remains finite text', () => {
  const [event] = model.buildEvents(snapshot({ news: [report({ url: `https://first.example/${'é'.repeat(1000)}`, severity: {} })] }));
  assert.equal(event.source.url, null);
  assert.equal(event.severity, 'unknown');
});

behavior('unknown location method prevents a complete provenance level despite available coordinates', () => {
  const [event] = model.buildEvents(snapshot({ health: [{ n: 'First News', err: false }], news: [report({ locationMethod: undefined })] }));
  assert.equal(event.quality.level, 'partial');
  assert.equal(event.quality.checks.location, false);
  assert.ok(event.quality.explanationCodes.includes('unknown-location-method'));
});

behavior('known inferred methods remain labelled when the provider uses a geographic precision label', () => {
  const [event] = model.buildEvents(snapshot({ news: [report({ locationMethod: 'country-centroid', locationPrecision: 'country-level' })] }));
  assert.equal(event.location.precision, 'country-level');
  assert.ok(event.quality.explanationCodes.includes('inferred-location'));
});

behavior('actual USGS magnitude field and epoch-second IODA start fields preserve provider facts', () => {
  const events = model.buildEvents(snapshot({ earthquakes: [{ id: 'q', magnitude: 5.8, place: 'Offshore', time: '2026-10-01T08:00:00Z' }],
    ioda: { recentEvents: [{ id: 77, country: 'Hungary', start: 1790841600 }] } }));
  assert.equal(events.find(event => event.kind === 'earthquake').title, 'M5.8 earthquake — Offshore');
  assert.equal(events.find(event => event.kind === 'outage').observedAt, '2026-10-01T08:00:00.000Z');
});

behavior('GDELT explicit indexing times do not become publication times through duplicate merging', () => {
  const item = { headline: 'Indexed report', source: 'GDELT', type: 'gdelt', observedAt: '2026-10-01T08:00:00Z', publishedAt: null, timestamp: '2026-10-01T08:00:00Z', url: 'https://publisher.example/story' };
  const events = model.buildEvents(snapshot({ newsFeed: [item, { ...item, headline: 'Duplicate indexed report' }] }));
  assert.equal(events.length, 1);
  assert.equal(events[0].observedAt, '2026-10-01T08:00:00.000Z');
  assert.equal(events[0].publishedAt, null);
});

behavior('clustering accepts bounded event-hex identifiers without requiring one fixed hash length', () => {
  const events = model.buildEvents(snapshot({ news: [report(), report({ url: 'https://second.example/story' })] }));
  events[0].id = 'event-abcd';
  events[1].id = 'event-1234';
  assert.equal(model.clusterEvents(events)[0].count, 2);
});

behavior('RFC source dates reject impossible calendar days and midnight rollover', () => {
  const events = model.buildEvents(snapshot({ news: [
    report({ url: 'https://first.example/bad-day', date: 'Mon, 30 Feb 2026 12:00:00 GMT' }),
    report({ url: 'https://first.example/bad-clock', date: 'Thu, 01 Oct 2026 24:00:00 GMT' }),
    report({ url: 'https://first.example/good', date: 'Thu, 01 Oct 2026 11:00:00 +0200' }),
  ] }));
  assert.equal(events[0].publishedAt, null);
  assert.equal(events[1].publishedAt, null);
  assert.equal(events[2].publishedAt, '2026-10-01T09:00:00.000Z');
});

behavior('stable provider identifiers survive updates to the original source URL', () => {
  const first = model.buildEvents(snapshot({ earthquakes: [{ id: 'us7000abcd', url: 'https://earthquake.usgs.gov/old', magnitude: 5.8, place: 'Offshore' }] }))[0];
  const next = model.buildEvents(snapshot({ earthquakes: [{ id: 'us7000abcd', url: 'https://earthquake.usgs.gov/new', magnitude: 5.9, place: 'Updated place' }] }))[0];
  assert.equal(first.id, next.id);
  assert.notEqual(first.source.url, next.source.url);
});

behavior('URL duplicates merge even when only one representation retained a provider identifier', () => {
  const events = model.buildEvents(snapshot({ news: [report({ id: 'publisher-123' })], newsFeed: [
    { headline: report().title, source: 'First News', url: report().url, timestamp: report().date, type: 'rss' },
  ] }));
  assert.equal(events.length, 1);
  assert.equal(events[0].location.lat, 46.5);
});

behavior('linked delta posts retain known publication while delta timestamp stays collection only', () => {
  const [event] = model.buildEvents(snapshot({ delta: { timestamp: collectedAt, signals: { new: [
    { key: 'tg_urgent:123', reason: 'New urgent OSINT post', item: { text: 'Original publication', date: '2026-10-01T08:00:00Z', channel: 'example', url: 'https://t.me/example/123' } },
  ] } } }));
  assert.equal(event.kind, 'signal');
  assert.equal(event.publishedAt, '2026-10-01T08:00:00.000Z');
  assert.equal(event.observedAt, null);
  assert.equal(event.collectedAt, collectedAt);
});

behavior('auth-bearing query parameters never become event detail source links or related origins', () => {
  const keys = ['api_key', 'api-key', 'APIKEY', 'access_token', 'accessToken', 'refresh-token', 'password', 'token', 'auth', 'authorization', 'signature', 'secret', '%61ccess_%74oken'];
  const events = model.buildEvents(snapshot({ news: keys.map((key, index) => report({
    title: `Odessa port explosion closes shipping routes ${index}`,
    url: `https://publisher${index}.example/story?${key}=synthetic-value`,
  })) }));
  assert.equal(events.length, keys.length);
  for (const event of events) {
    assert.equal(event.source.url, null);
    assert.equal(event.source.hostname, null);
    assert.equal(event.quality.checks.sourceUrl, false);
    assert.deepEqual(event.relatedSources, []);
  }
});

behavior('ordinary source query parameters remain usable after auth-query validation', () => {
  const url = 'https://first.example/story?article=123&tokenizer=words&author=News&signature_format=plain';
  const [event] = model.buildEvents(snapshot({ news: [report({ url })] }));
  assert.equal(event.source.url, url);
  assert.equal(event.source.hostname, 'first.example');
  assert.equal(event.quality.checks.sourceUrl, true);
});

behavior('provider severity words map onto the event scale', () => {
  // CAP orders Extreme > Severe > Moderate > Minor: only Extreme (and GDACS Red) is critical, Severe is high.
  const cases = { Red:'critical', Extreme:'critical', Severe:'high', SEVERE:'high', Orange:'high', High:'high', Elevated:'elevated',
    Yellow:'moderate', Medium:'moderate', Moderate:'moderate', Minor:'low', Info:'low', Green:'low', Low:'low', Monitor:'monitor', unknown:'unknown' };
  for (const [word, level] of Object.entries(cases)) assert.equal(model.normalizeSeverity(word), level, word);
  for (const bad of ['', 'banana', null, 7, {}, 'x'.repeat(400)]) assert.equal(model.normalizeSeverity(bad), null);
});

test('buildEvents: a high-intensity fire at a mapped military area and a new KEV entry become located/dated records', () => {
  const snapshot = {
    meta: { timestamp: '2026-10-14T10:00:00Z' },
    thermal: [{ region: 'Middle East', fires: [
      { lat: 33.512, lon: 36.278, frp: 140, at: '2026-10-14T09:12:00Z', site: 'Mezzeh Air Base' },
      { lat: 30, lon: 31, frp: 300, at: '2026-10-14T09:12:00Z' },
    ] }],
    kev: [{ providerId: 'CVE-2026-12345', source: 'CISA-KEV', title: 'CVE-2026-12345: Router RCE exploited', summary: 'Remote code execution.',
      observedAt: '2026-10-13', url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-12345', severity: 'high' }],
  };
  const events = model.buildEvents(snapshot, { now: Date.parse("2026-10-14T10:00:00Z") });
  const fires = events.filter(event => event.kind === 'thermal');
  assert.equal(fires.length, 1, 'only the fire beside a mapped site becomes an event');
  assert.equal(fires[0].title, 'High-intensity fire (140 MW) at Mezzeh Air Base');
  assert.equal(fires[0].location.method, 'provider');
  assert.equal(fires[0].observedAt, '2026-10-14T09:12:00.000Z');
  assert.equal(fires[0].severity, 'high');
  const kev = events.find(event => event.source.name === 'CISA-KEV');
  assert.equal(kev.kind, 'cyber');
  assert.equal(kev.title, 'CVE-2026-12345: Router RCE exploited');
  assert.ok(kev.observedAt.startsWith('2026-10-13'));
});
