import { eventLevel, levelAtLeast, levelRank } from './levels.mjs';
import { METRICS } from './metrics.mjs';

// Rule evaluators: pure functions from an effective rule and a context to a list of hits.
// They read the context and never write to it (the tests deep-freeze it), do no I/O and read no clock: `ctx.now` is
// the only time. Whether a rule is enabled, how often a hit must repeat (`forSweeps`), cooldowns and the cap on active
// alerts belong to the alert engine; `evaluateRule` only says what matches right now.
//
// Ctx = {snapshot, events, metrics, previousMetrics, health, failStreak(source), isActive(dedupKey), now}
// Hit = {dedupKey, severity, title, summary, entity: {type, id, label?, lat?, lon?}, evidence: [≤ 8], metric?}

const MAX_TITLE = 160;
const MAX_SUMMARY = 600;
const MAX_EVIDENCE = 8;
const MAX_ID = 200;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// Provider times a little ahead of `now` are clock skew; further ahead is not evidence (same limit as apis/utils/freshness.mjs).
const FUTURE_SKEW_MS = 5 * MINUTE_MS;
const EARTH_RADIUS_KM = 6371;
// News, signals, forecasts and economic data do not count as something happening at a place.
const CONVERGENCE_KINDS = Object.freeze(['conflict', 'earthquake', 'weather', 'disaster', 'outage', 'health']);

// ─── small helpers ───────────────────────────────────────────────────────────

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const listOf = value => Array.isArray(value) ? value : [];
const usableId = value => typeof value === 'string' && value !== '' && value.length <= MAX_ID;
const num = value => String(Number(value.toPrecision(6)));
const tidy = value => Number(value.toFixed(6));

// Control characters, line/paragraph separators and bidi overrides never reach a title, summary or label.
const BIDI = new RegExp('[\u202a-\u202e\u2066-\u2069]', 'g');
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028\u2029]', 'g');

/** One line of at most `max` characters (ending in "…" when cut), no control or bidi characters; '' for a non-string. */
function clip(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.slice(0, max * 4).replace(BIDI, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return wholeChars(flat);
  return `${wholeChars(flat.slice(0, max - 1).trimEnd())}…`;
}

// A cut can leave half a surrogate pair at the end.
function wholeChars(text) {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

// Case- and accent-insensitive comparison: "Árvíz" and "arviz" are the same word.
const fold = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

const COMPARE = Object.freeze({
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
});

const METRIC_INFO = new Map(METRICS.map(item => [item.key, { label: item.label, unit: item.unit }]));
const infoOf = key => METRIC_INFO.get(key) ?? { label: clip(String(key), 40), unit: '' };
const withUnit = (value, unit) => unit === '' ? num(value) : `${num(value)} ${unit}`;

/** A metric's value from a metrics table, or null when it is absent or not a finite number. */
function metricOf(table, key) {
  return isObject(table) && Object.hasOwn(table, key) && finite(table[key]) ? table[key] : null;
}

const askActive = (ctx, dedupKey) => typeof ctx.isActive === 'function' && Boolean(ctx.isActive(dedupKey));

// ─── geography ───────────────────────────────────────────────────────────────

const hasCoordinates = place => isObject(place) && finite(place.lat) && finite(place.lon) && Math.abs(place.lat) <= 90 && Math.abs(place.lon) <= 180;

/** Great-circle distance in km between two {lat, lon} points; NaN when either is not a finite coordinate pair. */
export function haversineKm(a, b) {
  if (!isObject(a) || !isObject(b) || !finite(a.lat) || !finite(a.lon) || !finite(b.lat) || !finite(b.lon)) return NaN;
  const radians = degrees => degrees * Math.PI / 180;
  const deltaLat = radians(b.lat - a.lat);
  const deltaLon = radians(b.lon - a.lon);
  const arc = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(arc)));
}

// The grid cell holding a point: cells are `degrees` wide, start at -90/-180, and the pole and the antimeridian belong to
// the last cell. Null for anything that is not a valid coordinate or cell size.
function locate(lat, lon, degrees) {
  if (!finite(lat) || !finite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !finite(degrees) || degrees <= 0) return null;
  const row = Math.min(Math.ceil(180 / degrees) - 1, Math.floor((lat + 90) / degrees));
  const column = Math.min(Math.ceil(360 / degrees) - 1, Math.floor((lon + 180) / degrees));
  const south = tidy(-90 + row * degrees);
  const west = tidy(-180 + column * degrees);
  return { key: `c${num(degrees)}:${south},${west}`, lat: tidy(south + degrees / 2), lon: tidy(west + degrees / 2) };
}

/** A stable key of the grid cell holding the point, or null when the coordinates or the cell size are invalid. */
export function cellOf(lat, lon, degrees) {
  return locate(lat, lon, degrees)?.key ?? null;
}

// ─── scope ───────────────────────────────────────────────────────────────────

// Keywords are plain substrings of title, summary and location label (a newline keeps them apart: keywords cannot hold
// one). Events are built once per sweep and not changed afterwards, so the folded text is cached per event object.
const haystacks = new WeakMap();
function haystackOf(event) {
  let text = haystacks.get(event);
  if (text === undefined) {
    const label = isObject(event.location) ? event.location.label : undefined;
    text = fold([event.title, event.summary, label].filter(part => typeof part === 'string').join('\n'));
    haystacks.set(event, text);
  }
  return text;
}

const sourceNameOf = event => isObject(event.source) && typeof event.source.name === 'string' ? event.source.name : '';

// A predicate for one scope, with the per-rule work (folding the keywords) done once. Every filter has to match; an
// empty list is no filter. A keyword that folds to nothing, or an unusable radius, matches nothing rather than everything.
function compileScope(scope) {
  if (!isObject(scope)) return event => isObject(event);
  const kinds = listOf(scope.kinds).length > 0 ? new Set(scope.kinds) : null;
  const sources = listOf(scope.sources).length > 0 ? new Set(scope.sources.filter(item => typeof item === 'string').map(item => fold(item).trim())) : null;
  const keywords = listOf(scope.keywords).length > 0 ? scope.keywords.filter(item => typeof item === 'string').map(fold).filter(item => item !== '') : null;
  const radius = isObject(scope.radius) ? scope.radius : null;
  const radiusUsable = radius !== null && hasCoordinates(radius) && finite(radius.km);

  return event => {
    if (!isObject(event)) return false;
    if (kinds !== null && !kinds.has(event.kind)) return false;
    if (sources !== null && !sources.has(fold(sourceNameOf(event)).trim())) return false;
    if (keywords !== null) {
      const text = haystackOf(event);
      if (!keywords.some(word => text.includes(word))) return false;
    }
    if (radius !== null) {
      if (!radiusUsable || !hasCoordinates(event.location)) return false;
      if (!(haversineKm(event.location, radius) <= radius.km)) return false;
    }
    return true;
  };
}

/** True when the event satisfies every filter of a rule scope ({kinds, sources, keywords, radius}); no scope matches all events. */
export function matchesScope(event, scope) {
  return compileScope(scope)(event);
}

// ─── hits ────────────────────────────────────────────────────────────────────

function evidenceOf(event, level) {
  return { type: 'event', id: event.id, title: clip(event.title, MAX_TITLE) || 'Untitled event', source: clip(sourceNameOf(event), 120), level };
}

function coordinatesOf(event) {
  return hasCoordinates(event.location) ? { lat: event.location.lat, lon: event.location.lon } : {};
}

function eventHit(rule, event, level) {
  const title = clip(event.title, MAX_TITLE) || 'Untitled event';
  const source = clip(sourceNameOf(event), 120);
  const place = clip(isObject(event.location) ? event.location.label : undefined, 120);
  const summary = clip(event.summary, MAX_SUMMARY) || clip(`${clip(event.kind, 30) || 'unknown'} event from ${source || 'an unknown source'}${place ? ` (${place})` : ''}`, MAX_SUMMARY);
  return {
    dedupKey: `${rule.id}|${event.id}`,
    severity: rule.severity === 'auto' ? level : rule.severity,
    title,
    summary,
    entity: { type: 'event', id: event.id, label: title, ...coordinatesOf(event) },
    evidence: [evidenceOf(event, level)],
  };
}

// ─── event ───────────────────────────────────────────────────────────────────

function evaluateEvent(rule, ctx) {
  const { minLevel, maxLevel = 'critical' } = rule.params;
  const ceiling = levelRank(maxLevel);
  const inScope = compileScope(rule.scope);
  const hits = [];
  for (const event of listOf(ctx.events)) {
    if (!isObject(event) || event.kind === 'signal' || !usableId(event.id)) continue;
    const level = eventLevel(event);
    if (level === null || !levelAtLeast(level, minLevel) || levelRank(level) > ceiling) continue;
    if (!inScope(event)) continue;
    hits.push(eventHit(rule, event, level));
  }
  return hits;
}

// ─── threshold ───────────────────────────────────────────────────────────────

// Count metrics (urgent_posts ... sources_stale) fall to 0 when a provider is down, so a rule such as "conflict_events < 5"
// would fire on an outage. Nothing here treats them differently; the built-in pack has no "below N" rule on a count.
function evaluateThreshold(rule, ctx) {
  const { metric, op, value, clearValue } = rule.params;
  if (!Object.hasOwn(COMPARE, op)) return [];
  const current = metricOf(ctx.metrics, metric);
  if (current === null) return [];

  const dedupKey = `${rule.id}|${metric}`;
  const compare = COMPARE[op];
  const fires = compare(current, value);
  // An alert that is already open holds until the value is on the far side of clearValue. The clear side is the strict
  // complement of the fire predicate applied at clearValue, so `>=` and `<=` ties hold and `>` and `<` ties clear.
  const holds = !fires && clearValue !== undefined && askActive(ctx, dedupKey) && compare(current, clearValue);
  if (!fires && !holds) return [];

  const { label, unit } = infoOf(metric);
  const hysteresis = clearValue === undefined || clearValue === value ? '' : ` and holds while it stays ${op} ${num(clearValue)}`;
  return [{
    dedupKey,
    severity: rule.severity,
    title: clip(`${label} ${num(current)} ${op} ${num(value)}`, MAX_TITLE),
    summary: clip(`${label} is ${withUnit(current, unit)}; the rule fires when it is ${op} ${num(value)}${hysteresis}.`, MAX_SUMMARY),
    entity: { type: 'metric', id: metric, label },
    evidence: [],
    metric: { key: metric, value: current, threshold: value },
  }];
}

// ─── change ──────────────────────────────────────────────────────────────────

function evaluateChange(rule, ctx) {
  const { metric, pct } = rule.params;
  const current = metricOf(ctx.metrics, metric);
  const previous = metricOf(ctx.previousMetrics, metric);
  if (current === null || previous === null || previous === 0) return [];
  const moved = Math.abs(current - previous) * 100 / Math.abs(previous);
  if (!(moved >= pct)) return [];

  const { label, unit } = infoOf(metric);
  return [{
    dedupKey: `${rule.id}|${metric}`,
    severity: rule.severity,
    title: clip(`${label} ${current >= previous ? 'up' : 'down'} ${num(Math.round(moved * 10) / 10)}%`, MAX_TITLE),
    summary: clip(`${label} moved from ${num(previous)} to ${withUnit(current, unit)} between sweeps (threshold ${num(pct)}%).`, MAX_SUMMARY),
    entity: { type: 'metric', id: metric, label },
    evidence: [],
    metric: { key: metric, value: current, previous },
  }];
}

// ─── absence ─────────────────────────────────────────────────────────────────

function formatAge(ms) {
  return ms < 2 * HOUR_MS ? `${Math.round(ms / MINUTE_MS)} min` : `${num(Math.round(ms / HOUR_MS * 10) / 10)} h`;
}

function evaluateAbsence(rule, ctx) {
  const { source, minFailSweeps, maxAgeMinutes } = rule.params;
  const wanted = source === 'any' ? null : fold(source).trim();
  const streakOf = typeof ctx.failStreak === 'function' ? ctx.failStreak : () => 0;
  const hits = [];
  for (const row of listOf(ctx.health)) {
    if (!isObject(row) || !usableId(row.n) || row.disabled) continue;
    if (wanted !== null && fold(row.n).trim() !== wanted) continue;

    const broken = Boolean(row.err || row.stale);
    const streak = broken ? streakOf(row.n) : 0;
    const failing = broken && finite(streak) && streak >= minFailSweeps;
    const ageMs = isObject(row.freshness) ? row.freshness.ageMs : undefined;
    const aged = maxAgeMinutes !== undefined && finite(ageMs) && ageMs > maxAgeMinutes * MINUTE_MS;
    if (!failing && !aged) continue;

    const name = clip(row.n, 80);
    const state = row.err ? 'failing' : 'stale';
    const reasons = [];
    if (failing) reasons.push(`${name} has been ${state} for ${streak} consecutive sweep${streak === 1 ? '' : 's'}`);
    if (aged) reasons.push(`${name} provider data is ${formatAge(ageMs)} old (limit ${formatAge(maxAgeMinutes * MINUTE_MS)})`);
    hits.push({
      dedupKey: `${rule.id}|${row.n}`,
      severity: rule.severity,
      title: clip(failing ? `${name} is ${state}` : `${name} data is outdated`, MAX_TITLE),
      summary: clip(`${reasons.join('. ')}.`, MAX_SUMMARY),
      entity: { type: 'source', id: row.n, label: name },
      evidence: [],
    });
  }
  return hits;
}

// ─── convergence ─────────────────────────────────────────────────────────────

// The time an event is placed at: the provider's own, never the collection time. NaN when there is none.
function providerMs(event) {
  const stamp = event.observedAt || event.publishedAt;
  return typeof stamp === 'string' ? Date.parse(stamp) : NaN;
}

const bySeverityThenRecency = (a, b) => levelRank(b.level) - levelRank(a.level) || b.time - a.time;

// At most MAX_EVIDENCE events: the most severe one of each kind first, then the most severe of the rest.
function pickEvidence(items) {
  const ranked = [...items].sort(bySeverityThenRecency);
  const picked = [];
  const seen = new Set();
  for (const item of ranked) {
    if (picked.length < MAX_EVIDENCE && !seen.has(item.event.kind)) {
      seen.add(item.event.kind);
      picked.push(item);
    }
  }
  for (const item of ranked) {
    if (picked.length < MAX_EVIDENCE && !picked.includes(item)) picked.push(item);
  }
  return picked.sort(bySeverityThenRecency);
}

function evaluateConvergence(rule, ctx) {
  const { cellDegrees, windowHours, minKinds, minLevel } = rule.params;
  if (!finite(ctx.now)) return [];
  const kinds = new Set(Array.isArray(rule.params.kinds) ? rule.params.kinds : CONVERGENCE_KINDS);

  const cells = new Map();
  for (const event of listOf(ctx.events)) {
    if (!isObject(event) || !kinds.has(event.kind) || !usableId(event.id)) continue;
    const level = eventLevel(event);
    if (level === null || !levelAtLeast(level, minLevel)) continue;
    const cell = isObject(event.location) ? locate(event.location.lat, event.location.lon, cellDegrees) : null;
    if (cell === null) continue;
    const time = providerMs(event);
    const age = ctx.now - time;
    if (!(age <= windowHours * HOUR_MS && age >= -FUTURE_SKEW_MS)) continue;

    const group = cells.get(cell.key) ?? { cell, items: [] };
    group.items.push({ event, level, time });
    cells.set(cell.key, group);
  }

  const hits = [];
  for (const { cell, items } of cells.values()) {
    const distinct = [...new Set(items.map(item => item.event.kind))];
    if (distinct.length < minKinds) continue;

    const where = `${cell.lat.toFixed(1)}, ${cell.lon.toFixed(1)}`;
    const named = [...items].sort(bySeverityThenRecency).map(item => clip(item.event.location.label, 80)).find(label => label !== '');
    const place = named ?? where;
    hits.push({
      dedupKey: `${rule.id}|${cell.key}`,
      severity: rule.severity,
      title: clip(`${distinct.length} event kinds converge near ${place}`, MAX_TITLE),
      summary: clip(`Kinds: ${distinct.map(kind => clip(kind, 30)).join(', ')}. ${items.length} events within a ${num(cellDegrees)}° cell centred on ${where}, over the last ${num(windowHours)} h.`, MAX_SUMMARY),
      entity: { type: 'cell', id: cell.key, label: place, lat: cell.lat, lon: cell.lon },
      evidence: pickEvidence(items).map(item => evidenceOf(item.event, item.level)),
    });
  }
  return hits;
}

// ─── delta ───────────────────────────────────────────────────────────────────

// The severity of a delta signal is its own (critical or high, as the delta engine assigns it); the rule only chooses
// the lowest one it wants, so a hit takes the signal's severity and not the rule's.
function evaluateDelta(rule, ctx) {
  const signals = isObject(ctx.snapshot) && isObject(ctx.snapshot.delta) ? ctx.snapshot.delta.signals : undefined;
  if (!isObject(signals)) return [];
  const wanted = rule.params.minSeverity === 'critical' ? ['critical'] : ['critical', 'high'];

  const hits = [];
  for (const list of [signals.new, signals.escalated]) {
    for (const signal of listOf(list)) {
      if (!isObject(signal) || !usableId(signal.key) || !wanted.includes(signal.severity)) continue;
      hits.push(deltaHit(rule, signal));
    }
  }
  return hits;
}

function deltaHit(rule, signal) {
  const label = clip(signal.label, MAX_TITLE);
  const reason = clip(signal.reason, MAX_TITLE);
  const parts = [];
  let title;
  if (label !== '') {
    const direction = signal.direction === 'down' || signal.direction === 'up' ? signal.direction : finite(signal.pctChange) && signal.pctChange < 0 ? 'down' : 'up';
    title = finite(signal.pctChange) ? `${label} ${direction} ${num(Math.abs(signal.pctChange))}%` : label;
    parts.push(reason);
  } else {
    title = reason !== '' ? reason : clip(signal.key, MAX_TITLE);
  }
  parts.push(clip(signal.text, MAX_SUMMARY));
  if (finite(signal.from) && finite(signal.to)) parts.push(`${num(signal.from)} → ${num(signal.to)}`);
  title = clip(title, MAX_TITLE);
  return {
    dedupKey: `${rule.id}|${signal.key}`,
    severity: signal.severity,
    title,
    summary: clip(parts.filter(part => part !== '').join(' · '), MAX_SUMMARY) || title,
    entity: { type: 'signal', id: signal.key, label: title },
    evidence: [],
  };
}

// ─── thread ──────────────────────────────────────────────────────────────────

const THREAD_ID = /^thread-[a-f0-9]{16}$/;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

// A story thread of the sweep (snapshot.threads, the most significant ones) carried by enough sources, record kinds and observations at the
// rule's level or above. The evidence is the thread's own latest members that the sweep still holds.
function evaluateThread(rule, ctx) {
  const { minSources, minKinds, minObservations, minLevel } = rule.params;
  const summary = isObject(ctx.snapshot) && isObject(ctx.snapshot.threads) ? ctx.snapshot.threads : null;
  if (!summary) return [];
  const byId = new Map();
  for (const event of listOf(ctx.events)) if (isObject(event) && usableId(event.id) && !byId.has(event.id)) byId.set(event.id, event);
  const hits = [];
  for (const thread of listOf(summary.top)) {
    if (!isObject(thread) || typeof thread.id !== 'string' || !THREAD_ID.test(thread.id)) continue;
    const kinds = listOf(thread.kinds).filter(kind => typeof kind === 'string' && kind !== '');
    // The rule counts: a model link (lib/llm/linker.mjs) may join a thread but never raises an alert on its own.
    const basis = isObject(thread.rule) ? { sources: count(thread.rule.sources), kinds: count(thread.rule.kinds), observations: count(thread.rule.observations) }
      : { sources: count(thread.sources), kinds: kinds.length, observations: count(thread.observations) };
    if (basis.sources < minSources || basis.kinds < minKinds || basis.observations < minObservations) continue;
    if (!levelAtLeast(thread.maxLevel, minLevel)) continue;
    const items = listOf(thread.members).map(id => byId.get(id)).filter(Boolean)
      .map(event => { const time = providerMs(event); return { event, level: eventLevel(event) ?? 'info', time: Number.isFinite(time) ? time : 0 }; });
    const title = clip(thread.title, 160) || 'Untitled';
    hits.push({
      dedupKey: `${rule.id}|${thread.id}`,
      severity: rule.severity,
      title: clip(`Story thread: ${title}`, MAX_TITLE),
      summary: clip(`${count(thread.memberCount)} records from ${count(thread.sources)} sources (${kinds.map(kind => clip(kind, 30)).join(', ')}), ${count(thread.observations)} observations. Linked by rule (a shared story, place or entity), not confirmed.`, MAX_SUMMARY),
      entity: { type: 'thread', id: thread.id, label: clip(title, 80) },
      evidence: pickEvidence(items).map(item => evidenceOf(item.event, item.level)),
    });
  }
  return hits;
}

// ─── dispatch ────────────────────────────────────────────────────────────────

const EVALUATORS = new Map([
  ['event', evaluateEvent],
  ['threshold', evaluateThreshold],
  ['change', evaluateChange],
  ['absence', evaluateAbsence],
  ['convergence', evaluateConvergence],
  ['delta', evaluateDelta],
  ['thread', evaluateThread],
]);

/**
 * The hits of one effective rule against one context, in a stable order, one per dedupKey (the first wins).
 * An unknown rule kind, a malformed rule or a missing context gives []. `rule.enabled` is not looked at.
 */
export function evaluateRule(rule, ctx) {
  if (!isObject(rule) || !isObject(rule.params) || !isObject(ctx)) return [];
  const evaluate = EVALUATORS.get(rule.kind);
  if (evaluate === undefined) return [];
  const seen = new Set();
  return evaluate(rule, ctx).filter(hit => !seen.has(hit.dedupKey) && seen.add(hit.dedupKey));
}
