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
  assert.equal(cached.stale, true);
  assert.equal(hits, 1);
  resetBls({ disk: false });
  const afterRestart = await bls(undefined, { now: NOW + 7 * 3600000 });
  assert.equal(afterRestart.stale, true);
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
  const saved = { ACLED_EMAIL: process.env.ACLED_EMAIL, ACLED_PASSWORD: process.env.ACLED_PASSWORD };
  process.env.ACLED_EMAIL = 'user@example.com';
  process.env.ACLED_PASSWORD = 'secret';
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
      headers: { 'content-type': 'text/html' },
    });
  });
  const data = await acled({ now: NOW });
  assert.match(data.error, /Cloudflare challenge/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /oauth\/token/);
  assert.equal(new URLSearchParams(calls[0].body).get('scope'), 'authenticated');
});

test('CelesTrak caches a good briefing for two hours and never pulls Starlink', async t => {
  resetSpace();
  t.after(() => resetSpace());
  const calls = [];
  useFetch(t, async url => {
    calls.push(String(url));
    return new Response(JSON.stringify([{ OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544, EPOCH: '2026-10-11T04:00:00' }]));
  });
  const first = await space({ now: NOW });
  assert.equal(first.status, 'active');
  assert.ok(calls.every(url => !url.includes('starlink') && !url.includes('oneweb')));
  const before = calls.length;
  const cached = await space({ now: NOW + 30 * 60 * 1000 });
  assert.equal(cached.stale, true);
  assert.equal(calls.length, before);
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
  assert.equal(calls.length, 10);
  resetOpenSky({ disk: false });
  const blocked = await opensky({ now: NOW + 30 * 60 * 1000 });
  assert.equal(calls.length, 10, 'no hotspot request after restart while blocked');
  assert.match(blocked.error, /credit limit reached/i);
});
