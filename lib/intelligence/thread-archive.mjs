// The history behind the story threads, kept in shape by the background maintenance (lib/maintenance.mjs):
//   - backfillGraph: history records of the thread window that the entity graph never saw (the graph started later than the history, or
//     a sweep's graph step failed) are added to it in time order and linked with the same rules, so the current threads cover them too;
//   - ThreadArchive: the threads of each finished day, computed from the history with the same graph and thread code and kept as
//     <runsDir>/intelligence/threads-archive/YYYY-MM-DD.json for 30 days. A day is computed once, as soon as it has ended: its threads as
//     they stood at the end of the day (a thread that carries on is in the next day's file too, and is listed where it ended); a day the
//     history import adds records to is computed again (invalidate). The "Past" threads of the dashboard read only these files and leave out
//     every thread with a member that is still in a current thread, so a story moves from Current to Past when it drops out of the live
//     72-hour window.
// Records are fed chronologically, a page at a time, each page linked at its own time (linkEvents looks back from `now`), with a yield
// between pages: the work never holds the event loop for long.
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonWithBackup, writeJsonAtomicAsync } from '../atomic-json.mjs';
import { GraphStore } from './graph.mjs';
import { ThreadStore } from './threads.mjs';
import { mergeStories } from './story-merge.mjs';
import { graphRecordsOf, linkEvents } from './linkers.mjs';
import { createDictionaries } from './extract.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const WINDOW = 72 * HOUR;          // the thread window (threads.mjs)
const PAGE = 20; // one page of linking stays near or under 100 ms on the main thread
const KEEP_DAYS = 30;
const MAX_PER_DAY = 400;
const MAX_MEMBERS_KEPT = 60;
const VERSION = 1;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const THREAD = /^thread-[a-f0-9]{16}$/;
const iso = ms => new Date(ms).toISOString();
const dayOf = ms => iso(ms).slice(0, 10);
const noYield = async () => {};

/**
 * Feeds `graph` with the history records first seen from `fromMs` to `toMs`, oldest first, a page at a time; a record the graph already
 * holds is skipped. Each page is ingested with its records' own first-sighting times and linked at the time of its newest record.
 * Returns the number of events added.
 */
export async function feedGraph(graph, history, fromMs, toMs, { dictionaries = createDictionaries(), slice = noYield, limit = Infinity, cache = null } = {}) {
  let after = null, added = 0;
  while (added < limit) {
    const page = history.range(iso(fromMs), iso(toMs), { after, limit: PAGE });
    if (!page.length) break;
    after = page.at(-1);
    const fresh = page.filter(record => !graph.events.has(record.id));
    if (fresh.length) {
      const seen = new Map(fresh.map(record => [record.id, Date.parse(record.firstSeenAt)]));
      // Entity extraction (~0.6 ms a record) once per record: the archive's days overlap by 72 hours and share `cache`.
      const made = graphRecordsOf(cache ? fresh.filter(record => !cache.has(record.id)) : fresh, dictionaries);
      if (cache) for (const record of made) cache.set(record.id, record);
      const extracted = cache ? fresh.map(record => cache.get(record.id)).filter(Boolean) : made;
      const records = extracted.map(record => ({ ...record, time: seen.get(record.id) }));
      const now = Math.max(...seen.values());
      const ids = graph.ingest(records, { now });
      if (ids.length) {
        const related = new Map(records.filter(record => record.related.length).map(record => [record.id, record.related]));
        graph.link(linkEvents(ids, graph, { now, related }), { now });
        added += ids.length;
      }
    }
    await slice();
    if (page.length < PAGE) break;
  }
  return added;
}

/**
 * The live graph's backfill: the history records of the last 72 hours (the thread window) that the graph lacks. Returns the number added;
 * the caller recomputes the threads when it is not 0.
 */
export function backfillGraph(graph, history, { now = Date.now(), dictionaries, slice } = {}) {
  return feedGraph(graph, history, now - WINDOW, now, { dictionaries, slice });
}

/** The past threads: one immutable file per finished day, computed once from the history. */
export class ThreadArchive {
  constructor(runsDir, { now = Date.now } = {}) {
    this.runsDir = String(runsDir);
    this.dir = join(this.runsDir, 'intelligence', 'threads-archive');
    this.now = typeof now === 'function' ? now : Date.now;
    this.cache = new Map(); // day -> threads (the files are immutable once written)
  }

  /** The days with an archive file, oldest first. */
  days() {
    try { return readdirSync(this.dir).map(name => name.match(DAY_FILE)?.[1]).filter(Boolean).sort(); } catch { return []; }
  }

  #file(day) {
    if (this.cache.has(day)) return this.cache.get(day);
    const result = readJsonWithBackup(join(this.dir, `${day}.json`), { validate: value => value?.version === VERSION && Array.isArray(value.threads) });
    if (!result.value) return null;
    const file = { threads: result.value.threads.filter(thread => THREAD.test(thread?.id)), computedAt: Date.parse(result.value.computedAt) || 0 };
    this.cache.set(day, file);
    return file;
  }

  /** The threads of `day` (YYYY-MM-DD), or null when the day has no file. */
  read(day) { return this.#file(day)?.threads ?? null; }

  /** The days to compute, oldest first: every finished day (yesterday and before) of the history's retention that has no file. */
  pendingDays(history, { now = this.now() } = {}) {
    const out = [];
    const last = Date.parse(`${dayOf(now - DAY)}T00:00:00.000Z`);
    const first = Math.max(Date.parse(`${dayOf(now - (KEEP_DAYS - 1) * DAY)}T00:00:00.000Z`), this.#oldest(history) ?? Infinity);
    for (let start = first; start <= last; start += DAY) {
      const day = dayOf(start);
      if (!this.#file(day)) out.push(day);
    }
    return out;
  }

  /** Drops the files of `days` so they are computed again (the history gained records of those days). Returns how many went. */
  invalidate(days) {
    let removed = 0;
    for (const day of days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      this.cache.delete(day);
      for (const name of [`${day}.json`, `${day}.json.bak`]) { try { unlinkSync(join(this.dir, name)); removed += name.endsWith('.json') ? 1 : 0; } catch { /* none */ } }
    }
    return removed;
  }

  #oldest(history) {
    const first = history.range(iso(0), iso(this.now()), { limit: 1 })[0];
    return first ? Date.parse(`${first.firstSeenAt.slice(0, 10)}T00:00:00.000Z`) : null;
  }

  /**
   * Computes the threads of `day`: a temporary graph of the history records first seen in the 72 hours before the day's end, the threads as
   * they stood at the end of the day, and of them those whose last member is on that day. Writes the day's file; returns its thread count.
   */
  async computeDay(day, history, { dictionaries = createDictionaries(), slice = noYield, cache = null } = {}) {
    const start = Date.parse(`${day}T00:00:00.000Z`), end = start + DAY - 1;
    const graph = new GraphStore(join(this.runsDir, 'intelligence', '.archive-scratch'), { now: () => end, retentionDays: 5 });
    await feedGraph(graph, history, end - WINDOW, end, { dictionaries, slice, cache });
    const threads = new ThreadStore(join(this.runsDir, 'intelligence', '.archive-scratch'), { now: () => end });
    threads.compute(graph, { now: end });
    // The same story merging as the live threads (story-merge.mjs), so a past day reads like the live list did.
    mergeStories(graph, threads, { now: end });
    await slice();
    const ended = threads.threads.filter(thread => thread.last >= start && thread.last <= end).slice(0, MAX_PER_DAY);
    const titles = new Map();
    const ids = [...new Set(ended.flatMap(thread => thread.members.slice(-MAX_MEMBERS_KEPT)))];
    if (ids.length) for (const [id, record] of history.getMany(ids)) titles.set(id, record);
    const rows = ended.map(thread => {
      const members = thread.members.slice(-MAX_MEMBERS_KEPT);
      const links = [];
      const set = new Set(members);
      for (const id of members) for (const edge of graph.edgesOf(id)) if (set.has(edge.id) && id < edge.id) links.push({ a: id, b: edge.id, type: edge.type, s: edge.s, m: edge.m });
      return {
        ...thread, score: undefined, first: iso(thread.first), last: iso(thread.last), day, members,
        events: [...members].reverse().map(id => {
          const record = graph.get(id), stored = titles.get(id);
          return { id, title: (stored?.title ?? record?.h ?? '').slice(0, 300), kind: record?.k ?? stored?.kind ?? null, level: record?.l ?? null,
            source: stored?.source?.name ?? record?.s ?? null, url: stored?.source?.url ?? null, time: record ? iso(record.time) : null,
            entities: (record?.n ?? []).map(([entity, rel, strength]) => ({ id: entity, type: entity.split(':')[0], label: graph.label(entity), rel, s: strength })) };
        }),
        links,
      };
    });
    mkdirSync(this.dir, { recursive: true });
    const now = this.now();
    await writeJsonAtomicAsync(join(this.dir, `${day}.json`), { version: VERSION, day, computedAt: iso(now), threads: rows });
    this.cache.set(day, { threads: rows, computedAt: now });
    return rows.length;
  }

  /** Drops the days older than the 30 kept. Returns how many files went. */
  prune({ now = this.now() } = {}) {
    const oldest = dayOf(now - (KEEP_DAYS - 1) * DAY);
    let removed = 0;
    for (const day of this.days()) if (day < oldest) {
      for (const name of [`${day}.json`, `${day}.json.bak`]) { try { unlinkSync(join(this.dir, name)); } catch { /* already gone */ } }
      this.cache.delete(day); removed++;
    }
    return removed;
  }

  /**
   * The past threads from `from` to `to` (days, inclusive), newest day first; a thread that carried on into a later archived day shows only
   * where it ended, and one that is still live (`liveIds`, or a member in `liveMembers`: the live store's event -> thread map) not at all.
   * Optional topic and ISO2 country filters.
   */
  list({ from = null, to = null, topic = null, country = null, liveIds = new Set(), liveMembers = null, limit = 200 } = {}) {
    const days = this.days().filter(day => (!from || day >= from) && (!to || day <= to)).reverse();
    const seen = new Set(liveIds);
    const out = [];
    for (const day of days) {
      for (const thread of this.read(day) ?? []) {
        if (seen.has(thread.id)) continue;
        seen.add(thread.id);
        // Still a current story: one of its records belongs to a live thread (whose id may differ: live ids are inherited).
        if (liveMembers && (thread.members ?? []).some(id => liveMembers.has(id))) continue;
        if (topic && thread.topic !== topic) continue;
        if (country && !(thread.countries ?? []).some(row => row.iso2 === country)) continue;
        out.push(thread);
      }
    }
    return { total: out.length, threads: out.slice(0, limit) };
  }

  /** One archived thread by id (the newest day it is in), or null. */
  get(id) {
    if (!THREAD.test(String(id))) return null;
    for (const day of this.days().reverse()) {
      const thread = (this.read(day) ?? []).find(row => row.id === id);
      if (thread) return thread;
    }
    return null;
  }
}
