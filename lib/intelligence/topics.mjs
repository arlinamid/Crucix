// The topic of a record and of a story thread: armed conflict, politics, technology, disaster, health or economy. Read from the title words
// (folded, lower case, as extract.mjs tokensOf gives them) in the catalogue's main languages, plus the topic a record kind always has (a KEV entry
// is technology, a sanctions list update is politics). A word of at least six letters also matches its inflected forms. A record may have
// several topics or none. Conflict is conflict.mjs's reading; disaster and health come from hazards.mjs.
import { conflictOf, isConflictWord } from './conflict.mjs';
import { hazardsOf, isHazardWord } from './hazards.mjs';

export const TOPICS = Object.freeze(['conflict', 'politics', 'technology', 'disaster', 'health', 'economy']);

const WORDS = Object.freeze({
  politics: ['election', 'elections', 'vote', 'votes', 'voters', 'ballot', 'referendum', 'parliament', 'parliamentary', 'president', 'presidential',
    'minister', 'ministers', 'government', 'coalition', 'opposition', 'cabinet', 'resigns', 'resignation', 'impeachment', 'coup', 'protest', 'protests',
    'protesters', 'sanctions', 'summit', 'diplomat', 'diplomats', 'diplomatic', 'treaty', 'senate', 'congress', 'lawmakers', 'legislation',
    'campaign', 'candidate', 'regime', 'ambassador', 'embassy', 'chancellor', 'premier', 'mayor', 'party', 'policy',
    'elecciones', 'eleccion', 'gobierno', 'ministro', 'presidente', 'protestas', 'sanciones', 'parlamento', 'votacion',
    'election', 'gouvernement', 'ministre', 'manifestation', 'manifestations', 'sanctions', 'scrutin',
    'wahl', 'wahlen', 'regierung', 'bundestag', 'kanzler', 'proteste', 'sanktionen',
    'valasztas', 'valasztasok', 'kormany', 'miniszter', 'miniszterelnok', 'parlament', 'tuntetes', 'tuntetok', 'szankciok', 'ellenzek',
    'выборы', 'правительство', 'министр', 'президент', 'парламент', 'санкции', 'протесты', 'انتخابات', 'حكومة', 'وزير', 'رئيس', 'برلمان', 'عقوبات'],
  technology: ['cyber', 'cyberattack', 'cyberattacks', 'hacker', 'hackers', 'hacked', 'hacking', 'ransomware', 'malware', 'spyware', 'breach',
    'vulnerability', 'vulnerabilities', 'exploit', 'exploited', 'zero-day', 'phishing', 'botnet', 'outage', 'outages', 'internet', 'datacenter',
    'semiconductor', 'semiconductors', 'chip', 'chips', 'chipmaker', 'nvidia', 'tsmc', 'intel', 'microsoft', 'google', 'apple', 'openai', 'anthropic',
    'starlink', 'spacex', 'satellite', 'satellites', 'rocket', 'launch', 'launches', 'software', 'cloud', 'quantum', 'telecom', 'broadband',
    'undersea', 'cable', 'cables', 'artificial', 'intelligence', 'robot', 'robots', 'drone', 'drones', 'gnss', 'jamming', 'spoofing',
    'ciberataque', 'hackers', 'ciberseguridad', 'cyberattaque', 'piratage', 'cyberangriff', 'hackerangriff', 'kibertamadas', 'hackerek', 'adatszivargas',
    'кибератака', 'хакеры', 'спутник', 'سيبراني'],
  economy: ['inflation', 'recession', 'gdp', 'tariff', 'tariffs', 'trade', 'exports', 'imports', 'stocks', 'shares', 'markets', 'investors',
    'currency', 'interest', 'rates', 'bank', 'banks', 'debt', 'bonds', 'oil', 'gas', 'prices', 'economy', 'economic', 'budget', 'deficit', 'imf',
    'inflacion', 'aranceles', 'economia', 'inflation', 'economie', 'wirtschaft', 'zolle', 'inflacio', 'gazdasag', 'kamat', 'forint',
    'инфляция', 'экономика', 'пошлины', 'اقتصاد', 'تضخم'],
});
// The topic a record kind always has.
const KIND_TOPICS = Object.freeze({ cyber: 'technology', launch: 'technology', outage: 'technology', network: 'technology', interference: 'technology',
  sanctions: 'politics', economic: 'economy', energy: 'economy', market: null, earthquake: 'disaster', weather: 'disaster', disaster: 'disaster', health: 'health' });
// Words too general to make a title political or economic on their own ("the party", "trade fair", "gas leak"); they need a second word of the topic.
const SOFT = new Set(['party', 'policy', 'campaign', 'trade', 'oil', 'gas', 'prices', 'markets', 'bank', 'banks', 'rates', 'interest', 'shares', 'internet',
  'cloud', 'launch', 'launches', 'rocket', 'chip', 'chips', 'cable', 'cables', 'intelligence', 'artificial', 'drone', 'drones', 'mayor', 'vote', 'votes']);

const matchers = Object.fromEntries(Object.entries(WORDS).map(([topic, list]) => {
  const exact = new Set(list);
  const prefixes = list.filter(word => [...word].length >= 6);
  return [topic, token => exact.has(token) || prefixes.some(word => token.startsWith(word) && token.length - word.length <= 6)];
}));

/** True for a word of any topic lexicon (also conflict and hazard words): it names a subject, not a person, product or place. */
export const isTopicWord = token => typeof token === 'string' && (Object.values(matchers).some(matches => matches(token)) || isConflictWord(token) || isHazardWord(token));

/** The topics of a record from its title tokens, its kind and the topic of its specialist feed (`hint`, or null): a Set of TOPICS. */
export function topicsOf(tokens, kind = '', hint = null) {
  const found = new Set();
  if (TOPICS.includes(hint)) found.add(hint);
  const list = Array.isArray(tokens) ? tokens.filter(token => typeof token === 'string') : [];
  const fixed = KIND_TOPICS[kind];
  if (fixed) found.add(fixed);
  if (conflictOf(list).conflict) found.add('conflict');
  for (const hazard of hazardsOf(list, kind)) found.add(hazard === 'outbreak' ? 'health' : hazard === 'outage' ? 'technology' : 'disaster');
  for (const [topic, matches] of Object.entries(matchers)) {
    const hits = list.filter(token => matches(token));
    if (hits.some(token => !SOFT.has(token)) || hits.length >= 2) found.add(topic);
  }
  return found;
}

/** The leading topic of a group of records by count, conflict first on a tie (then the TOPICS order); null without any. */
export function leadingTopic(counts) {
  let best = null;
  for (const topic of TOPICS) if ((counts[topic] || 0) > 0 && (best === null || counts[topic] > counts[best])) best = topic;
  return best;
}
