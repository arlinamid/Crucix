// Armed conflict from the reports: Crucix has no free conflict event feed (ACLED is institutional-only; GDELT Events was measured and is mostly
// machine-coding noise: a barbecue opening coded as a fight), so the signal is read from news and OSINT titles. A title is a conflict report
// when it carries a strong word (airstrike, shelling, artillery, clashes, missile ...) or two weaker ones (drone + killed, troops + offensive);
// "strike" (a labour strike) and "attack" (a heart attack, a cyberattack) alone never count. The words are folded and lower-cased (tokensOf);
// a word of at least six letters also matches its inflected forms ("légicsapásban", "Luftangriffe").
//
// Per country (lib/intelligence/risk-step.mjs), the signal counts distinct conflict STORIES (a story reported by five outlets is one, through
// the graph's story groups) per 24-hour window, with the outlets behind them:
//   intensity   100 * (1 - e^(-stories / 4)): four stories in a day is about 63
//   escalation  the excess of the last 24 hours over the previous six days' mean, relative to (mean + 2), as 100 * (1 - e^(-excess));
//               only after the graph has observed seven days (before that a new graph would see every story as a rise)
//   value       0.6 x intensity + 0.4 x escalation, or the intensity alone while escalation is not ready
// It is a reading of how much armed conflict the reports describe, not a count of incidents or casualties.
import { graphTime } from './graph.mjs';

const STRONG = ['airstrike', 'airstrikes', 'shelling', 'shelled', 'artillery', 'bombardment', 'bombardments', 'bombing', 'bombings', 'bombed',
  'missile', 'missiles', 'clashes', 'warplanes', 'gunmen', 'ambush', 'ambushed', 'massacre', 'insurgents', 'jihadists', 'mortar', 'mortars',
  'counteroffensive', 'frontline', 'warship',
  'bombardeo', 'bombardeos', 'misil', 'misiles', 'enfrentamientos', 'emboscada', 'masacre', 'artilleria',
  'bombardement', 'bombardements', 'affrontements', 'embuscade',
  'luftangriff', 'beschuss', 'raketenangriff', 'drohnenangriff', 'gefechte', 'artillerie',
  'legicsapas', 'bombazas', 'raketatamadas', 'drontamadas', 'tuzerseg', 'tuzersegi', 'osszecsapas', 'osszecsapasok',
  'обстрел', 'обстрелы', 'бомбардировка', 'ракетный', 'артиллерия', 'غارة', 'غارات', 'قصف', 'اشتباكات'];
// Weak: alone they are ambiguous (a teachers' strike, a war of words); two of them, or one with an armed actor, are a conflict report.
const WEAK = ['strike', 'kills', 'killing', 'invasion', 'drone', 'drones', 'rocket', 'rockets', 'strikes', 'attack', 'attacks', 'attacked', 'troops', 'soldiers', 'militants', 'militia',
  'rebels', 'offensive', 'ceasefire', 'gunfire', 'sniper', 'raid', 'raids', 'fighting', 'war', 'army', 'military', 'killed', 'wounded',
  'casualties', 'hostages', 'ataque', 'ataques', 'drones', 'tropas', 'soldados', 'combates', 'guerra', 'frappe', 'frappes', 'attaque', 'soldats',
  'guerre', 'angriff', 'angriffe', 'soldaten', 'krieg', 'drohnen', 'tamadas', 'katonak', 'haboru', 'dron', 'удар', 'удары', 'атака',
  'беспилотник', 'беспилотники', 'войска', 'война', 'هجوم', 'حرب', 'جنود'];
// Armed actors whose name in a title is itself a weak conflict word ("Houthis and Riyadh trade strikes").
const ACTORS = ['houthis', 'houthi', 'hamas', 'hezbollah', 'idf', 'irgc', 'taliban', 'wagner', 'isis', 'shabaab', 'rsf', 'm23', 'jnim', 'boko'];
const CASUALTY = ['kills', 'killing', 'killed', 'dead', 'deaths', 'casualties', 'wounded', 'injured', 'muertos', 'heridos', 'morts', 'blesses', 'tote', 'verletzte',
  'halott', 'halottak', 'sebesult', 'погибли', 'погибших', 'раненых', 'قتلى', 'جرحى'];

const index = list => {
  const exact = new Set(list);
  const prefixes = list.filter(word => [...word].length >= 6);
  return token => exact.has(token) || prefixes.some(word => token.startsWith(word) && token.length - word.length <= 6);
};
const isStrong = index(STRONG);
const isWeak = index(WEAK);
const isCasualty = index(CASUALTY);
const isActor = index(ACTORS);
// "air strike" and "air raid" come as two tokens (the tokens are a set, so only together, never in order).
const AIR = new Set(['strike', 'strikes', 'raid', 'raids']);
// ... but not an airline's ("Air France strike cancels flights").
const AIRLINES = new Set(['france', 'india', 'canada', 'china', 'berlin', 'europa', 'arabia', 'asia', 'astana', 'serbia', 'baltic', 'transat', 'malta',
  'mauritius', 'tahiti', 'seychelles', 'algerie', 'senegal', 'namibia', 'peace', 'premia', 'dolomiti', 'corsica', 'austral', 'moldova', 'macau',
  'busan', 'seoul', 'japan', 'zealand', 'niugini', 'arabia', 'cairo', 'tanzania', 'botswana', 'mauritanie', 'cote', 'ivoire', 'flights', 'airline', 'pilots', 'crew']);

/** How a title (its tokens) reads: `{conflict, strong, casualties}`. */
export function conflictOf(tokens) {
  let strong = 0;
  let weak = 0;
  let casualties = false;
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (typeof token !== 'string') continue;
    if (isStrong(token)) strong++;
    else if (isWeak(token) || isActor(token)) weak++;
    if (isCasualty(token)) casualties = true;
  }
  if (Array.isArray(tokens) && tokens.includes('air') && tokens.some(token => AIR.has(token)) && !tokens.some(token => AIRLINES.has(token))) strong++;
  return { conflict: strong > 0 || weak >= 2, strong: strong > 0, casualties };
}

const DAY = 86400000;
const DAYS = 7;
const INTENSITY_SCALE = 4;
const ESCALATION_PRIOR = 2;
const REPORT_KINDS = new Set(['news', 'osint']);
const round1 = value => Math.round(value * 10) / 10;
// A country counts as escalating from this escalation value (the last day well above its own week): the alert metric and the panel use it.
export const ESCALATING = 50;

/**
 * The conflict signal of every country the graph's conflict reports name: Map iso3 -> {stories: [7 windows, index 0 = last 24 h], sources,
 * casualties, intensity, escalation, value, ids}. `groups` maps an event id to its story group (GraphStore.storyGroups). `observedDays` is how
 * long the graph has been observing; escalation is null below seven days.
 */
export function conflictSignals(graph, { now = Date.now(), groups = new Map(), observedDays = 0 } = {}) {
  const countries = new Map();
  for (const record of graph.recent(now - DAYS * DAY)) {
    if (!REPORT_KINDS.has(record.k)) continue;
    const reading = conflictOf(record.w);
    if (!reading.conflict) continue;
    const window = Math.floor((now - graphTime(record)) / DAY);
    if (window < 0 || window >= DAYS) continue;
    const story = groups.get(record.id) ?? record.id;
    for (const [entity] of record.n) {
      if (!entity.startsWith('country:')) continue;
      const iso3 = entity.slice(8);
      if (!countries.has(iso3)) countries.set(iso3, { windows: Array.from({ length: DAYS }, () => new Set()), sources: new Set(), casualties: false, ids: [] });
      const row = countries.get(iso3);
      row.windows[window].add(story);
      if (window === 0) {
        if (record.s) row.sources.add(record.s);
        if (reading.casualties) row.casualties = true;
        if (row.ids.length < 20) row.ids.push(record.id);
      }
    }
  }
  const out = new Map();
  for (const [iso3, row] of countries) {
    const stories = row.windows.map(set => set.size);
    const intensity = round1(100 * (1 - Math.exp(-stories[0] / INTENSITY_SCALE)));
    let escalation = null;
    if (observedDays >= DAYS) {
      const base = stories.slice(1).reduce((sum, count) => sum + count, 0) / (DAYS - 1);
      escalation = round1(100 * (1 - Math.exp(-Math.max(0, stories[0] - base) / (base + ESCALATION_PRIOR))));
    }
    const value = round1(escalation === null ? intensity : 0.6 * intensity + 0.4 * escalation);
    out.set(iso3, { stories, sources: row.sources.size, casualties: row.casualties, intensity, escalation, value, ids: row.ids });
  }
  return out;
}

/** The compact summary for snapshot.risk.conflict: the countries with the strongest signal and how many are escalating. */
export function summarizeConflict(signals, displayOf = (iso3, name) => name, nameOf = iso3 => iso3, { limit = 8, observedDays = 0 } = {}) {
  const rows = [...(signals instanceof Map ? signals : new Map())].filter(([, row]) => row.stories[0] > 0)
    .sort((a, b) => b[1].value - a[1].value || b[1].stories[0] - a[1].stories[0] || (a[0] < b[0] ? -1 : 1));
  return {
    escalating: rows.filter(([, row]) => row.escalation !== null && row.escalation >= ESCALATING).length,
    ready: observedDays >= DAYS,
    observedDays: Math.floor(Math.max(0, observedDays)),
    top: rows.slice(0, limit).map(([iso3, row]) => ({ iso3, name: nameOf(iso3), displayName: displayOf(iso3, nameOf(iso3)), stories: row.stories[0],
      usual: round1(row.stories.slice(1).reduce((sum, count) => sum + count, 0) / (DAYS - 1)), sources: row.sources, casualties: row.casualties,
      intensity: row.intensity, escalation: row.escalation, value: row.value })),
  };
}
