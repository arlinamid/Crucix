import test from 'node:test';
import assert from 'node:assert/strict';
import { RULE_KINDS, DEFAULT_RULES, MAX_USER_RULES, validateRule, mergeRules, describeRule } from '../lib/alerts/rules.mjs';
import { LEVELS, levelRank } from '../lib/alerts/levels.mjs';
import { METRIC_KEYS } from '../lib/alerts/metrics.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const deepFrozen = value => value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(deepFrozen));

// Smallest valid input of every kind.
const MINIMAL = {
  event: { id: 'e', name: 'E', kind: 'event', params: { minLevel: 'high' } },
  threshold: { id: 't', name: 'T', kind: 'threshold', params: { metric: 'vix', op: '>', value: 30 } },
  change: { id: 'c', name: 'C', kind: 'change', params: { metric: 'wti', pct: 5 } },
  absence: { id: 'a', name: 'A', kind: 'absence', params: { source: 'any', minFailSweeps: 3 } },
  convergence: { id: 'v', name: 'V', kind: 'convergence' },
  delta: { id: 'd', name: 'D', kind: 'delta', params: { minSeverity: 'critical' } },
  thread: { id: 'h', name: 'H', kind: 'thread' },
};

function rejected(input, field, opts) {
  const result = validateRule(input, opts);
  assert.equal(result.ok, false, `expected a rejection at ${field}`);
  assert.equal(result.error.code, 'INVALID_RULE');
  assert.equal(result.error.field, field);
  assert.equal(typeof result.error.message, 'string');
  assert.ok(result.error.message.length > 0);
  return result.error;
}
function accepted(input, opts) {
  const result = validateRule(input, opts);
  assert.equal(result.ok, true, result.ok ? '' : `${result.error.field}: ${result.error.message}`);
  return result.rule;
}
// MINIMAL[kind] with some fields replaced; `params` and `scope` are merged one level deep.
function minimal(kind, changes = {}) {
  const base = clone(MINIMAL[kind]);
  const { params, scope, ...rest } = changes;
  Object.assign(base, rest);
  if (params !== undefined) base.params = { ...base.params, ...params };
  if (scope !== undefined) base.scope = scope;
  return base;
}

// ─── constants and the built-in pack ─────────────────────────────────────────

test('RULE_KINDS lists the seven kinds', () => {
  assert.deepEqual([...RULE_KINDS], ['event', 'threshold', 'change', 'absence', 'convergence', 'delta', 'thread']);
  assert.ok(Object.isFrozen(RULE_KINDS));
  assert.equal(MAX_USER_RULES, 50);
});

test('the built-in pack is the eight spec rules, in order', () => {
  assert.deepEqual(DEFAULT_RULES.map(rule => rule.id), ['events-critical', 'events-high', 'convergence-default', 'threads-multisource', 'source-stale', 'vix-spike', 'hy-spread-wide', 'delta-critical', 'hungary-region']);
});

test('every built-in rule validates and survives validation unchanged', () => {
  for (const rule of DEFAULT_RULES) {
    const result = validateRule(clone(rule));
    assert.equal(result.ok, true, `${rule.id}: ${result.ok ? '' : result.error.field}`);
    assert.deepEqual(result.rule, clone(rule), `${rule.id} is already normalised`);
  }
});

test('the built-in pack is deeply frozen and every rule has a distinct id and a name', () => {
  assert.ok(Object.isFrozen(DEFAULT_RULES));
  assert.ok(deepFrozen(DEFAULT_RULES));
  assert.equal(new Set(DEFAULT_RULES.map(rule => rule.id)).size, DEFAULT_RULES.length);
  for (const rule of DEFAULT_RULES) assert.ok(rule.name.length > 0 && rule.name.length <= 80);
  assert.throws(() => { 'use strict'; DEFAULT_RULES[0].enabled = false; }, TypeError);
});

test('the built-in parameters match the spec', () => {
  const byId = Object.fromEntries(DEFAULT_RULES.map(rule => [rule.id, rule]));
  const pick = (id, ...fields) => Object.fromEntries(fields.map(field => [field, clone(byId[id][field])]));
  assert.deepEqual(pick('events-critical', 'kind', 'severity', 'notify', 'enabled', 'params', 'scope'), { kind: 'event', severity: 'auto', notify: true, enabled: true, params: { minLevel: 'critical' }, scope: {} });
  // events-high is capped at high so a critical event raises one alert (events-critical), not two.
  assert.deepEqual(pick('events-high', 'kind', 'severity', 'notify', 'forSweeps', 'params'), { kind: 'event', severity: 'auto', notify: true, forSweeps: 1, params: { minLevel: 'high', maxLevel: 'high' } });
  assert.deepEqual(pick('convergence-default', 'kind', 'severity', 'notify', 'params'), { kind: 'convergence', severity: 'high', notify: true, params: { cellDegrees: 2, windowHours: 24, minKinds: 3, minLevel: 'watch' } });
  assert.deepEqual(pick('source-stale', 'kind', 'severity', 'notify', 'params'), { kind: 'absence', severity: 'watch', notify: false, params: { source: 'any', minFailSweeps: 3 } });
  assert.deepEqual(pick('vix-spike', 'kind', 'severity', 'notify', 'forSweeps', 'params'), { kind: 'threshold', severity: 'high', notify: true, forSweeps: 2, params: { metric: 'vix', op: '>', value: 30 } });
  assert.deepEqual(pick('hy-spread-wide', 'kind', 'severity', 'notify', 'forSweeps', 'params'), { kind: 'threshold', severity: 'watch', notify: false, forSweeps: 2, params: { metric: 'hy_spread', op: '>', value: 5 } });
  assert.deepEqual(pick('delta-critical', 'kind', 'severity', 'notify', 'params'), { kind: 'delta', severity: 'critical', notify: false, params: { minSeverity: 'critical' } });
  assert.deepEqual(pick('hungary-region', 'kind', 'severity', 'notify', 'params', 'scope'), { kind: 'event', severity: 'auto', notify: false, params: { minLevel: 'watch' }, scope: { radius: { lat: 47.5, lon: 19, km: 500 } } });
});

// ─── validateRule: defaults ──────────────────────────────────────────────────

test('the minimal input of every kind is valid and gets the documented defaults', () => {
  const common = { enabled: true, severity: 'high', notify: false, cooldownMinutes: 30 };
  assert.deepEqual(accepted(MINIMAL.event), { id: 'e', name: 'E', kind: 'event', ...common, forSweeps: 1, scope: {}, params: { minLevel: 'high' } });
  assert.deepEqual(accepted(MINIMAL.threshold), { id: 't', name: 'T', kind: 'threshold', ...common, forSweeps: 2, params: { metric: 'vix', op: '>', value: 30 } });
  assert.deepEqual(accepted(MINIMAL.change), { id: 'c', name: 'C', kind: 'change', ...common, forSweeps: 1, params: { metric: 'wti', pct: 5 } });
  assert.deepEqual(accepted(MINIMAL.absence), { id: 'a', name: 'A', kind: 'absence', ...common, forSweeps: 1, params: { source: 'any', minFailSweeps: 3 } });
  assert.deepEqual(accepted(MINIMAL.convergence), { id: 'v', name: 'V', kind: 'convergence', ...common, forSweeps: 1, params: { cellDegrees: 2, windowHours: 24, minKinds: 3, minLevel: 'watch' } });
  assert.deepEqual(accepted(MINIMAL.delta), { id: 'd', name: 'D', kind: 'delta', ...common, forSweeps: 1, params: { minSeverity: 'critical' } });
});

test('explicit values win over the defaults, and the name is trimmed', () => {
  const rule = accepted(minimal('threshold', { name: '  Hot VIX  ', enabled: false, notify: true, severity: 'critical', forSweeps: 5, cooldownMinutes: 0, params: { op: '<=', value: -1.5, clearValue: 0 } }));
  assert.deepEqual(rule, { id: 't', name: 'Hot VIX', kind: 'threshold', enabled: false, severity: 'critical', notify: true, forSweeps: 5, cooldownMinutes: 0, params: { metric: 'vix', op: '<=', value: -1.5, clearValue: 0 } });
});

test('every kind accepts its full parameter set', () => {
  assert.deepEqual(accepted(minimal('event', { severity: 'auto', scope: { kinds: ['conflict', 'space-weather'], sources: ['GDACS'], keywords: ['Ukraine', 'ceasefire'], radius: { lat: -90, lon: 180, km: 3000 } } })).scope, { kinds: ['conflict', 'space-weather'], sources: ['GDACS'], keywords: ['Ukraine', 'ceasefire'], radius: { lat: -90, lon: 180, km: 3000 } });
  assert.deepEqual(accepted(minimal('absence', { params: { source: 'GDACS', minFailSweeps: 50, maxAgeMinutes: 90 } })).params, { source: 'GDACS', minFailSweeps: 50, maxAgeMinutes: 90 });
  assert.deepEqual(accepted(minimal('convergence', { params: { cellDegrees: 4, windowHours: 72, minKinds: 2, minLevel: 'critical', kinds: ['conflict', 'outage'] } })).params, { cellDegrees: 4, windowHours: 72, minKinds: 2, minLevel: 'critical', kinds: ['conflict', 'outage'] });
  assert.deepEqual(accepted(minimal('change', { params: { metric: 'btc', pct: 0.1 } })).params, { metric: 'btc', pct: 0.1 });
  assert.deepEqual(accepted(minimal('delta', { params: { minSeverity: 'high' } })).params, { minSeverity: 'high' });
});

test('every level is a valid severity and minLevel; auto only on event rules', () => {
  for (const level of LEVELS) {
    assert.equal(accepted(minimal('event', { severity: level, params: { minLevel: level } })).severity, level);
    assert.equal(accepted(minimal('threshold', { severity: level })).severity, level);
  }
  assert.equal(accepted(minimal('event', { severity: 'auto' })).severity, 'auto');
  for (const kind of RULE_KINDS.filter(item => item !== 'event')) rejected(minimal(kind, { severity: 'auto' }), 'severity');
});

test('every metric of the registry is accepted', () => {
  for (const metric of METRIC_KEYS) {
    accepted(minimal('threshold', { params: { metric } }));
    accepted(minimal('change', { params: { metric } }));
  }
});

test('boundary values are accepted', () => {
  accepted(minimal('event', { id: 'a'.repeat(40), name: 'n'.repeat(80), forSweeps: 10, cooldownMinutes: 1440 }));
  accepted(minimal('event', { id: '0-9', forSweeps: 1, cooldownMinutes: 0 }));
  accepted(minimal('change', { params: { pct: 100 } }));
  accepted(minimal('absence', { params: { minFailSweeps: 1, maxAgeMinutes: 1 } }));
  accepted(minimal('absence', { params: { maxAgeMinutes: 43200 } }));
  accepted(minimal('event', { scope: { radius: { lat: 90, lon: -180, km: 1 } } }));
  accepted(minimal('event', { scope: { keywords: Array.from({ length: 10 }, (_, index) => `${index}`.padEnd(40, 'x')) } }));
});

test('convergence boundary values are accepted', () => {
  assert.equal(accepted(minimal('convergence', { params: { minKinds: 6 } })).params.minKinds, 6);
  assert.equal(accepted(minimal('convergence', { params: { windowHours: 6 } })).params.windowHours, 6);
  assert.equal(accepted(minimal('convergence', { params: { cellDegrees: 1 } })).params.cellDegrees, 1);
  assert.equal(accepted(minimal('convergence', { params: { minKinds: 6, kinds: ['a', 'b', 'c', 'd', 'e', 'f'] } })).params.minKinds, 6);
  rejected(minimal('convergence', { params: { minKinds: 6, kinds: ['a', 'b', 'c', 'd', 'e'] } }), 'params.minKinds');
});

test('regex-looking keywords are plain text and are stored verbatim', () => {
  assert.deepEqual(accepted(minimal('event', { scope: { keywords: ['.*', '(a+)+$', '['] } })).scope.keywords, ['.*', '(a+)+$', '[']);
});

// ─── maxLevel ────────────────────────────────────────────────────────────────

test('an event rule may cap its level with maxLevel; without it nothing is stored', () => {
  assert.deepEqual(accepted(MINIMAL.event).params, { minLevel: 'high' });
  assert.deepEqual(accepted(minimal('event', { params: { minLevel: 'high', maxLevel: undefined } })).params, { minLevel: 'high' });
  assert.deepEqual(accepted(minimal('event', { params: { minLevel: 'high', maxLevel: 'high' } })).params, { minLevel: 'high', maxLevel: 'high' });
  assert.deepEqual(accepted(minimal('event', { params: { minLevel: 'watch', maxLevel: 'critical' } })).params, { minLevel: 'watch', maxLevel: 'critical' });
});

test('maxLevel must be a level that is not below minLevel', () => {
  for (const minLevel of LEVELS) {
    for (const maxLevel of LEVELS) {
      const input = minimal('event', { params: { minLevel, maxLevel } });
      if (levelRank(maxLevel) >= levelRank(minLevel)) assert.equal(accepted(input).params.maxLevel, maxLevel, `${minLevel}..${maxLevel}`);
      else rejected(input, 'params.maxLevel');
    }
  }
  for (const maxLevel of ['auto', 'urgent', 'HIGH', 5, null, {}, ['high']]) rejected(minimal('event', { params: { maxLevel } }), 'params.maxLevel');
});

test('maxLevel exists on event rules only', () => {
  for (const kind of RULE_KINDS.filter(item => item !== 'event')) rejected(minimal(kind, { params: { maxLevel: 'high' } }), 'params.maxLevel');
});

test('an override can set maxLevel, but not below minLevel', () => {
  const rule = mergeRules(DEFAULT_RULES, [{ id: 'hungary-region', override: { params: { minLevel: 'watch', maxLevel: 'high' } } }]).find(item => item.id === 'hungary-region');
  assert.equal(rule.source, 'override');
  assert.deepEqual(rule.params, { minLevel: 'watch', maxLevel: 'high' });
  const invalid = mergeRules(DEFAULT_RULES, [{ id: 'hungary-region', override: { params: { minLevel: 'high', maxLevel: 'watch' } } }]).find(item => item.id === 'hungary-region');
  assert.equal(invalid.source, 'builtin');
  assert.deepEqual(invalid.params, { minLevel: 'watch' });
});

// ─── validateRule: rejections ────────────────────────────────────────────────

test('common fields are rejected with the failing field', () => {
  rejected(minimal('event', { id: 'A b' }), 'id');
  rejected(minimal('event', { id: 'Upper' }), 'id');
  rejected(minimal('event', { id: '' }), 'id');
  rejected(minimal('event', { id: 'a'.repeat(41) }), 'id');
  rejected(minimal('event', { id: 'a_b' }), 'id');
  rejected(minimal('event', { id: 'abc\n' }), 'id');
  rejected(minimal('event', { id: 7 }), 'id');
  rejected((({ id, ...rest }) => rest)(minimal('event')), 'id');
  rejected(minimal('event', { name: 'n'.repeat(81) }), 'name');
  rejected(minimal('event', { name: '' }), 'name');
  rejected(minimal('event', { name: '   ' }), 'name');
  rejected(minimal('event', { name: 'two\nlines' }), 'name');
  rejected(minimal('event', { name: 5 }), 'name');
  rejected((({ name, ...rest }) => rest)(minimal('event')), 'name');
  rejected(minimal('event', { kind: 'banana' }), 'kind');
  rejected(minimal('event', { kind: 'toString' }), 'kind');
  rejected((({ kind, ...rest }) => rest)(minimal('event')), 'kind');
  rejected(minimal('event', { enabled: 'yes' }), 'enabled');
  rejected(minimal('event', { enabled: 1 }), 'enabled');
  rejected(minimal('event', { notify: null }), 'notify');
  rejected(minimal('event', { severity: 'urgent' }), 'severity');
  rejected(minimal('event', { severity: 'HIGH' }), 'severity');
  rejected(minimal('event', { severity: 3 }), 'severity');
  rejected(minimal('threshold', { severity: 'auto' }), 'severity');
  for (const forSweeps of [0, 11, 1.5, -1, '2', NaN, Infinity, null]) rejected(minimal('event', { forSweeps }), 'forSweeps');
  for (const cooldownMinutes of [-1, 1441, 0.5, '30', NaN, Infinity]) rejected(minimal('event', { cooldownMinutes }), 'cooldownMinutes');
});

test('unknown fields are rejected at every level', () => {
  rejected({ ...minimal('event'), extra: 1 }, 'extra');
  rejected({ ...minimal('event'), source: 'user' }, 'source');
  rejected(minimal('threshold', { params: { bogus: 1 } }), 'params.bogus');
  rejected(minimal('event', { scope: { bogus: 1 } }), 'scope.bogus');
  rejected(minimal('event', { scope: { radius: { lat: 1, lon: 1, km: 1, bogus: 1 } } }), 'scope.radius.bogus');
  rejected(minimal('threshold', { params: { pct: 5 } }), 'params.pct');
  rejected(minimal('event', { params: { metric: 'vix' } }), 'params.metric');
});

test('threshold parameters', () => {
  rejected(minimal('threshold', { params: { op: '==' } }), 'params.op');
  rejected(minimal('threshold', { params: { op: '=>' } }), 'params.op');
  rejected(minimal('threshold', { params: { op: 5 } }), 'params.op');
  rejected(minimal('threshold', { params: { metric: 'nope' } }), 'params.metric');
  rejected(minimal('threshold', { params: { metric: 'constructor' } }), 'params.metric');
  rejected(minimal('threshold', { params: { metric: 7 } }), 'params.metric');
  for (const value of [NaN, Infinity, -Infinity, '5', null, true, {}, [5]]) rejected(minimal('threshold', { params: { value } }), 'params.value');
  for (const clearValue of [NaN, Infinity, '5', null]) rejected(minimal('threshold', { params: { clearValue } }), 'params.clearValue');
  rejected(minimal('threshold', { params: { metric: undefined } }), 'params.metric');
  rejected(minimal('threshold', { params: { value: undefined } }), 'params.value');
  rejected((({ params, ...rest }) => rest)(minimal('threshold')), 'params');
  rejected({ ...minimal('threshold'), params: null }, 'params');
  rejected({ ...minimal('threshold'), params: [] }, 'params');
});

test('a threshold clearValue must lie on the clearing side of the threshold', () => {
  accepted(minimal('threshold', { params: { op: '>', value: 30, clearValue: 28 } }));
  accepted(minimal('threshold', { params: { op: '>=', value: 30, clearValue: 30 } }));
  accepted(minimal('threshold', { params: { op: '<', value: 5, clearValue: 6 } }));
  accepted(minimal('threshold', { params: { op: '<=', value: 5, clearValue: 5 } }));
  rejected(minimal('threshold', { params: { op: '>', value: 30, clearValue: 31 } }), 'params.clearValue');
  rejected(minimal('threshold', { params: { op: '>=', value: 30, clearValue: 40 } }), 'params.clearValue');
  rejected(minimal('threshold', { params: { op: '<', value: 5, clearValue: 4 } }), 'params.clearValue');
  rejected(minimal('threshold', { params: { op: '<=', value: 5, clearValue: 0 } }), 'params.clearValue');
});

test('change parameters', () => {
  for (const pct of [0, 0.09, 101, -5, NaN, Infinity, '5', null]) rejected(minimal('change', { params: { pct } }), 'params.pct');
  rejected(minimal('change', { params: { metric: 'nope' } }), 'params.metric');
  rejected((({ params, ...rest }) => rest)(minimal('change')), 'params');
});

test('absence parameters', () => {
  for (const minFailSweeps of [0, 51, 1.5, '3', NaN, null]) rejected(minimal('absence', { params: { minFailSweeps } }), 'params.minFailSweeps');
  for (const maxAgeMinutes of [0, 43201, 1.5, '90', NaN, null]) rejected(minimal('absence', { params: { maxAgeMinutes } }), 'params.maxAgeMinutes');
  for (const source of ['', '   ', 'x'.repeat(41), 7, null, 'a\u0000b']) rejected(minimal('absence', { params: { source } }), 'params.source');
  rejected(minimal('absence', { params: { minFailSweeps: undefined } }), 'params.minFailSweeps');
});

test('convergence parameters', () => {
  for (const cellDegrees of [3, 0, 8, 2.5, '2', null]) rejected(minimal('convergence', { params: { cellDegrees } }), 'params.cellDegrees');
  for (const minKinds of [1, 7, 2.5, '3', null]) rejected(minimal('convergence', { params: { minKinds } }), 'params.minKinds');
  for (const windowHours of [5, 73, 12.5, '24', null]) rejected(minimal('convergence', { params: { windowHours } }), 'params.windowHours');
  rejected(minimal('convergence', { params: { minLevel: 'urgent' } }), 'params.minLevel');
  rejected(minimal('convergence', { params: { kinds: 'conflict' } }), 'params.kinds');
  rejected(minimal('convergence', { params: { kinds: ['conflict', 'Not A Kind'] } }), 'params.kinds[1]');
  rejected(minimal('convergence', { params: { kinds: ['conflict', 4] } }), 'params.kinds[1]');
  rejected(minimal('convergence', { params: { kinds: Array.from({ length: 21 }, (_, index) => `k${index}`) } }), 'params.kinds');
  rejected(minimal('convergence', { params: { minKinds: 4, kinds: ['conflict', 'outage', 'health'] } }), 'params.minKinds');
  accepted(minimal('convergence', { params: { minKinds: 3, kinds: ['conflict', 'outage', 'health'] } }));
  accepted(minimal('convergence', { params: { minKinds: 3, kinds: ['conflict', 'outage', 'health', 'conflict'] } }));
  rejected(minimal('convergence', { params: { minKinds: 3, kinds: ['conflict', 'outage', 'conflict'] } }), 'params.minKinds');
});

test('delta and event parameters', () => {
  for (const minSeverity of ['watch', 'info', 'auto', 'CRITICAL', 5, null]) rejected(minimal('delta', { params: { minSeverity } }), 'params.minSeverity');
  for (const minLevel of ['auto', 'urgent', 5, null]) rejected(minimal('event', { params: { minLevel } }), 'params.minLevel');
  rejected((({ params, ...rest }) => rest)(minimal('event')), 'params');
  rejected((({ params, ...rest }) => rest)(minimal('delta')), 'params');
  rejected({ ...minimal('delta'), params: {} }, 'params.minSeverity');
});

test('scope rules', () => {
  for (const kind of RULE_KINDS.filter(item => item !== 'event')) {
    rejected(minimal(kind, { scope: {} }), 'scope');
    rejected(minimal(kind, { scope: { keywords: ['x'] } }), 'scope');
  }
  rejected({ ...minimal('event'), scope: 'everywhere' }, 'scope');
  rejected({ ...minimal('event'), scope: null }, 'scope');
  rejected({ ...minimal('event'), scope: [] }, 'scope');
  const keywords = n => Array.from({ length: n }, (_, index) => `word${index}`);
  rejected(minimal('event', { scope: { keywords: keywords(11) } }), 'scope.keywords');
  rejected(minimal('event', { scope: { keywords: ['ok', 'ok2', 'ok3', 'x'.repeat(41)] } }), 'scope.keywords[3]');
  rejected(minimal('event', { scope: { keywords: ['ok', 5] } }), 'scope.keywords[1]');
  rejected(minimal('event', { scope: { keywords: ['ok', null] } }), 'scope.keywords[1]');
  rejected(minimal('event', { scope: { keywords: ['ok', ''] } }), 'scope.keywords[1]');
  rejected(minimal('event', { scope: { keywords: ['ok', '   '] } }), 'scope.keywords[1]');
  rejected(minimal('event', { scope: { keywords: ['a\nb'] } }), 'scope.keywords[0]');
  rejected(minimal('event', { scope: { keywords: 'war' } }), 'scope.keywords');
  rejected(minimal('event', { scope: { keywords: { length: 1, 0: 'x' } } }), 'scope.keywords');
  rejected(minimal('event', { scope: { keywords: new Array(3) } }), 'scope.keywords[0]');
  rejected(minimal('event', { scope: { kinds: ['Conflict'] } }), 'scope.kinds[0]');
  rejected(minimal('event', { scope: { kinds: [7] } }), 'scope.kinds[0]');
  rejected(minimal('event', { scope: { kinds: Array.from({ length: 21 }, (_, index) => `k${index}`) } }), 'scope.kinds');
  rejected(minimal('event', { scope: { sources: ['GDACS', 'x'.repeat(41)] } }), 'scope.sources[1]');
  rejected(minimal('event', { scope: { sources: Array.from({ length: 21 }, (_, index) => `s${index}`) } }), 'scope.sources');
  rejected(minimal('event', { scope: { radius: 'near' } }), 'scope.radius');
  rejected(minimal('event', { scope: { radius: { lat: 91, lon: 0, km: 10 } } }), 'scope.radius.lat');
  rejected(minimal('event', { scope: { radius: { lat: -91, lon: 0, km: 10 } } }), 'scope.radius.lat');
  rejected(minimal('event', { scope: { radius: { lat: 0, lon: 181, km: 10 } } }), 'scope.radius.lon');
  rejected(minimal('event', { scope: { radius: { lat: 0, lon: 0, km: 0 } } }), 'scope.radius.km');
  rejected(minimal('event', { scope: { radius: { lat: 0, lon: 0, km: 0.5 } } }), 'scope.radius.km');
  rejected(minimal('event', { scope: { radius: { lat: 0, lon: 0, km: 3001 } } }), 'scope.radius.km');
  rejected(minimal('event', { scope: { radius: { lat: NaN, lon: 0, km: 10 } } }), 'scope.radius.lat');
  rejected(minimal('event', { scope: { radius: { lat: 0, lon: Infinity, km: 10 } } }), 'scope.radius.lon');
  rejected(minimal('event', { scope: { radius: { lat: '1', lon: 0, km: 10 } } }), 'scope.radius.lat');
  rejected(minimal('event', { scope: { radius: { lat: 0, lon: 0 } } }), 'scope.radius.km');
  rejected(minimal('event', { scope: { radius: {} } }), 'scope.radius.lat');
});

test('empty scope lists are dropped and duplicate entries collapse', () => {
  assert.deepEqual(accepted(minimal('event', { scope: { kinds: [], sources: [], keywords: [] } })).scope, {});
  assert.deepEqual(accepted(minimal('event', { scope: { kinds: ['conflict', 'conflict', 'outage'], keywords: ['a', 'b', 'a'] } })).scope, { kinds: ['conflict', 'outage'], keywords: ['a', 'b'] });
  assert.deepEqual(accepted(minimal('event', { scope: { keywords: [' war ', 'Ünïcode'] } })).scope, { keywords: [' war ', 'Ünïcode'] });
});

// ─── validateRule: hostile input ─────────────────────────────────────────────

test('non-object input is rejected', () => {
  for (const input of [null, undefined, [], [MINIMAL.event], 'event', '', 5, true, () => ({}), Symbol('x')]) rejected(input, 'rule');
});

test('only plain data objects are accepted', () => {
  class Rule { constructor() { Object.assign(this, MINIMAL.event); } }
  rejected(new Rule(), 'rule');
  rejected(new Map(), 'rule');
  rejected(new Date(), 'rule');
  rejected({ ...minimal('event'), params: new Map() }, 'params');
  rejected(minimal('event', { scope: Object.assign(Object.create({ keywords: ['x'] }), { kinds: ['conflict'] }) }), 'scope');
  accepted(Object.assign(Object.create(null), minimal('event')));
});

test('prototype-pollution keys are rejected wherever they appear', () => {
  rejected(JSON.parse('{"__proto__":{"x":1}}'), '__proto__');
  rejected(JSON.parse('{"id":"a","name":"A","kind":"event","params":{"minLevel":"high"},"__proto__":{"polluted":true}}'), '__proto__');
  rejected(JSON.parse('{"id":"a","name":"A","kind":"event","params":{"minLevel":"high","__proto__":{"polluted":true}}}'), 'params.__proto__');
  rejected(JSON.parse('{"id":"a","name":"A","kind":"event","params":{"minLevel":"high"},"scope":{"__proto__":{"polluted":true}}}'), 'scope.__proto__');
  rejected(JSON.parse('{"id":"a","name":"A","kind":"event","params":{"minLevel":"high"},"scope":{"radius":{"lat":1,"lon":1,"km":1,"constructor":{}}}}'), 'scope.radius.constructor');
  rejected({ ...minimal('event'), constructor: { prototype: { x: 1 } } }, 'constructor');
  rejected({ ...minimal('event'), prototype: {} }, 'prototype');
  assert.equal({}.polluted, undefined);
  assert.equal({}.x, undefined);
});

test('a huge keywords array is rejected by its length, not by walking it', () => {
  const started = process.hrtime.bigint();
  rejected(minimal('event', { scope: { keywords: new Array(10_000).fill('x') } }), 'scope.keywords');
  rejected(minimal('event', { scope: { keywords: new Array(1_000_000) } }), 'scope.keywords');
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 200, 'rejected without iterating the entries');
});

test('oversized and hostile strings are rejected or echoed truncated', () => {
  rejected(minimal('event', { name: 'x'.repeat(1_000_000) }), 'name');
  const error = rejected({ ...minimal('event'), ['k'.repeat(500)]: 1 }, `${'k'.repeat(40)}…`);
  assert.ok(error.message.length < 200);
  rejected(minimal('event', { scope: { keywords: ['a\u0000b'] } }), 'scope.keywords[0]');
  rejected(minimal('event', { name: 'a' + String.fromCharCode(0x202e) + 'b\u0007' }), 'name');
});

test('every control, separator and bidi character is rejected on its own and inside text, in every text field', () => {
  // U+202E and U+2067 are bidi overrides/isolates, U+2028 a line separator, U+0085 a C1 control.
  for (const char of ['\u202e', '\u2067', '\u2028', '\u0085', '\u202a', '\u2066', '\u2069', '\u2029', '\u007f', '\u009f', '\t']) {
    for (const text of [char, `a${char}b`]) {
      rejected(minimal('event', { name: text }), 'name');
      rejected(minimal('event', { scope: { keywords: ['ok', text] } }), 'scope.keywords[1]');
      rejected(minimal('event', { scope: { sources: [text] } }), 'scope.sources[0]');
      rejected(minimal('absence', { params: { source: text } }), 'params.source');
    }
  }
});

test('the field echoed for an unknown key only contains path characters', () => {
  assert.equal(rejected({ ...minimal('event'), ['bad key<script>\n\u202e']: 1 }, 'bad?key?script???').message, 'is not a known field');
  rejected(minimal('threshold', { params: { 'x"y': 1 } }), 'params.x?y');
  rejected(minimal('event', { scope: { radius: { lat: 1, lon: 1, km: 1, '\u0000\u2028': 1 } } }), 'scope.radius.??');
  rejected({ ...minimal('event'), 'a[0]-b.c_d': 1 }, 'a[0]-b.c_d');
  rejected({ ...minimal('event'), [`${'k'.repeat(39)}<${'k'.repeat(20)}`]: 1 }, `${'k'.repeat(39)}?…`);
});

// ─── validateRule: a polluted Object.prototype ───────────────────────────────

// Properties are non-enumerable so nothing else in the process reacts to them; they are removed before the caller asserts.
function withPolluted(props, run) {
  for (const [key, value] of Object.entries(props)) Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true, enumerable: false });
  try { return run(); } finally { for (const key of Object.keys(props)) delete Object.prototype[key]; }
}

test('validateRule ignores id, scope and params inherited from a polluted Object.prototype', () => {
  const { id, params, ...noIdNoParams } = minimal('event');
  // Built before the pollution: minimal() itself destructures `scope` from an empty object.
  const withoutScope = minimal('threshold');
  const eventInput = minimal('event');
  const [noId, noParams, scopeOnThreshold, eventScope, optsId] = withPolluted(
    { id: 'polluted-id', params: { minLevel: 'info' }, scope: { keywords: ['leak'] } },
    () => [
      validateRule({ ...noIdNoParams, params: { minLevel: 'high' } }),
      validateRule({ id: 'e', name: 'E', kind: 'event' }),
      validateRule(withoutScope),
      validateRule(eventInput),
      validateRule({ name: 'E', kind: 'event', params: { minLevel: 'high' } }, {}),
    ],
  );
  assert.equal(noId.ok, false);
  assert.equal(noId.error.field, 'id');
  assert.equal(noParams.ok, false);
  assert.equal(noParams.error.field, 'params');
  assert.equal(scopeOnThreshold.ok, true, 'an inherited scope is not a scope on a threshold rule');
  assert.equal('scope' in scopeOnThreshold.rule, false);
  assert.deepEqual(eventScope.rule.scope, {});
  assert.equal(optsId.ok, false);
  assert.equal(optsId.error.field, 'id', 'an inherited id never fills in the opts id');
});

test('mergeRules ignores id, override and rule inherited from a polluted Object.prototype', () => {
  const merged = withPolluted(
    { id: 'polluted-id', override: { enabled: false }, rule: userRule('polluted-id') },
    () => mergeRules(DEFAULT_RULES, [{ id: 'vix-spike' }, {}, { id: 'polluted-id' }, { rule: userRule('polluted-id') }]),
  );
  assert.deepEqual(merged.map(rule => rule.id), DEFAULT_RULES.map(rule => rule.id));
  assert.ok(merged.every(rule => rule.source === 'builtin'));
  assert.equal(merged.find(rule => rule.id === 'vix-spike').enabled, true);
});

test('accessor properties are not read', () => {
  let called = false;
  const input = minimal('event');
  Object.defineProperty(input, 'name', { enumerable: true, get() { called = true; return 'x'; } });
  rejected(input, 'name');
  assert.equal(called, false);
  const scoped = minimal('event', { scope: { keywords: ['ok'] } });
  Object.defineProperty(scoped.scope.keywords, 0, { get() { called = true; return 'x'; } });
  rejected(scoped, 'scope.keywords[0]');
  assert.equal(called, false);
});

test('symbol keys are rejected', () => {
  rejected({ ...minimal('event'), [Symbol('x')]: 1 }, 'rule');
});

test('validateRule never throws and never mutates its input', () => {
  const garbage = [undefined, null, 0, NaN, '', 'x', [], [[]], {}, { id: {} }, { id: 'a', name: 'A', kind: ['event'] }, { id: 'a', name: 'A', kind: 'event', params: { minLevel: {} } }, { id: 'a', name: 'A', kind: 'threshold', params: { metric: [], op: {}, value: {} } }, Object.create(null)];
  for (const input of garbage) assert.doesNotThrow(() => validateRule(input), JSON.stringify(input));
  for (const kind of RULE_KINDS) {
    const input = minimal(kind);
    const before = JSON.stringify(input);
    validateRule(input);
    assert.equal(JSON.stringify(input), before);
  }
});

test('a validated rule is a fresh plain object that shares nothing with the input', () => {
  const input = minimal('event', { scope: { kinds: ['conflict'], keywords: ['one'], radius: { lat: 1, lon: 2, km: 3 } } });
  const rule = accepted(input);
  const snapshot = clone(rule);
  assert.notEqual(rule, input);
  assert.notEqual(rule.params, input.params);
  assert.notEqual(rule.scope, input.scope);
  assert.notEqual(rule.scope.kinds, input.scope.kinds);
  assert.notEqual(rule.scope.radius, input.scope.radius);
  assert.equal(Object.getPrototypeOf(rule), Object.prototype);
  assert.equal(Object.getPrototypeOf(rule.scope), Object.prototype);
  assert.equal(Object.isFrozen(rule), false);
  input.name = 'changed';
  input.params.minLevel = 'critical';
  input.scope.kinds.push('outage');
  input.scope.keywords[0] = 'two';
  input.scope.radius.km = 999;
  input.extra = true;
  assert.deepEqual(rule, snapshot);
  rule.params.minLevel = 'info';
  assert.equal(accepted(minimal('event')).params.minLevel, 'high');
});

test('opts.id supplies or must match the rule id', () => {
  const { id, ...withoutId } = minimal('event');
  assert.equal(accepted(withoutId, { id: 'from-path' }).id, 'from-path');
  assert.equal(accepted({ ...withoutId, id: 'same' }, { id: 'same' }).id, 'same');
  rejected({ ...withoutId, id: 'other' }, 'id', { id: 'from-path' });
  rejected(withoutId, 'id', { id: 'BAD ID' });
  assert.equal(accepted(minimal('event'), {}).id, 'e');
  assert.equal(accepted(minimal('event'), null).id, 'e');
});

// ─── mergeRules ──────────────────────────────────────────────────────────────

const userRule = (id, kind = 'delta') => ({ ...clone(MINIMAL[kind]), id, name: `User ${id}` });

test('mergeRules marks sources and keeps user rules after the built-ins', () => {
  const merged = mergeRules(DEFAULT_RULES, [
    { id: 'zeta', rule: userRule('zeta') },
    { id: 'vix-spike', override: { enabled: false } },
    { id: 'alpha', rule: userRule('alpha', 'change') },
  ]);
  assert.deepEqual(merged.map(rule => rule.id), [...DEFAULT_RULES.map(rule => rule.id), 'zeta', 'alpha']);
  assert.deepEqual(merged.map(rule => rule.source), ['builtin', 'builtin', 'builtin', 'builtin', 'builtin', 'override', 'builtin', 'builtin', 'builtin', 'user', 'user']);
  assert.equal(merged.find(rule => rule.id === 'vix-spike').enabled, false);
  assert.equal(merged.find(rule => rule.id === 'zeta').name, 'User zeta');
});

test('with no user records the built-ins come back as builtin copies', () => {
  const merged = mergeRules(DEFAULT_RULES, []);
  assert.deepEqual(merged.map(({ source, ...rule }) => rule), clone(DEFAULT_RULES));
  assert.ok(merged.every(rule => rule.source === 'builtin'));
  for (const bad of [undefined, null, 'x', {}, 7]) assert.equal(mergeRules(DEFAULT_RULES, bad).length, DEFAULT_RULES.length);
  assert.deepEqual(mergeRules(undefined, undefined), []);
});

test('an override changes only the whitelisted fields', () => {
  const override = {
    id: 'hijack', name: 'Hijacked', kind: 'delta', source: 'user',
    enabled: false, notify: true, severity: 'critical', forSweeps: 4, cooldownMinutes: 90,
    params: { metric: 'vix', op: '>', value: 40, clearValue: 35 },
  };
  const merged = mergeRules(DEFAULT_RULES, [{ id: 'vix-spike', override }]);
  const rule = merged.find(item => item.id === 'vix-spike');
  const original = DEFAULT_RULES.find(item => item.id === 'vix-spike');
  assert.deepEqual(rule, { ...clone(original), enabled: false, notify: true, severity: 'critical', forSweeps: 4, cooldownMinutes: 90, params: { metric: 'vix', op: '>', value: 40, clearValue: 35 }, source: 'override' });
  assert.equal(merged.length, DEFAULT_RULES.length);
});

test('an event override can replace the scope and params wholesale', () => {
  const merged = mergeRules(DEFAULT_RULES, [{ id: 'hungary-region', override: { scope: { radius: { lat: 48, lon: 20, km: 100 }, keywords: ['flood'] }, params: { minLevel: 'high' } } }]);
  const rule = merged.find(item => item.id === 'hungary-region');
  assert.deepEqual(rule.scope, { radius: { lat: 48, lon: 20, km: 100 }, keywords: ['flood'] });
  assert.deepEqual(rule.params, { minLevel: 'high' });
  assert.equal(rule.source, 'override');
});

test('an override that would make the rule invalid, or is empty, leaves the built-in alone', () => {
  const cases = [
    { enabled: 'no' },
    { severity: 'auto' },
    { params: { value: 40 } },
    { params: { metric: 'nope', op: '>', value: 1 } },
    { scope: { keywords: ['x'] } },
    { forSweeps: 99 },
    {},
    { name: 'only ignored fields', kind: 'delta' },
    JSON.parse('{"__proto__":{"enabled":false},"params":{"__proto__":{"x":1}}}'),
    null,
    'enabled',
    [],
  ];
  for (const override of cases) {
    const merged = mergeRules(DEFAULT_RULES, [{ id: 'vix-spike', override }]);
    const rule = merged.find(item => item.id === 'vix-spike');
    assert.equal(rule.source, 'builtin', JSON.stringify(override));
    const { source, ...bare } = rule;
    assert.deepEqual(bare, clone(DEFAULT_RULES.find(item => item.id === 'vix-spike')), JSON.stringify(override));
  }
  assert.equal({}.enabled, undefined);
});

test('an override for an unknown built-in is ignored', () => {
  const merged = mergeRules(DEFAULT_RULES, [{ id: 'no-such-rule', override: { enabled: false } }]);
  assert.equal(merged.length, DEFAULT_RULES.length);
  assert.ok(merged.every(rule => rule.id !== 'no-such-rule'));
});

test('invalid, colliding and duplicate user records are skipped', () => {
  const merged = mergeRules(DEFAULT_RULES, [
    { id: 'bad-kind', rule: { ...userRule('bad-kind'), kind: 'banana' } },
    { id: 'mismatch', rule: userRule('other-id') },
    { id: 'events-critical', rule: userRule('events-critical') },
    { id: 'dupe', rule: userRule('dupe') },
    { id: 'dupe', rule: { ...userRule('dupe'), name: 'Second' } },
    { id: 'no-rule' },
    { id: 'BAD ID', rule: userRule('BAD ID') },
    { id: 7, rule: userRule('seven') },
    null,
    'x',
    { rule: userRule('no-record-id') },
    { id: 'good', rule: userRule('good') },
  ]);
  const users = merged.filter(rule => rule.source === 'user');
  assert.deepEqual(users.map(rule => [rule.id, rule.name]), [['dupe', 'User dupe'], ['good', 'User good']]);
  assert.equal(merged.find(rule => rule.id === 'events-critical').source, 'builtin');
  assert.equal(merged.find(rule => rule.id === 'events-critical').name, DEFAULT_RULES[0].name);
});

test('at most MAX_USER_RULES user rules are returned', () => {
  const records = Array.from({ length: MAX_USER_RULES + 20 }, (_, index) => ({ id: `user-${index}`, rule: userRule(`user-${index}`) }));
  const merged = mergeRules(DEFAULT_RULES, records);
  assert.equal(merged.filter(rule => rule.source === 'user').length, MAX_USER_RULES);
  assert.equal(merged.at(-1).id, `user-${MAX_USER_RULES - 1}`);
});

test('mergeRules output does not alias the built-in pack or the stored records', () => {
  const record = { id: 'mine', rule: minimal('event', { id: 'mine', scope: { keywords: ['a'] } }), override: undefined };
  const merged = mergeRules(DEFAULT_RULES, [record, { id: 'hungary-region', override: { scope: { keywords: ['k'] } } }]);
  for (const rule of merged) {
    assert.equal(Object.isFrozen(rule), false);
    if (rule.params) rule.params.minLevel = 'info';
    rule.name = 'mutated';
  }
  merged.find(rule => rule.id === 'mine').scope.keywords.push('b');
  assert.deepEqual(record.rule.scope.keywords, ['a']);
  assert.equal(record.rule.name, 'E');
  assert.equal(DEFAULT_RULES[0].name, 'Critical events');
  assert.equal(DEFAULT_RULES[0].params.minLevel, 'critical');
  assert.deepEqual(clone(DEFAULT_RULES.find(rule => rule.id === 'hungary-region').scope), { radius: { lat: 47.5, lon: 19, km: 500 } });
});

test('every effective rule is itself valid input for validateRule once its source is dropped', () => {
  const merged = mergeRules(DEFAULT_RULES, [{ id: 'mine', rule: userRule('mine', 'absence') }, { id: 'events-high', override: { notify: false } }]);
  for (const { source, ...rule } of merged) assert.equal(validateRule(rule).ok, true, rule.id);
});

// ─── describeRule ────────────────────────────────────────────────────────────

test('describeRule gives a short one-line English summary of each kind', () => {
  const byId = Object.fromEntries(DEFAULT_RULES.map(rule => [rule.id, rule]));
  assert.equal(describeRule(byId['events-critical']), 'Events at critical or above');
  assert.equal(describeRule(byId['hungary-region']), 'Events at watch or above, within 500 km of 47.5, 19');
  assert.equal(describeRule(byId['vix-spike']), 'VIX > 30');
  assert.equal(describeRule(byId['hy-spread-wide']), 'HY spread > 5');
  assert.equal(describeRule(byId['source-stale']), 'Any source failing or stale for 3 sweeps');
  assert.equal(describeRule(byId['convergence-default']), '3+ event kinds within one 2° cell in 24 h at watch or above');
  assert.equal(describeRule(byId['delta-critical']), 'Delta signals at critical or above');
  assert.equal(describeRule(minimal('change', { params: { metric: 'btc', pct: 7.5 } })), 'Bitcoin moves by 7.5% or more between sweeps');
  assert.equal(describeRule(minimal('threshold', { params: { metric: 'wti', op: '<=', value: 60, clearValue: 62 } })), 'WTI crude <= 60 (clears at 62)');
  assert.equal(describeRule(minimal('absence', { params: { source: 'GDACS', minFailSweeps: 1, maxAgeMinutes: 90 } })), 'GDACS failing or stale for 1 sweep, or older than 90 min');
  assert.equal(describeRule(minimal('event', { scope: { kinds: ['conflict', 'outage'], sources: ['GDACS'], keywords: ['flood', 'quake'] } })), 'Events at high or above, kinds conflict, outage, sources GDACS, keywords flood, quake');
  assert.equal(describeRule(minimal('convergence', { params: { kinds: ['conflict', 'outage'], minKinds: 2, cellDegrees: 1, windowHours: 6, minLevel: 'high' } })), '2+ event kinds (conflict, outage) within one 1° cell in 6 h at high or above');
});

test('describeRule says when an event rule is capped by maxLevel', () => {
  assert.equal(describeRule(DEFAULT_RULES.find(rule => rule.id === 'events-high')), 'Events at exactly high');
  assert.equal(describeRule(minimal('event', { params: { minLevel: 'watch', maxLevel: 'high' } })), 'Events from watch up to high');
  assert.equal(describeRule(minimal('event', { params: { minLevel: 'high', maxLevel: 'critical' } })), 'Events at high or above');
  assert.equal(describeRule(minimal('event', { params: { minLevel: 'critical', maxLevel: 'critical' } })), 'Events at critical or above');
});

test('describeRule truncates every echoed string to 80 characters', () => {
  const text = describeRule({ kind: 'absence', params: { source: 'x'.repeat(200), minFailSweeps: 1 } });
  assert.equal(text, `${'x'.repeat(80)} failing or stale for 1 sweep`);
  assert.equal(describeRule({ kind: 'threshold', params: { metric: 'm'.repeat(81), op: '>', value: 1 } }), `${'m'.repeat(80)} > 1`);
});

test('describeRule tolerates incomplete or hostile rules without throwing', () => {
  for (const input of [undefined, null, 5, 'x', [], {}, { kind: 'banana' }, { kind: 'threshold' }, { kind: 'threshold', params: null }, { kind: 'event', scope: 5 }, { kind: 'absence', params: { source: {} } }, { kind: 'convergence', params: { kinds: 'x' } }]) {
    let text;
    assert.doesNotThrow(() => { text = describeRule(input); }, JSON.stringify(input));
    assert.equal(typeof text, 'string');
    assert.ok(!text.includes('\n'));
  }
  assert.equal(describeRule(null), '');
  assert.equal(describeRule({ kind: 'banana' }), '');
});
