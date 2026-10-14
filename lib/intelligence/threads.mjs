// Story threads: the events of the last 72 hours that the entity graph links strongly (a shared story, a report and an observation of the same
// strait, site or CVE, observations of different kinds at one place), as connected groups. A thread is a reading aid, not a finding: its
// members are related by the linkers' rules, and its source count is of distinct outlets and providers, not of independent confirmations
// (a wire story syndicated to ten sites is still one story). Recomputed every sweep from the graph; the ids stay stable through
// <runsDir>/intelligence/threads.json, which remembers the thread of each event: a group keeps the id most of its members had before.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.mjs';

const VERSION = 1;
const HOUR = 3600000;
const WINDOW = 72 * HOUR;
// The weakest edge that joins two events into one thread: an entity-assisted same story (0.55), a named and observed strait (0.64), a place
// (0.6), a CVE (0.9). A whole sea (0.4) or a plain-word actor (0.375) only shows as a link on the event.
const MIN_STRENGTH = 0.55;
const MAX_MEMBERS = 60;
const MAX_THREADS = 200;
const SUMMARY_TOP = 12;
const ID = /^event-[a-f0-9]{1,64}$/;
const THREAD = /^thread-[a-f0-9]{16}$/;
const REPORT_KINDS = new Set(['news', 'osint']);
const LEVEL_RANK = Object.freeze({ critical: 3, high: 2, watch: 1, info: 0 });

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rank = level => LEVEL_RANK[level] ?? -1;
const reasonOf = error => error?.code || (error instanceof Error ? error.message : String(error));
const threadId = seed => `thread-${createHash('sha256').update(String(seed)).digest('hex').slice(0, 16)}`;

/** Union-find over ids. */
function components(ids, pairs) {
  const parent = new Map(ids.map(id => [id, id]));
  const find = id => { let root = id; while (parent.get(root) !== root) root = parent.get(root); let node = id; while (parent.get(node) !== root) { const next = parent.get(node); parent.set(node, root); node = next; } return root; };
  for (const [a, b] of pairs) { const x = find(a), y = find(b); if (x !== y) parent.set(x < y ? y : x, x < y ? x : y); }
  const groups = new Map();
  for (const id of ids) { const root = find(id); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(id); }
  return [...groups.values()];
}

/** A thread's status from its members' times: emerging (first member < 6 h ago), active (a member < 24 h), fading (otherwise). */
export function threadStatus(first, last, now) {
  if (now - first < 6 * HOUR) return 'emerging';
  return now - last < 24 * HOUR ? 'active' : 'fading';
}

export class ThreadStore {
  #now;

  /** @param {string} runsDir the file is `<runsDir>/intelligence/threads.json`. */
  constructor(runsDir, { now = Date.now } = {}) {
    this.path = join(String(runsDir), 'intelligence', 'threads.json');
    this.#now = typeof now === 'function' ? now : Date.now;
    this.assign = new Map();
    this.threads = [];
    this.at = null;
    this.status = 'empty';
  }

  /** Read the file (or its .bak). Missing or corrupt gives an empty store; never throws. */
  load() {
    const result = readJsonWithBackup(this.path, { validate: value => object(value) && value.version === VERSION && object(value.assign) });
    this.assign = new Map();
    for (const [event, thread] of Object.entries(result.value?.assign ?? {})) if (ID.test(event) && THREAD.test(thread)) this.assign.set(event, thread);
    this.status = result.source === 'primary' ? 'ok' : result.source === 'backup' ? 'recovered' : result.error ? 'corrupt' : 'empty';
    return this.status;
  }

  /**
   * Recomputes the threads from `graph` (a GraphStore) at `now`: `[{id, title, status, first, last, members, memberCount, kinds, sources,
   * observations, reports, maxLevel, countries, entities, edges}]`, the most significant first, at most 200. Never throws on a sound graph.
   */
  compute(graph, { now = this.#now() } = {}) {
    const since = now - WINDOW;
    const recent = new Map(graph.recent(since).map(record => [record.id, record]));
    const pairs = [];
    const rulePairs = [];
    const edgeCounts = new Map();
    for (const [key, edge] of graph.edges) {
      const [a, b, type] = key.split('|');
      if (edge[0] < MIN_STRENGTH || !recent.has(a) || !recent.has(b)) continue;
      pairs.push([a, b]);
      if (edge[1] !== 'llm') rulePairs.push([a, b]);
      for (const id of [a, b]) {
        if (!edgeCounts.has(id)) edgeCounts.set(id, { 'same-story': 0, 'co-occurs': 0 });
        edgeCounts.get(id)[type]++;
      }
    }
    const linked = [...new Set(pairs.flat())].sort();
    const groups = components(linked, pairs).filter(group => group.length >= 2);
    const assign = new Map();
    const taken = new Set();
    const threads = [];
    // The largest groups choose their id first, so a split leaves the old id with the bigger part.
    for (const group of groups.sort((x, y) => y.length - x.length || (x[0] < y[0] ? -1 : 1))) {
      const members = group.map(id => recent.get(id)).sort((x, y) => x.time - y.time || (x.id < y.id ? -1 : 1));
      const votes = new Map();
      for (const member of members) { const old = this.assign.get(member.id); if (old && !taken.has(old)) votes.set(old, (votes.get(old) || 0) + 1); }
      const inherited = [...votes].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0];
      const id = inherited ?? threadId(members[0].id);
      taken.add(id);
      for (const member of members) assign.set(member.id, id);
      threads.push(this.#describe(id, members, graph, edgeCounts, now, rulePairs));
    }
    threads.sort((x, y) => y.score - x.score || y.last - x.last || (x.id < y.id ? -1 : 1));
    this.threads = threads.slice(0, MAX_THREADS);
    this.assign = assign;
    this.at = now;
    return this.threads;
  }

  #describe(id, members, graph, edgeCounts, now, rulePairs) {
    const kinds = [...new Set(members.map(member => member.k).filter(Boolean))].sort();
    const sources = new Set(members.map(member => member.s).filter(Boolean));
    const reports = members.filter(member => REPORT_KINDS.has(member.k));
    // The counts the rules alone stand behind: the broadest part of the thread that model links (method 'llm') did not join. The alert rule
    // and the corroboration score read these; with no model link they equal the thread's own.
    const ids = new Set(members.map(member => member.id));
    const byId = new Map(members.map(member => [member.id, member]));
    let rule = null;
    for (const part of components([...ids].sort(), rulePairs.filter(([a, b]) => ids.has(a) && ids.has(b)))) {
      const list = part.map(item => byId.get(item));
      const counts = { sources: new Set(list.map(member => member.s).filter(Boolean)).size, kinds: new Set(list.map(member => member.k).filter(Boolean)).size,
        observations: list.filter(member => !REPORT_KINDS.has(member.k)).length };
      if (!rule || counts.sources > rule.sources || (counts.sources === rule.sources && counts.kinds > rule.kinds)) rule = counts;
    }
    const maxLevel = members.reduce((best, member) => rank(member.l) > rank(best) ? member.l : best, null);
    const countries = new Map();
    const entities = new Map();
    for (const member of members) {
      for (const [entity, rel] of member.n) {
        const target = entity.startsWith('country:') ? countries : entities;
        const row = target.get(entity) ?? { id: entity, label: graph.label(entity), count: 0, located: false };
        row.count++;
        if (rel === 'located-in' || rel === 'near') row.located = true;
        target.set(entity, row);
      }
    }
    const order = (x, y) => y.count - x.count || (x.id < y.id ? -1 : 1);
    const edges = { 'same-story': 0, 'co-occurs': 0 };
    for (const member of members) for (const [type, count] of Object.entries(edgeCounts.get(member.id) ?? {})) edges[type] += count;
    for (const type of Object.keys(edges)) edges[type] /= 2;
    // The title: a report's when the thread has one (a headline reads better than a transit count), the most linked one, the more severe one
    // on a tie, then the newest.
    const degree = member => Object.values(edgeCounts.get(member.id) ?? {}).reduce((sum, count) => sum + count, 0);
    const report = member => REPORT_KINDS.has(member.k) && member.h ? 1 : 0;
    const lead = [...members].sort((x, y) => report(y) - report(x) || degree(y) - degree(x) || rank(y.l) - rank(x.l) || y.time - x.time || (x.id < y.id ? -1 : 1))[0];
    const first = members[0].time;
    const last = members.at(-1).time;
    // Significance for the order only: severity, distinct kinds, distinct sources, recency.
    const score = Math.max(0, rank(maxLevel)) * 3 + kinds.length * 2 + Math.min(sources.size, 8) + (now - last < 24 * HOUR ? 2 : 0);
    return {
      id, title: lead.h || '', lead: lead.id, status: threadStatus(first, last, now), first, last,
      members: members.slice(-MAX_MEMBERS).map(member => member.id), memberCount: members.length,
      kinds, sources: sources.size, reports: reports.length, observations: members.length - reports.length, maxLevel,
      countries: [...countries.values()].sort(order).slice(0, 8).map(({ id: entity, count, located }) => ({ iso3: entity.slice(8), count, located })),
      entities: [...entities.values()].sort(order).slice(0, 8).map(({ id: entity, label, count }) => ({ id: entity, type: entity.split(':')[0], label, count })),
      edges, score, rule,
    };
  }

  /** The thread an event belongs to, or null. */
  threadOf(eventId) {
    const id = this.assign.get(eventId);
    return id ? this.threads.find(thread => thread.id === id) ?? null : null;
  }

  /** One thread by id, or null. */
  get(id) {
    return THREAD.test(String(id)) ? this.threads.find(thread => thread.id === id) ?? null : null;
  }

  /** Threads naming a country (ISO3), most significant first. */
  forCountry(iso3) {
    return this.threads.filter(thread => thread.countries.some(row => row.iso3 === iso3));
  }

  /** Write the file atomically. Never throws: false (and a warning) on failure. */
  save(logger = console) {
    try {
      writeJsonAtomic(this.path, { version: VERSION, at: this.at, assign: Object.fromEntries(this.assign) });
      return true;
    } catch (error) {
      try { logger?.warn?.(`[Threads] threads.json not saved (${reasonOf(error)})`); } catch { /* logging never breaks the store */ }
      return false;
    }
  }
}

/** The compact `snapshot.threads` summary: the most significant threads with their first members. */
export function summarizeThreads(threads, now) {
  const list = Array.isArray(threads) ? threads : [];
  return {
    at: finite(now) ? new Date(now).toISOString() : null,
    count: list.length,
    top: list.slice(0, SUMMARY_TOP).map(thread => ({
      id: thread.id, title: thread.title, status: thread.status, first: new Date(thread.first).toISOString(), last: new Date(thread.last).toISOString(),
      memberCount: thread.memberCount, kinds: thread.kinds, sources: thread.sources, reports: thread.reports, observations: thread.observations,
      maxLevel: thread.maxLevel, countries: thread.countries.slice(0, 4), entities: thread.entities.slice(0, 4), members: thread.members.slice(-8), rule: thread.rule,
    })),
  };
}
