import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseArgs,
  toIso2,
  toIso3,
  getCliLanguage,
  isExecutable,
  getCliCmd,
  printHelp,
  packageVersion,
  versionLine,
  formatAge,
  formatNumber,
  formatPct,
  loadFromDisk,
  loadLiveFromDisk,
  loadLatestRaw,
  getSynthesizedData,
  getAlertsData,
  getCountryRiskData,
  fetchCountryLive,
  resolveRunsDir,
} from '../scripts/cli.mjs';
import { loadWorldRssCache, getWorldNewsByCountry } from '../lib/world-rss-runner.mjs';

test('cli parseArgs: recognizes standalone / no-server flags', () => {
  const flags = ['--no-server', '--standalone', '--offline', '--direct', '-S'];
  for (const flag of flags) {
    const opts = parseArgs([flag]);
    assert.equal(opts.noServer, true, `${flag} should set noServer to true`);
  }
});

test('cli parseArgs: default noServer is false', () => {
  const opts = parseArgs(['-c', 'news', '-l', '5']);
  assert.equal(opts.noServer, false);
  assert.equal(opts.category, 'news');
  assert.equal(opts.limit, 5);
});

test('cli parseArgs: recognizes version flags', () => {
  for (const flag of ['-v', '-V', '--version', 'version']) {
    assert.equal(parseArgs([flag]).version, true, flag);
  }
  assert.equal(parseArgs(['-c', 'news']).version, false);
  assert.match(versionLine(), new RegExp(`^crucix ${packageVersion().replace(/\./g, '\\.')}$`));
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
});

test('cli parseArgs: recognizes sweep flags', () => {
  assert.equal(parseArgs(['--sweep']).sweep, true);
  assert.equal(parseArgs(['--run-sweep']).sweep, true);
  assert.equal(parseArgs(['--no-server', '--sweep']).noServer, true);
  assert.equal(parseArgs(['--no-server', '--sweep']).sweep, true);
});

test('cli parseArgs: recognizes collector and daemon flags', () => {
  assert.equal(parseArgs(['--collector']).collector, true);
  assert.equal(parseArgs(['--daemon']).collector, true);
  assert.equal(parseArgs(['--watch']).collector, true);
  assert.equal(parseArgs(['--collector', '-i', '30']).interval, 30);
  assert.equal(parseArgs(['--collector', '--interval', '45']).interval, 45);
});

test('cli parseArgs: recognizes serve / headless server flags', () => {
  assert.equal(parseArgs(['--serve']).serve, true);
  assert.equal(parseArgs(['--server']).serve, true);
  assert.equal(parseArgs(['--start-server']).serve, true);
});

test('cli parseArgs: recognizes history flags', () => {
  assert.equal(parseArgs(['-H']).history, true);
  assert.equal(parseArgs(['--history']).history, true);
  assert.equal(parseArgs(['--history', '-l', '20']).limit, 20);
});

test('cli parseArgs: recognizes time window flags', () => {
  const o1 = parseArgs(['--since', '14d']);
  assert.equal(o1.since, '14d');
  assert.equal(o1.sinceMs, 14 * 86400 * 1000);
  assert.ok(o1.from);

  const o2 = parseArgs(['--window', '2w']);
  assert.equal(o2.since, '2w');
  assert.equal(o2.sinceMs, 14 * 86400 * 1000);

  const o3 = parseArgs(['-d', '7']);
  assert.equal(o3.since, '7d');
  assert.equal(o3.sinceMs, 7 * 86400 * 1000);

  const o4 = parseArgs(['--from', '2026-09-26', '--to', '2026-10-10']);
  assert.equal(o4.from, '2026-09-26');
  assert.equal(o4.to, '2026-10-10');
});

test('cli parseArgs: recognizes data flags', () => {
  assert.equal(parseArgs(['-b']).brief, true);
  assert.equal(parseArgs(['--brief']).brief, true);
  assert.equal(parseArgs(['-m']).markets, true);
  assert.equal(parseArgs(['--markets']).markets, true);
  assert.equal(parseArgs(['--finance']).markets, true);
  assert.equal(parseArgs(['--energy']).energy, true);
  assert.equal(parseArgs(['--metals']).metals, true);
  assert.equal(parseArgs(['--commodities']).commodities, true);
  assert.equal(parseArgs(['-A']).alerts, true);
  assert.equal(parseArgs(['--alerts']).alerts, true);
  assert.equal(parseArgs(['--all-alerts']).allAlerts, true);
  assert.equal(parseArgs(['--risk']).risk, true);
  assert.equal(parseArgs(['--risk', 'UKR']).countryRisk, 'UKR');
  assert.equal(parseArgs(['--risk', 'UA']).countryRisk, 'UKR', 'alpha-2 is accepted and mapped to the alpha-3 the risk index uses');
  assert.equal(parseArgs(['--country-risk', 'PAN']).countryRisk, 'PAN');
  assert.equal(parseArgs(['--earthquakes']).earthquakes, true);
  assert.equal(parseArgs(['--thermal']).thermal, true);
  assert.equal(parseArgs(['--chokepoints']).chokepoints, true);
  assert.equal(parseArgs(['--air']).air, true);
  assert.equal(parseArgs(['--cyber']).cyber, true);
  assert.equal(parseArgs(['--outages']).outages, true);
  assert.equal(parseArgs(['--predictions']).predictions, true);
  assert.equal(parseArgs(['--health']).health, true);
  assert.equal(parseArgs(['--status']).health, true);
  assert.equal(parseArgs(['--sources']).sources, true);
  assert.equal(parseArgs(['--source-data', 'USGS']).sourceData, 'USGS');
  assert.equal(parseArgs(['--sweeps']).sweeps, true);
  assert.equal(parseArgs(['--delta']).delta, true);
  assert.equal(parseArgs(['-a']).all, true);
  assert.equal(parseArgs(['--all']).all, true);
});

test('cli formatters: formatAge, formatNumber, formatPct', () => {
  const now = Date.now();
  assert.equal(formatAge(new Date(now - 10 * 1000).toISOString(), 'en'), '10s ago');
  assert.equal(formatAge(new Date(now - 120 * 1000).toISOString(), 'en'), '2m ago');
  assert.equal(formatAge(new Date(now - 7200 * 1000).toISOString(), 'en'), '2h ago');
  assert.equal(formatAge(new Date(now - 2 * 86400 * 1000).toISOString(), 'en'), '2d ago');
  assert.equal(formatAge(null, 'en'), '');

  // Hungarian formatAge
  assert.equal(formatAge(new Date(now - 10 * 1000).toISOString(), 'hu'), '10 mp ezelőtt');
  assert.equal(formatAge(new Date(now - 120 * 1000).toISOString(), 'hu'), '2 perce');
  assert.equal(formatAge(new Date(now - 7200 * 1000).toISOString(), 'hu'), '2 órája');
  assert.equal(formatAge(new Date(now - 2 * 86400 * 1000).toISOString(), 'hu'), '2 napja');
  assert.equal(formatAge(null, 'hu'), '');

  assert.equal(formatNumber(1234.56), '1,234.56');
  assert.equal(formatNumber(null), '--');

  assert.equal(formatPct(2.5), '+2.50%');
  assert.equal(formatPct(-1.75), '-1.75%');
  assert.equal(formatPct(null), '--');
});

test('cli i18n: getCliLanguage resolves language code correctly', () => {
  const origCrucixLang = process.env.CRUCIX_LANG;
  const origLang = process.env.LANG;
  const origLanguage = process.env.LANGUAGE;
  delete process.env.CRUCIX_LANG;
  delete process.env.LANG;
  delete process.env.LANGUAGE;
  try {
    assert.equal(getCliLanguage({ lang: 'hu' }), 'hu');
    assert.equal(getCliLanguage({ lang: 'HU' }), 'hu');
    assert.equal(getCliLanguage({ lang: 'fr' }), 'fr');
    assert.equal(getCliLanguage({ lang: 'en' }), 'en');
    assert.equal(getCliLanguage({ lang: 'de' }), 'en'); // unsupported defaults to en
    assert.equal(getCliLanguage({}), 'en');

    const parsed1 = parseArgs(['--lang', 'hu']);
    assert.equal(getCliLanguage(parsed1), 'hu');

    const parsed2 = parseArgs(['-L', 'fr']);
    assert.equal(getCliLanguage(parsed2), 'fr');

    process.env.CRUCIX_LANG = 'hu';
    assert.equal(getCliLanguage({}), 'hu');
  } finally {
    if (origCrucixLang !== undefined) process.env.CRUCIX_LANG = origCrucixLang;
    else delete process.env.CRUCIX_LANG;
    if (origLang !== undefined) process.env.LANG = origLang;
    else delete process.env.LANG;
    if (origLanguage !== undefined) process.env.LANGUAGE = origLanguage;
    else delete process.env.LANGUAGE;
  }
});

test('cli i18n: printHelp executes cleanly in English and Hungarian', () => {
  const origLog = console.log;
  let logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    assert.doesNotThrow(() => printHelp('en'));
    assert.doesNotThrow(() => printHelp('hu'));
    assert.ok(logged.some(msg => msg.includes('Crucix Intelligence CLI')));
    assert.ok(logged.some(msg => msg.includes('Használat:')));
  } finally {
    console.log = origLog;
  }
});

test('cli exe help: executable mode displays crucix command without npm references', () => {
  const origEnv = process.env.CRUCIX_EXECUTABLE;
  const origLog = console.log;
  let logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    process.env.CRUCIX_EXECUTABLE = '1';
    assert.equal(isExecutable(), true);
    assert.equal(getCliCmd(), 'crucix');

    printHelp('hu');
    const huOutput = logged.join('\n');
    assert.ok(huOutput.includes('crucix [opciók]'));
    assert.ok(huOutput.includes('crucix -b'));
    assert.ok(!huOutput.includes('npm run cli'), 'Hungarian exe help must not contain npm commands');

    logged = [];
    printHelp('en');
    const enOutput = logged.join('\n');
    assert.ok(enOutput.includes('crucix [options]'));
    assert.ok(enOutput.includes('crucix -b'));
    assert.ok(!enOutput.includes('npm run cli'), 'English exe help must not contain npm commands');
  } finally {
    console.log = origLog;
    if (origEnv !== undefined) {
      process.env.CRUCIX_EXECUTABLE = origEnv;
    } else {
      delete process.env.CRUCIX_EXECUTABLE;
    }
  }
});

test('cli loadFromDisk: reads history records without requiring web server', () => {
  const records = loadFromDisk();
  assert.ok(Array.isArray(records), 'records must be an array');
  if (records.length > 0) {
    const first = records[0];
    assert.ok(first.id, 'record has id');
    assert.ok(first.title, 'record has title');
    assert.ok(first.kind, 'record has kind');
  }
});

test('cli world rss cache: can be queried in standalone/no-server mode', () => {
  const loaded = loadWorldRssCache();
  if (loaded) {
    const brNews = getWorldNewsByCountry('BR');
    assert.ok(Array.isArray(brNews), 'br news must be an array');
    if (brNews.length > 0) {
      assert.equal(brNews[0].country, 'BR');
    }
  }
});

test('cli getSynthesizedData: loads markets and indicators from disk when present or handles empty state', async () => {
  const syn = await getSynthesizedData({ noServer: true });
  if (syn.data) {
    assert.ok(syn.data.markets, 'markets data exists');
    assert.ok(syn.data.energy, 'energy data exists');
    assert.ok(syn.data.metals, 'metals data exists');
    assert.ok(syn.data.earthquakes, 'earthquakes data exists');
    assert.ok(syn.data.chokepoints, 'chokepoints data exists');
  } else {
    assert.equal(syn.data, null, 'returns null when no latest.json exists');
  }
});

test('cli getAlertsData: loads alerts from disk', async () => {
  const alertsData = await getAlertsData({ noServer: true });
  assert.ok(Array.isArray(alertsData.alerts), 'alerts is an array');
});

test('cli getCountryRiskData: loads risk list and country details from disk', async () => {
  const listData = await getCountryRiskData({ noServer: true });
  assert.ok(Array.isArray(listData.list), 'country risk list is an array');

  const detailData = await getCountryRiskData({ noServer: true, countryRisk: 'USA' });
  if (detailData.detail) {
    assert.ok(detailData.detail, 'country detail exists');
    assert.equal(detailData.detail.iso3, 'USA');
  } else {
    assert.equal(detailData.detail, null, 'returns null when no country risk exists');
  }
});

test('cli build-exe script exists and is executable', () => {
  assert.ok(existsSync(join(process.cwd(), 'scripts', 'build-exe.mjs')));
});

test('cli resolveRunsDir: respects custom dir or defaults to project/user runs', () => {
  const custom = resolveRunsDir('/tmp/my-runs');
  assert.equal(custom, resolve('/tmp/my-runs'));

  const normal = resolveRunsDir();
  assert.ok(typeof normal === 'string' && normal.length > 0, 'Runs directory is resolved to a valid path');
  assert.ok(normal.endsWith('runs'), 'Runs directory ends with runs');
});

test('cli parseArgs: an option never swallows the next option', () => {
  for (const flag of ['--country', '-c', '-q', '--search', '--source', '--lang', '-L', '--limit', '--since', '--from', '--to', '--source-data', '--search-feeds']) {
    const opts = parseArgs([flag, '--json']);
    assert.equal(opts.json, true, `${flag} must leave --json alone`);
    assert.match(opts.errors.join('\n'), new RegExp(`${flag.replace(/-/g, '\\-')} needs a value`));
  }
});

test('cli parseArgs: rejects unknown options and bad values instead of ignoring them', () => {
  assert.match(parseArgs(['--foo']).errors[0], /unknown option --foo/);
  assert.match(parseArgs(['--limit', 'abc']).errors[0], /whole number/);
  assert.match(parseArgs(['--limit', '0']).errors[0], /whole number/);
  assert.match(parseArgs(['--days', 'abc']).errors[0], /whole number/);
  assert.match(parseArgs(['--since', '5x']).errors[0], /duration/);
  assert.match(parseArgs(['--from', 'notadate']).errors[0], /YYYY-MM-DD/);
  assert.match(parseArgs(['--to', '2026-02-30']).errors[0], /YYYY-MM-DD/);
  assert.match(parseArgs(['--from', '2026-12-01', '--to', '2026-01-01']).errors[0], /after --to/);
  assert.match(parseArgs(['--interval', '0']).errors[0], /whole number/);
  assert.match(parseArgs(['--country', 'H']).errors[0], /country code/);
  assert.match(parseArgs(['--risk', 'ZZZZ']).errors[0], /country code/);
  assert.deepEqual(parseArgs(['--limit', '5', '--since', '6h', '--from', '2026-01-01', '--to', '2026-02-01']).errors, []);
  assert.deepEqual(parseArgs([]).errors, []);
});

test('cli parseArgs: --port is validated and applied to the environment', () => {
  const saved = process.env.PORT;
  try {
    assert.match(parseArgs(['--port', '99999']).errors[0], /between 1 and 65535/);
    assert.match(parseArgs(['-p', 'abc']).errors[0], /between 1 and 65535/);
    assert.deepEqual(parseArgs(['-p', '4555']).errors, []);
    assert.equal(process.env.PORT, '4555');
  } finally {
    if (saved === undefined) delete process.env.PORT; else process.env.PORT = saved;
  }
});

test('cli parseArgs: country codes are normalized (alpha-3 to alpha-2 for news, alpha-2 to alpha-3 for risk)', () => {
  assert.equal(toIso2('hu'), 'HU');
  assert.equal(toIso2('ukr'), 'UA');
  assert.equal(toIso2('zzz'), null);
  assert.equal(toIso2('H'), null);
  assert.equal(toIso3('ua'), 'UKR');
  assert.equal(toIso3('HUN'), 'HUN');
  assert.equal(toIso3('1'), null);
  assert.equal(parseArgs(['--country', 'ukr']).country, 'UA');
  assert.equal(parseArgs(['hu']).country, 'HU');
  assert.equal(parseArgs(['UKR']).country, 'UA');
  assert.equal(parseArgs(['--feeds', 'deu']).country, 'DE');
});

test('cli parseArgs: positional words are subcommands, categories or countries; an extra one is an error', () => {
  assert.equal(parseArgs(['status']).health, true);
  assert.equal(parseArgs(['sweep']).sweep, true);
  assert.equal(parseArgs(['brief']).brief, true);
  assert.equal(parseArgs(['alerts']).alerts, true);
  assert.equal(parseArgs(['help']).help, true);
  const risk = parseArgs(['risk', 'ua']);
  assert.equal(risk.risk, true);
  assert.equal(risk.countryRisk, 'UKR');
  const both = parseArgs(['news', 'hu']);
  assert.equal(both.category, 'news');
  assert.equal(both.country, 'HU');
  assert.equal(parseArgs(['war']).category, 'war', 'a 3-letter word that is no country is a category');
  assert.equal(parseArgs(['cyber']).category, 'cyber');
  assert.match(parseArgs(['news', 'cyber']).errors[0], /unexpected argument "cyber"/);
  assert.deepEqual(parseArgs(['setup', '--cli']).errors, [], '--cli belongs to the setup wizard');
});

test('cli fetchCountryLive: reads each feed over HTTP, parses the XML and tolerates failing feeds', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (calls.length === 2) return new Response('boom', { status: 500 });
    const hours = calls.length;
    const date = new Date(Date.now() - hours * 3600_000).toUTCString();
    return new Response(`<rss version="2.0"><channel><item><title>Headline ${hours}</title><link>https://example.test/${hours}</link><pubDate>${date}</pubDate></item></channel></rss>`, { status: 200 });
  };
  try {
    const items = await fetchCountryLive('hu', 50);
    assert.ok(calls.length >= 2, 'one request per Hungarian feed');
    assert.equal(items.length, calls.length - 1, 'the failing feed is skipped, the others kept');
    assert.ok(items.every(item => item.title && item.url?.startsWith('https://example.test/') && item.source && item.country === 'HU'));
    const times = items.map(item => Date.parse(item.date));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
    assert.equal((await fetchCountryLive('hu', 1)).length, 1, 'the limit applies');
    assert.deepEqual(await fetchCountryLive('zz'), [], 'no feeds for the country');
  } finally {
    globalThis.fetch = original;
  }
});
