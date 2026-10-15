// Aviation entities in a record's text: the flight (flight:LH400), the aircraft registration (aircraft:D-AIMA) and the airline
// (airline:DLH). An air-watch incident (watch.mjs) writes them into its own title and summary, so a later report naming the same flight or
// aircraft shares an entity with it and the linker joins them (linkers.mjs). Deterministic and bounded like extract.mjs: fixed patterns
// built once from the static airline table, never from input.
//   - Flight numbers and registrations count only in an aviation context (a word such as flight, plane, airport, Boeing, járat, Flugzeug)
//     or in an aviation record: "F-35", "B-52H", "N95" or "AI 2027" are not aircraft or flights.
//   - A two-character airline code that is also a common word or abbreviation (AI, US, CA, MS ...) needs the word "flight" next to it.
//   - An airline name counts in an aviation context too ("Iberia", "Condor", "LATAM" are also a region, a bird and an acronym); a short one
//     ("United", "Delta") only before an aviation noun ("United flight").
//   - An Airbus type (A320, A350) is not a flight of Aegean (A3).
import { AIRLINES, airlineByIata, airlineByIcao, flightOfCallsign } from './airlines.mjs';

const MAX_SCAN = 1200;
const MAX_HITS = 6;
const fold = value => value.normalize('NFKD').replace(/\p{M}/gu, '');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CONTEXT = /\b(?:flights?|plane|planes|aircraft|airliners?|airlines?|airways|jets?|jetliner|pilots?|cockpit|runway|airports?|passengers?|landing|landed|takeoff|take-off|divert\w*|squawk\w*|mayday|faa|ntsb|easa|boeing|airbus|embraer|bombardier|cessna|turbulence|descent|depressuri\w*|hijack\w*|jarat\w*|repulo\w*|leszall\w*|legitarsasag\w*|pilota\w*|flug\w*|notlandung|avion|atterriss\w*|vuelo|aterriz\w*)\b/;
const FLIGHT_WORD = /\b(?:flight|flights|flug|vol|vuelo|jarat\w*)\b/i;
// Two-character codes that are also words, abbreviations or US states.
const AMBIGUOUS = new Set(['AI', 'AS', 'AM', 'AT', 'AR', 'AV', 'AD', 'AZ', 'BY', 'CA', 'DE', 'FI', 'GA', 'HA', 'HU', 'IS', 'IT', 'LA', 'ME', 'MS', 'MU', 'OH', 'OK',
  'OO', 'OS', 'SA', 'SU', 'UA', 'US', 'UX', 'VA', 'WS']);

const NAMES = AIRLINES.flatMap(airline => [airline.name, ...airline.aliases].map(name => [fold(name), airline])).sort((a, b) => b[0].length - a[0].length);
const NAME_OF = new Map(NAMES);
const NAME_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${NAMES.map(([name]) => escape(name)).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
const SHORTS = AIRLINES.flatMap(airline => airline.shorts.map(name => [fold(name), airline]));
const SHORT_OF = new Map(SHORTS);
const SHORT_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?<!Arab )(${SHORTS.map(([name]) => escape(name)).join('|')})\\s+(?:flights?|planes?|jets?|jetliner|airliner|pilots?|crew|passengers)\\b`, 'gu');
// "UA123", "UA 123", "flight 6E 2131"; and the ICAO form of a callsign, "DLH400".
// A number may end in a hyphenated suffix ("W6 2201-es járata").
const CODE_FLIGHT = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]|[0-9][A-Z])\s?0*(\d{1,4})(?![A-Za-z0-9]|-[A-Z0-9])/g;
const CALLSIGN = /(?<![A-Za-z0-9-])([A-Z]{3})(\d{1,4})(?![A-Za-z0-9]|-[A-Z0-9])/g;
const AIRBUS_TYPE = /^A3\d\d$/;
// "<airline> flight 1175": the number after a named airline.
const NUMBER_AFTER = /^\s*(?:Airlines?|Airways|Air Lines)?\s*(?:[Ff]light|[Ff]lug|vol|vuelo)\s+(?:[Nn]o\.?\s*|[Nn]umber\s+)?0*(\d{1,4})(?![A-Za-z0-9])/;

// Registrations: the US N-number, hyphenated national prefixes with a letter suffix (G-EUUA, D-AIMA, HA-LYA, EC-MXV, C-FABC), and the
// numeric forms of China (B-1234), Russia (RA-12345), Japan (JA8089) and Korea (HL7700).
const PREFIX3 = ['EC', 'EI', 'EJ', 'HA', 'OE', 'OK', 'OM', 'SP', 'YR', 'LZ', 'SE', 'OH', 'LN', 'OY', 'TF', 'PH', 'OO', 'LX', 'HB', 'CS', 'SX', 'TC', '4X', 'A6', 'A7',
  'A9C', 'A4O', '9V', '9M', '9H', '9A', '9K', 'VH', 'ZK', 'XA', 'XB', 'PR', 'PP', 'PS', 'PT', 'LV', 'CC', 'HK', 'OB', 'YV', 'ZS', '5Y', 'ET', 'SU', 'CN', '7T', 'VT',
  'AP', 'EP', 'UR', 'EW', '4L', 'UP', 'EK', '4K', 'YL', 'LY', 'ES', 'S5', 'YU', 'E7', 'Z3', 'HS', 'PK', 'RP', 'VN', '9N', 'S2', '4R', '8Q', 'HZ', 'JY', 'OD', 'YK',
  'YI', '5A', 'TS', 'EX', '5N', 'TJ', '6V', '3B', 'ER', 'T7'];
const REGISTRATION = new RegExp([
  'N[1-9]\\d{0,4}[A-Z]{0,2}',
  '[GDFIM]-[A-Z]{4}',
  'C-[FGI][A-Z]{3}',
  `(?:${PREFIX3.join('|')})-[A-Z]{3,4}`,
  'B-(?:\\d{4,5}|\\d{3}[A-Z]|\\d{2}[A-Z]{2}|[A-Z]{3})',
  'R[AF]-\\d{5}',
  'JA(?:\\d{4}|\\d{3}[A-Z]|\\d{2}[A-Z]{2})',
  'HL\\d{4}',
].map(pattern => `(?<![A-Za-z0-9-])(?:${pattern})(?![A-Za-z0-9-])`).join('|'), 'g');
const validRegistration = reg => !reg.startsWith('N') || (reg.length >= 4 && reg.length <= 6 && !/^N\d{1,2}$/.test(reg));

const nearFlightWord = (text, index, length) => FLIGHT_WORD.test(text.slice(Math.max(0, index - 14), index + length + 14));

/**
 * The aviation entities of a record: `[{id, type, label, rel, s}]` (flight 0.9, aircraft 0.9, airline 0.8 or 0.6 for a short name), at most
 * six of each. `aviation`: the record is an aviation observation (an air-watch incident), which is its own context.
 */
export function aviationEntities(rawText, { aviation = false } = {}) {
  const text = fold(String(rawText ?? '').slice(0, MAX_SCAN));
  if (!text) return [];
  const out = new Map();
  const add = (id, type, label, rel, s) => { const known = out.get(id); if (!known || known.s < s) out.set(id, { id, type, label: label.slice(0, 120), rel, s }); };
  const counts = { flight: 0, aircraft: 0, airline: 0 };
  const put = (id, type, label, rel, s) => { if (out.has(id) || counts[type]++ < MAX_HITS) add(id, type, label, rel, s); };
  if (!aviation && !CONTEXT.test(text.toLowerCase())) return [];
  // Airlines, and the flight number after a named one.
  for (const match of text.matchAll(NAME_RE)) {
    const airline = NAME_OF.get(match[0]);
    put(`airline:${airline.icao}`, 'airline', airline.name, 'mentions', 0.8);
    const number = NUMBER_AFTER.exec(text.slice(match.index + match[0].length, match.index + match[0].length + 40));
    if (number) put(`flight:${airline.iata}${number[1]}`, 'flight', `${airline.iata}${number[1]} (${airline.name})`, 'involves', 0.9);
  }
  for (const match of text.matchAll(SHORT_RE)) {
    const airline = SHORT_OF.get(match[1]);
    put(`airline:${airline.icao}`, 'airline', airline.name, 'mentions', 0.6);
    const number = NUMBER_AFTER.exec(text.slice(match.index + match[1].length, match.index + match[1].length + 40));
    if (number) put(`flight:${airline.iata}${number[1]}`, 'flight', `${airline.iata}${number[1]} (${airline.name})`, 'involves', 0.9);
  }
  for (const match of text.matchAll(CODE_FLIGHT)) {
    const airline = airlineByIata(match[1]);
    if (!airline || AIRBUS_TYPE.test(match[0])) continue;
    const spaced = match[0].length > match[1].length + match[2].length && /\s/.test(match[0]);
    const year = spaced && /^(?:19|20)\d\d$/.test(match[2]);
    if ((AMBIGUOUS.has(match[1]) || year) && !nearFlightWord(text, match.index, match[0].length)) continue;
    put(`flight:${airline.iata}${match[2]}`, 'flight', `${airline.iata}${match[2]} (${airline.name})`, 'involves', 0.9);
  }
  for (const match of text.matchAll(CALLSIGN)) {
    const known = flightOfCallsign(match[0]);
    if (known) put(`flight:${known.flight}`, 'flight', `${known.flight} (${known.airline.name})`, 'involves', 0.9);
  }
  for (const match of text.matchAll(REGISTRATION)) {
    if (validRegistration(match[0])) put(`aircraft:${match[0]}`, 'aircraft', match[0], 'involves', 0.9);
  }
  return [...out.values()];
}

/** The airline of an ICAO designator, for the air watch's titles. */
export const airlineNamed = icao => airlineByIcao(icao)?.name ?? null;
