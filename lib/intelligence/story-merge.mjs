// Story merging: one story told in many headlines becomes one thread. The pair rules (linkers.mjs) join two reports when their titles
// share enough words; a story that runs for a day is told in many wordings ("Trump waives Russia sanctions", "Trump puts new Russia
// sanctions on hold", "Kremlin praises Trump's decision"), so it fell into several threads, each a different cluster of wordings. On the
// live data of 2026-10-17 the sanctions waiver was 9 threads, the Starlink restrictions in Ukraine 15, a press secretary's resignation 9.
//
// Here each current thread, and each report of the last 36 hours that is in no thread, gets a profile: the stemmed words of its report
// titles, each weighted by how rare it is among the reports of the last 96 hours (IDF), names (a capital inside a sentence-case title)
// half as much again; function words and reporting verbs carry nothing, nor does a word in more than 5% of the reports. Two profiles alike
// enough (cosine >= 0.45; a lone report joining a thread >= 0.5) are joined by a same-story edge (method 'text', strength 0.6) between their
// two most alike reports, and the thread compute takes it from there.
//   - Centroid linkage: two groups join only when their whole profiles are alike, not when one member of each is (no chaining into a
//     "Trump / Russia / Ukraine" blob); a merged thread stays within 60 members.
//   - Two lone reports are left to the pair rules (no new two-report threads from here); a lone report with fewer than 4 weighted words,
//     or two units sharing fewer than 2, is not joined; units whose times are more than 36 hours apart are not joined.
// Measured on a copy of that live graph: 797 threads became 673; the sanctions story 9 threads -> 4 (the main one 48 members), Starlink
// 15 -> 8, the press secretary 9 -> 3. Of the joins just above the threshold about one in ten was doubtful (two Saudi sports postponements).
import { graphTime } from './graph.mjs';

const HOUR = 3600000;
export const STORY_MERGE = Object.freeze({ tau: 0.45, loneTau: 0.5, maxShare: 0.05, nameBoost: 1.5, windowMs: 36 * HOUR, dfWindowMs: 96 * HOUR,
  maxMembers: 60, strength: 0.6, minWords: 4, minCommon: 2 });
const REPORT_KINDS = new Set(['news', 'osint']);

/** A crude stem: a common English ending off, then at most six letters ("waives", "waiving", "waiver" -> "waiv"). */
export const stem = word => word.replace(/(ing|ed|es|er|s)$/, '').slice(0, 6);
// Function words and reporting verbs: frequent enough to say nothing, rare enough to slip past the IDF.
const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have he her his how if in inside into is it its may '
  + 'more most new no not of on or our out over said say says she so some than that the their them then there these they this those to under up '
  + 'us was we were what when where which while who why will with would you your any all also after again against amid about across behind came '
  + 'come comes get gets got make makes made take takes took tell tells told call calls called show shows set sets just still only now first last '
  + 'next back down off one two three time times day days week weeks year years today report reports update live video watch breaking latest '
  + 'news official officials people says warns deny denies denied plan plans could should know want wants need needs being way').split(' ').map(stem));

const fold = word => word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/['’].*$/, '');
// Words written with a capital inside a title in sentence case: names (Starlink, Zacharia, Graham). Title case tells nothing.
function namesOf(title) {
  const words = String(title || '').match(/[\p{L}][\p{L}\p{N}'’-]*/gu) || [];
  const long = words.filter(word => word.length > 3), upper = long.filter(word => word[0] !== word[0].toLowerCase());
  if (!long.length || upper.length / long.length >= 0.6) return new Set();
  return new Set(words.slice(1).filter(word => word[0] !== word[0].toLowerCase()).map(word => stem(fold(word))));
}
const stemsOf = record => new Set((record.w ?? []).filter(word => !/\d/.test(word)).map(stem).filter(word => word.length >= 3 && !STOP.has(word)));

function cosine(a, b) {
  if (!a.norm || !b.norm) return 0;
  const [small, big] = a.v.size < b.v.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [key, x] of small.v) { const y = big.v.get(key); if (y) dot += x * y; }
  return dot / (a.norm * b.norm);
}
const normOf = v => { let n = 0; for (const x of v.values()) n += x * x; return Math.sqrt(n); };

/**
 * The same-story edges that join the threads (`groups`: member id lists) and the lone reports of one story: `[{a, b, type, s, m}]`.
 * Pure apart from reading `graph`.
 */
export function storyMergeEdges(graph, groups, { now = Date.now(), settings = STORY_MERGE } = {}) {
  const isReport = record => REPORT_KINDS.has(record?.k);
  const reports = graph.recent(now - settings.dfWindowMs).filter(isReport);
  if (!reports.length) return [];
  const df = new Map();
  for (const record of reports) for (const word of stemsOf(record)) df.set(word, (df.get(word) || 0) + 1);
  const total = reports.length;
  const idf = word => { const d = df.get(word) || 0; return d < 2 || d / total > settings.maxShare ? 0 : Math.log(total / d); };
  const profile = records => {
    const v = new Map();
    for (const record of records) {
      const names = namesOf(record.h);
      for (const word of stemsOf(record)) { const weight = idf(word) * (names.has(word) ? settings.nameBoost : 1); if (weight) v.set(word, (v.get(word) || 0) + weight); }
    }
    return { v, norm: normOf(v) };
  };
  // Units: the threads with a report, and the lone reports of the window.
  const units = [];
  const grouped = new Set();
  for (const members of groups) {
    const records = members.map(id => { const record = graph.get(id); return record ? { id, ...record, time: graphTime(record) } : null; }).filter(Boolean);
    for (const record of records) grouped.add(record.id);
    const own = records.filter(isReport);
    if (own.length) units.push({ thread: true, size: members.length, reports: own, first: Math.min(...records.map(r => r.time)), last: Math.max(...records.map(r => r.time)) });
  }
  for (const record of reports) if (!grouped.has(record.id) && record.time >= now - settings.windowMs) units.push({ thread: false, size: 1, reports: [record], first: record.time, last: record.time });
  for (const unit of units) unit.profile = profile(unit.reports);
  // Candidate pairs through shared words.
  const byWord = new Map();
  units.forEach((unit, i) => { for (const word of unit.profile.v.keys()) { if (!byWord.has(word)) byWord.set(word, []); byWord.get(word).push(i); } });
  const pairs = [];
  units.forEach((unit, i) => {
    if (!unit.thread && unit.profile.v.size < settings.minWords) return;
    const seen = new Set();
    for (const word of unit.profile.v.keys()) for (const j of byWord.get(word)) {
      if (j <= i || seen.has(j)) continue;
      seen.add(j);
      const other = units[j];
      if (!unit.thread && !other.thread) continue;
      if (!other.thread && other.profile.v.size < settings.minWords) continue;
      if (other.first - unit.last > settings.windowMs || unit.first - other.last > settings.windowMs) continue;
      let common = 0;
      for (const key of unit.profile.v.keys()) if (other.profile.v.has(key)) common++;
      if (common < settings.minCommon) continue;
      const similarity = cosine(unit.profile, other.profile);
      if (similarity >= (unit.thread && other.thread ? settings.tau : settings.loneTau)) pairs.push([similarity, i, j]);
    }
  });
  pairs.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
  // Centroid linkage with a size cap; the edge goes between the two most alike reports of the two units.
  const parent = units.map((_, i) => i), size = units.map(unit => unit.size), sums = units.map(unit => new Map(unit.profile.v));
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const edges = [];
  for (const [, i, j] of pairs) {
    const a = find(i), b = find(j);
    if (a === b || size[a] + size[b] > settings.maxMembers) continue;
    if ((a !== i || b !== j) && cosine({ v: sums[a], norm: normOf(sums[a]) }, { v: sums[b], norm: normOf(sums[b]) }) < settings.tau) continue;
    let best = null;
    for (const x of units[i].reports) {
      const px = profile([x]);
      for (const y of units[j].reports) {
        const similarity = cosine(px, profile([y]));
        if (!best || similarity > best[0]) best = [similarity, x.id, y.id];
      }
    }
    if (!best || best[1] === best[2]) continue;
    parent[b] = a; size[a] += size[b];
    for (const [key, x] of sums[b]) sums[a].set(key, (sums[a].get(key) || 0) + x);
    edges.push({ a: best[1], b: best[2], type: 'same-story', s: settings.strength, m: 'text' });
  }
  return edges;
}

/** Joins the threads of one story: computes the edges over the threads just computed, links them, and computes the threads again. */
export function mergeStories(graph, threads, { now = Date.now() } = {}) {
  const edges = storyMergeEdges(graph, threads.threads.map(thread => thread.members), { now });
  if (edges.length) {
    graph.link(edges, { now });
    threads.compute(graph, { now });
  }
  return edges.length;
}
