import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertEngine, AlertError } from '../lib/alerts/engine.mjs';

const T0 = Date.parse('2026-10-02T12:00:00Z');
const MINUTE = 60000;
const SWEEP = 15 * MINUTE;
const YEAR = 365 * 24 * 60 * MINUTE;
const ALERT_ID = /^alert-[0-9a-f]{32}$/;

function recorder() {
  const lines = [];
  const push = (...parts) => lines.push(parts.join(' '));
  return { lines, warn: push, error: push, log: push, info: push };
}

// An engine over a fresh tmp dir with a hand-driven clock. `warm` runs the bootstrap sweep on an empty snapshot,
// so later alerts are not silent.
function setup(t, { warm = true, config, dir } = {}) {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'crucix-alert-engine-'));
  if (!dir) t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = { now: T0 };
  const logger = recorder();
  const engine = new AlertEngine(root, { now: () => clock.now, logger, config });
  engine.load();
  if (warm) engine.evaluate({ events: [] });
  const sweep = (snapshot = {}, options) => { clock.now += SWEEP; return engine.evaluate({ events: [], ...snapshot }, options); };
  return { dir: root, clock, logger, engine, sweep };
}

let counter = 0;
function ev(overrides = {}) {
  counter += 1;
  return {
    id: `event-${String(counter).padStart(32, '0')}`, kind: 'conflict', title: `Event ${counter}`, summary: '',
    source: { name: 'ACLED', url: null, hostname: null, status: 'ok' },
    observedAt: new Date(T0).toISOString(), publishedAt: null,
    location: { lat: null, lon: null, method: 'unknown', label: null, precision: 'unknown' },
    severity: 'critical', ...overrides,
  };
}

const ofRule = (engine, ruleId, state = 'all') => engine.list({ state, rule: ruleId });
const vix = value => ({ markets: { vix: { value } } });

function assertAlertError(fn, { status, code, field }) {
  assert.throws(fn, error => {
    assert.ok(error instanceof AlertError, String(error));
    assert.equal(error.status, status);
    if (code !== undefined) assert.equal(error.code, code);
    if (field !== undefined) assert.equal(error.field, field);
    return true;
  });
}

const watchRule = { name: 'Everything from watch up', kind: 'event', severity: 'auto', notify: true, params: { minLevel: 'watch' } };

// ─── hysteresis, dedupe, escalation ──────────────────────────────────────────

test('a threshold hit opens an alert only after forSweeps consecutive sweeps', t => {
  const { engine, sweep } = setup(t);
  assert.equal(sweep(vix(35)).created.length, 0, 'vix-spike needs two sweeps');
  const second = sweep(vix(36));
  assert.deepEqual(second.created.map(alert => alert.ruleId), ['vix-spike']);
  const [alert] = second.created;
  assert.match(alert.id, ALERT_ID);
  assert.equal(alert.state, 'firing');
  assert.equal(alert.severity, 'high');
  assert.equal(alert.notify, true);
  assert.equal(alert.silent, false);
  assert.equal(alert.kind, 'threshold');
  assert.deepEqual(alert.metric, { key: 'vix', value: 36, threshold: 30 });
  assert.equal(engine.get(alert.id).id, alert.id);
});

test('the pending counter needs consecutive sweeps: one quiet sweep starts it again', t => {
  const { engine, sweep } = setup(t);
  engine.putRule('slow', { ...watchRule, forSweeps: 3 });
  const event = ev({ severity: 'moderate' });
  sweep({ events: [event] });
  sweep({ events: [event] });
  sweep({ events: [] });
  sweep({ events: [event] });
  assert.equal(sweep({ events: [event] }).created.length, 0);
  assert.deepEqual(sweep({ events: [event] }).created.map(alert => alert.ruleId), ['slow']);
});

test('dedupe: the same hit twice is one alert with count 2, and the title is not refreshed', t => {
  const { engine, sweep } = setup(t);
  const event = ev({ title: 'Original title' });
  const first = sweep({ events: [event] });
  assert.equal(first.created.length, 1);
  const second = sweep({ events: [{ ...event, title: 'Changed title' }] });
  assert.equal(second.created.length, 0);
  const alerts = ofRule(engine, 'events-critical');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].count, 2);
  assert.equal(alerts[0].title, 'Original title');
  assert.equal(alerts[0].lastSeenAt, T0 + 2 * SWEEP);
  assert.equal(alerts[0].firstSeenAt, T0 + SWEEP);
});

test('escalation: a more severe hit un-acks and un-snoozes, clears the notification and is reported', t => {
  const { engine, sweep } = setup(t);
  engine.putRule('wide', watchRule);
  const quietEvent = ev({ severity: 'moderate' });
  const loudEvent = ev({ severity: 'moderate' });
  sweep({ events: [quietEvent, loudEvent] });
  const [a, b] = ofRule(engine, 'wide');
  engine.ack(a.id);
  engine.snooze(b.id, 60, 'later');
  engine.markNotified(a.id, ['telegram']);

  const result = sweep({ events: [{ ...quietEvent, severity: 'high' }, { ...loudEvent, severity: 'elevated' }] });
  assert.deepEqual(result.escalated.map(alert => alert.id).sort(), [a.id, b.id].sort());
  for (const id of [a.id, b.id]) {
    const alert = engine.get(id);
    assert.equal(alert.state, 'firing');
    assert.equal(alert.severity, 'high');
    assert.equal('ack' in alert, false);
    assert.equal('snooze' in alert, false);
    assert.equal('notified' in alert, false);
    assert.ok(alert.log.some(entry => entry.action === 'escalated'));
  }
  assert.equal(result.created.filter(alert => alert.ruleId === 'wide').length, 0);

  const calmer = sweep({ events: [{ ...quietEvent, severity: 'moderate' }, loudEvent] });
  assert.equal(calmer.escalated.length, 0, 'a lower severity is not a de-escalation');
  assert.equal(engine.get(a.id).severity, 'high');
});

// ─── resolve, cooldown ───────────────────────────────────────────────────────

test('an alert resolves after two missed sweeps, not after one', t => {
  const { engine, sweep } = setup(t);
  const event = ev();
  const [alert] = sweep({ events: [event] }).created;
  assert.equal(sweep().resolved.length, 0);
  assert.equal(engine.get(alert.id).state, 'firing');
  sweep({ events: [event] });
  assert.equal(sweep().resolved.length, 0, 'a hit in between resets the miss counter');
  const result = sweep();
  assert.deepEqual(result.resolved.map(item => item.id), [alert.id]);
  const resolved = engine.get(alert.id);
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.resolvedAt, T0 + 5 * SWEEP);
  assert.ok(resolved.log.some(entry => entry.action === 'resolved'));
});

test('cooldown: a resolved alert does not reopen within 30 minutes, and reopens as a new alert after', t => {
  const { engine, sweep, clock } = setup(t);
  const event = ev();
  const [first] = sweep({ events: [event] }).created;
  sweep();
  sweep();
  const resolvedAt = engine.get(first.id).resolvedAt;
  clock.now = resolvedAt + 29 * MINUTE - SWEEP;
  assert.equal(sweep({ events: [event] }).created.length, 0, 'inside the cooldown');
  clock.now = resolvedAt + 30 * MINUTE - SWEEP;
  const reopened = sweep({ events: [event] }).created;
  assert.equal(reopened.length, 1);
  assert.notEqual(reopened[0].id, first.id);
  assert.match(reopened[0].id, ALERT_ID);
  assert.equal(engine.get(first.id).state, 'resolved');
});

test('a manual resolve with a persisting condition reopens after the cooldown', t => {
  const { engine, sweep } = setup(t);
  const event = ev();
  const [alert] = sweep({ events: [event] }).created;
  const resolved = engine.resolve(alert.id);
  assert.equal(resolved.state, 'resolved');
  assert.ok(resolved.log.some(entry => entry.action === 'resolved' && /manual/.test(entry.note)));
  assertAlertError(() => engine.resolve(alert.id), { status: 400, code: 'INVALID_STATE' });
  assert.equal(sweep({ events: [event] }).created.length, 0, '15 minutes later: still cooling down');
  const reopened = sweep({ events: [event] }).created;
  assert.equal(reopened.length, 1, 'reopened 30 minutes after the manual resolve');
  assert.notEqual(reopened[0].id, alert.id);
});

// ─── ack, snooze ─────────────────────────────────────────────────────────────

test('ack and snooze validate their input and the alert', t => {
  const { engine, sweep } = setup(t);
  const [alert] = sweep({ events: [ev()] }).created;
  assertAlertError(() => engine.ack('alert-00000000000000000000000000000000'), { status: 404, code: 'NOT_FOUND' });
  assertAlertError(() => engine.snooze(alert.id, 14), { status: 400, code: 'INVALID_SNOOZE', field: 'minutes' });
  assertAlertError(() => engine.snooze(alert.id, 10081), { status: 400, code: 'INVALID_SNOOZE', field: 'minutes' });
  assertAlertError(() => engine.snooze(alert.id, 30.5), { status: 400, code: 'INVALID_SNOOZE', field: 'minutes' });
  assertAlertError(() => engine.snooze(alert.id, '30'), { status: 400, code: 'INVALID_SNOOZE', field: 'minutes' });
  assertAlertError(() => engine.snooze(alert.id, 30, 'x'.repeat(121)), { status: 400, code: 'INVALID_SNOOZE', field: 'reason' });
  assertAlertError(() => engine.snooze(alert.id, 30, 'bad\nreason'), { status: 400, code: 'INVALID_SNOOZE', field: 'reason' });
  assertAlertError(() => engine.snooze(alert.id, 30, 42), { status: 400, code: 'INVALID_SNOOZE', field: 'reason' });
  assert.equal(engine.get(alert.id).state, 'firing', 'a rejected snooze changes nothing');

  const snoozed = engine.snooze(alert.id, 10080, 'x'.repeat(120));
  assert.equal(snoozed.state, 'snoozed');
  assert.equal(snoozed.snooze.until, T0 + SWEEP + 10080 * MINUTE);
  assert.equal(snoozed.snooze.reason.length, 120);
  assert.equal(engine.snooze(alert.id, 15).snooze.until, T0 + SWEEP + 15 * MINUTE);
  assert.equal('reason' in engine.snooze(alert.id, 15, '   ').snooze, false);

  const acked = engine.ack(alert.id);
  assert.equal(acked.state, 'acked');
  assert.equal(acked.ack.at, T0 + SWEEP);
  assert.equal('snooze' in acked, false);
  const again = engine.ack(alert.id);
  assert.equal(again.state, 'acked');
  assert.deepEqual(again.log, acked.log, 'ack is idempotent: no second log entry');
  engine.resolve(alert.id);
  assertAlertError(() => engine.ack(alert.id), { status: 400, code: 'INVALID_STATE' });
  assertAlertError(() => engine.snooze(alert.id, 30), { status: 400, code: 'INVALID_STATE' });
  acked.state = 'firing';
  assert.equal(engine.get(alert.id).state, 'resolved', 'returned alerts are copies');
});

test('snooze expiry returns to firing while the hit persists', t => {
  const { engine, clock, sweep } = setup(t);
  const event = ev();
  const [alert] = sweep({ events: [event] }).created;
  engine.snooze(alert.id, 15);
  clock.now += 14 * MINUTE;
  assert.equal(engine.evaluate({ events: [event] }).summary.counts.snoozed, 1, 'a minute before the deadline');
  clock.now += MINUTE;
  const result = engine.evaluate({ events: [event] });
  assert.equal(result.summary.counts.snoozed, 0, 'at the deadline');
  assert.equal(result.summary.counts.critical, 1);
  assert.equal(engine.get(alert.id).state, 'firing');
  assert.equal('snooze' in engine.get(alert.id), false);
  assert.ok(engine.get(alert.id).log.some(entry => entry.action === 'unsnoozed'));
});

test('snooze expiry resolves the alert when the hit is gone, without waiting for a second miss', t => {
  const { engine, sweep } = setup(t);
  const event = ev();
  const [alert] = sweep({ events: [event] }).created;
  engine.snooze(alert.id, 20);
  sweep({ events: [event] });
  assert.equal(engine.get(alert.id).state, 'snoozed', 'deadline not reached');
  const result = sweep();
  assert.equal(engine.get(alert.id).state, 'resolved', 'past the deadline with the hit gone');
  assert.deepEqual(result.resolved.map(item => item.id), [alert.id]);
  assert.ok(engine.get(alert.id).log.some(entry => entry.action === 'resolved' && /snooze/.test(entry.note)));
});

test('summary() applies a due snooze expiry between sweeps and saves only when something changed', t => {
  const { engine, sweep, clock, dir } = setup(t);
  const kept = ev();
  const gone = ev();
  const [a, b] = sweep({ events: [kept, gone] }).created;
  engine.snooze(a.id, 20);
  engine.snooze(b.id, 20);
  sweep({ events: [kept] });
  const file = join(dir, 'alerts', 'alerts.json');
  const before = readFileSync(file, 'utf8');
  engine.summary();
  assert.equal(readFileSync(file, 'utf8'), before, 'nothing due, nothing written');
  clock.now += 6 * MINUTE;
  const summary = engine.summary();
  assert.equal(engine.get(a.id).state, 'firing', 'hit at the last sweep: back to firing');
  assert.equal(engine.get(b.id).state, 'resolved', 'missed at the last sweep: resolved');
  assert.equal(summary.counts.snoozed, 0);
  assert.notEqual(readFileSync(file, 'utf8'), before, 'the change was saved');
});

test('ackAll({severity}) acknowledges only firing alerts of that severity', t => {
  const { engine, sweep } = setup(t);
  engine.putRule('wide', watchRule);
  sweep({ events: [ev({ severity: 'moderate' }), ev({ severity: 'moderate' }), ev({ severity: 'high' })] });
  const acked = engine.ackAll({ severity: 'watch' });
  assert.equal(acked.length, 2);
  assert.ok(acked.every(alert => alert.severity === 'watch' && alert.state === 'acked'));
  const rest = engine.list({ state: 'active' }).filter(alert => alert.severity !== 'watch');
  assert.ok(rest.length >= 1);
  assert.ok(rest.every(alert => alert.state === 'firing'));
  assert.equal(engine.ackAll({ severity: 'watch' }).length, 0, 'nothing left to acknowledge');
  assertAlertError(() => engine.ackAll({ severity: 'extreme' }), { status: 400, field: 'severity' });
  assert.equal(engine.ackAll().length, rest.length);
  assert.equal(engine.summary().counts.acked, 2 + rest.length);
});

test('per-rule cap: 60 hits of one rule give 50 alerts, the most severe first', t => {
  const { engine, sweep, logger } = setup(t);
  engine.putRule('wide', watchRule);
  const events = [...Array.from({ length: 55 }, () => ev({ severity: 'moderate' })), ...Array.from({ length: 5 }, () => ev({ severity: 'high' }))];
  sweep({ events });
  const alerts = ofRule(engine, 'wide');
  assert.equal(alerts.length, 50);
  assert.equal(alerts.filter(alert => alert.severity === 'high').length, 5);
  assert.ok(logger.lines.some(line => line.includes('wide') && line.includes('10')), logger.lines.join('\n'));
  // A freed slot is filled on the next sweep.
  engine.resolve(alerts.find(alert => alert.severity === 'watch').id);
  sweep({ events });
  assert.equal(ofRule(engine, 'wide', 'active').length, 50);
  assert.equal(ofRule(engine, 'wide', 'all').length, 51);
});

test('maxActivePerRule comes from the config', t => {
  const { engine, sweep } = setup(t, { config: { maxActivePerRule: 3 } });
  sweep({ events: Array.from({ length: 5 }, () => ev()) });
  assert.equal(ofRule(engine, 'events-critical').length, 3);
});

// ─── bootstrap, restart ──────────────────────────────────────────────────────

test('bootstrap past the per-rule cap: hits held back at bootstrap open silent later, new ones do not', t => {
  const { engine, sweep } = setup(t, { warm: false });
  const events = Array.from({ length: 60 }, () => ev());
  const first = engine.evaluate({ events });
  assert.equal(first.created.length, 50);
  assert.ok(first.created.every(alert => alert.silent));
  assert.deepEqual(first.summary.overflow, [{ ruleId: 'events-critical', count: 10 }]);

  const gone = new Set(first.created.slice(0, 5).map(alert => alert.dedupKey));
  const remaining = events.filter(event => !gone.has(`events-critical|${event.id}`));
  assert.equal(sweep({ events: remaining }).created.length, 0);
  const freed = sweep({ events: remaining });
  assert.equal(freed.resolved.length, 5);
  assert.equal(freed.silent, false);
  assert.equal(freed.created.length, 5, 'five held-back hits fill the freed slots');
  for (const alert of freed.created) {
    assert.equal(alert.silent, true, 'present at bootstrap: still the baseline');
    assert.ok(alert.log.some(entry => entry.action === 'silent'));
  }
  assert.deepEqual(freed.summary.overflow, [{ ruleId: 'events-critical', count: 5 }]);

  // Free every slot: a brand-new event is not part of the baseline.
  engine.putRule('events-critical', { enabled: false });
  engine.deleteRule('events-critical');
  const later = sweep({ events: [ev()] });
  assert.deepEqual(later.created.map(alert => alert.silent), [false]);
});

test('bootstrap at scale: with several broad rules over many events, every later open of a bootstrap event is silent', t => {
  const { engine, sweep, dir } = setup(t, { warm: false, config: { maxActivePerRule: 5, maxAlerts: 100 } });
  for (let n = 0; n < 3; n += 1) engine.putRule(`broad-${n}`, watchRule);
  let events = Array.from({ length: 60 }, () => ev());
  const first = engine.evaluate({ events });
  assert.equal(first.created.length, 20, 'events-critical and three broad rules, five each');
  const baseline = Object.keys(JSON.parse(readFileSync(join(dir, 'alerts', 'alerts.json'), 'utf8')).engine.baseline);
  assert.ok(baseline.length <= 60, `one subject per event, not per rule and event: ${baseline.length}`);

  const later = [];
  for (let round = 0; round < 5; round += 1) {
    events = events.slice(10);
    later.push(...sweep({ events }).created, ...sweep({ events }).created);
  }
  assert.ok(later.length >= 40, String(later.length));
  assert.deepEqual(later.filter(alert => !alert.silent).map(alert => alert.title), [], 'no bootstrap event ever notifies');

  // Only a new event remains: the old alerts resolve after two misses and the new event takes their slots.
  const brandNew = ev();
  sweep({ events: [brandNew] });
  const opened = sweep({ events: [brandNew] }).created;
  assert.deepEqual(opened.map(alert => [alert.entity.id, alert.silent]), Array.from({ length: 4 }, () => [brandNew.id, false]));
  for (let n = 0; n < 6; n += 1) sweep({ events: [brandNew] });
  const left = Object.keys(JSON.parse(readFileSync(join(dir, 'alerts', 'alerts.json'), 'utf8')).engine.baseline);
  assert.deepEqual(left, [], 'subjects no rule hits any more leave the baseline');
});

const baselineOf = dir => JSON.parse(readFileSync(join(dir, 'alerts', 'alerts.json'), 'utf8')).engine.baseline;

const HICCUPS = {
  'an empty event list': engine => engine.evaluate({ events: [] }),
  'no event list at all': engine => engine.evaluate({}),
  // The half that would open next is missing for one sweep.
  'half of the events missing': (engine, events) => engine.evaluate({ events: events.slice(0, 10) }),
};
for (const [name, hiccup] of Object.entries(HICCUPS)) {
  test(`a feed hiccup after the bootstrap (${name}) does not turn bootstrap events into notifications`, t => {
    const { engine, sweep, clock } = setup(t, { warm: false, config: { maxActivePerRule: 5 } });
    const events = Array.from({ length: 20 }, () => ev());
    const bootstrap = engine.evaluate({ events });
    assert.equal(bootstrap.created.length, 5, name);
    clock.now += SWEEP;
    hiccup(engine, events);
    // The five open alerts are gone from the feed: their slots go to the next bootstrap events.
    // Then the first half is gone for good: the five open alerts resolve and their slots go to bootstrap events.
    const later = [...sweep({ events: events.slice(10) }).created, ...sweep({ events: events.slice(10) }).created];
    assert.equal(later.length, 5, name);
    assert.ok(later.every(alert => alert.silent), `${name}: ${later.map(alert => alert.silent)}`);
  });
}

test('a hit resets the miss count of a baseline subject: only consecutive quiet sweeps count', t => {
  const { engine, sweep } = setup(t, { warm: false });
  engine.evaluate({ events: [], ...vix(35) });
  for (let n = 0; n < 4; n += 1) sweep();
  sweep(vix(35));
  for (let n = 0; n < 4; n += 1) sweep();
  sweep(vix(35));
  assert.deepEqual(sweep(vix(35)).created.map(alert => alert.silent), [true], 'eight quiet sweeps, never six in a row');
});

test('stored miss counters of subjects that are not in the baseline are dropped', t => {
  const first = setup(t);
  const file = join(first.dir, 'alerts', 'alerts.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.engine.baseline = { 'event|kept': T0 };
  saved.engine.baselineMisses = { 'event|kept': 2, 'event|orphan': 3 };
  writeFileSync(file, JSON.stringify(saved));
  const second = setup(t, { warm: false, dir: first.dir });
  second.sweep();
  assert.deepEqual(baselineOf(first.dir), { 'event|kept': T0 });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).engine.baselineMisses, { 'event|kept': 3 });
});

test('a subject that is really gone leaves the baseline after 6 complete quiet sweeps; incomplete ones do not count', t => {
  const { engine, sweep, clock, dir } = setup(t, { warm: false, config: { maxActivePerRule: 5 } });
  engine.evaluate({ events: Array.from({ length: 20 }, () => ev()) });
  assert.equal(Object.keys(baselineOf(dir)).length, 15);
  for (let n = 0; n < 5; n += 1) sweep();
  clock.now += SWEEP;
  engine.evaluate({});
  engine.evaluate({ get events() { throw new Error('feed down'); } });
  assert.equal(Object.keys(baselineOf(dir)).length, 15, 'five complete quiet sweeps and two incomplete ones');
  sweep();
  assert.deepEqual(baselineOf(dir), {}, 'the sixth complete quiet sweep');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'alerts', 'alerts.json'), 'utf8')).engine.baselineMisses, {});
});

test('a hit in its cooldown takes no rank: the other hits and a new event open during the cooldown', t => {
  const cases = [
    { name: 'events-critical (30 min)', setupRule: () => {}, ruleId: 'events-critical', make: () => ev() },
    { name: 'user rule with a 1440 min cooldown', setupRule: engine => { engine.putRule('events-critical', { enabled: false }); engine.putRule('long', { ...watchRule, cooldownMinutes: 1440 }); }, ruleId: 'long', make: () => ev({ severity: 'moderate' }) },
  ];
  for (const { name, setupRule, ruleId, make } of cases) {
    const { engine, sweep, dir } = setup(t, { config: { maxActivePerRule: 5 } });
    setupRule(engine);
    const events = Array.from({ length: 8 }, make);
    const first = sweep({ events }).created;
    assert.equal(first.length, 5, name);
    sweep();
    assert.equal(sweep().resolved.length, 5, `${name}: all five resolve and start their cooldown`);
    const fresh = make();
    const back = sweep({ events: [...events, fresh] });
    assert.equal(back.created.length, 4, `${name}: the three held hits and the new event open`);
    assert.ok(back.created.some(alert => alert.entity.id === fresh.id), name);
    assert.equal(ofRule(engine, ruleId, 'active').length, 4);
    const pending = JSON.parse(readFileSync(join(dir, 'alerts', 'alerts.json'), 'utf8')).engine.pending;
    assert.ok(first.every(alert => !Object.hasOwn(pending, alert.dedupKey)), `${name}: no streak builds during a cooldown`);
  }
});

test('a displacement during the bootstrap puts the displaced subject into the baseline', t => {
  const { engine, sweep, clock } = setup(t, { warm: false, config: { maxAlerts: 5 } });
  engine.putRule('events-critical', { enabled: false });
  engine.putRule('watch-only', { ...watchRule, params: { minLevel: 'watch', maxLevel: 'watch' } });
  engine.putRule('crit-late', { ...watchRule, params: { minLevel: 'critical' } });
  const watch = Array.from({ length: 5 }, () => ev({ severity: 'moderate' }));
  const critical = ev();
  const bootstrap = engine.evaluate({ events: [...watch, critical] });
  assert.equal(bootstrap.resolved.length, 1, 'one watch alert displaced by the critical one');
  const displaced = bootstrap.resolved[0];
  assert.equal(clock.now, T0);
  sweep({ events: watch });
  sweep({ events: watch });
  const reopened = sweep({ events: watch }).created;
  assert.deepEqual(reopened.map(alert => [alert.dedupKey, alert.silent]), [[displaced.dedupKey, true]]);
});

test('bootstrap at real scale: 2000 events and 3 broad rules, half the events go, every new open is silent', t => {
  const { engine, sweep } = setup(t, { warm: false });
  for (let n = 0; n < 3; n += 1) engine.putRule(`broad-${n}`, watchRule);
  const events = Array.from({ length: 2000 }, () => ev());
  assert.equal(engine.evaluate({ events }).created.length, 200);
  const remaining = events.slice(1000);
  sweep({ events: remaining });
  const later = sweep({ events: remaining }).created;
  assert.equal(later.length, 200, 'four rules refill their 50 slots');
  assert.equal(later.filter(alert => !alert.silent).length, 0);
});

test('forSweeps 3 rules over many events open after three sweeps and pending stays bounded by construction', t => {
  const { engine, sweep, dir } = setup(t, { config: { maxActivePerRule: 5 } });
  for (let n = 0; n < 5; n += 1) engine.putRule(`slow-${n}`, { ...watchRule, forSweeps: 3 });
  const events = Array.from({ length: 200 }, () => ev({ severity: 'moderate' }));
  const pendingSizes = [];
  let result;
  for (let round = 0; round < 3; round += 1) {
    // The feed order changes every sweep; streaks that have started keep their place anyway.
    result = sweep({ events: round % 2 ? [...events].reverse() : events });
    pendingSizes.push(Object.keys(JSON.parse(readFileSync(join(dir, 'alerts', 'alerts.json'), 'utf8')).engine.pending).length);
  }
  for (let n = 0; n < 5; n += 1) assert.equal(ofRule(engine, `slow-${n}`, 'active').length, 5, `slow-${n}`);
  assert.ok(pendingSizes.every(size => size <= 5 * 5), pendingSizes.join(','));
  assert.deepEqual(result.summary.overflow.map(row => row.count), [195, 195, 195, 195, 195], 'the untracked hits are reported');
});

test('a hit pushed out of the tracked set by more severe ones loses its pending streak', t => {
  const { engine, sweep, dir } = setup(t, { config: { maxActivePerRule: 5 } });
  engine.putRule('slow', { ...watchRule, forSweeps: 3 });
  const moderate = Array.from({ length: 10 }, () => ev({ severity: 'moderate' }));
  const high = Array.from({ length: 10 }, () => ev({ severity: 'high' }));
  const pendingOf = () => Object.keys(JSON.parse(readFileSync(join(dir, 'alerts', 'alerts.json'), 'utf8')).engine.pending).filter(key => key.startsWith('slow|'));
  sweep({ events: moderate });
  assert.equal(pendingOf().length, 5);
  sweep({ events: [...moderate, ...high] });
  const pending = pendingOf();
  assert.equal(pending.length, 5);
  assert.ok(pending.every(key => high.some(event => key === `slow|${event.id}`)), 'only the high hits are tracked now');
});

test('a failed evaluation does not shrink the baseline', t => {
  const { engine, sweep } = setup(t, { warm: false, config: { maxActivePerRule: 1 } });
  const events = [ev(), ev(), ev()];
  const [opened] = engine.evaluate({ events }).created;
  engine.evaluate({ get events() { throw new Error('feed down'); } });
  const rest = events.filter(event => opened.entity.id !== event.id);
  sweep({ events: rest });
  const later = sweep({ events: rest }).created.filter(alert => alert.ruleId === 'events-critical');
  assert.equal(later.length, 1);
  assert.equal(later[0].silent, true);
});

test('the global ceiling is severity-aware: a critical hit displaces the least severe open alert, once', t => {
  const { engine, sweep, clock } = setup(t, { config: { maxAlerts: 20 } });
  engine.putRule('watch-only', { ...watchRule, params: { minLevel: 'watch', maxLevel: 'watch' } });
  const events = Array.from({ length: 20 }, () => ev({ severity: 'moderate' }));
  assert.equal(sweep({ events }).created.length, 20);
  const critical = ev();
  const result = sweep({ events: [...events, critical] });
  assert.deepEqual(result.created.map(alert => [alert.ruleId, alert.severity]), [['events-critical', 'critical']]);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].severity, 'watch');
  assert.ok(result.resolved[0].log.some(entry => entry.action === 'resolved' && /displaced/.test(entry.note)));
  assert.deepEqual(result.summary.overflow, [{ ruleId: 'watch-only', count: 1 }]);
  assert.equal(engine.list({ state: 'active' }).length, 20);
  for (let round = 0; round < 4; round += 1) {
    clock.now += 15 * MINUTE;
    const again = sweep({ events: [...events, critical] });
    assert.equal(again.created.length, 0, `sweep ${round}: nothing is re-created`);
    assert.equal(again.resolved.length, 0);
  }
  assert.equal(engine.list({ state: 'active' }).length, 20);
});

test('bootstrap with a threshold that needs two sweeps: the condition present at bootstrap opens silent', t => {
  const { engine, sweep } = setup(t, { warm: false });
  assert.equal(engine.evaluate({ events: [], ...vix(35) }).created.length, 0);
  const second = sweep(vix(36));
  assert.equal(second.silent, false);
  assert.deepEqual(second.created.map(alert => [alert.ruleId, alert.silent]), [['vix-spike', true]]);
});

test('a baseline subject survives 5 quiet sweeps but not 6 (miss hysteresis)', t => {
  for (const [quiet, silent] of [[5, true], [6, false]]) {
    const { engine, sweep } = setup(t, { warm: false });
    engine.evaluate({ events: [], ...vix(35) });
    for (let n = 0; n < quiet; n += 1) sweep();
    sweep(vix(35));
    assert.deepEqual(sweep(vix(35)).created.map(alert => alert.silent), [silent], `${quiet} quiet sweeps`);
  }
});

test('the bootstrap ends only when an evaluation could read the event list', t => {
  const { engine } = setup(t, { warm: false });
  assert.equal(engine.evaluate({}).silent, true);
  assert.equal(engine.evaluate({ get events() { throw new Error('no events'); } }).silent, true);
  assert.equal(engine.evaluate({ events: 'nope' }).silent, true);
  const baseline = engine.evaluate({ events: [ev()] });
  assert.equal(baseline.silent, true);
  assert.ok(baseline.created.length === 1 && baseline.created.every(alert => alert.silent));
  assert.equal(engine.evaluate({ events: [] }).silent, false);
});

test('a global ceiling on open alerts: hits beyond maxAlerts are held back and nothing is re-created later', t => {
  const { engine, sweep, dir } = setup(t, { config: { maxAlerts: 10 } });
  const events = Array.from({ length: 20 }, () => ev());
  assert.equal(sweep({ events }).created.length, 10);
  for (let round = 0; round < 3; round += 1) {
    const result = sweep({ events });
    assert.equal(result.created.length, 0, `sweep ${round + 2}`);
    assert.deepEqual(result.summary.overflow, [{ ruleId: 'events-critical', count: 10 }]);
  }
  assert.equal(engine.list({ state: 'all' }).length, 10);
  const saved = JSON.parse(readFileSync(join(dir, 'alerts', 'alerts.json'), 'utf8'));
  assert.equal(saved.alerts.length, 10);
});

test('summary.overflow lists at most 10 rules, most held back first, and rules() is unchanged by it', t => {
  const { engine, sweep } = setup(t, { config: { maxActivePerRule: 2 } });
  for (let n = 0; n < 12; n += 1) engine.putRule(`wide-${String(n).padStart(2, '0')}`, { ...watchRule, params: { minLevel: n === 11 ? 'high' : 'watch' } });
  const before = engine.rules();
  const events = [...Array.from({ length: 4 }, () => ev({ severity: 'moderate' })), ev({ severity: 'high' })];
  const { summary } = sweep({ events });
  assert.equal(summary.overflow.length, 10);
  assert.deepEqual(summary.overflow.slice(0, 2), [{ ruleId: 'wide-00', count: 3 }, { ruleId: 'wide-01', count: 3 }]);
  assert.equal(summary.overflow.some(row => row.ruleId === 'wide-11'), false, 'wide-11 had one hit and no overflow');
  assert.deepEqual(engine.rules(), before);
  const failed = engine.evaluate({ get events() { throw new Error('feed down'); } });
  assert.deepEqual(failed.summary.overflow, summary.overflow, 'a rule that failed keeps its last count');
  assert.equal(sweep({ events: [] }).summary.overflow.length, 0, 'only the last evaluation counts');
});

test('a forward clock jump that is corrected does not stretch cooldowns or snoozes', t => {
  const { engine, sweep, clock } = setup(t);
  const events = [ev(), ev()];
  const [first, snoozed] = sweep({ events }).created;
  clock.now = T0 + YEAR;
  sweep({ events });
  engine.resolve(first.id);
  engine.snooze(snoozed.id, 60);

  clock.now = T0 + SWEEP;
  assert.equal(sweep({ events }).created.length, 0, 'the cooldown still runs, for its normal 30 minutes');
  const { snooze } = engine.get(snoozed.id);
  assert.ok(snooze.at <= clock.now);
  assert.equal(snooze.until, clock.now + 60 * MINUTE, 'the snooze keeps its length from the corrected clock');
  for (const alert of engine.list({ state: 'active' })) assert.ok(alert.lastSeenAt <= clock.now);
  assert.equal(sweep({ events }).created.length, 0);
  const reopened = sweep({ events }).created;
  assert.deepEqual(reopened.map(alert => alert.dedupKey), [first.dedupKey], 'reopens 30 minutes after the correction');
  assert.equal(engine.get(snoozed.id).state, 'snoozed');
});

test('pending counters stay bounded: 2000 events x 50 rules at forSweeps 3 save at most 5000 entries', t => {
  const { engine, sweep, dir } = setup(t);
  for (let n = 0; n < 50; n += 1) engine.putRule(`slow-${n}`, { ...watchRule, forSweeps: 3 });
  const events = Array.from({ length: 2000 }, () => ev({ severity: 'moderate' }));
  sweep({ events });
  const saved = JSON.parse(readFileSync(join(dir, 'alerts', 'alerts.json'), 'utf8'));
  const pending = Object.keys(saved.engine.pending).length;
  assert.ok(pending > 0 && pending <= 5000, String(pending));
});

test('bootstrap: the first evaluation creates silent alerts; the next one is not silent and adds nothing', t => {
  const { engine, clock } = setup(t, { warm: false });
  const events = Array.from({ length: 11 }, () => ev());
  const first = engine.evaluate({ events });
  assert.equal(first.silent, true);
  assert.equal(first.created.length, 11);
  for (const alert of first.created) {
    assert.equal(alert.silent, true);
    assert.ok(alert.log.some(entry => entry.action === 'silent'), JSON.stringify(alert.log));
  }
  clock.now += SWEEP;
  const second = engine.evaluate({ events });
  assert.equal(second.silent, false);
  assert.equal(second.created.length, 0);
  assert.equal(engine.summary().counts.critical, 11);
  assert.equal(engine.get(first.created[0].id).count, 2);
});

test('bootstrap again after a corrupt store: alerts created on that sweep are silent', t => {
  const first = setup(t);
  first.sweep({ events: [ev()] });
  writeFileSync(join(first.dir, 'alerts', 'alerts.json'), 'garbage');
  writeFileSync(join(first.dir, 'alerts', 'alerts.json.bak'), 'garbage');
  const second = setup(t, { warm: false, dir: first.dir });
  assert.equal(second.engine.summary().status.alerts, 'corrupt');
  assert.equal(second.engine.summary().threat.level, 1);
  const result = second.engine.evaluate({ events: [ev()] });
  assert.equal(result.silent, true);
  assert.ok(result.created.every(alert => alert.silent));
});

test('restart: a new engine on the same directory keeps alerts, pending counters, snooze deadlines and cooldowns', t => {
  const first = setup(t);
  const snoozedEvent = ev();
  const cooledEvent = ev();
  const [snoozed, cooled] = first.sweep({ events: [snoozedEvent, cooledEvent] }).created;
  first.engine.snooze(snoozed.id, 60);
  first.sweep({ events: [snoozedEvent, cooledEvent], ...vix(35) });
  first.engine.resolve(cooled.id);

  const second = setup(t, { warm: false, dir: first.dir });
  second.clock.now = first.clock.now;
  assert.deepEqual(second.engine.list({ state: 'all' }), first.engine.list({ state: 'all' }));
  assert.equal(second.engine.get(snoozed.id).snooze.until, T0 + SWEEP + 60 * MINUTE);

  const result = second.sweep({ events: [snoozedEvent, cooledEvent], ...vix(36) });
  assert.equal(result.silent, false, 'the stored state is not a bootstrap');
  assert.deepEqual(result.created.map(alert => alert.ruleId), ['vix-spike'], 'pending carried over; the cooldown still blocks');
  assert.equal(second.engine.get(snoozed.id).state, 'snoozed');
  second.clock.now = T0 + SWEEP + 60 * MINUTE;
  assert.equal(second.engine.summary().counts.snoozed, 0, 'the restored deadline expires on time');
  assert.equal(second.engine.get(snoozed.id).state, 'firing');
});

// ─── robustness ──────────────────────────────────────────────────────────────

test('a throwing rule is logged once and does not stop the other rules or the save', t => {
  const { engine, sweep, logger, dir } = setup(t);
  engine.putRule('wti-high', { name: 'WTI high', kind: 'threshold', severity: 'watch', forSweeps: 1, params: { metric: 'wti', op: '>', value: 100 } });
  const [existing] = sweep({ events: [ev()] }).created;
  const hostile = {
    get events() { throw new Error('events exploded'); },
    get health() { throw new Error('health exploded'); },
    energy: { wti: 120 },
  };
  for (let round = 0; round < 3; round += 1) {
    logger.lines.length = 0;
    const result = engine.evaluate(hostile);
    if (round === 0) assert.deepEqual(result.created.map(alert => alert.ruleId), ['wti-high']);
    const failures = logger.lines.filter(line => line.includes('events exploded'));
    assert.deepEqual(failures.length, 4, `one line per event-reading rule:\n${logger.lines.join('\n')}`);
    assert.ok(failures.some(line => line.includes('events-critical')));
    assert.equal(logger.lines.filter(line => line.includes('source-stale') && line.includes('health exploded')).length, 1);
  }
  assert.equal(engine.get(existing.id).state, 'firing', 'a rule that failed does not count as a miss');
  const saved = JSON.parse(readFileSync(join(dir, 'alerts', 'alerts.json'), 'utf8'));
  assert.ok(saved.alerts.some(alert => alert.ruleId === 'wti-high'));
});

test('a failing save is logged and never thrown', t => {
  const { engine, dir, logger } = setup(t);
  rmSync(join(dir, 'alerts'), { recursive: true, force: true });
  writeFileSync(join(dir, 'alerts'), 'a file where the directory should be');
  const result = engine.evaluate({ events: [ev()] });
  assert.equal(result.created.length, 1);
  assert.ok(logger.lines.some(line => line.includes('alerts.json')), logger.lines.join('\n'));
  assert.doesNotThrow(() => engine.ack(result.created[0].id));
});

test('evaluate() without an object snapshot returns the current summary and changes nothing', t => {
  const { engine, sweep } = setup(t);
  sweep({ events: [ev()] });
  const before = engine.summary();
  for (const bad of [null, undefined, 'snapshot', 42, []]) {
    const result = engine.evaluate(bad);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.escalated, []);
    assert.deepEqual(result.resolved, []);
    assert.equal(result.silent, false);
    assert.equal(result.summary.lastEvaluatedAt, before.lastEvaluatedAt);
    assert.deepEqual(result.summary.counts, before.counts);
  }
});

test('evaluate() on a fresh engine with a non-object snapshot does not end the bootstrap', t => {
  const { engine } = setup(t, { warm: false });
  engine.evaluate(null);
  assert.equal(engine.evaluate({ events: [ev()] }).silent, true);
});

test('the clock going backwards gives no negative ages and no mass resolve', t => {
  const { engine, sweep, clock } = setup(t);
  const events = [ev(), ev(), ev()];
  const created = sweep({ events }).created;
  const [snoozed] = created;
  engine.snooze(snoozed.id, 15);
  clock.now -= 6 * 60 * MINUTE;
  const back = engine.evaluate({ events });
  assert.equal(back.resolved.length, 0);
  assert.equal(back.created.length, 0);
  engine.evaluate({ events: [] });
  assert.equal(engine.list({ state: 'resolved' }).length, 0, 'one miss is not a resolve');
  for (const alert of engine.list({ state: 'all' })) {
    assert.ok(alert.lastSeenAt >= alert.firstSeenAt, 'lastSeenAt never goes before firstSeenAt');
    assert.ok(alert.lastSeenAt <= clock.now, 'nor after now');
    assert.equal(alert.count, 2);
  }
  assert.equal(engine.get(snoozed.id).state, 'snoozed', 'a snooze does not expire because the clock went back');
  engine.resolve(created[1].id);
  const resolved = engine.get(created[1].id);
  assert.ok(resolved.resolvedAt >= resolved.lastSeenAt, 'resolvedAt never goes before lastSeenAt');
});

test('evaluate({delta}) feeds the delta rule, and failStreaks come from snapshot.health', t => {
  const { engine, sweep } = setup(t);
  const delta = { signals: { new: [{ key: 'vix', severity: 'critical', label: 'VIX', pctChange: 40, direction: 'up', reason: 'jump' }], escalated: [] } };
  const result = sweep({}, { delta });
  assert.deepEqual(result.created.map(alert => alert.ruleId), ['delta-critical']);
  assert.equal(result.created[0].notify, false);

  const health = [{ n: 'GDELT', err: true, stale: false }, { n: 'NOAA', err: false, stale: false }];
  sweep({ health });
  assert.equal(sweep({ health }).created.length, 0);
  assert.deepEqual(sweep({ health }).created.map(alert => alert.dedupKey), ['source-stale|GDELT']);
});

test('the change rule compares with the metrics stored by the previous evaluation', t => {
  const { engine, sweep } = setup(t);
  engine.putRule('wti-move', { name: 'WTI move', kind: 'change', severity: 'watch', params: { metric: 'wti', pct: 5 } });
  assert.equal(sweep({ energy: { wti: 100 } }).created.length, 0);
  assert.deepEqual(sweep({ energy: { wti: 110 } }).created.map(alert => alert.ruleId), ['wti-move']);
});

test('rule ids such as constructor and prototype work like any other', t => {
  const { engine, sweep } = setup(t);
  engine.putRule('constructor', watchRule);
  engine.putRule('prototype', { ...watchRule, name: 'Prototype' });
  sweep({ events: [ev({ severity: 'moderate' })] });
  assert.equal(ofRule(engine, 'constructor').length, 1);
  assert.equal(ofRule(engine, 'prototype').length, 1);
  engine.deleteRule('constructor');
  assert.equal(ofRule(engine, 'constructor', 'active').length, 0);
  assert.deepEqual(engine.rules().filter(rule => rule.source === 'user').map(rule => rule.id), ['prototype']);
});

// ─── rules ───────────────────────────────────────────────────────────────────

test('putRule creates and replaces user rules and overrides built-ins', t => {
  const { engine } = setup(t);
  const created = engine.putRule('oil', { name: 'Oil', kind: 'threshold', params: { metric: 'wti', op: '>', value: 90 } });
  assert.equal(created.source, 'user');
  assert.equal(created.forSweeps, 2, 'defaults applied');
  const replaced = engine.putRule('oil', { name: 'Oil high', kind: 'threshold', params: { metric: 'wti', op: '>', value: 95 } });
  assert.equal(replaced.params.value, 95);
  assert.equal(engine.rules().filter(rule => rule.id === 'oil').length, 1);

  const override = engine.putRule('vix-spike', { severity: 'critical', params: { metric: 'vix', op: '>', value: 25 } });
  assert.equal(override.source, 'override');
  assert.equal(override.severity, 'critical');
  assert.equal(override.name, 'VIX spike');
  const full = engine.rules().find(rule => rule.id === 'vix-spike');
  const { source, ...body } = full;
  assert.equal(source, 'override');
  assert.equal(engine.putRule('vix-spike', body).source, 'override', 'the full rule shape is accepted for a built-in');
  assertAlertError(() => engine.putRule('vix-spike', { ...body, name: 'Renamed' }), { status: 400, code: 'INVALID_RULE', field: 'name' });
  assertAlertError(() => engine.putRule('vix-spike', { ...body, kind: 'change' }), { status: 400, code: 'INVALID_RULE', field: 'kind' });
  assertAlertError(() => engine.putRule('vix-spike', { ...body, id: 'other' }), { status: 400, code: 'INVALID_RULE', field: 'id' });
  assertAlertError(() => engine.putRule('vix-spike', { bogus: 1 }), { status: 400, code: 'INVALID_RULE', field: 'bogus' });
  assertAlertError(() => engine.putRule('vix-spike', { params: { metric: 'vix', op: '>', value: 'high' } }), { status: 400, code: 'INVALID_RULE', field: 'params.value' });
  assert.equal(engine.rules().find(rule => rule.id === 'vix-spike').params.value, 25, 'a rejected PUT changes nothing');
});

test('invalid rules raise AlertError 400 with the failing field', t => {
  const { engine } = setup(t);
  assertAlertError(() => engine.putRule('bad', { name: 'Bad', kind: 'threshold', params: { metric: 'vix', op: '>', value: 'x' } }), { status: 400, code: 'INVALID_RULE', field: 'params.value' });
  assertAlertError(() => engine.putRule('bad', { name: 'Bad', kind: 'event', params: { minLevel: 'watch' }, extra: 1 }), { status: 400, code: 'INVALID_RULE', field: 'extra' });
  assertAlertError(() => engine.putRule('Bad Id', watchRule), { status: 400, code: 'INVALID_RULE', field: 'id' });
  assertAlertError(() => engine.putRule('__proto__', watchRule), { status: 400, code: 'INVALID_RULE', field: 'id' });
  assertAlertError(() => engine.putRule('bad', null), { status: 400, code: 'INVALID_RULE', field: 'rule' });
  assertAlertError(() => engine.putRule('bad', JSON.parse('{"__proto__":{"enabled":false},"name":"x","kind":"event","params":{"minLevel":"watch"}}')), { status: 400, code: 'INVALID_RULE' });
  assert.equal(engine.rules().some(rule => rule.id === 'bad'), false);
  assert.equal(({}).enabled, undefined);
});

test('at most 50 user rules', t => {
  const { engine } = setup(t);
  for (let n = 0; n < 50; n += 1) engine.putRule(`rule-${n}`, watchRule);
  assertAlertError(() => engine.putRule('rule-50', watchRule), { status: 400 });
  assert.equal(engine.putRule('rule-7', { ...watchRule, name: 'Replaced' }).name, 'Replaced', 'replacing one is still allowed');
  engine.putRule('vix-spike', { enabled: false });
  assert.equal(engine.rules().filter(rule => rule.source === 'user').length, 50);
});

test('disabling a rule resolves its alerts with a log note and stops new ones', t => {
  const { engine, sweep } = setup(t);
  const event = ev();
  sweep({ events: [event] });
  const [alert] = ofRule(engine, 'events-critical');
  engine.putRule('events-critical', { enabled: false });
  const closed = engine.get(alert.id);
  assert.equal(closed.state, 'resolved');
  assert.ok(closed.log.some(entry => entry.action === 'resolved' && /disabled/.test(entry.note)));
  assert.equal(sweep({ events: [event] }).created.length, 0);
  engine.deleteRule('events-critical');
  assert.equal(engine.rules().find(rule => rule.id === 'events-critical').source, 'builtin');
  assert.equal(sweep({ events: [event] }).created.length, 1, 'no cooldown after a rule was disabled');
});

test('deleteRule removes user rules and overrides, never a built-in itself', t => {
  const { engine, sweep } = setup(t);
  engine.putRule('wide', watchRule);
  sweep({ events: [ev({ severity: 'moderate' })] });
  const [alert] = ofRule(engine, 'wide');
  engine.deleteRule('wide');
  assert.equal(engine.rules().some(rule => rule.id === 'wide'), false);
  const closed = engine.get(alert.id);
  assert.equal(closed.state, 'resolved');
  assert.ok(closed.log.some(entry => /deleted/.test(entry.note ?? '')));
  assertAlertError(() => engine.deleteRule('wide'), { status: 404, code: 'NOT_FOUND' });
  assertAlertError(() => engine.deleteRule('vix-spike'), { status: 400, code: 'INVALID_STATE' });
  engine.putRule('vix-spike', { enabled: false });
  engine.deleteRule('vix-spike');
  assert.equal(engine.rules().find(rule => rule.id === 'vix-spike').source, 'builtin');
  assert.equal(engine.rules().find(rule => rule.id === 'vix-spike').enabled, true);
});

test('rules persist across a restart', t => {
  const first = setup(t);
  first.engine.putRule('oil', { name: 'Oil', kind: 'threshold', params: { metric: 'wti', op: '>', value: 90 } });
  first.engine.putRule('vix-spike', { enabled: false });
  const second = setup(t, { warm: false, dir: first.dir });
  assert.deepEqual(second.engine.rules(), first.engine.rules());
  assert.deepEqual(second.engine.summary().rules, { enabled: 9, total: 10 });
});

test('alerts of a rule that disappeared from the rule set are resolved on the next sweep', t => {
  const first = setup(t);
  first.engine.putRule('wide', watchRule);
  first.sweep({ events: [ev({ severity: 'moderate' })] });
  const rulesFile = join(first.dir, 'alerts', 'rules.json');
  writeFileSync(rulesFile, '{"version":1,"rules":[]}');
  const second = setup(t, { warm: false, dir: first.dir });
  second.clock.now = first.clock.now;
  const result = second.sweep();
  assert.equal(result.resolved.filter(alert => alert.ruleId === 'wide').length, 1);
});

// ─── summary ─────────────────────────────────────────────────────────────────

test('threat level: none 1, one firing watch 3, acked critical alone 1, firing critical 5', t => {
  const { engine, sweep } = setup(t);
  assert.deepEqual(engine.summary().threat, { level: 1, drivers: [] });
  engine.putRule('wide', watchRule);
  engine.putRule('events-critical', { enabled: false });
  const watchEvent = ev({ severity: 'moderate' });
  sweep({ events: [watchEvent] });
  const [watch] = ofRule(engine, 'wide');
  assert.equal(engine.summary().threat.level, 3);
  assert.deepEqual(engine.summary().threat.drivers, [{ alertId: watch.id, ruleId: 'wide', severity: 'watch', title: watch.title }]);
  engine.ack(watch.id);
  engine.deleteRule('events-critical');
  sweep({ events: [watchEvent, ev()] });
  const critical = ofRule(engine, 'events-critical')[0];
  assert.equal(engine.summary().threat.level, 5);
  engine.ack(critical.id);
  for (const alert of ofRule(engine, 'wide', 'active')) if (alert.state === 'firing') engine.ack(alert.id);
  assert.equal(engine.summary().threat.level, 1, 'acknowledged alerts do not raise the level');
  engine.snooze(critical.id, 60);
  assert.equal(engine.summary().threat.level, 1, 'nor do snoozed ones');
});

test('summary: counts, at most 5 drivers, top ordering and compact shape', t => {
  const { engine, sweep, clock } = setup(t);
  engine.putRule('wide', { ...watchRule, params: { minLevel: 'info' } });
  engine.putRule('events-critical', { enabled: false });
  engine.putRule('events-high', { enabled: false });
  const events = [ev({ severity: 'low' }), ev({ severity: 'moderate' })];
  sweep({ events });
  clock.now += MINUTE;
  events.push(ev({ severity: 'high' }), ev({ severity: 'moderate' }), ev({ severity: 'critical', title: 'Older critical' }));
  sweep({ events });
  events.push(ev({ severity: 'critical', title: 'Newer critical' }), ev({ severity: 'high' }));
  sweep({ events });
  const all = engine.list({ state: 'active' });
  assert.equal(all.length, 7);
  engine.ack(all.find(alert => alert.severity === 'info').id);

  const summary = engine.summary();
  assert.deepEqual(Object.keys(summary).sort(), ['counts', 'generatedAt', 'lastEvaluatedAt', 'overflow', 'rules', 'status', 'threat', 'top']);
  assert.deepEqual(summary.overflow, []);
  assert.equal(summary.generatedAt, clock.now);
  assert.equal(summary.lastEvaluatedAt, clock.now);
  assert.deepEqual(summary.counts, { critical: 2, high: 2, watch: 2, info: 0, total: 7, acked: 1, snoozed: 0 });
  assert.equal(summary.threat.level, 5);
  assert.equal(summary.threat.drivers.length, 5);
  assert.deepEqual(summary.top.map(alert => alert.severity), ['critical', 'critical', 'high', 'high', 'watch']);
  assert.deepEqual(summary.top.slice(0, 2).map(alert => alert.title), ['Newer critical', 'Older critical']);
  assert.deepEqual(Object.keys(summary.top[0]).sort(), ['count', 'firstSeenAt', 'id', 'lastSeenAt', 'ruleId', 'ruleName', 'severity', 'silent', 'state', 'title']);
  assert.deepEqual(summary.status, { alerts: 'empty', rules: 'empty' }, 'the status of the last load');
  assert.deepEqual(summary.rules, { enabled: 8, total: 10 });
});

test('list filters by state, severity and rule, sorts firing first and honours the limit', t => {
  const { engine, sweep } = setup(t);
  engine.putRule('wide', watchRule);
  sweep({ events: [ev({ severity: 'moderate' }), ev({ severity: 'high' }), ev()] });
  const [first] = engine.list({ state: 'active' });
  assert.equal(first.severity, 'critical');
  engine.ack(first.id);
  assert.equal(engine.list({ state: 'active' }).at(-1).id, first.id, 'acknowledged after firing');
  assert.equal(engine.list({ severity: 'watch' }).length, 1);
  assert.equal(engine.list({ rule: 'wide' }).length, 3);
  assert.equal(engine.list({ limit: 2 }).length, 2);
  engine.resolve(first.id);
  assert.deepEqual(engine.list({ state: 'resolved' }).map(alert => alert.id), [first.id]);
  assert.equal(engine.list({ state: 'active' }).some(alert => alert.id === first.id), false);
  assert.equal(engine.list({ state: 'all' }).length, 5);
  assert.equal(engine.get('alert-nope'), null);
  assert.equal(engine.get(42), null);
});

test('markNotified records channels once per episode and ignores unknown ids', t => {
  const { engine, sweep } = setup(t);
  const [alert] = sweep({ events: [ev()] }).created;
  engine.markNotified(alert.id, ['telegram']);
  engine.markNotified(alert.id, ['ntfy', 'telegram', 'Bad Channel!', 7]);
  assert.deepEqual(engine.get(alert.id).notified.channels, ['telegram', 'ntfy']);
  assert.doesNotThrow(() => engine.markNotified('alert-00000000000000000000000000000000', ['telegram']));
});

test('metricsCatalog lists every metric with its current value', t => {
  const { engine, sweep } = setup(t);
  const catalog = engine.metricsCatalog(vix(31.5));
  const entry = catalog.find(item => item.key === 'vix');
  assert.deepEqual(entry, { key: 'vix', label: 'VIX', unit: 'index', kind: 'number', value: 31.5 });
  assert.ok(catalog.length >= 20);
  assert.equal(catalog.find(item => item.key === 'gold').value, null);
  sweep(vix(28));
  assert.equal(engine.metricsCatalog(null).find(item => item.key === 'vix').value, 28, 'without a snapshot: the last evaluated values');
});

test('the engine works before load() and its results are detached copies', t => {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-alert-engine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const engine = new AlertEngine(dir, { now: () => T0, logger: recorder() });
  const result = engine.evaluate({ events: [ev()] });
  assert.equal(result.silent, true);
  result.created[0].title = 'tampered';
  result.summary.top[0].title = 'tampered';
  assert.notEqual(engine.get(result.created[0].id).title, 'tampered');
  assert.ok(existsSync(join(dir, 'alerts', 'alerts.json')));
  assert.equal(engine.summary().top[0].title, engine.get(result.created[0].id).title);
});
