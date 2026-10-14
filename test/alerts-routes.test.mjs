import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHttpSecurity } from '../lib/http-security.mjs';
import { installAlertRoutes } from '../lib/alerts/routes.mjs';
import { AlertEngine, AlertError } from '../lib/alerts/engine.mjs';
import { RULE_KINDS } from '../lib/alerts/rules.mjs';

const T0 = Date.parse('2026-10-02T12:00:00Z');
const SWEEP = 15 * 60000;
const AUTH = { user: 'reader', password: 'test-password' };
const BASIC = `Basic ${Buffer.from('reader:test-password').toString('base64')}`;
const UNKNOWN_ID = `alert-${'0'.repeat(32)}`;
const quiet = { warn() {}, error() {}, log() {}, info() {} };

let counter = 0;
function ev(severity) {
  counter += 1;
  return {
    id: `event-${String(counter).padStart(32, '0')}`, kind: 'conflict', title: `Event ${counter}`, summary: '',
    source: { name: 'ACLED', url: null, hostname: null, status: 'ok' },
    observedAt: new Date(T0).toISOString(), publishedAt: null,
    location: { lat: null, lon: null, method: 'unknown', label: null, precision: 'unknown' },
    severity,
  };
}

const userRule = (overrides = {}) => ({ name: 'VIX above 40', kind: 'threshold', severity: 'high', params: { metric: 'vix', op: '>', value: 40 }, ...overrides });

// An engine with one firing critical and one firing high alert behind the real Basic auth, on a random port.
async function setup(t, { auth = AUTH, engine: custom, onChange, security } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-alert-routes-'));
  const clock = { now: T0 };
  const engine = custom ?? new AlertEngine(dir, { now: () => clock.now, logger: quiet });
  if (custom === undefined) {
    engine.load();
    engine.evaluate({ events: [] });
    clock.now += SWEEP;
    engine.evaluate({ events: [ev('critical'), ev('high')] });
  }
  const changes = [];
  const app = express();
  installHttpSecurity(app, auth);
  installAlertRoutes(app, {
    engine,
    getSnapshot: () => ({ markets: { vix: { value: 22 } } }),
    onChange: onChange ?? ((summary, newIds) => changes.push({ summary, newIds })),
    security,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = 'GET', body, headers = {}, credentials = true } = {}) => fetch(url + path, {
    method,
    body: body === undefined || typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    headers: { ...(credentials ? { Authorization: BASIC } : {}), ...headers },
  });
  // A same-origin JSON request, as the dashboard sends it.
  const send = (method, path, body = {}, headers = {}) => call(path, { method, body, headers: { 'Content-Type': 'application/json', Origin: url, ...headers } });
  const post = (path, body, headers) => send('POST', path, body, headers);
  const firing = custom === undefined ? engine.list() : [];
  return {
    url, engine, clock, changes, call, send, post,
    critical: firing.find(alert => alert.severity === 'critical'),
    high: firing.find(alert => alert.severity === 'high'),
  };
}

// A request with a Host header of our choosing (fetch always sends the real one), as a DNS-rebinding page would make it.
function raw(url, path, { method = 'POST', headers = {}, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url + path, { method, headers: { 'Content-Type': 'application/json', ...headers } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'], body: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function assertJsonError(response, status, code, field) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const body = await response.json();
  assert.equal(typeof body.error, 'string');
  if (code !== undefined) assert.equal(body.code, code);
  if (field !== undefined) assert.equal(body.field, field);
  return body;
}

test('every alert route requires the Basic credentials', async t => {
  const { call, critical } = await setup(t);
  const routes = [
    ['GET', '/api/alerts'], ['GET', '/api/alerts/summary'], ['GET', '/api/alerts/rules'],
    ['POST', `/api/alerts/${critical.id}/ack`], ['POST', `/api/alerts/${critical.id}/snooze`], ['POST', `/api/alerts/${critical.id}/resolve`],
    ['POST', '/api/alerts/ack-all'], ['PUT', '/api/alerts/rules/my-rule'], ['DELETE', '/api/alerts/rules/my-rule'],
  ];
  for (const [method, path] of routes) {
    const response = await call(path, { method, credentials: false, body: method === 'GET' ? undefined : {}, headers: { 'Content-Type': 'application/json' } });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test('GET routes return the agreed shapes without caching', async t => {
  const { call } = await setup(t);
  const list = await call('/api/alerts');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const body = await list.json();
  assert.deepEqual(Object.keys(body).sort(), ['alerts', 'counts', 'generatedAt', 'threat']);
  assert.equal(body.alerts.length, 2);
  assert.equal(body.counts.critical, 1);
  assert.equal(body.counts.high, 1);
  assert.equal(body.threat.level, 5);
  assert.equal(body.threat.drivers.length, 2);
  assert.equal(body.generatedAt, T0 + SWEEP);

  const summary = await call('/api/alerts/summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.headers.get('cache-control'), 'no-store');
  const data = await summary.json();
  for (const key of ['counts', 'threat', 'top', 'overflow', 'rules', 'status', 'generatedAt', 'lastEvaluatedAt']) assert.ok(Object.hasOwn(data, key), key);
  assert.equal(data.top.length, 2);

  const rules = await call('/api/alerts/rules');
  assert.equal(rules.status, 200);
  assert.equal(rules.headers.get('cache-control'), 'no-store');
  const catalog = await rules.json();
  assert.deepEqual(Object.keys(catalog).sort(), ['kinds', 'metrics', 'rules']);
  assert.deepEqual(catalog.kinds, [...RULE_KINDS]);
  assert.equal(catalog.rules.length, 9);
  assert.ok(catalog.rules.every(rule => rule.source === 'builtin'));
  const vix = catalog.metrics.find(metric => metric.key === 'vix');
  assert.deepEqual(Object.keys(vix).sort(), ['key', 'kind', 'label', 'unit', 'value']);
  assert.equal(vix.value, 22);
});

test('GET /api/alerts filters by state, severity, rule and limit and rejects anything else', async t => {
  const { call } = await setup(t);
  const only = async query => (await (await call(`/api/alerts?${query}`)).json()).alerts;
  assert.deepEqual((await only('severity=critical')).map(alert => alert.severity), ['critical']);
  assert.deepEqual((await only('rule=events-high')).map(alert => alert.ruleId), ['events-high']);
  assert.equal((await only('limit=1')).length, 1);
  assert.equal((await only('state=resolved')).length, 0);
  assert.equal((await only('state=all&severity=&rule=')).length, 2, 'an empty value is no filter');
  for (const query of ['limit=500', 'limit=0', 'limit=abc', 'limit=1.5', 'state=open', 'severity=extreme', 'rule=Bad_Rule', 'unknown=1', 'state=all&state=active', '__proto__=x']) {
    await assertJsonError(await call(`/api/alerts?${query}`), 400, 'INVALID_QUERY');
  }
  await assertJsonError(await call('/api/alerts/summary?x=1'), 400, 'INVALID_QUERY');
  await assertJsonError(await call('/api/alerts/rules?x=1'), 400, 'INVALID_QUERY');
});

test('a same-origin JSON ack changes the alert and reports the change', async t => {
  const { post, engine, critical, changes } = await setup(t);
  const response = await post(`/api/alerts/${critical.id}/ack`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.alert.id, critical.id);
  assert.equal(body.alert.state, 'acked');
  assert.equal(body.summary.threat.level, 4, 'the acknowledged critical no longer drives the level');
  assert.equal(engine.get(critical.id).state, 'acked');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].summary.threat.level, 4);
  assert.deepEqual(changes[0].newIds, []);
});

test('requests without Origin and Sec-Fetch-Site pass on their JSON Content-Type alone', async t => {
  const { call, engine, critical, high } = await setup(t);
  const plain = await call(`/api/alerts/${critical.id}/ack`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(plain.status, 200);
  assert.equal(engine.get(critical.id).state, 'acked');
  for (const site of ['same-origin', 'none']) {
    const response = await call(`/api/alerts/${high.id}/ack`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': site } });
    assert.equal(response.status, 200, site);
  }
});

test('a cross-site request with valid cached credentials is refused before it changes anything', async t => {
  const { post, send, call, engine, critical, changes } = await setup(t);
  const attempts = [
    { Origin: 'http://evil.example' },
    { Origin: 'null' },
    { Origin: 'http://127.0.0.1:1' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
  ];
  for (const headers of attempts) {
    for (const path of [`/api/alerts/${critical.id}/ack`, `/api/alerts/${critical.id}/resolve`, '/api/alerts/ack-all']) {
      await assertJsonError(await post(path, {}, headers), 403, 'CROSS_ORIGIN', null);
    }
    await assertJsonError(await send('PUT', '/api/alerts/rules/my-rule', userRule(), headers), 403, 'CROSS_ORIGIN');
    await assertJsonError(await send('DELETE', '/api/alerts/rules/vix-spike', {}, headers), 403, 'CROSS_ORIGIN');
  }
  assert.equal(engine.get(critical.id).state, 'firing');
  assert.equal(engine.rules().length, 9);
  assert.equal(changes.length, 0);
  // Same origin but a cross-site fetch context is still refused.
  const mixed = await call(`/api/alerts/${critical.id}/ack`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site', Origin: 'http://127.0.0.1' } });
  assert.equal(mixed.status, 403);
});

test('a body that is not JSON is refused with 415 before it changes anything', async t => {
  const { call, engine, critical, url } = await setup(t);
  const bodies = [
    { body: '{}', headers: { 'Content-Type': 'text/plain' } },
    { body: 'minutes=60', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    { body: '{}', headers: { 'Content-Type': 'multipart/form-data; boundary=x' } },
    { body: '{}', headers: { 'Content-Type': 'application/json-patch+json' } },
    { body: new TextEncoder().encode('{}'), headers: {} },
  ];
  for (const { body, headers } of bodies) {
    const response = await call(`/api/alerts/${critical.id}/ack`, { method: 'POST', body, headers: { Origin: url, ...headers } });
    await assertJsonError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', null);
  }
  await assertJsonError(await call('/api/alerts/rules/vix-spike', { method: 'DELETE' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(engine.get(critical.id).state, 'firing');
  assert.equal(engine.rules().length, 9);
});

test('an oversize body is 413 and malformed JSON is 400, both as JSON', async t => {
  const { post, engine, critical } = await setup(t);
  const big = JSON.stringify({ minutes: 60, reason: 'x'.repeat(9000) });
  await assertJsonError(await post(`/api/alerts/${critical.id}/snooze`, big), 413, 'BODY_TOO_LARGE', null);
  for (const body of ['{"minutes": 60', '{minutes: 60}', '"just a string"', '60', 'null']) {
    const response = await post(`/api/alerts/${critical.id}/snooze`, body);
    await assertJsonError(response, 400, undefined, undefined);
  }
  await assertJsonError(await post(`/api/alerts/${critical.id}/snooze`, '{"minutes": 60'), 400, 'INVALID_JSON', null);
  await assertJsonError(await post(`/api/alerts/${critical.id}/snooze`, [60]), 400, 'INVALID_BODY', 'body');
  assert.equal(engine.get(critical.id).state, 'firing');
});

test('alert ids are checked: bad format 400, unknown 404, resolved 400', async t => {
  const { post } = await setup(t);
  for (const id of ['bad', `alert-${'0'.repeat(31)}`, `alert-${'G'.repeat(32)}`, `event-${'0'.repeat(32)}`]) {
    await assertJsonError(await post(`/api/alerts/${id}/ack`), 400, 'INVALID_ID', 'id');
  }
  for (const action of ['ack', 'snooze', 'resolve']) {
    await assertJsonError(await post(`/api/alerts/${UNKNOWN_ID}/${action}`, action === 'snooze' ? { minutes: 60 } : {}), 404, 'NOT_FOUND', 'id');
  }
});

test('snooze takes 15 minutes to 7 days and an optional one-line reason', async t => {
  const { post, engine, critical } = await setup(t);
  for (const body of [{ minutes: 5 }, { minutes: 10081 }, { minutes: '60' }, { minutes: 60.5 }, {}, { minutes: 60, reason: 'line\nbreak' }, { minutes: 60, reason: 'x'.repeat(121) }]) {
    await assertJsonError(await post(`/api/alerts/${critical.id}/snooze`, body), 400, 'INVALID_SNOOZE');
  }
  await assertJsonError(await post(`/api/alerts/${critical.id}/snooze`, { minutes: 60, until: 1 }), 400, 'INVALID_BODY', 'until');
  assert.equal(engine.get(critical.id).state, 'firing');
  const response = await post(`/api/alerts/${critical.id}/snooze`, { minutes: 60, reason: 'Maintenance' });
  assert.equal(response.status, 200);
  const { alert } = await response.json();
  assert.equal(alert.state, 'snoozed');
  assert.equal(alert.snooze.until, T0 + SWEEP + 60 * 60000);
  assert.equal(alert.snooze.reason, 'Maintenance');
});

test('resolve closes an alert once; ack and resolve take no body fields', async t => {
  const { post, engine, critical } = await setup(t);
  await assertJsonError(await post(`/api/alerts/${critical.id}/ack`, { note: 'x' }), 400, 'INVALID_BODY', 'note');
  const response = await post(`/api/alerts/${critical.id}/resolve`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).alert.state, 'resolved');
  assert.equal(engine.get(critical.id).state, 'resolved');
  await assertJsonError(await post(`/api/alerts/${critical.id}/resolve`), 400, 'INVALID_STATE', 'id');
});

test('ack-all acknowledges every firing alert or one severity', async t => {
  const one = await setup(t);
  await assertJsonError(await one.post('/api/alerts/ack-all', { severity: 'extreme' }), 400, 'INVALID_STATE', 'severity');
  await assertJsonError(await one.post('/api/alerts/ack-all', { level: 'high' }), 400, 'INVALID_BODY', 'level');
  const high = await one.post('/api/alerts/ack-all', { severity: 'high' });
  assert.equal(high.status, 200);
  const body = await high.json();
  assert.deepEqual(body.alerts.map(alert => alert.id), [one.high.id]);
  assert.equal(body.summary.counts.high, 0);
  assert.equal(body.summary.counts.critical, 1);
  assert.equal(one.engine.get(one.critical.id).state, 'firing');

  const all = await setup(t);
  const response = await all.post('/api/alerts/ack-all');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).alerts.length, 2);
  assert.equal(all.engine.list().filter(alert => alert.state === 'acked').length, 2);
  assert.equal(all.changes.length, 1);
});

test('PUT creates and replaces user rules, takes the id from the path and ignores source', async t => {
  const { send, call, engine, changes } = await setup(t);
  const created = await send('PUT', '/api/alerts/rules/vix-forty', userRule({ source: 'user' }));
  assert.equal(created.status, 200);
  const { rule, summary } = await created.json();
  assert.equal(rule.id, 'vix-forty');
  assert.equal(rule.source, 'user');
  assert.equal(summary.rules.total, 10);
  assert.equal(changes.length, 1);
  // A rule exactly as GET returned it can be sent back.
  const listed = (await (await call('/api/alerts/rules')).json()).rules.find(item => item.id === 'vix-forty');
  const replaced = await send('PUT', '/api/alerts/rules/vix-forty', { ...listed, name: 'VIX above 45', params: { ...listed.params, value: 45 } });
  assert.equal(replaced.status, 200);
  assert.equal((await replaced.json()).rule.params.value, 45);
  assert.equal(engine.rules().length, 10);
  await assertJsonError(await send('PUT', '/api/alerts/rules/vix-forty', userRule({ id: 'other-id' })), 400, 'INVALID_RULE', 'id');
  await assertJsonError(await send('PUT', '/api/alerts/rules/Bad_Id', userRule()), 400, 'INVALID_RULE', 'id');
  // "constructor" and "prototype" are ordinary rule ids.
  for (const id of ['constructor', 'prototype']) {
    const response = await send('PUT', `/api/alerts/rules/${id}`, userRule());
    assert.equal(response.status, 200, id);
    assert.equal((await response.json()).rule.id, id);
  }
});

test('PUT on a built-in sets a complete override and the GET body round-trips', async t => {
  const { send, call, engine } = await setup(t);
  const builtin = (await (await call('/api/alerts/rules')).json()).rules.find(item => item.id === 'events-high');
  const response = await send('PUT', '/api/alerts/rules/events-high', { ...builtin, notify: false, params: { minLevel: 'high', maxLevel: 'high' } });
  assert.equal(response.status, 200);
  const { rule } = await response.json();
  assert.equal(rule.source, 'override');
  assert.equal(rule.notify, false);
  assert.deepEqual(rule.params, { minLevel: 'high', maxLevel: 'high' });
  await assertJsonError(await send('PUT', '/api/alerts/rules/events-high', { kind: 'threshold' }), 400, 'INVALID_RULE', 'kind');
  await assertJsonError(await send('PUT', '/api/alerts/rules/events-high', { params: { minLevel: 'critical', maxLevel: 'high' } }), 400, 'INVALID_RULE');
  assert.equal(engine.rules().find(item => item.id === 'events-high').notify, false, 'a refused override leaves the last one');
});

test('hostile rule input is refused with a field and changes nothing', async t => {
  const { send, engine, changes } = await setup(t);
  const hostile = [
    ['{"__proto__": {"polluted": true}, "name": "x", "kind": "threshold", "params": {"metric": "vix", "op": ">", "value": 1}}', '__proto__'],
    [JSON.stringify(userRule({ extra: 1 })), 'extra'],
    [JSON.stringify(userRule({ '<img src=x onerror=alert(1)>': 1 })), undefined],
    ['{"name": "x", "kind": "threshold", "params": {"metric": "vix", "op": ">", "value": 1e999}}', 'params.value'],
    [JSON.stringify(userRule({ name: 42 })), 'name'],
    [JSON.stringify(userRule({ forSweeps: 11 })), 'forSweeps'],
    [JSON.stringify(userRule({ params: { metric: 'nope', op: '>', value: 1 } })), 'params.metric'],
    [JSON.stringify({ name: 'Keywords', kind: 'event', params: { minLevel: 'high' }, scope: { keywords: Array.from({ length: 1500 }, () => 'x') } }), 'scope.keywords'],
    ['[]', 'rule'],
  ];
  for (const [body, field] of hostile) {
    const error = await assertJsonError(await send('PUT', '/api/alerts/rules/hostile', body), 400, 'INVALID_RULE', field);
    assert.match(String(error.field), /^[A-Za-z0-9_.[\]?-]+$/, 'the field is never echoed raw');
  }
  assert.equal({}.polluted, undefined);
  assert.equal(engine.rules().length, 9);
  assert.equal(changes.length, 0);
  // A regex-looking keyword is plain text and stored verbatim.
  const keywords = await send('PUT', '/api/alerts/rules/odd-keywords', { name: 'Odd', kind: 'event', params: { minLevel: 'high' }, scope: { keywords: ['(a+)+$', '.*'] } });
  assert.equal(keywords.status, 200);
  assert.deepEqual((await keywords.json()).rule.scope.keywords, ['(a+)+$', '.*']);
});

test('the 51st user rule is refused', async t => {
  const { send, engine } = await setup(t);
  for (let i = 0; i < 50; i += 1) assert.equal((await send('PUT', `/api/alerts/rules/rule-${i}`, userRule())).status, 200);
  await assertJsonError(await send('PUT', '/api/alerts/rules/rule-50', userRule()), 400, 'INVALID_STATE', 'id');
  assert.equal(engine.rules().length, 59);
  assert.equal((await send('PUT', '/api/alerts/rules/rule-0', userRule({ name: 'Replaced' }))).status, 200, 'replacing an existing one still works');
});

test('DELETE removes user rules and resets overrides but never deletes a built-in', async t => {
  const { send, engine } = await setup(t);
  await assertJsonError(await send('DELETE', '/api/alerts/rules/vix-spike'), 400, 'INVALID_STATE', 'id');
  await assertJsonError(await send('DELETE', '/api/alerts/rules/no-such-rule'), 404, 'NOT_FOUND', 'id');
  await assertJsonError(await send('DELETE', '/api/alerts/rules/Bad_Id'), 400, 'INVALID_RULE', 'id');
  assert.equal((await send('PUT', '/api/alerts/rules/mine', userRule())).status, 200);
  const deleted = await send('DELETE', '/api/alerts/rules/mine');
  assert.equal(deleted.status, 200);
  const body = await deleted.json();
  assert.equal(body.deleted, 'mine');
  assert.equal(body.summary.rules.total, 9);
  assert.equal((await send('PUT', '/api/alerts/rules/vix-spike', { enabled: false })).status, 200);
  assert.equal((await send('DELETE', '/api/alerts/rules/vix-spike')).status, 200);
  assert.equal(engine.rules().find(rule => rule.id === 'vix-spike').source, 'builtin');
});

test('a failing engine answers 503 JSON without details and a failing listener does not fail the request', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const broken = new Proxy({}, { get: () => () => { throw new Error('disk exploded at C:\\secret\\alerts.json'); } });
  const { call, post } = await setup(t, { engine: broken });
  for (const response of [await call('/api/alerts'), await call('/api/alerts/summary'), await call('/api/alerts/rules'), await post(`/api/alerts/${UNKNOWN_ID}/ack`)]) {
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: 'Alerts temporarily unavailable' });
    assert.ok(!text.includes('secret') && !text.includes(' at '));
  }
  assert.ok(logged.mock.callCount() >= 4);

  const listening = await setup(t, { onChange: () => { throw new Error('broadcast failed'); } });
  const response = await listening.post(`/api/alerts/${listening.critical.id}/ack`);
  assert.equal(response.status, 200);
  assert.equal(listening.engine.get(listening.critical.id).state, 'acked');
});

test('an AlertError keeps its status and code, and its field and message are echoed only as safe text', async t => {
  const engine = {
    summary: () => ({}),
    ackAll: () => { throw new AlertError(400, 'INVALID_STATE', 'bad <b>value</b>\u2028injected', '<img src=x onerror=alert(1)>'); },
  };
  const { post } = await setup(t, { engine });
  const body = await assertJsonError(await post('/api/alerts/ack-all', {}), 400, 'INVALID_STATE', '?img?src?x?onerror?alert?1??');
  assert.ok(!body.error.includes('\u2028'));
});

test('without configured credentials the guard still applies', async t => {
  const { call, post, critical, url } = await setup(t, { auth: {} });
  assert.equal((await call('/api/alerts/summary', { credentials: false })).status, 200);
  await assertJsonError(await post(`/api/alerts/${critical.id}/ack`, {}, { Origin: 'http://evil.example' }), 403, 'CROSS_ORIGIN');
  assert.equal((await call(`/api/alerts/${critical.id}/ack`, { method: 'POST', body: '{}', credentials: false, headers: { Origin: url, 'Content-Type': 'text/plain' } })).status, 415);
});

// ─── DNS rebinding, reverse proxies and the origin leniency ─────────────────────

test('DNS rebinding: without credentials configured, a change through a foreign host name is refused even from its own origin', async t => {
  const { url, engine, critical, changes } = await setup(t, { auth: {} });
  const port = new URL(url).port;
  for (const host of [`attacker.example:${port}`, 'attacker.example', `localhost.attacker.example:${port}`, `127.0.0.1.nip.io:${port}`, `xn--80ak6aa92e.com:${port}`]) {
    for (const headers of [{ Host: host, Origin: `http://${host}` }, { Host: host }]) {
      const response = await raw(url, `/api/alerts/${critical.id}/ack`, { headers });
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.match(response.type, /^application\/json/);
      assert.deepEqual([response.body.code, response.body.field, typeof response.body.error], ['HOST_NOT_ALLOWED', null, 'string']);
    }
  }
  const disable = await raw(url, '/api/alerts/rules/events-critical', { method: 'PUT', body: '{"enabled":false}', headers: { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}` } });
  assert.equal(disable.status, 403);
  assert.equal(disable.body.code, 'HOST_NOT_ALLOWED');
  assert.equal(engine.get(critical.id).state, 'firing');
  assert.equal(engine.rules().find(rule => rule.id === 'events-critical').enabled, true, 'the rule stays on');
  assert.equal(changes.length, 0);
  // The other refusals keep their order and codes: a wrong body type is still 415, a foreign origin still CROSS_ORIGIN.
  assert.equal((await raw(url, '/api/alerts/ack-all', { headers: { Host: 'attacker.example', 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await raw(url, '/api/alerts/ack-all', { headers: { Host: 'attacker.example', Origin: 'http://evil.example' } })).body.code, 'CROSS_ORIGIN');
});

test('without credentials configured, IP addresses, localhost, *.localhost, the ALERT_PUBLIC_URL host and ALERT_ALLOWED_HOSTS may change alerts', async t => {
  const { url, engine } = await setup(t, { auth: {}, security: { publicUrl: 'https://dash.example.test/crucix', allowedHosts: ['crucix.lan'] } });
  const port = new URL(url).port;
  const hosts = ['localhost', `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, '[::1]', `app.localhost:${port}`, `192.168.1.20:${port}`, '[fe80::1]',
    `[::ffff:127.0.0.1]:${port}`, 'dash.example.test', `crucix.lan:${port}`, 'CRUCIX.LAN'];
  for (const host of hosts) {
    // A browser sends the origin lower-cased.
    for (const headers of [{ Host: host, Origin: `http://${host.toLowerCase()}` }, { Host: host }]) {
      assert.equal((await raw(url, '/api/alerts/ack-all', { headers })).status, 200, JSON.stringify(headers));
    }
  }
  assert.equal(engine.list().filter(alert => alert.state === 'acked').length, 2);
  for (const host of ['dash.example.test.evil.example', 'lan', 'crucix.lan.evil.example', 'example.test', '[::1', '127.0.0.1:99999x', 'a b', 'x@127.0.0.1']) {
    assert.equal((await raw(url, '/api/alerts/ack-all', { headers: { Host: host } })).status, 403, host);
  }
});

test('with credentials configured the host check is skipped: a rebound origin carries no credentials', async t => {
  const { url } = await setup(t);
  const port = new URL(url).port;
  const headers = { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}` };
  assert.equal((await raw(url, '/api/alerts/ack-all', { headers })).status, 401, 'no credentials, no change');
  assert.equal((await raw(url, '/api/alerts/ack-all', { headers: { ...headers, Authorization: BASIC } })).status, 200);
});

test('the origin may be the https form of the same host or the ALERT_PUBLIC_URL origin, nothing else', async t => {
  const { url, post } = await setup(t, { security: { publicUrl: 'https://dash.example.test:8443/crucix' } });
  const host = new URL(url).host;
  for (const origin of [url, `https://${host}`, 'https://dash.example.test:8443']) {
    assert.equal((await post('/api/alerts/ack-all', {}, { Origin: origin })).status, 200, origin);
  }
  for (const origin of ['https://other.example', `https://${host}.evil.example`, `https://${new URL(url).hostname}`, 'http://dash.example.test:8443', 'https://dash.example.test',
    'https://dash.example.test:8443.evil.example', 'https://dash.example.test:8443/crucix']) {
    await assertJsonError(await post('/api/alerts/ack-all', {}, { Origin: origin }), 403, 'CROSS_ORIGIN', null);
  }
  // Without ALERT_PUBLIC_URL that origin is a foreign one.
  const plain = await setup(t);
  await assertJsonError(await plain.post('/api/alerts/ack-all', {}, { Origin: 'https://dash.example.test:8443' }), 403, 'CROSS_ORIGIN');
});

test('behind a reverse proxy that rewrites Host, the ALERT_PUBLIC_URL origin still changes alerts without credentials', async t => {
  const { url } = await setup(t, { auth: {}, security: { publicUrl: 'https://crucix.example.com' } });
  const proxied = { Host: `127.0.0.1:${new URL(url).port}`, Origin: 'https://crucix.example.com', 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await raw(url, '/api/alerts/ack-all', { headers: proxied })).status, 200);
  const preserved = { Host: 'crucix.example.com', Origin: 'https://crucix.example.com', 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await raw(url, '/api/alerts/ack-all', { headers: preserved })).status, 200, 'a proxy that keeps Host works too');
});

// ─── Express's own errors ────────────────────────────────────────────────────────

test('a path that cannot be decoded is a JSON 400 without a stack, logged as one line', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const { post, send, call, engine } = await setup(t);
  const responses = [await post('/api/alerts/%E0%A4%A/ack'), await send('PUT', '/api/alerts/rules/%E0%A4%A', userRule()), await send('DELETE', '/api/alerts/rules/%zz')];
  for (const response of responses) {
    const text = await response.text();
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(JSON.parse(text), { error: 'Invalid request', code: 'INVALID_REQUEST', field: null });
  }
  assert.equal(engine.rules().length, 9);
  assert.equal(logged.mock.callCount(), 3);
  for (const { arguments: args } of logged.mock.calls) {
    const line = args.map(String).join(' ');
    assert.ok(!line.includes('\n') && !/\bat\s/.test(line), line);
    assert.match(line, /^\[Alerts\] /);
  }
  // Other paths keep their own handling.
  assert.equal((await call('/api/alerts/summary')).status, 200);
});
