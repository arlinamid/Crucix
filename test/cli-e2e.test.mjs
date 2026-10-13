// End-to-end: the real `scripts/cli.mjs` runs as a subprocess against a fake Crucix API on 127.0.0.1 (the HTTP client path),
// against fixture files in a temporary runs/ folder (the --no-server path) and against stubbed RSS feeds (the live news path).
// Nothing here touches the network or the operator's profile.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCli, STUB_FETCH } from './helpers/run-cli.mjs';

const hoursAgo = hours => new Date(Date.now() - hours * 3600_000).toISOString();
const dayOf = iso => iso.slice(0, 10);

let workdir;
let runsDir;
let apiServer;
let apiPort;
let requests;
let apiBehavior;

const RECORDS = [
  { id: 'e1', kind: 'news', title: 'Alpha ceasefire talks resume', source: { name: 'BBC' }, publishedAt: hoursAgo(2) },
  { id: 'e2', kind: 'cyber', title: 'Beta zero-day exploited in the wild', source: { name: 'CISA' }, publishedAt: hoursAgo(30) },
  { id: 'e3', kind: 'news', title: 'Gamma grain corridor update', source: { name: 'Reuters' }, publishedAt: hoursAgo(24 * 10) },
  { id: 'e4', kind: 'news', title: 'Delta port closure', source: { name: 'BBC' }, publishedAt: hoursAgo(5) },
];

function write(relative, value) {
  const file = join(runsDir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'crucix-cli-e2e-'));
  runsDir = join(workdir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  write('intelligence/history.json', { version: 1, records: RECORDS });
  write('intelligence/countries.json', { series: { UKR: [[1, 70], [2, 74]], HUN: [[1, 10], [2, 12]] }, events: { UKR: [1, 2, 3] } });
  write('alerts/alerts.json', { version: 1, engine: null, alerts: [
    { id: 'a-old', ruleId: 'r1', ruleName: 'Rule', severity: 'high', state: 'resolved', title: 'RESOLVED-ONE', firstSeenAt: Date.now() - 9 * 3600_000, lastSeenAt: Date.now() - 8 * 3600_000, resolvedAt: Date.now() - 8 * 3600_000 },
    { id: 'a-fire', ruleId: 'r2', ruleName: 'Rule', severity: 'critical', state: 'firing', title: 'FIRING-ONE', firstSeenAt: Date.now() - 2 * 3600_000, lastSeenAt: Date.now() - 600_000 },
    { id: 'a-ack', ruleId: 'r3', ruleName: 'Rule', severity: 'watch', state: 'acked', title: 'ACKED-ONE', firstSeenAt: Date.now() - 3 * 3600_000, lastSeenAt: Date.now() - 1800_000 },
  ] });
  write('memory/hot.json', { alertedSignals: {}, runs: [
    { timestamp: hoursAgo(1), data: {}, delta: { summary: { direction: 'risk-off', totalChanges: 7, criticalChanges: 2, signalBreakdown: { new: 3, escalated: 2, deescalated: 1 } } } },
    { timestamp: hoursAgo(2), data: {}, delta: { summary: { direction: 'neutral', totalChanges: 99, criticalChanges: 0 } } },
  ] });

  requests = [];
  apiBehavior = {};
  apiServer = http.createServer((req, res) => {
    requests.push(req.url);
    const url = new URL(req.url, 'http://127.0.0.1');
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/alerts') return reply(200, { alerts: [{ id: 'a1', title: 'FAKE-API-ALERT', severity: 'high', state: 'firing', firstSeenAt: Date.now() - 3600_000, lastSeenAt: Date.now() }] });
    if (url.pathname === '/api/countries') return reply(200, { countries: [{ iso3: 'POL', name: 'Poland', score: 33, change24h: 1 }] });
    if (url.pathname.startsWith('/api/countries/')) return reply(200, { iso3: url.pathname.split('/').pop(), name: 'From API', score: 61, components: [] });
    if (url.pathname === '/api/history') return reply(200, apiBehavior.history ?? { items: [], stats: { byKind: {}, totalRecords: 0 } });
    if (url.pathname.startsWith('/api/news/country/')) return reply(200, { cached: true, items: [{ title: 'API-NEWS-ITEM', source: 'ApiWire', lang: 'en', url: 'https://example.test/n', date: hoursAgo(1) }] });
    return reply(404, { error: 'not found' });
  });
  await new Promise(done => apiServer.listen(0, '127.0.0.1', done));
  apiPort = apiServer.address().port;
});

after(async () => {
  await new Promise(done => apiServer.close(done));
  rmSync(workdir, { recursive: true, force: true });
});

const cli = (args, options = {}) => runCli(args, { workdir, runsDir, ...options });

// --- usage errors -------------------------------------------------------------------------------------------------

test('e2e usage: an unknown option exits 2 with a message, not 0 with an empty result', async () => {
  const { code, stdout, stderr } = await cli(['--foo', '--no-server']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown option --foo/);
  assert.match(stderr, /--help/);
  assert.equal(stdout, '');
});

test('e2e usage: an option without a value does not swallow the next option', async () => {
  const { code, stderr, stdout } = await cli(['--country', '--json', '--no-server']);
  assert.equal(code, 2);
  assert.match(stderr, /--country needs a value/);
  assert.equal(stdout, '');
});

test('e2e usage: invalid numbers, durations and dates are reported together', async () => {
  const { code, stderr } = await cli(['--history', '--limit', 'abc', '--days', 'x', '--since', '5x', '--from', 'notadate', '-p', '99999']);
  assert.equal(code, 2);
  for (const pattern of [/--limit needs a whole number of 1 or more/, /--days needs a whole number/, /--since needs a duration/, /--from needs a date/, /-p needs a whole number between 1 and 65535/]) {
    assert.match(stderr, pattern);
  }
});

test('e2e usage: --from after --to is an error', async () => {
  const { code, stderr } = await cli(['--history', '--no-server', '--from', '2026-12-01', '--to', '2026-01-01']);
  assert.equal(code, 2);
  assert.match(stderr, /--from 2026-12-01 is after --to 2026-01-01/);
});

test('e2e usage: --version, --help and the bare-word help work and count 73 sources', async () => {
  const version = await cli(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^crucix \d+\.\d+\.\d+/);
  for (const args of [['--help'], ['help']]) {
    const help = await cli(args);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /73 OSINT data sources/);
    assert.doesNotMatch(help.stdout, /\b71 OSINT/);
  }
});

// --- bare-word subcommands ----------------------------------------------------------------------------------------

test('e2e subcommands: `alerts` and `risk` run the alerts and risk views', async () => {
  const alerts = await cli(['alerts', '--no-server']);
  assert.equal(alerts.code, 0);
  assert.match(alerts.stdout, /Crucix Alerts/);
  const risk = await cli(['risk', '--no-server']);
  assert.equal(risk.code, 0);
  assert.match(risk.stdout, /Country Risk Ranking/);
  assert.match(risk.stdout, /\[UKR\] Ukraine\s+:\s+74\/100/);
});

// --- --port reaches the API ---------------------------------------------------------------------------------------

test('e2e --port: client commands talk to the server on that port', async () => {
  requests.length = 0;
  const { code, stdout } = await cli(['--alerts', '--port', String(apiPort)]);
  assert.equal(code, 0);
  assert.match(stdout, /\[API\]/);
  assert.match(stdout, /Active: 1, Total: 1/);
  assert.match(stdout, /\[HIGH\].*FAKE-API-ALERT.*\(firing\)/);
  assert.doesNotMatch(stdout, /No active alerts/);
  assert.deepEqual(requests, ['/api/alerts']);
});

test('e2e --port: the PORT variable still works and a dead port falls back to the disk', async () => {
  const viaEnv = await cli(['--alerts'], { env: { PORT: String(apiPort) } });
  assert.match(viaEnv.stdout, /FAKE-API-ALERT/);
  const dead = await cli(['--alerts', '--port', '1']);
  assert.equal(dead.code, 0);
  assert.match(dead.stdout, /STANDALONE|NO-SERVER/);
  assert.doesNotMatch(dead.stdout, /FAKE-API-ALERT/);
});

// --- country risk ---------------------------------------------------------------------------------------------------

test('e2e risk: an alpha-2 code is mapped to the alpha-3 the index uses (disk)', async () => {
  const { code, stdout } = await cli(['--risk', 'UA', '--no-server']);
  assert.equal(code, 0);
  assert.match(stdout, /Country Risk Profile: \[UKR\] Ukraine/);
  assert.match(stdout, /74\/100/);
  assert.match(stdout, /Recorded events\s*: 3/);
  assert.doesNotMatch(stdout, /N\/A/);
});

test('e2e risk: --country-risk hu and the API both receive the alpha-3 code', async () => {
  const disk = await cli(['--country-risk', 'hu', '--no-server']);
  assert.match(disk.stdout, /\[HUN\] Hungary/);
  requests.length = 0;
  const api = await cli(['--risk', 'ua', '--port', String(apiPort)]);
  assert.match(api.stdout, /\[UKR\] From API/);
  assert.deepEqual(requests, ['/api/countries/UKR']);
});

test('e2e risk: an unknown code is a usage error', async () => {
  const { code, stderr } = await cli(['--risk', 'ZZZZ', '--no-server']);
  assert.equal(code, 2);
  assert.match(stderr, /country code/);
});

// --- history from disk ----------------------------------------------------------------------------------------------

test('e2e history (disk): newest first, and --since is an exact window', async () => {
  const all = await cli(['--history', '--no-server', '--json']);
  assert.deepEqual(JSON.parse(all.stdout).map(r => r.id), ['e1', 'e4' ].length ? ['e1', 'e4', 'e2', 'e3'] : []);
  const recent = await cli(['--history', '--no-server', '--since', '6h', '--json']);
  assert.deepEqual(JSON.parse(recent.stdout).map(r => r.id), ['e1', 'e4']);
  const day = await cli(['--history', '--no-server', '--days', '2', '--json']);
  assert.deepEqual(JSON.parse(day.stdout).map(r => r.id), ['e1', 'e4', 'e2']);
});

test('e2e history (disk): the limit keeps the newest records', async () => {
  const { stdout } = await cli(['--history', '--no-server', '--limit', '2', '--json']);
  assert.deepEqual(JSON.parse(stdout).map(r => r.id), ['e1', 'e4']);
});

test('e2e history (disk): category, source and text filters combine', async () => {
  const cyber = await cli(['cyber', '--no-server', '--json']);
  assert.deepEqual(JSON.parse(cyber.stdout).map(r => r.id), ['e2']);
  const bbc = await cli(['--history', '--source', 'bbc', '--no-server', '--json']);
  assert.deepEqual(JSON.parse(bbc.stdout).map(r => r.id), ['e1', 'e4']);
  const text = await cli(['-q', 'grain', '--no-server', '--json']);
  assert.deepEqual(JSON.parse(text.stdout).map(r => r.id), ['e3']);
  const none = await cli(['-q', 'nothing-matches-this', '--no-server']);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /No events found/);
});

test('e2e history (disk): --from/--to include the whole last day', async () => {
  const day = dayOf(RECORDS[0].publishedAt);
  const { stdout } = await cli(['--history', '--no-server', '--from', day, '--to', day, '--json']);
  const ids = JSON.parse(stdout).map(r => r.id);
  assert.ok(ids.includes('e1'), 'a record from earlier today is inside --to today');
  assert.ok(!ids.includes('e3'), 'a ten-day-old record is outside');
});

test('e2e history (disk): --categories counts kinds', async () => {
  const { stdout } = await cli(['--categories', '--no-server', '--json']);
  assert.deepEqual(JSON.parse(stdout), { news: 3, cyber: 1 });
});

// --- history through the API ----------------------------------------------------------------------------------------

test('e2e history (API): sends only known query parameters and refines --since to the exact window', async () => {
  apiBehavior.history = { items: RECORDS.map(r => ({ ...r })), stats: { byKind: { news: 3, cyber: 1 }, totalRecords: 4 } };
  requests.length = 0;
  const { code, stdout } = await cli(['--history', '--since', '6h', '--source', 'BBC', '--port', String(apiPort), '--json']);
  assert.equal(code, 0);
  const query = new URL(requests[0], 'http://127.0.0.1').searchParams;
  assert.equal(query.get('from'), dayOf(new Date(Date.now() - 6 * 3600_000).toISOString()));
  assert.equal(query.get('source'), 'BBC');
  assert.equal(query.get('limit'), '10');
  assert.deepEqual([...query.keys()].sort(), ['from', 'limit', 'source']);
  assert.deepEqual(JSON.parse(stdout).map(r => r.id), ['e1', 'e4'], 'older records of the same day are cut client-side');
});

test('e2e history (API): a reply without items falls back to the disk archive', async () => {
  apiBehavior.history = { unexpected: true };
  const { code, stdout } = await cli(['--history', '--port', String(apiPort)]);
  assert.equal(code, 0);
  assert.match(stdout, /\[OFFLINE\]/);
  assert.match(stdout, /Alpha ceasefire talks resume/);
  apiBehavior.history = undefined;
});

// --- country news: API, cache and the live fetch --------------------------------------------------------------------

test('e2e country news: a country code is served by the API when it is up', async () => {
  requests.length = 0;
  const { code, stdout } = await cli(['hu', '--port', String(apiPort)]);
  assert.equal(code, 0);
  assert.match(stdout, /API-NEWS-ITEM/);
  assert.deepEqual(requests, ['/api/news/country/HU']);
});

test('e2e country news: `hu --live` fetches the feeds, parses them and keeps working when a feed fails', async () => {
  const { code, stdout, stderr } = await cli(['hu', '--live', '--no-server', '--limit', '6', '--json'], { preload: STUB_FETCH });
  assert.match(stderr, /Fetching live news for \[HU\]/);
  assert.equal(code, 0);
  const items = JSON.parse(stdout);
  assert.equal(items.length, 6);
  for (const item of items) {
    assert.match(item.title, /^Stub headline /);
    assert.match(item.url, /^https?:\/\/.+\/story-\d$/);
    assert.equal(item.country, 'HU');
    assert.ok(item.source);
  }
  const times = items.map(item => Date.parse(item.date));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
});

test('e2e country news: the live view prints headlines with their links, and an alpha-3 code is accepted', async () => {
  const { code, stdout, stderr } = await cli(['ukr', '--live', '--no-server'], { preload: STUB_FETCH });
  assert.match(stderr, /Fetching live news for \[UA\]/);
  assert.equal(code, 0);
  assert.match(stdout, /Crucix News \[UA\]/);
  assert.match(stdout, /Stub headline/);
  assert.match(stdout, /🔗 https?:\/\//);
});

test('e2e country news: a country without feeds says so instead of listing unrelated archive events', async () => {
  const { code, stdout } = await cli(['--country', 'ZZ', '--no-server'], { preload: STUB_FETCH });
  assert.equal(code, 0);
  assert.match(stdout, /Could not find news for code: ZZ/);
  assert.doesNotMatch(stdout, /Crucix Events/);
  const json = await cli(['--country', 'ZZ', '--no-server', '--json'], { preload: STUB_FETCH });
  assert.deepEqual(JSON.parse(json.stdout), []);
});

// --- catalog --------------------------------------------------------------------------------------------------------

test('e2e catalog: --feeds takes alpha-2 and alpha-3 codes', async () => {
  const two = JSON.parse((await cli(['--feeds', 'DE', '--json'])).stdout);
  const three = JSON.parse((await cli(['--feeds', 'deu', '--json'])).stdout);
  assert.ok(two.length > 0);
  assert.deepEqual(three, two);
  const countries = JSON.parse((await cli(['--countries', '--json'])).stdout);
  assert.ok(countries.HU > 0 && countries.DE > 0);
});

// --- crashes become messages ----------------------------------------------------------------------------------------

test('e2e errors: an unexpected exception prints one line and exits 1, not a stack trace', async () => {
  const preload = join(workdir, 'explode.mjs');
  writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("network blew up"); };\n');
  // RUNS_DIR names a file, so the collector's mkdir fails before the first sweep: main() rejects.
  const { code, stderr } = await cli(['--collector', '--interval', '1'], { env: { RUNS_DIR: join(workdir, 'runs', 'intelligence', 'history.json') }, preload });
  assert.equal(code, 1);
  assert.match(stderr, /❌ /);
  assert.doesNotMatch(stderr, /\n\s+at .*\(file:\/\//, 'no stack trace without DEBUG');
});

// --- stored alerts and delta (disk) ---------------------------------------------------------------------------------

test('e2e alerts (disk): every state but resolved counts as active, open alerts first', async () => {
  const { code, stdout } = await cli(['-A', '--no-server']);
  assert.equal(code, 0);
  assert.match(stdout, /Active: 2, Total: 3/);
  assert.doesNotMatch(stdout, /No active alerts/);
  assert.match(stdout, /FIRING-ONE/);
  assert.match(stdout, /ACKED-ONE/);
  assert.doesNotMatch(stdout, /RESOLVED-ONE/);
  const all = await cli(['--all-alerts', '--no-server']);
  assert.match(all.stdout, /RESOLVED-ONE/);
  assert.ok(all.stdout.indexOf('FIRING-ONE') < all.stdout.indexOf('RESOLVED-ONE'), 'newest activity first');
  const json = JSON.parse((await cli(['-A', '--no-server', '--json'])).stdout);
  assert.deepEqual(json.active.map(a => a.id), ['a-fire', 'a-ack']);
});

test('e2e delta (disk): shows the newest run, which the memory stores first', async () => {
  const { code, stdout } = await cli(['--delta', '--no-server']);
  assert.equal(code, 0);
  assert.match(stdout, /RISK-OFF/);
  assert.match(stdout, /Total Changes:\s+7/);
  assert.doesNotMatch(stdout, /99/);
});
