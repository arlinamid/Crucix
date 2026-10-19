// Entities of an event record, beyond its country: the chokepoint, military area, threat actor, vulnerability, and the flight, aircraft and
// airline (lib/air/aviation.mjs) it is about. Each comes
// with how it was found (`rel`) and how much it is worth as a link (`s`, 0-1), so that two reports sharing "Bab el-Mandeb" or
// "CVE-2026-1234" can be joined although their titles share no words. Deterministic and bounded: dictionaries and fixed patterns only,
// no regex is built from input, at most MAX_ENTITIES per event. The country rules are entities.mjs's (resolveEventCountries).
import { countryByName, keyOf, stemsOf, words } from './countries.mjs';
import { resolveEventCountries, TEXT_KINDS, TRUSTED_METHODS } from './entities.mjs';
import { CHOKEPOINTS, chokepointAt } from './chokepoints.mjs';
import { militarySiteAt } from './military-sites.mjs';
import { aviationEntities } from '../air/aviation.mjs';

export const ENTITY_TYPES = Object.freeze(['country', 'chokepoint', 'site', 'actor', 'cve', 'flight', 'aircraft', 'airline']);
const MAX_ENTITIES = 12;
const MAX_SCAN = 1200;
const MAX_TOKENS = 16;
const CVE = /\bCVE-(\d{4})-(\d{4,7})\b/gi;
export const STOP_WORDS = new Set(['the', 'and', 'for', 'from', 'with', 'that', 'this', 'are', 'was', 'were', 'has', 'have', 'its', 'his', 'her', 'after',
  'over', 'into', 'amid', 'says', 'said', 'new', 'news', 'report', 'reports', 'update', 'updates', 'breaking', 'live', 'video', 'watch']);
// A plain-word actor name (Turla, Snake, Bitter, CHROMIUM) is also an everyday word or a product: it counts only in a cyber context.
const CYBER_CONTEXT = new Set(['hack', 'hacker', 'hackers', 'hacked', 'hacking', 'cyber', 'cyberattack', 'cyberattacks', 'apt', 'malware', 'ransomware',
  'espionage', 'phishing', 'spyware', 'backdoor', 'exploit', 'exploited', 'botnet', 'intrusion', 'breach', 'ddos', 'wiper', 'threat', 'actor',
  'kibertámadás', 'hackerek', 'hackertámadás', 'cyberangriff', 'hacker', 'cyberattaque', 'piratage', 'кибератака', 'хакеры']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const fold = value => value.normalize('NFKD').replace(/\p{M}/gu, '');

// A short, stable hash for a name with no Latin letters (a site named in Cyrillic or Arabic).
const hashOf = value => { let hash = 5381; for (const char of value) hash = ((hash * 33) ^ char.codePointAt(0)) >>> 0; return hash.toString(36); };
/** A stable id part: folded, lower case, non-alphanumerics as single dashes, at most 60 characters; a hash when no Latin letter is left. */
export const slugOf = value => {
  const text = String(value ?? '');
  const slug = fold(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || (text.trim() ? `h${hashOf(text.trim())}` : '');
};

// phrase key -> hit, longest phrases first; the first entry for a key wins. Matching is case-sensitive on folded words.
function phraseTable(entries) {
  const map = new Map();
  for (const { phrase, hit } of entries) {
    const list = words(phrase);
    if (!list.length) continue;
    const key = keyOf(list, 0, list.length);
    if (!map.has(key)) map.set(key, hit);
  }
  const longest = Math.min(8, Math.max(1, ...[...map.keys()].map(key => key.split(' ').length)));
  return { map, longest };
}

// Every phrase of the table in `list` (words), longest first at each position; inflected last words through stemsOf when `stems`.
function scan({ map, longest }, list, { stems = false } = {}) {
  const hits = [];
  for (let i = 0; i < list.length;) {
    let step = 1;
    for (let size = Math.min(longest, list.length - i); size >= 1; size--) {
      const key = keyOf(list, i, size);
      let hit = map.get(key);
      if (!hit && stems) {
        const head = size > 1 ? keyOf(list, i, size - 1) + ' ' : '';
        const stem = stemsOf(list[i + size - 1]).map(candidate => head + candidate).find(candidate => map.has(candidate));
        hit = stem ? map.get(stem) : undefined;
      }
      if (hit) { hits.push(hit); step = size; break; }
    }
    i += step;
  }
  return hits;
}

// A strait named only as part of a bridge's name ("az isztambuli Boszporusz-hídon", "Bosphorus Bridge") is the city, not the shipping
// lane: such a mention counts at the strength of a broad one (0.5), too weak alone to join a thread (threads.mjs MIN_STRENGTH 0.55).
// A story that names the strait itself as well ("Kerch Strait bridge") keeps the full strength.
const CHOKEPOINT_BY_SLUG = new Map(CHOKEPOINTS.map(entry => [entry.slug, entry]));
const isBridgeWord = word => ['bridge', 'bridges', 'brucke', 'kopru', 'koprusu', 'pont', 'puente', 'ponte', 'most'].includes(word)
  || /^hid(on|at|nal|rol|ja|jan|hoz|ra|ban|bol|ak)?$/.test(word);
function bridgeOnly(list, entry) {
  const heads = (entry?.names ?? []).map(name => words(name)).filter(parts => parts.length === 1).map(parts => parts[0].toLowerCase());
  let named = 0, bridge = 0;
  for (let i = 0; i < list.length; i++) {
    const word = list[i].toLowerCase();
    if (!heads.some(head => word.startsWith(head))) continue;
    named++;
    if (isBridgeWord((list[i + 1] ?? '').toLowerCase())) bridge++;
  }
  return named > 0 && bridge === named;
}

const CHOKEPOINT_TABLE = phraseTable(CHOKEPOINTS.flatMap(entry => [
  ...entry.names.map(phrase => ({ phrase, hit: { slug: entry.slug, label: entry.label, s: 0.8 } })),
  ...entry.broad.map(phrase => ({ phrase, hit: { slug: entry.slug, label: entry.label, s: 0.5 } })),
]));

// The actor table of one MISP release, kept while the release does not change (one per sweep is the normal case).
let actorCache = { key: null, table: null };
function actorTable(actors) {
  const countries = object(actors?.countries) ? actors.countries : null;
  if (!countries) return null;
  const key = `${str(actors.release, 80)}|${Object.keys(countries).length}`;
  if (actorCache.key === key) return actorCache.table;
  const entries = [];
  for (const [iso3, entry] of Object.entries(countries)) {
    for (const group of Array.isArray(entry?.groups) ? entry.groups.slice(0, 40) : []) {
      const name = str(group?.name, 60);
      if (!name) continue;
      const id = `actor:${slugOf(name)}`;
      for (const phrase of [name, ...(Array.isArray(group.aliases) ? group.aliases.slice(0, 40) : [])].map(item => str(item, 60))) {
        const letters = phrase.replace(/[^\p{L}\p{N}]/gu, '');
        if (letters.length < 4 || countryByName(phrase)) continue;
        // Strong: several words, a digit (APT28, TA505) or an inner capital (MuddyWater, OilRig); everything else needs a cyber context.
        const strong = /\s/.test(phrase.trim()) || /\d/.test(phrase) || /\p{Ll}\p{Lu}/u.test(phrase);
        entries.push({ phrase, hit: { id, label: name, country: iso3, strong } });
      }
    }
  }
  const table = entries.length ? phraseTable(entries) : null;
  actorCache = { key, table };
  return table;
}

/** The dictionaries of one sweep: the MISP actors from riskInputs(raw).sources.actors (null without them). */
export function createDictionaries({ actors = null } = {}) {
  return { actors: actorTable(actors) };
}

/** Title tokens for report similarity: folded, lower case, longer than two characters, no stop words, at most 16, sorted. */
export function tokensOf(title) {
  const out = new Set();
  for (const word of words(str(title, 600))) {
    const token = word.toLowerCase();
    if (token.length > 2 && !STOP_WORDS.has(token) && !/^\d+$/.test(token)) out.add(token);
    if (out.size >= MAX_TOKENS) break;
  }
  return [...out].sort();
}

/**
 * The entities of one event record: `[{id, type, label, rel, s}]`, the strongest link per entity, at most 12. `rel` is how the entity was
 * found: 'located-in' (a trusted place), 'near' (trusted coordinates within a chokepoint's radius or on a mapped military area),
 * 'mentions' (named in the title or summary) or 'involves' (an identifier: a CVE, a named threat actor).
 */
export function extractEntities(event, dictionaries = {}) {
  if (!object(event)) return [];
  const found = new Map();
  const add = (id, type, label, rel, s) => {
    const known = found.get(id);
    if (!known || known.s < s) found.set(id, { id, type, label: str(label, 120), rel, s });
  };
  const kind = str(event.kind, 40);
  const resolved = resolveEventCountries(event);
  for (const iso3 of resolved?.c ?? []) add(`country:${iso3}`, 'country', iso3, resolved.m === 'l' ? 'located-in' : 'mentions', resolved.m === 'l' ? 1 : 0.5);
  const location = object(event.location) ? event.location : {};
  if (!TEXT_KINDS.has(kind) && TRUSTED_METHODS.has(str(location.method, 80)) && Number.isFinite(location.lat) && Number.isFinite(location.lon)) {
    const passage = chokepointAt(location.lat, location.lon);
    if (passage) add(`chokepoint:${passage.slug}`, 'chokepoint', passage.label, 'near', 0.9);
    const site = militarySiteAt(location.lat, location.lon);
    const home = resolved?.m === 'l' ? resolved.c[0] : null;
    if (site && site.name) add(`site:${slugOf(site.name)}${home ? `-${home.toLowerCase()}` : ''}`, 'site', site.name, 'near', 0.9);
  }
  const text = `${str(event.title, 600)}\n${str(event.summary, 600)}`.slice(0, MAX_SCAN);
  const list = words(text);
  for (const hit of scan(CHOKEPOINT_TABLE, list, { stems: true })) {
    const strength = hit.s > 0.5 && bridgeOnly(list, CHOKEPOINT_BY_SLUG.get(hit.slug)) ? 0.5 : hit.s;
    add(`chokepoint:${hit.slug}`, 'chokepoint', hit.label, 'mentions', strength);
  }
  if (dictionaries.actors) {
    const hits = scan(dictionaries.actors, list);
    const context = kind === 'cyber' || list.some(word => CYBER_CONTEXT.has(word.toLowerCase()));
    for (const hit of hits) if (hit.strong || context) add(hit.id, 'actor', hit.label, 'involves', hit.strong ? 0.7 : 0.5);
  }
  for (const match of text.matchAll(CVE)) add(`cve:CVE-${match[1]}-${match[2]}`, 'cve', `CVE-${match[1]}-${match[2]}`, 'involves', 0.9);
  for (const hit of aviationEntities(text, { aviation: kind === 'aviation' })) add(hit.id, hit.type, hit.label, hit.rel, hit.s);
  return [...found.values()].sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1)).slice(0, MAX_ENTITIES);
}
