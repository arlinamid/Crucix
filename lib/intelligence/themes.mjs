// The themes of the history: which words and two-word phrases the records of the last days carry, overall, per topic (topics.mjs; "none"
// for a record no topic word matches) and per kind, and which of them rise today against the days before. The input of an advanced theme
// filter (sub-themes such as a war, a region's crisis, AI, elections): what actually recurs, measured, not guessed. Titles only, folded
// and without stop words, numbers and words of one or two letters, so "Strait of Hormuz" counts as "strait hormuz".
import { words } from './countries.mjs';
import { STOP_WORDS } from './extract.mjs';
import { topicsOf } from './topics.mjs';

const DAY = 86400000;
// Function words of the other languages of the world feeds (Spanish, Portuguese, French, Italian, German, Hungarian) and web fragments:
// the English stop list alone left "que", "para", "les", "der" and "com" among the most frequent "themes".
const MORE_STOP = new Set(('que para por del los las una con como pero mas sus sobre entre tras desde hasta este esta son fue han ser '
  + 'dos uno nao com uma pelo pela ele ela seu sua nas nos aos ' + 'les des une pour dans sur est pas plus par avec sont aux ces son ses qui '
  + 'della delle dei degli gli che non per nel nella alla allo sono anche ' + 'der die das und den dem von mit ist für auf ein eine einen nach bei '
  + 'aus wie zum zur sich nicht auch ' + 'egy hogy nem meg már még csak volt lesz után ellen között ' + 'www http https html news').split(' '));
const PAGE = 2000;
const TOP = 40;
const noYield = async () => {};

/** The title's words in order: folded, lower case, no stop words, no numbers, longer than two characters. */
export function titleWords(title) {
  return words(String(title ?? '').slice(0, 600)).map(word => word.toLowerCase()).filter(token => token.length > 2 && !STOP_WORDS.has(token) && !MORE_STOP.has(token) && !/^\d+$/.test(token));
}

const bump = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
const top = (map, n = TOP) => [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);

/**
 * Reads the records first seen in the last `days` days (history.range) and returns `{ from, to, days, records, topics, kinds, terms,
 * phrases, byTopic: {topic: {records, terms, phrases}}, byKind: {kind: {records, terms}}, rising }`. `rising`: today's terms that occur
 * at least 3 times and at least twice as often as on an average earlier day of the window.
 */
export async function themeAnalysis(history, { days = 7, now = Date.now(), slice = noYield, top: limit = TOP, kinds: onlyKinds = null } = {}) {
  const to = new Date(now).toISOString(), from = new Date(now - days * DAY).toISOString();
  const today = to.slice(0, 10);
  const terms = new Map(), phrases = new Map(), topics = new Map(), kinds = new Map();
  const byTopic = new Map(), byKind = new Map();
  const todayTerms = new Map(), earlierTerms = new Map();
  const dayset = new Set();
  let records = 0, after = null;
  for (;;) {
    const page = history.range(from, to, { after, limit: PAGE });
    if (!page.length) break;
    after = page.at(-1);
    for (const record of page) {
      // `kinds` (e.g. ['news', 'osint']): the reports only, without the templated observations (SIGMETs, vessel counts, OONI rows).
      if (onlyKinds && !onlyKinds.includes(record.kind)) continue;
      records++;
      const list = titleWords(record.title);
      const unique = [...new Set(list)];
      const pairs = [...new Set(list.slice(1).map((word, i) => `${list[i]} ${word}`))];
      const recordTopics = [...topicsOf(unique, record.kind, null)];
      const day = String(record.firstSeenAt).slice(0, 10);
      dayset.add(day);
      bump(kinds, record.kind);
      for (const topic of recordTopics.length ? recordTopics : ['none']) {
        bump(topics, topic);
        if (!byTopic.has(topic)) byTopic.set(topic, { records: 0, terms: new Map(), phrases: new Map() });
        const row = byTopic.get(topic);
        row.records++;
        for (const word of unique) bump(row.terms, word);
        for (const pair of pairs) bump(row.phrases, pair);
      }
      if (!byKind.has(record.kind)) byKind.set(record.kind, { records: 0, terms: new Map() });
      const kindRow = byKind.get(record.kind);
      kindRow.records++;
      for (const word of unique) { bump(terms, word); bump(kindRow.terms, word); bump(day === today ? todayTerms : earlierTerms, word); }
      for (const pair of pairs) bump(phrases, pair);
    }
    await slice();
    if (page.length < PAGE) break;
  }
  const earlierDays = Math.max(1, [...dayset].filter(day => day !== today).length);
  const rising = [...todayTerms].filter(([, n]) => n >= 3).map(([word, n]) => {
    const usual = (earlierTerms.get(word) || 0) / earlierDays;
    return [word, n, Math.round(usual * 10) / 10];
  }).filter(([, n, usual]) => n >= 2 * Math.max(usual, 1)).sort((a, b) => b[1] / Math.max(b[2], 1) - a[1] / Math.max(a[2], 1) || b[1] - a[1]).slice(0, limit);
  return {
    from, to, days, records,
    topics: Object.fromEntries(top(topics, 20)), kinds: Object.fromEntries(top(kinds, 30)),
    terms: top(terms, limit), phrases: top(phrases, limit),
    byTopic: Object.fromEntries([...byTopic].sort((a, b) => b[1].records - a[1].records).map(([topic, row]) => [topic, { records: row.records, terms: top(row.terms, limit), phrases: top(row.phrases, limit) }])),
    byKind: Object.fromEntries([...byKind].sort((a, b) => b[1].records - a[1].records).slice(0, 12).map(([kind, row]) => [kind, { records: row.records, terms: top(row.terms, 20) }])),
    rising: rising.map(([word, count, usual]) => ({ word, today: count, usual })),
  };
}
