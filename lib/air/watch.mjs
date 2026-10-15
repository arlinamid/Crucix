// The air watch: OpenSky's global state vector every few minutes (in the worker process), a short track of every aircraft, and the
// moments worth a story before the news has one. Each finding is an air incident: an aviation record (`Air-Watch`) that goes the way of
// every observation (events -> history -> entity graph -> threads), naming the flight, the aircraft and the airline in its own text so a
// later report of the same flight joins its thread (lib/air/aviation.mjs, linkers.mjs). Detectors:
//   descent    a loss of at least 2,400 m (~8,000 ft) from above FL200 within about ten minutes, faster than a normal descent (2,000 ft/min
//              on average, 2,400 ft/min, or 4,000 ft/min at the last report), far from the destination of a route it is flying (inside the route's corridor
//              and heading for its destination: a flight number reused for another leg would make an ordinary approach look far from
//              "its" airport); without such a route, only a much steeper one (4,000 ft/min on average). Airline-pattern callsigns only
//              (DLH400, EJA895): jet trainers, test and private aircraft descend steeply as a matter of course (their emergencies still
//              show as squawks).
//   squawk     an emergency transponder code newly set and still set at the next contact (a mistyped code is usually gone within
//              seconds): 7500 (unlawful interference), 7600 (radio failure), 7700 (general emergency).
//   diversion  an airliner that was flying its route towards the destination, then turned away from it (30° or more off the course
//              to the destination: a flight number's wrong leg would land in the same direction without a turn), now landing (low and
//              descending, or on the ground after a low contact: an on-ground flag at cruise is an error) more than 300 km from the
//              destination and 80 km from where it came from; `return` when it comes back to its origin instead.
// Altitude errors are filtered: barometric and geometric altitude far apart, a lone high reading, or a high reading at a speed no aircraft
// flies there (a light aircraft "at FL370").
// These are transponder observations, not confirmed events: altitude errors, test squawks and wrong routes happen, and every incident
// says so. Each incident fires once per aircraft and kind within three hours.
import { countryAt } from '../intelligence/geo.mjs';
import { countryDisplayName } from '../intelligence/countries.mjs';
import { distanceKm } from '../intelligence/chokepoints.mjs';
import { notableKind, watchRound, writeWatchRound, readWatchRound } from '../../apis/sources/opensky.mjs';
import { AIRLINE_CALLSIGN, routeOf as cachedRoute } from '../../apis/sources/air-routes.mjs';
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
const SQUAWKS = Object.freeze({ '7500': ['unlawful interference', 'high'], '7600': ['radio failure', 'elevated'], '7700': ['general emergency', 'high'] });
// Descent thresholds (metres, m/s, km).
const DESCENT = Object.freeze({ fromAlt: 6100, loss: 2400, windowMs: 11 * MINUTE, minMs: 90000, rate: 12, steepRate: 15, farFromDestination: 400, farFromOrigin: 100,
  unroutedFromAlt: 7600, unroutedLoss: 3000, unroutedRate: 20, vrate: -20, unroutedVrate: -30, heading: 60 });
const DIVERSION = Object.freeze({ cruise: 6000, low: 1500, fromDestination: 300, fromOrigin: 80, returned: 50, away: 150, approach: 10, detour: 1.25, slack: 150,
  heading: 30, turn: 30 });

const finite = value => typeof value === 'number' && Number.isFinite(value);
// A point: [t ms, lat, lon, altitude m (barometric, else geometric), vertical rate m/s, squawk, on ground, geometric altitude, speed m/s].
const T = 0, LAT = 1, LON = 2, ALT = 3, VR = 4, SQ = 5, GND = 6, GEO = 7, SPD = 8;
// Above FL250 an aircraft flies faster than this (m/s, ~215 kt); a slower one there is an altitude error.
const HIGH_ALT = 7600, MIN_HIGH_SPEED = 110;
const plausible = point => (!finite(point[GEO]) || !finite(point[ALT]) || Math.abs(point[GEO] - point[ALT]) <= 1500)
  && !(finite(point[ALT]) && point[ALT] >= HIGH_ALT && finite(point[SPD]) && point[SPD] < MIN_HIGH_SPEED);
const km = (a, lat, lon) => distanceKm(a[LAT], a[LON], lat, lon);
const RAD = Math.PI / 180;
// The initial great-circle bearing from one point to another, degrees.
function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}
const angle = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
// Whether the aircraft is flying this route now: inside its corridor and heading for its destination (from its last two positions).
function flying(track, route) {
  const current = track.p.at(-1), previous = [...track.p].reverse().find(point => current[T] - point[T] >= 90000);
  if (!previous || km(previous, current[LAT], current[LON]) < 5) return false;
  const [o, d] = [route.o, route.d];
  if (km(current, o[1], o[2]) + km(current, d[1], d[2]) > DIVERSION.detour * distanceKm(o[1], o[2], d[1], d[2]) + DIVERSION.slack) return false;
  return angle(bearing(previous[LAT], previous[LON], current[LAT], current[LON]), bearing(current[LAT], current[LON], d[1], d[2])) <= DESCENT.heading;
}
const feet = metres => Math.round(metres * FT / 100) * 100;
const thousands = value => value.toLocaleString('en-US');

export class AirWatch {
  tracks = new Map();   // icao24 -> { c: callsign, k: notable kind, b: round first seen, p: points }
  fired = new Map();    // `${type}|${icao24}` -> ms
  incidents = [];       // the last 24 hours, newest first
  rounds = 0;
  #routeOf;

  constructor({ routeOf = callsign => cachedRoute(callsign) } = {}) { this.#routeOf = routeOf; }

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
    const found = [];
    for (const s of Array.isArray(states) ? states : []) {
      if (!Array.isArray(s)) continue;
      const icao = typeof s[0] === 'string' ? s[0].trim().toLowerCase() : '';
      if (!HEX.test(icao) || !finite(s[5]) || !finite(s[6])) continue;
      const ground = s[8] === true;
      let track = this.tracks.get(icao);
      if (!track) {
        if (ground) continue; // an aircraft on the ground is only followed once it has been seen flying
        track = { c: '', k: null, b: this.rounds, p: [] };
        this.tracks.set(icao, track);
      }
      const t = s[4] > 0 ? s[4] * 1000 : s[3] > 0 ? s[3] * 1000 : at;
      const last = track.p.at(-1);
      if (last && t <= last[T]) continue; // no newer contact
      const geo = finite(s[13]) ? s[13] : null;
      track.p.push([t, Math.round(s[6] * 1000) / 1000, Math.round(s[5] * 1000) / 1000, finite(s[7]) ? s[7] : geo, finite(s[11]) ? s[11] : null,
        String(s[14] ?? '').trim().slice(0, 4), ground, geo, finite(s[9]) ? s[9] : null]);
      while (track.p.length > MAX_POINTS || (track.p.length > 1 && t - track.p[0][T] > TRACK_MS)) track.p.shift();
      const callsign = String(s[1] ?? '').trim().toUpperCase().slice(0, 8);
      if (callsign) track.c = callsign;
      if (!ground) track.k = notableKind(s);
      for (const detect of [squawkOnset, rapidDescent, diversion]) {
        const finding = detect(icao, track, this);
        if (finding && this.#fresh(finding, now)) found.push(finding);
      }
    }
    for (const [icao, track] of this.tracks) if (now - track.p.at(-1)[T] > TRACK_MS) this.tracks.delete(icao);
    for (const [key, when] of this.fired) if (now - when > REFIRE_MS) this.fired.delete(key);
    const rank = { critical: 3, high: 2, elevated: 1 };
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
  return { type: 'squawk', key: `squawk-${current[SQ]}|${icao}`, icao24: icao, callsign: track.c, point: current, severity: SQUAWKS[current[SQ]][1],
    evidence: { squawk: current[SQ], previous: before?.[SQ] || null, altitude: current[ALT] } };
}

function rapidDescent(icao, track, watch) {
  const current = track.p.at(-1);
  if (current[GND] || !finite(current[ALT]) || current[ALT] < 300 || track.k === 'military' || !AIRLINE_CALLSIGN.test(track.c)) return null;
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
  // A route counts only while the aircraft is flying it; near either end a descent is an approach or a climb-out's error.
  const known = watch.routeOf(track.c);
  const route = known && flying(track, known) ? known : null;
  let toDestination = null, toOrigin = null;
  if (route) {
    toDestination = km(current, route.d[1], route.d[2]);
    toOrigin = km(current, route.o[1], route.o[2]);
    if (toDestination <= DESCENT.farFromDestination || toOrigin <= DESCENT.farFromOrigin) return null;
  }
  const vrate = finite(current[VR]) ? current[VR] : 0;
  const steepNow = vrate <= (route ? DESCENT.vrate : DESCENT.unroutedVrate);
  const fires = route
    ? top[ALT] >= DESCENT.fromAlt && loss >= DESCENT.loss && (rate >= DESCENT.rate || steepNow)
    : top[ALT] >= DESCENT.unroutedFromAlt && loss >= DESCENT.unroutedLoss && (rate >= DESCENT.unroutedRate || steepNow);
  if (!fires) return null;
  return { type: 'descent', key: `descent|${icao}`, icao24: icao, callsign: track.c, point: current, route,
    severity: rate >= DESCENT.steepRate || steepNow ? 'high' : 'elevated',
    evidence: { from: Math.round(top[ALT]), to: Math.round(current[ALT]), minutes: Math.round(seconds / 6) / 10, rate: Math.round(rate * 10) / 10,
      vrate: finite(current[VR]) ? current[VR] : null, toDestination: toDestination === null ? null : Math.round(toDestination) } };
}

function diversion(icao, track, watch) {
  const current = track.p.at(-1);
  if (track.p.length < 3 || track.k === 'military') return null;
  const previous = track.p.at(-2);
  const low = point => !point[GND] && finite(point[ALT]) && point[ALT] < DIVERSION.low;
  const landing = current[GND] ? low(previous) || (finite(previous[ALT]) && previous[ALT] < 2 * DIVERSION.low && !previous[GND])
    : low(current) && finite(current[VR]) && current[VR] < -1;
  if (!landing) return null;
  const route = watch.routeOf(track.c);
  if (!route) return null;
  const [o, d] = [route.o, route.d];
  const leg = distanceKm(o[1], o[2], d[1], d[2]);
  const [first, second] = track.p;
  // The route fits: the aircraft was along it at first, and getting closer to the destination.
  if (km(first, o[1], o[2]) + km(first, d[1], d[2]) > DIVERSION.detour * leg + DIVERSION.slack) return null;
  if (km(first, d[1], d[2]) - km(second, d[1], d[2]) < DIVERSION.approach) return null;
  if (angle(bearing(first[LAT], first[LON], second[LAT], second[LON]), bearing(second[LAT], second[LON], d[1], d[2])) > DIVERSION.heading) return null;
  // The last contact at cruise still on course for the destination; from there the landing must lie well off that course.
  const cruising = point => finite(point[ALT]) && point[ALT] >= DIVERSION.cruise && !point[GND];
  let onCourse = null;
  for (let i = 1; i < track.p.length - 1; i++) {
    const [a, b] = [track.p[i - 1], track.p[i]];
    if (cruising(a) && cruising(b) && angle(bearing(a[LAT], a[LON], b[LAT], b[LON]), bearing(b[LAT], b[LON], d[1], d[2])) <= DIVERSION.heading) onCourse = b;
  }
  if (!onCourse) return null;
  if (angle(bearing(onCourse[LAT], onCourse[LON], current[LAT], current[LON]), bearing(onCourse[LAT], onCourse[LON], d[1], d[2])) < DIVERSION.turn) return null;
  const toDestination = km(current, d[1], d[2]), toOrigin = km(current, o[1], o[2]);
  if (toDestination <= DIVERSION.fromDestination) return null;
  const returned = toOrigin <= DIVERSION.returned && track.p.some(point => km(point, o[1], o[2]) > DIVERSION.away);
  if (!returned && toOrigin <= DIVERSION.fromOrigin) return null;
  return { type: returned ? 'return' : 'diversion', key: `diversion|${icao}`, icao24: icao, callsign: track.c, point: current, route, severity: 'elevated',
    evidence: { landed: current[GND], toDestination: Math.round(toDestination), toOrigin: Math.round(toOrigin), altitude: finite(current[ALT]) ? Math.round(current[ALT]) : null } };
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
      + `${finite(e.toDestination) ? `, ${thousands(e.toDestination)} km from the destination` : ', route unknown'}.`;
  } else if (finding.type === 'squawk') {
    title = `Squawk ${e.squawk} (${SQUAWKS[e.squawk][0]}): ${subject}${place}`;
    detail = `Transponder code ${e.squawk} set${e.previous ? ` (it was ${e.previous})` : ''}${finite(e.altitude) ? ` at ${thousands(feet(e.altitude))} ft` : ''}.`;
  } else {
    const where = e.landed ? 'landed' : 'is landing';
    title = finding.type === 'return'
      ? `Return to origin: ${subject} ${where} back at ${origin}${place}`
      : `Diversion: ${subject} ${where} ${thousands(e.toDestination)} km from ${destination}${place}`;
    detail = `It was flying ${routeText ?? 'its route'} and ${where} ${thousands(e.toDestination)} km from the destination and ${thousands(e.toOrigin)} km from the origin.`;
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
