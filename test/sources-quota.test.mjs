import test from 'node:test';
import assert from 'node:assert/strict';
import { briefing as bls, resetState as resetBls } from '../apis/sources/bls.mjs';
import { briefing as epa, resetState as resetEpa } from '../apis/sources/epa.mjs';
import { briefing as acled, resetState as resetAcled } from '../apis/sources/acled.mjs';
import { briefing as space, resetState as resetSpace } from '../apis/sources/space.mjs';
import { briefing as opensky, resetState as resetOpenSky } from '../apis/sources/opensky.mjs';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

function useFetch(t, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => { globalThis.fetch = original; });
}

test('BLS serves a 12-hour cache instead of spending another daily query', async t => {
  resetBls();
  t.after(() => resetBls());
  let hits = 0;
  useFetch(t, async () => {
    hits++;
    return new Response(JSON.stringify({
      status: 'REQUEST_SUCCEEDED',
      Results: { series: [{ seriesID: 'LNS14000000', data: [{ year: '2026', period: 'M09', value: '4.2' }] }] },
    }));
  });
  const first = await bls(undefined, { now: NOW });
  assert.equal(first.error, undefined);
  assert.equal(hits, 1);
  const cached = await bls(undefined, { now: NOW + 6 * 3600000 });
  assert.equal(cached.cached, true);
  assert.equal(cached.stale, undefined, 'within the planned interval the cached result is current, not stale');
  assert.equal(hits, 1);
  resetBls({ disk: false });
  const afterRestart = await bls(undefined, { now: NOW + 7 * 3600000 });
  assert.equal(afterRestart.cached, true);
  assert.equal(hits, 1, 'disk cache survives a memory reset');
});

test('BLS daily-threshold error returns the last good briefing', async t => {
  resetBls();
  t.after(() => resetBls());
  let limited = false;
  useFetch(t, async () => {
    if (limited) {
      return new Response(JSON.stringify({
        status: 'REQUEST_NOT_PROCESSED',
        message: ['Request could not be serviced, as the daily threshold for total number of requests allocated to the user with registration key  has been reached.'],
      }));
    }
    return new Response(JSON.stringify({
      status: 'REQUEST_SUCCEEDED',
      Results: { series: [{ seriesID: 'LNS14000000', data: [{ year: '2026', period: 'M09', value: '4.2' }] }] },
    }));
  });
  await bls(undefined, { now: NOW });
  limited = true;
  const stale = await bls(undefined, { now: NOW + 13 * 3600000 });
  assert.equal(stale.stale, true);
  assert.match(stale.message, /daily threshold/);
});

test('EPA 403 is not retried for six hours', async t => {
  resetEpa();
  t.after(() => resetEpa());
  let hits = 0;
  useFetch(t, async () => {
    hits++;
    return new Response('blocked', { status: 403 });
  });
  const first = await epa({ now: NOW });
  assert.match(first.error, /403/);
  assert.equal(hits, 1);
  const again = await epa({ now: NOW + 60 * 1000 });
  assert.match(again.error || again.message, /403/);
  assert.equal(hits, 1, 'cooldown skips the WAF');
});

test('ACLED OAuth sends scope=authenticated and does not also cookie-login after a Cloudflare challenge', async t => {
  resetAcled();
  t.after(() => resetAcled());
  const saved = {
    ACLED_EMAIL: process.env.ACLED_EMAIL,
    ACLED_PASSWORD: process.env.ACLED_PASSWORD,
    ACLED_ACCESS_TOKEN: process.env.ACLED_ACCESS_TOKEN,
    ACLED_REFRESH_TOKEN: process.env.ACLED_REFRESH_TOKEN,
  };
  process.env.ACLED_EMAIL = 'user@example.com';
  process.env.ACLED_PASSWORD = 'secret';
  delete process.env.ACLED_ACCESS_TOKEN;
  delete process.env.ACLED_REFRESH_TOKEN;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const calls = [];
  useFetch(t, async (url, init = {}) => {
    calls.push({ url: String(url), body: String(init.body || '') });
    return new Response('<html><title>Just a moment...</title></html>', {
      status: 403,
      headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge', 'cf-ray': 'test-ray' },
    });
  });
  const data = await acled({ now: NOW });
  assert.match(data.error, /Cloudflare challenge/);
  assert.equal(data.code, 'auth_blocked');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /oauth\/token/);
  assert.equal(new URLSearchParams(calls[0].body).get('scope'), 'authenticated');

  const again = await acled({ now: NOW + 60 * 1000 });
  assert.equal(again.code, 'auth_blocked');
  assert.equal(calls.length, 1, 'auth_blocked cooldown skips another OAuth attempt');
});

test('ACLED classifies JSON invalid_grant separately from Cloudflare HTML 403', async t => {
  resetAcled();
  t.after(() => resetAcled());
  const saved = {
    ACLED_EMAIL: process.env.ACLED_EMAIL,
    ACLED_PASSWORD: process.env.ACLED_PASSWORD,
    ACLED_ACCESS_TOKEN: process.env.ACLED_ACCESS_TOKEN,
  };
  process.env.ACLED_EMAIL = 'user@example.com';
  process.env.ACLED_PASSWORD = 'wrong';
  delete process.env.ACLED_ACCESS_TOKEN;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  useFetch(t, async (url) => {
    if (String(url).includes('/oauth/token')) {
      return new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'The user credentials were incorrect.',
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ current_user: { uid: '1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': 'SSESS=abc; Path=/' },
    });
  });
  // Cookie fallback may succeed in this fixture; assert OAuth path alone via classify import.
  const { classifyHttpFailure } = await import('../apis/sources/acled.mjs');
  const headers = new Headers({ 'content-type': 'application/json' });
  const fail = classifyHttpFailure(400, headers, JSON.stringify({
    error: 'invalid_grant',
    error_description: 'The user credentials were incorrect.',
  }), { phase: 'auth' });
  assert.equal(fail.code, 'invalid_grant');
  const cf = classifyHttpFailure(403, new Headers({
    'content-type': 'text/html',
    'cf-mitigated': 'challenge',
    'cf-ray': 'abc',
  }), '<html>Just a moment...</html>', { phase: 'auth' });
  assert.equal(cf.code, 'auth_blocked');
  assert.match(cf.error, /cf-ray abc/);
});

test('ACLED refresh token avoids password grant and permission_denied stays distinct', async t => {
  resetAcled();
  t.after(() => resetAcled());
  const saved = {
    ACLED_EMAIL: process.env.ACLED_EMAIL,
    ACLED_PASSWORD: process.env.ACLED_PASSWORD,
    ACLED_ACCESS_TOKEN: process.env.ACLED_ACCESS_TOKEN,
    ACLED_REFRESH_TOKEN: process.env.ACLED_REFRESH_TOKEN,
  };
  delete process.env.ACLED_EMAIL;
  delete process.env.ACLED_PASSWORD;
  delete process.env.ACLED_ACCESS_TOKEN;
  process.env.ACLED_REFRESH_TOKEN = 'refresh-me';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const calls = [];
  useFetch(t, async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, body: String(init.body || '') });
    if (href.includes('/oauth/token')) {
      const body = new URLSearchParams(String(init.body || ''));
      assert.equal(body.get('grant_type'), 'refresh_token');
      return new Response(JSON.stringify({
        access_token: 'access-1',
        refresh_token: 'refresh-2',
        expires_in: 3600,
        token_type: 'Bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      status: 403,
      message: 'Consent must be accepted',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  process.env.ACLED_EMAIL = 'user@example.com';
  process.env.ACLED_PASSWORD = 'secret';
  const data = await acled({ now: NOW });
  assert.equal(data.code, 'permission_denied');
  assert.match(data.error || data.message, /Consent must be accepted|permission_denied/);
  assert.equal(calls.filter(c => c.url.includes('/oauth/token')).length, 1);
  assert.ok(calls.some(c => c.url.includes('/api/acled/read')));
  assert.equal(data.status, 'disabled', 'a permanent 403 reports the optional source as disabled, not failed');
  const before = calls.length;
  const again = await acled({ now: NOW + 3600_000 });
  assert.equal(again.status, 'disabled');
  assert.equal(calls.length, before, 'no new request while the denial is remembered (24 h)');
});

test('CelesTrak caches a good briefing for two hours and counts Starlink at most once a day', async t => {
  resetSpace();
  t.after(() => resetSpace());
  const calls = [];
  useFetch(t, async url => {
    calls.push(String(url));
    if (String(url).includes('GROUP=starlink')) return new Response(JSON.stringify([{ OBJECT_NAME: 'STARLINK-1' }, { OBJECT_NAME: 'STARLINK-2' }, { OBJECT_NAME: 'STARLINK-3', DECAY_DATE: '2026-10-01' }]));
    if (String(url).includes('GROUP=oneweb')) return new Response(JSON.stringify([{ OBJECT_NAME: 'ONEWEB-1' }]));
    return new Response(JSON.stringify([{ OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544, EPOCH: '2026-10-11T04:00:00', OWNER: 'ISS' }]));
  });
  const megaLists = () => calls.filter(url => url.includes('starlink') || url.includes('oneweb')).length;
  const first = await space({ now: NOW });
  assert.equal(first.status, 'active');
  assert.equal(megaLists(), 2, 'one catalogue read per constellation');
  assert.deepEqual([first.constellations.starlink, first.constellations.oneweb], [2, 1], 'decayed objects are not counted');
  assert.ok(calls.filter(url => url.includes('starlink')).every(url => url.includes('/satcat/')), 'the catalogue, not the GP mega-list');
  const before = calls.length;
  const cached = await space({ now: NOW + 30 * 60 * 1000 });
  assert.equal(cached.cached, true);
  assert.equal(cached.stale, undefined, 'within the planned interval the cached result is current, not stale');
  assert.equal(calls.length, before);
  resetSpace({ disk: false });
  const later = await space({ now: NOW + 3 * 3600000 });
  assert.equal(megaLists(), 2, 'the next 2-hour briefing reuses the day-old count');
  assert.equal(later.constellations.starlink, 2);
  resetSpace({ disk: false });
  await space({ now: NOW + 25 * 3600000 });
  assert.equal(megaLists(), 4, 'a day later the constellations are counted again');
});

test('CelesTrak space data: owners from the catalogue, ISS altitude from the mean motion, no false constellation zero', async t => {
  resetSpace();
  t.after(() => resetSpace());
  useFetch(t, async url => {
    const u = String(url);
    if (u.includes('/satcat/') && u.includes('GROUP=military')) return new Response(JSON.stringify([{ OBJECT_NAME: 'USA 1', OWNER: 'US' }, { OBJECT_NAME: 'YAOGAN 1', OWNER: 'PRC' }, { OBJECT_NAME: 'X', OWNER: '' }]));
    if (u.includes('/satcat/') && u.includes('GROUP=last-30-days')) return new Response(JSON.stringify([
      { OBJECT_NAME: 'OLDER', NORAD_CAT_ID: 1, OWNER: 'PRC', LAUNCH_DATE: '2026-09-20', APOGEE: 500, PERIGEE: 490, PERIOD: 94.6, INCLINATION: 97 },
      { OBJECT_NAME: 'NEWER', NORAD_CAT_ID: 2, OWNER: 'US', LAUNCH_DATE: '2026-10-09', APOGEE: 560, PERIGEE: 550, PERIOD: 95.6, INCLINATION: 53 },
    ]));
    if (u.includes('GROUP=stations')) return new Response(JSON.stringify([{ OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544, EPOCH: '2026-10-11T04:00:00', INCLINATION: 51.63, MEAN_MOTION: 15.4975, ECCENTRICITY: 0.0007 }]));
    return new Response('rate limited', { status: 403 });
  });
  const data = await space({ now: NOW });
  assert.deepEqual(data.militaryByCountry, { US: 1, PRC: 1, TBD: 1 });
  assert.deepEqual(data.launchByCountry, { US: 1, PRC: 1 });
  assert.deepEqual(data.recentLaunches.map(l => [l.name, l.country, l.apogee]), [['NEWER', 'US', 560], ['OLDER', 'PRC', 500]]);
  assert.ok(data.iss.apogee > 410 && data.iss.apogee < 430, `ISS apogee ${data.iss.apogee}`);
  assert.ok(data.iss.perigee > 400 && data.iss.perigee < 420, `ISS perigee ${data.iss.perigee}`);
  assert.ok(Math.abs(data.iss.period - 92.92) < 0.05, `ISS period ${data.iss.period}`);
  assert.deepEqual([data.constellations.starlink, data.constellations.oneweb], [null, null], 'a failed first count is unknown, not zero');
});

test('OpenSky 429 pause is remembered after a memory reset', async t => {
  resetOpenSky();
  t.after(() => resetOpenSky());
  delete process.env.OPENSKY_CLIENT_ID;
  delete process.env.OPENSKY_CLIENT_SECRET;
  const calls = [];
  useFetch(t, async url => {
    if (String(url) === TOKEN_URL) return new Response('no', { status: 500 });
    calls.push(String(url));
    return new Response('limit', { status: 429, headers: { 'X-Rate-Limit-Retry-After-Seconds': '3600' } });
  });
  await opensky({ now: NOW });
  assert.equal(calls.length, 1, 'one global state vector per round');
  resetOpenSky({ disk: false });
  const blocked = await opensky({ now: NOW + 30 * 60 * 1000 });
  assert.equal(calls.length, 1, 'no request after restart while blocked');
  assert.match(blocked.error, /credit limit reached/i);
});

test('ACLED: an expired ACLED_ACCESS_TOKEN is dropped after its 401 and never sent again; the password grant takes over (2.51.1)', async t => {
  resetAcled();
  t.after(() => resetAcled());
  const saved = { ACLED_EMAIL: process.env.ACLED_EMAIL, ACLED_PASSWORD: process.env.ACLED_PASSWORD, ACLED_ACCESS_TOKEN: process.env.ACLED_ACCESS_TOKEN, ACLED_REFRESH_TOKEN: process.env.ACLED_REFRESH_TOKEN };
  process.env.ACLED_EMAIL = 'user@example.com';
  process.env.ACLED_PASSWORD = 'secret';
  process.env.ACLED_ACCESS_TOKEN = 'expired-env-token';
  delete process.env.ACLED_REFRESH_TOKEN;
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const bearers = [];
  useFetch(t, async (url, init = {}) => {
    if (String(url).includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 86400 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const bearer = new Headers(init.headers).get('authorization');
    bearers.push(bearer);
    if (bearer === 'Bearer expired-env-token') {
      return new Response(JSON.stringify({ message: 'The resource owner or authorization server denied the request.' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    // An Open-tier account: authenticated, but no API access.
    return new Response(JSON.stringify({ message: 'Access denied' }), { status: 403, headers: { 'content-type': 'application/json' } });
  });
  const first = await acled();
  assert.deepEqual(bearers, ['Bearer expired-env-token', 'Bearer fresh-token'], 'retried once without the expired token');
  assert.equal(first.status, 'disabled', 'the account has no API access: disabled, not an error');
  assert.equal(first.error, undefined);
  // After a restart the expired token is still known: it is not sent again.
  resetAcled({ disk: false });
  bearers.length = 0;
  await acled({ now: Date.now() + 2 * 86400000 });
  assert.ok(!bearers.includes('Bearer expired-env-token'));
});
