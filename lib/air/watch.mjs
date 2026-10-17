// The air watch: OpenSky's global state vector every few minutes (in the worker process), a short track of every aircraft, and the
// moments worth a story before the news has one. Each finding is an air incident: an aviation record (`Air-Watch`) that goes the way of
// every observation (events -> history -> entity graph -> threads), naming the flight, the aircraft and the airline in its own text so a
// later report of the same flight joins its thread (lib/air/aviation.mjs, linkers.mjs). Detectors:
//   squawk     an emergency transponder code newly set and still set at the next contact (a mistyped code is usually gone within
//              seconds): 7500 (unlawful interference), 7600 (radio failure), 7700 (general emergency). High for an airline-pattern
//              callsign, moderate for other traffic (training flights set 7500 by mistake) and for 7600.
//   descent    a loss of at least 2,400 m (~8,000 ft) from above FL200 at 4,000 ft/min or more on average (a normal descent is
//              1,500-3,000), at most 10,000 ft/min (faster is an altitude error), ending still above 1,500 m and more than 40 km from
//              every airport airline flights use (the route cache's airports): an arrival is not an incident. Airline-pattern callsigns
//              only (DLH400, EJA895): jet trainers, test and private aircraft descend steeply as a matter of course.
//   landing    an aircraft that set an emergency squawk or made a rapid descent within the last hour now landing (low and descending, or
//              on the ground after a low contact): `diversion` when far from the destination of a route it was flying, `return` when back
//              at its origin, otherwise `landing`.
// 2.51.1: the 2.51.0 detectors judged descents and diversions by the cached route of the callsign. On live data that gave ~130
// incidents a day, nearly all ordinary arrivals: a flight number flies other legs than the one cached, so "far from the destination"
// was mostly a different airport. A route is no longer needed to fire; only a landing after an emergency still names it.
// Altitude errors are filtered: positions older than their contact (a coverage gap: the time is the position's own), barometric and
// geometric altitude far apart, a lone high reading, or a high reading at a speed no aircraft flies there (a light aircraft "at FL370").
// These are transponder observations, not confirmed events, and every incident says so. Each fires once per aircraft and kind in 3 hours.
import { countryAt } from '../intelligence/geo.mjs';
import { countryDisplayName } from '../intelligence/countries.mjs';
import { distanceKm } from '../intelligence/chokepoints.mjs';
import { notableKind, watchRound, writeWatchRound, readWatchRound } from '../../apis/sources/opensky.mjs';
import { AIRLINE_CALLSIGN, knownAirports, routeOf as cachedRoute } from '../../apis/sources/air-routes.mjs';
import { airlineByIcao, flightOfCallsign } from './airlines.mjs';
import { identify } from './identity.mjs';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const TRACK_MS = 60 * MINUTE;
const MAX_POINTS = 24;
const REFIRE_MS = 3 * HOUR;
const KEEP_MS = 24 * HOUR;
const MAX_INCIDENTS = 200;
const MAX_PER_ROUND = 15;
// The incidents a sweep takes into its snapshot (the history keeps them after that).
const SNAPSHOT_MS = 6 * HOUR;
const FT = 3.28084;
const HEX = /^[0-9a-f]{6}$/;
// Code -> [meaning, severity for an airline-pattern callsign, severity for other traffic].
const SQUAWKS = Object.freeze({ '7500': ['unlawful interference', 'high', 'moderate'], '7600': ['radio failure', 'moderate', 'moderate'],
  '7700': ['general emergency', 'high', 'moderate'] });
// Descent thresholds (metres, m/s, km).
const DESCENT = Object.freeze({ fromAlt: 6100, loss: 2400, windowMs: 11 * MINUTE, minMs: 90000, rate: 20, maxRate: 50, endAbove: 1500, fromAirport: 40 });
const DIVERSION = Object.freeze({ low: 1500, fromDestination: 300, fromOrigin: 80, returned: 50, away: 150, afterMs: 60 * MINUTE, airport: 60 });
// A position older than its contact by more than this is from before a coverage gap.
const STALE_POSITION_S = 60;

const finite = value => typeof value === 'number' && Number.isFinite(value);
// A point: [t ms, lat, lon, altitude m (barometric, else geometric), vertical rate m/s, squawk, on ground, geometric altitude, speed m/s].
const T = 0, LAT = 1, LON = 2, ALT = 3, VR = 4, SQ = 5, GND = 6, GEO = 7, SPD = 8;
// Above FL250 an aircraft flies faster than this (m/s, ~215 kt); a slower one there is an altitude error.
const HIGH_ALT = 7600, MIN_HIGH_SPEED = 110;
const plausible = point => (!finite(point[GEO]) || !finite(point[ALT]) || Math.abs(point[GEO] - point[ALT]) <= 1500)
  && !(finite(point[ALT]) && point[ALT] >= HIGH_ALT && finite(point[SPD]) && point[SPD] < MIN_HIGH_SPEED);
const km = (a, lat, lon) => distanceKm(a[LAT], a[LON], lat, lon);
// The airports in 1° cells, for "is this near an airport" (about 1,800 airports; rebuilt each round from the route cache).
export function airportIndex(list) {
  const cells = new Map();
  let size = 0;
  for (const airport of Array.isArray(list) ? list : []) {
    if (!Array.isArray(airport) || !finite(airport[1]) || !finite(airport[2])) continue;
    const key = `${Math.floor(airport[1])}|${Math.floor(airport[2])}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(airport);
    size++;
  }
  return {
    size,
    /** The nearest airport within `radius` km of the point ({ airport, km }), or null. */
    near(lat, lon, radius) {
      let best = null;
      const span = Math.ceil(radius / 50) + 1;
      for (let y = -span; y <= span; y++) for (let x = -span; x <= span; x++) {
        for (const airport of cells.get(`${Math.floor(lat) + y}|${Math.floor(lon) + x}`) ?? []) {
          const d = distanceKm(lat, lon, airport[1], airport[2]);
          if (d <= radius && (!best || d < best.km)) best = { airport, km: d };
        }
      }
      return best;
    },
  };
}
const feet = metres => Math.round(metres * FT / 100) * 100;
const thousands = value => value.toLocaleString('en-US');

export class AirWatch {
  tracks = new Map();   // icao24 -> { c: callsign, k: notable kind, b: round first seen, p: points }
  fired = new Map();    // `${type}|${icao24}` -> ms
  incidents = [];       // the last 24 hours, newest first
  rounds = 0;
  airports = airportIndex([]);
  #routeOf;
  #airports;

  constructor({ routeOf = callsign => cachedRoute(callsign), airports = () => knownAirports() } = {}) { this.#routeOf = routeOf; this.#airports = airports; }

  /** Carries the incidents of a previous run (the round file) over a restart: they stay in the snapshot and do not fire again. */
  restore(incidents, now = Date.now()) {
    for (const incident of Array.isArray(incidents) ? incidents : []) {
      const at = Date.parse(incident?.observedAt);
      if (!incident || typeof incident.key !== 'string' || !finite(at) || now - at > KEEP_MS) continue;
      this.incidents.push(incident);
      this.fired.set(incident.key, Math.max(this.fired.get(incident.key) ?? 0, at));
    }
    this.incidents.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  }

  /**
   * One round of state vectors (OpenSky's arrays). Returns the new incidents (findings with their evidence, not yet described), at most 15,
   * the most severe first.
   */
  update(states, { now = Date.now(), at = now } = {}) {
    this.rounds++;
    try { this.airports = airportIndex(this.#airports()); } catch { /* keep the last index */ }
    const found = [];
    for (const s of Array.isArray(states) ? states : []) {
      if (!Array.isArray(s)) continue;
      const icao = typeof s[0] === 'string' ? s[0].trim().toLowerCase() : '';
      if (!HEX.test(icao) || !finite(s[5]) || !finite(s[6])) continue;
      // The position's own time: after a coverage gap the last contact is newer than the position and altitude it came with.
      if (s[3] > 0 && s[4] > 0 && s[4] - s[3] > STALE_POSITION_S) continue;
      const ground = s[8] === true;
      let track = this.tracks.get(icao);
      if (!track) {
        if (ground) continue; // an aircraft on the ground is only followed once it has been seen flying
        track = { c: '', k: null, b: this.rounds, p: [] };
        this.tracks.set(icao, track);
      }
      const t = s[3] > 0 ? s[3] * 1000 : s[4] > 0 ? s[4] * 1000 : at;
      const last = track.p.at(-1);
      if (last && t <= last[T]) continue; // no newer contact
      const geo = finite(s[13]) ? s[13] : null;
      track.p.push([t, Math.round(s[6] * 1000) / 1000, Math.round(s[5] * 1000) / 1000, finite(s[7]) ? s[7] : geo, finite(s[11]) ? s[11] : null,
        String(s[14] ?? '').trim().slice(0, 4), ground, geo, finite(s[9]) ? s[9] : null]);
      while (track.p.length > MAX_POINTS || (track.p.length > 1 && t - track.p[0][T] > TRACK_MS)) track.p.shift();
      const callsign = String(s[1] ?? '').trim().toUpperCase().slice(0, 8);
      if (callsign) track.c = callsign;
      if (!ground) track.k = notableKind(s);
      for (const detect of [squawkOnset, rapidDescent, landing]) {
        const finding = detect(icao, track, this);
        if (!finding || !this.#fresh(finding, now)) continue;
        found.push(finding);
        // An emergency (a squawk or a rapid descent) makes the aircraft's landing within the hour an incident too.
        if (finding.type !== 'landing' && finding.type !== 'diversion' && finding.type !== 'return') track.emergency = { at: t, what: finding.type === 'squawk' ? `squawk ${finding.evidence.squawk}` : 'a rapid descent' };
      }
    }
    for (const [icao, track] of this.tracks) if (now - track.p.at(-1)[T] > TRACK_MS) this.tracks.delete(icao);
    for (const [key, when] of this.fired) if (now - when > REFIRE_MS) this.fired.delete(key);
    const rank = { critical: 3, high: 2, elevated: 1, moderate: 0 };
    return found.sort((a, b) => (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0)).slice(0, MAX_PER_ROUND);
  }

  #fresh(finding, now) {
    const when = this.fired.get(finding.key);
    if (when !== undefined && now - when < REFIRE_MS) return false;
    this.fired.set(finding.key, now);
    return true;
  }

  routeOf(callsign) { try { return callsign ? this.#routeOf(callsign) : null; } catch { return null; } }

  /** Adds described incidents (newest first), keeping 24 hours and at most 200. */
  publish(incidents, now = Date.now()) {
    this.incidents.unshift(...incidents);
    this.incidents = this.incidents.filter(incident => now - Date.parse(incident.observedAt) <= KEEP_MS).slice(0, MAX_INCIDENTS);
  }

  /** The incidents of the last six hours, for the sweep's snapshot. */
  recent(now = Date.now()) { return this.incidents.filter(incident => now - Date.parse(incident.observedAt) <= SNAPSHOT_MS); }
}

function squawkOnset(icao, track, watch) {
  const current = track.p.at(-1);
  if (current[GND] || !Object.hasOwn(SQUAWKS, current[SQ])) return null;
  // Set at this contact and the one before; newly: another code before that, or an aircraft that appeared with it after the first round.
  const previous = track.p.at(-2), before = track.p.at(-3);
  if (!previous || previous[SQ] !== current[SQ]) return null;
  const onset = before ? before[SQ] !== current[SQ] : track.b > 1;
  if (!onset) return null;
  const severity = SQUAWKS[current[SQ]][AIRLINE_CALLSIGN.test(track.c) ? 1 : 2];
  return { type: 'squawk', key: `squawk-${current[SQ]}|${icao}`, icao24: icao, callsign: track.c, point: current, severity,
    evidence: { squawk: current[SQ], previous: before?.[SQ] || null, altitude: current[ALT] } };
}

function rapidDescent(icao, track, watch) {
  const current = track.p.at(-1);
  if (current[GND] || !finite(current[ALT]) || current[ALT] < DESCENT.endAbove || track.k === 'military' || !AIRLINE_CALLSIGN.test(track.c)) return null;
  if (!plausible(current)) return null;
  let top = null;
  for (let i = 0; i < track.p.length - 1; i++) {
    const point = track.p[i], age = current[T] - point[T];
    if (age < DESCENT.minMs || age > DESCENT.windowMs || !finite(point[ALT]) || point[GND] || !plausible(point)) continue;
    // A lone high reading (its neighbour far below) is an altitude error, not a level the aircraft flew.
    const before = track.p[i - 1];
    if (before && finite(before[ALT]) && point[ALT] - before[ALT] > 1500) continue;
    if (!top || point[ALT] > top[ALT]) top = point;
  }
  if (!top) return null;
  const loss = top[ALT] - current[ALT], seconds = (current[T] - top[T]) / 1000, rate = loss / seconds;
  if (top[ALT] < DESCENT.fromAlt || loss < DESCENT.loss || rate < DESCENT.rate || rate > DESCENT.maxRate) return null;
  // An arrival: the descent ends near an airport airline flights use (with no airport known yet, nothing counts as remote).
  if (!watch.airports.size || watch.airports.near(current[LAT], current[LON], DESCENT.fromAirport)) return null;
  return { type: 'descent', key: `descent|${icao}`, icao24: icao, callsign: track.c, point: current, route: null, severity: 'elevated',
    evidence: { from: Math.round(top[ALT]), to: Math.round(current[ALT]), minutes: Math.round(seconds / 6) / 10, rate: Math.round(rate * 10) / 10,
      vrate: finite(current[VR]) ? current[VR] : null, toDestination: null } };
}

function landing(icao, track, watch) {
  const current = track.p.at(-1), previous = track.p.at(-2);
  if (!previous || !track.emergency || current[T] - track.emergency.at > DIVERSION.afterMs) return null;
  const low = point => !point[GND] && finite(point[ALT]) && point[ALT] < DIVERSION.low;
  const down = current[GND] ? low(previous) || (finite(previous[ALT]) && previous[ALT] < 2 * DIVERSION.low && !previous[GND])
    : low(current) && finite(current[VR]) && current[VR] < -1;
  if (!down) return null;
  const route = watch.routeOf(track.c);
  const at = watch.airports.near(current[LAT], current[LON], DIVERSION.airport);
  let type = 'landing', toDestination = null, toOrigin = null;
  if (route) {
    toDestination = km(current, route.d[1], route.d[2]);
    toOrigin = km(current, route.o[1], route.o[2]);
    if (toOrigin <= DIVERSION.returned && track.p.some(point => km(point, route.o[1], route.o[2]) > DIVERSION.away)) type = 'return';
    else if (toDestination > DIVERSION.fromDestination && toOrigin > DIVERSION.fromOrigin) type = 'diversion';
  }
  return { type, key: `landing|${icao}`, icao24: icao, callsign: track.c, point: current, route, severity: 'high',
    evidence: { after: track.emergency.what, landed: current[GND], airport: at?.airport[0] ?? null, toDestination: toDestination === null ? null : Math.round(toDestination),
      toOrigin: toOrigin === null ? null : Math.round(toOrigin), altitude: finite(current[ALT]) ? Math.round(current[ALT]) : null } };
}

const airportLabel = (code, known) => known?.city ? `${known.city} (${code})` : code;

/**
 * The incident record of a finding: an aviation observation with a title and summary that name the flight, the aircraft and the airline
 * (so the extractor finds them), its place and time. `identity`: identify()'s answer for the aircraft ({ aircraft, route }), may be empty.
 */
export function describe(finding, identity = {}) {
  const { aircraft = null, route: known = null } = identity ?? {};
  const [t, lat, lon] = finding.point;
  const iso3 = countryAt(lat, lon);
  const place = iso3 ? ` over ${countryDisplayName(iso3, 'en')}` : '';
  const fromTable = flightOfCallsign(finding.callsign);
  const flight = known?.flight || fromTable?.flight || null;
  const airline = known?.airline?.name || fromTable?.airline.name || airlineByIcao(aircraft?.operator)?.name || aircraft?.owner || null;
  const who = [airline, flight || finding.callsign || `aircraft ${finding.icao24}`].filter(Boolean).join(' ');
  const tags = [aircraft?.registration, aircraft?.icaoType].filter(Boolean);
  const subject = `${who}${tags.length ? ` (${tags.join(', ')})` : ''}`;
  const e = finding.evidence;
  const origin = finding.route?.o[0] ?? known?.origin?.iata ?? known?.origin?.icao ?? null;
  const destination = finding.route?.d[0] ?? known?.destination?.iata ?? known?.destination?.icao ?? null;
  const routeText = origin && destination ? `${airportLabel(origin, known?.origin?.iata === origin ? known.origin : null)} → ${airportLabel(destination, known?.destination?.iata === destination ? known.destination : null)}` : null;
  let title, detail;
  if (finding.type === 'descent') {
    title = `Rapid descent: ${subject} lost ${thousands(feet(e.from - e.to))} ft in ${e.minutes} min${place}`;
    detail = `Altitude ${thousands(feet(e.from))} → ${thousands(feet(e.to))} ft in ${e.minutes} min (on average ${thousands(Math.round(e.rate * FT * 60 / 100) * 100)} ft/min`
      + `${finite(e.vrate) ? `; ${thousands(Math.round(e.vrate * FT * 60 / 100) * 100)} ft/min at the last report` : ''})`
      + ', more than 40 km from any airport airline flights use.';
  } else if (finding.type === 'squawk') {
    title = `Squawk ${e.squawk} (${SQUAWKS[e.squawk][0]}): ${subject}${place}`;
    detail = `Transponder code ${e.squawk} set${e.previous ? ` (it was ${e.previous})` : ''}${finite(e.altitude) ? ` at ${thousands(feet(e.altitude))} ft` : ''}.`;
  } else {
    const where = e.landed ? 'landed' : 'is landing';
    const near = e.airport ? ` near ${e.airport}` : '';
    title = finding.type === 'return' ? `Return to origin after ${e.after}: ${subject} ${where} back at ${origin}${place}`
      : finding.type === 'diversion' ? `Diversion after ${e.after}: ${subject} ${where}${near}, ${thousands(e.toDestination)} km from ${destination}${place}`
      : `Landing after ${e.after}: ${subject} ${where}${near}${place}`;
    detail = finite(e.toDestination)
      ? `It was flying ${routeText ?? 'its route'} and ${where} ${thousands(e.toDestination)} km from the destination and ${thousands(e.toOrigin)} km from the origin.`
      : `It ${where}${near} within an hour of ${e.after}.`;
  }
  const parts = [
    flight ? `Flight ${flight}${finding.callsign && finding.callsign !== flight ? ` (callsign ${finding.callsign})` : ''}${airline ? `, ${airline}` : ''}.` : finding.callsign ? `Callsign ${finding.callsign}.` : '',
    routeText ? `Route ${routeText}.` : '',
    aircraft ? `Aircraft ${[aircraft.registration, [aircraft.manufacturer, aircraft.type].filter(Boolean).join(' ')].filter(Boolean).join(', ')} (ICAO ${finding.icao24}).` : `ICAO address ${finding.icao24}.`,
    detail,
    'An ADS-B observation from OpenSky, not a confirmed event: altitude errors, test codes and wrong routes happen.',
  ];
  return {
    key: finding.key, providerId: `air-watch:${finding.type}:${finding.icao24}:${Math.floor(t / MINUTE)}`, kind: 'aviation', type: finding.type,
    source: 'Air-Watch', sourceStatus: 'ok', title: title.slice(0, 300), summary: parts.filter(Boolean).join(' ').slice(0, 2000),
    url: `https://globe.adsb.lol/?icao=${finding.icao24}`, observedAt: new Date(t).toISOString(), lat, lon, locationMethod: 'provider',
    locationPrecision: 'exact', severity: finding.severity, icao24: finding.icao24, callsign: finding.callsign || null, flight,
    registration: aircraft?.registration ?? null, aircraftType: aircraft?.icaoType ?? null, airline, from: origin, to: destination, evidence: e,
  };
}

/**
 * One round of the watch: the global vector (opensky.mjs watchRound, which also serves the sweep through the round file), the detectors,
 * the identity of each new incident's aircraft, and the round file with the recent incidents. Never throws.
 */
export async function airWatchRound(watch, { now = Date.now(), round = watchRound, lookup = identify, options, log = console } = {}) {
  const started = Date.now();
  if (!watch.rounds && !watch.incidents.length) watch.restore(readWatchRound(options)?.result?.incidents, now);
  let data;
  try { data = await round({ now }); } catch (error) { data = { error: String(error?.message || error) }; }
  if (data?.error) return { ok: false, error: String(data.error).slice(0, 300), ...(data.disabled ? { disabled: true } : {}) };
  const findings = watch.update(data.states, { now, at: data.observedAt });
  const described = [];
  for (const finding of findings) {
    let identity = {};
    try { identity = await lookup({ icao24: finding.icao24, callsign: finding.callsign }, { now }); } catch { /* described without it */ }
    described.push(describe(finding, identity));
  }
  watch.publish(described, now);
  for (const incident of described) log?.log?.(`[AirWatch] ${incident.title}`);
  const incidents = watch.recent(now);
  writeWatchRound({ at: now, result: { ...data.result, incidents } }, options);
  return { ok: true, states: data.states.length, tracks: watch.tracks.size, found: described.length, incidents: incidents.length, ms: Date.now() - started };
}
