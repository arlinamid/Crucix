import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aviationEntities } from '../lib/air/aviation.mjs';
import { flightOfCallsign } from '../lib/air/airlines.mjs';
import { parseAircraft, parseRoute } from '../lib/air/identity.mjs';
import { AirWatch, airWatchRound, describe } from '../lib/air/watch.mjs';
import { briefing, resetState } from '../apis/sources/opensky.mjs';
import { airIncidentsOf } from '../dashboard/inject.mjs';
import { buildEvents } from '../lib/intelligence/events.mjs';
import { createDictionaries, extractEntities } from '../lib/intelligence/extract.mjs';
import { GraphStore } from '../lib/intelligence/graph.mjs';
import { graphRecordsOf, linkEvents } from '../lib/intelligence/linkers.mjs';

const MINUTE = 60000;
const T0 = Date.parse('2026-10-15T10:00:00Z');
const FRA = ['FRA', 50.0333, 8.5706, 'DE', 'EDDF'];
const JFK = ['JFK', 40.6398, -73.7789, 'US', 'KJFK'];
const ROUTES = { DLH400: { o: FRA, d: JFK }, DLH401: { o: JFK, d: FRA }, DLH402: { o: FRA, d: JFK }, DLH403: { o: FRA, d: JFK }, DLH404: { o: FRA, d: JFK } };
const ids = list => list.map(entity => entity.id).sort();
// An OpenSky state vector: [icao24, callsign, country, time_position, last_contact, lon, lat, baro m, on_ground, velocity, track, vrate, sensors, geo m, squawk].
const sv = ({ icao, cs, lat, lon, alt, t, vr = 0, sq = '1000', ground = false, geo = alt, speed = 230 }) =>
  [icao, `${cs.padEnd(8)}`, 'Germany', t / 1000, t / 1000, lon, lat, ground ? null : alt, ground, speed, 270, vr, null, ground ? null : geo, sq];
// The airports airline flights use (the route cache's, in the watch).
const AIRPORTS = [FRA, JFK, ['SNN', 52.7019, -8.9248], ['DEN', 39.8617, -104.6731], ['ORD', 41.9786, -87.9048]];
const watchOf = () => new AirWatch({ routeOf: callsign => ROUTES[callsign] ?? null, airports: () => AIRPORTS });

test('aviation entities: flights, registrations and airlines in news text; aircraft types, years and look-alikes are not', () => {
  assert.deepEqual(ids(aviationEntities('United Airlines Flight 1175 makes emergency landing in Honolulu')), ['airline:UAL', 'flight:UA1175']);
  assert.deepEqual(ids(aviationEntities('Delta flight DL1137 diverts to Shannon; Airbus A330 N806NW returned safely')), ['aircraft:N806NW', 'airline:DAL', 'flight:DL1137']);
  assert.deepEqual(ids(aviationEntities('Wizz Air W6 2201-es járata kényszerleszállást hajtott végre, a HA-LYA gép utasai')), ['aircraft:HA-LYA', 'airline:WZZ', 'flight:W62201']);
  assert.deepEqual(ids(aviationEntities('Air India flight AI171 crashed after takeoff; Boeing 787 VT-ANB')), ['aircraft:VT-ANB', 'airline:AIC', 'flight:AI171']);
  assert.deepEqual(ids(aviationEntities('Lufthansa A380 plunges over the Atlantic, passengers injured')), ['airline:DLH'], 'A380 is a type, not Aegean flight A3 80');
  assert.deepEqual(aviationEntities('US deploys F-35 and B-52H bombers; F-16C jets intercept Su-35 over the Baltic'), []);
  assert.deepEqual(aviationEntities('N95 masks run short; the AI 2027 report is out'), []);
  assert.deepEqual(aviationEntities('United Arab Emirates flights resume to Beirut airport'), []);
  assert.deepEqual(aviationEntities('Iberia region drought worsens; a Condor seen in the Andes'), [], 'an airline name needs an aviation context');
  assert.deepEqual(ids(aviationEntities('Squawk 7700: DLH400 N12345', { aviation: true })), ['aircraft:N12345', 'flight:LH400'], 'an aviation record is its own context');
  assert.deepEqual(flightOfCallsign('DLH0400'), { flight: 'LH400', airline: flightOfCallsign('DLH400').airline });
  assert.equal(flightOfCallsign('N123AB'), null);
  // extractEntities carries them with the other entities.
  assert.ok(ids(extractEntities({ kind: 'news', title: 'Delta flight DL1137 diverts to Shannon', summary: '', location: {} }, createDictionaries())).includes('flight:DL1137'));
});

test('identity: adsbdb answers are parsed into strict fields; anything else is dropped', () => {
  const aircraft = parseAircraft({ response: { aircraft: { type: '747 830', icao_type: 'B748', manufacturer: 'Boeing', registration: 'D-ABYF', registered_owner: 'Lufthansa<script>',
    registered_owner_country_iso_name: 'DE', registered_owner_operator_flag_code: 'DLH' } } });
  assert.deepEqual(aircraft, { registration: 'D-ABYF', type: '747 830', icaoType: 'B748', manufacturer: 'Boeing', owner: 'Lufthansascript', ownerCountry: 'DE', operator: 'DLH' });
  assert.equal(parseAircraft({ response: 'unknown aircraft' }), null);
  assert.equal(parseAircraft({ response: { aircraft: { registration: '../../x' } } }), null);
  const route = parseRoute({ response: { flightroute: { callsign_icao: 'UAL1175', callsign_iata: 'UA1175', airline: { name: 'United Airlines', icao: 'UAL', iata: 'UA' },
    origin: { iata_code: 'SFO', icao_code: 'KSFO', municipality: 'San Francisco', latitude: 37.619, longitude: -122.375 }, destination: { iata_code: 'HNL', latitude: 999 } } } });
  assert.equal(route.flight, 'UA1175');
  assert.equal(route.origin.city, 'San Francisco');
  assert.equal(route.destination.lat, null, 'a coordinate off the globe is dropped');
});

test('air watch: a steep fall at cruise far from any airport fires; an arrival, a normal descent, an altitude error, a jet trainer do not', () => {
  const watch = watchOf();
  // [callsign, icao, first position and altitude, second position and altitude, extra fields of the second]
  const cases = [
    ['DLH400', '3c4b26', [53, -15, 11000], [52.9, -16.2, 4000], { vr: -25 }],            // mid-Atlantic, 23 m/s: fires
    ['AAL9999', 'a1b2c4', [41, -100, 11000], [41, -100.5, 4500], { vr: -30 }],             // ~350 km from Denver, 22 m/s: fires
    ['UAL100', 'a1b2c7', [40.9, -73.2, 11000], [40.7, -73.6, 4500], { vr: -30 }],          // the same steepness into JFK: an arrival
    ['DLH401', '3c4b27', [52, -30, 11000], [51.9, -31.2, 7000], { vr: -12 }],              // 4,000 m at 13 m/s: a normal steep descent
    ['DLH402', '3c4b28', [54, -20, 11000], [54, -21, 8000], { geo: 11000 }],                // barometric and geometric 3 km apart
    ['DLH403', '3c4b29', [55, -25, 11000], [55, -26, 2000], { vr: -40 }],                  // 9,000 m in 5 min (30 m/s), still at 2,000 m: fires
    ['DLH404', '3c4b2a', [56, -25, 12000], [56, -26, 1800], {}],                            // 34 m/s (under the 50 m/s error limit), still at 1,800 m: fires
    ['DLH405', '3c4b2b', [57, -25, 12000], [57, -26, 500], {}],                             // ends below 1,500 m: not a mid-air event
    ['DLH406', '3c4b2c', [58, -25, 12000], [58, -26, 0], {}],                               // altitude 0: an error
    ['N212UT', 'a1b2c6', [33, -111, 9400], [33.1, -111.3, 2500], { vr: -30 }],             // a jet trainer, no airline callsign
    ['RCH871', 'ae1234', [45, -40, 11000], [45, -41, 3000], { vr: -30 }],                  // a military-pattern callsign
  ];
  watch.update(cases.map(([cs, icao, [lat, lon, alt]]) => sv({ icao, cs, lat, lon, alt, t: T0 })), { now: T0 });
  const t = T0 + 5 * MINUTE;
  // A 60 m/s "fall" (18,000 m in 5 min) is an altitude error.
  watch.update([sv({ icao: 'a1b2c8', cs: 'SWA1', lat: 30, lon: -60, alt: 19000, t: T0 })], { now: T0 });
  const found = watch.update([...cases.map(([cs, icao, , [lat, lon, alt], extra]) => sv({ icao, cs, lat, lon, alt, t, ...extra })),
    sv({ icao: 'a1b2c8', cs: 'SWA1', lat: 30, lon: -61, alt: 1000, t })], { now: t });
  assert.deepEqual(found.map(f => f.callsign).sort(), ['AAL9999', 'DLH400', 'DLH403', 'DLH404']);
  assert.ok(found.every(f => f.type === 'descent' && f.severity === 'elevated'));
  assert.equal(found.find(f => f.callsign === 'DLH400').evidence.from - found.find(f => f.callsign === 'DLH400').evidence.to, 7000);
  // Once per aircraft and kind within three hours.
  assert.deepEqual(watch.update([sv({ icao: '3c4b26', cs: 'DLH400', lat: 52.8, lon: -17, alt: 2000, vr: -12, t: t + 5 * MINUTE })], { now: t + 5 * MINUTE }), []);
  // No airport known yet (an empty route cache): nothing counts as remote, so nothing fires.
  const blind = new AirWatch({ routeOf: () => null, airports: () => [] });
  blind.update([sv({ icao: '3c4b26', cs: 'DLH400', lat: 53, lon: -15, alt: 11000, t: T0 })], { now: T0 });
  assert.deepEqual(blind.update([sv({ icao: '3c4b26', cs: 'DLH400', lat: 52.9, lon: -16.2, alt: 4000, t })], { now: t }), []);
});

test('air watch: a position older than its contact (a coverage gap) is not a new point', () => {
  const watch = watchOf();
  watch.update([sv({ icao: '3c4b26', cs: 'DLH400', lat: 53, lon: -15, alt: 11000, t: T0 })], { now: T0 });
  // The contact is 5 minutes later but the position (and its altitude) is from 4 minutes before it.
  const stale = sv({ icao: '3c4b26', cs: 'DLH400', lat: 52.9, lon: -16.2, alt: 4000, t: T0 + 5 * MINUTE });
  stale[3] = (T0 + MINUTE) / 1000;
  assert.deepEqual(watch.update([stale], { now: T0 + 5 * MINUTE }), []);
  assert.equal(watch.tracks.get('3c4b26').p.length, 1);
  // A new aircraft whose only position is stale is not followed yet (no empty track).
  const fresh = sv({ icao: '3c4b99', cs: 'DLH499', lat: 50, lon: 0, alt: 11000, t: T0 + 10 * MINUTE });
  fresh[3] = (T0 + MINUTE) / 1000;
  assert.deepEqual(watch.update([fresh], { now: T0 + 10 * MINUTE }), []);
  assert.equal(watch.tracks.has('3c4b99'), false);
});

test('air watch: an emergency squawk fires when newly set and still set at the next contact; not when on from the start or gone at once', () => {
  const watch = watchOf();
  const round = (t, codes) => watch.update(Object.entries(codes).map(([n, sq]) => sv({ icao: `aaa00${n}`, cs: `THY${n}`, lat: 40 + Number(n), lon: 29 - (t - T0) / 3e5, alt: 9000, t, sq })), { now: t });
  assert.deepEqual(round(T0, { 2: '2200', 3: '7700', 5: '1200' }), []);
  assert.deepEqual(round(T0 + 5 * MINUTE, { 2: '7700', 3: '7700', 4: '7600', 5: '7500' }), [], 'one contact is not enough');
  // THY2 newly set and kept; THY3 on from the first round; THY4 appeared with it after the first round; THY5 a mistyped 7500 put right.
  const found = round(T0 + 10 * MINUTE, { 2: '7700', 3: '7700', 4: '7600', 5: '1200' });
  assert.deepEqual(found.map(f => `${f.callsign}:${f.evidence.squawk}`).sort(), ['THY2:7700', 'THY4:7600']);
  assert.equal(found.find(f => f.callsign === 'THY2').evidence.previous, '2200');
  assert.equal(found.find(f => f.callsign === 'THY2').severity, 'high', 'an airliner in an emergency');
  assert.equal(found.find(f => f.callsign === 'THY4').severity, 'moderate', 'a radio failure');
  // Other traffic: a training flight's 7500 is moderate.
  const ga = watchOf();
  for (const [i, sq] of ['1200', '7500', '7500'].entries()) var gaFound = ga.update([sv({ icao: 'a99347', cs: 'N99347', lat: 30.6, lon: -87.4 - i / 10, alt: 900, t: T0 + i * 5 * MINUTE, sq })], { now: T0 + i * 5 * MINUTE });
  assert.equal(gaFound[0].severity, 'moderate');
});

test('air watch: a landing within the hour after an emergency is an incident (a diversion, a return, or a landing); a landing alone is not', () => {
  const watch = watchOf();
  // Positions every 5 minutes: [lat, lon, altitude m | 'ground', vertical rate, squawk].
  const tracks = {
    // FRA -> JFK out over the Atlantic, 7700, back east and down to Shannon: a diversion.
    '3c4b28': ['DLH402', [[53.5, -14, 11000], [53.3, -20, 11000, 0, '7700'], [53.2, -16, 10000, -3, '7700'], [53.0, -13, 8500, -5, '7700'], [52.9, -11, 7000, -5, '7700'],
      [52.8, -9.8, 5000, -6, '7700'], [52.7, -9.3, 3000, -6, '7700'], [52.68, -9.0, 1200, -4, '7700']]],
    // FRA -> JFK, 7700 over Belgium, turned back to Frankfurt: a return.
    '3c4b29': ['DLH403', [[50.5, 6.0, 9000], [51.0, 3.0, 11000, 0, '7700'], [50.8, 5.0, 9000, -5, '7700'], [50.5, 6.5, 7000, -6, '7700'], [50.3, 7.4, 5000, -6, '7700'],
      [50.2, 8.0, 3500, -5, '7700'], [50.1, 8.4, 1400, -5, '7700'], [50.05, 8.6, 'ground']]],
    // No route: a squawk, then a landing near Denver.
    'a1b2d1': ['SWA5', [[40.5, -103.0, 9000], [40.3, -103.6, 8000, -3, '7700'], [40.1, -104.0, 6000, -6, '7700'], [40.0, -104.3, 4000, -6, '7700'],
      [39.9, -104.6, 1400, -5, '7700'], [39.86, -104.67, 'ground']]],
    // FRA -> JFK down to Shannon with no emergency: the wrong leg of a flight number looks just like this, and is nothing.
    '3c4b2b': ['DLH404', [[52.0, -2.0, 11000], [52.3, -6.0, 11000], [52.4, -7.0, 9000, -5], [52.5, -7.6, 7500, -5], [52.55, -8.0, 6000, -5], [52.6, -8.3, 4500, -5],
      [52.62, -8.5, 3000, -5], [52.65, -8.7, 1200, -4]]],
  };
  let found = [];
  for (let i = 0; i < 8; i++) {
    const t = T0 + i * 5 * MINUTE;
    const states = Object.entries(tracks).filter(([, [, points]]) => points[i]).map(([icao, [cs, points]]) => {
      const [lat, lon, alt, vr = 0, sq = '1000'] = points[i];
      return alt === 'ground' ? sv({ icao, cs, lat, lon, ground: true, t, sq }) : sv({ icao, cs, lat, lon, alt, vr, t, sq });
    });
    found = found.concat(watch.update(states, { now: t }));
  }
  const landings = found.filter(f => f.type !== 'squawk');
  assert.deepEqual(landings.map(f => `${f.type}:${f.callsign}`).sort(), ['diversion:DLH402', 'landing:SWA5', 'return:DLH403']);
  assert.ok(landings.every(f => f.severity === 'high' && f.evidence.after === 'squawk 7700'));
  assert.equal(landings.find(f => f.callsign === 'SWA5').evidence.airport, 'DEN');
  const text = describe(landings.find(f => f.callsign === 'DLH402'));
  assert.match(text.title, /^Diversion after squawk 7700: Lufthansa LH402 is landing near SNN, [\d,]+ km from JFK/);
  assert.match(describe(landings.find(f => f.callsign === 'SWA5')).title, /^Landing after squawk 7700: .* near DEN/);
});

test('air watch: an incident names its flight, aircraft and airline, becomes an aviation event, and a report of the same flight links to it', t => {
  const watch = watchOf();
  watch.update([sv({ icao: '3c4b26', cs: 'DLH400', lat: 53, lon: -15, alt: 11000, t: T0 })], { now: T0 });
  const [finding] = watch.update([sv({ icao: '3c4b26', cs: 'DLH400', lat: 52.9, lon: -16.2, alt: 4000, vr: -25, t: T0 + 5 * MINUTE })], { now: T0 + 5 * MINUTE });
  const incident = describe(finding, {
    aircraft: { registration: 'D-ABYF', icaoType: 'B748', manufacturer: 'Boeing', type: '747 830' },
    route: { flight: 'LH400', airline: { name: 'Lufthansa' }, origin: { iata: 'FRA', city: 'Frankfurt am Main' }, destination: { iata: 'JFK', city: 'New York' } },
  });
  assert.match(incident.title, /^Rapid descent: Lufthansa LH400 \(D-ABYF, B748\) lost 23,000 ft in 5 min/);
  assert.match(incident.summary, /Route Frankfurt am Main \(FRA\) → New York \(JFK\)\./);
  assert.match(incident.summary, /not a confirmed event/);
  assert.equal(incident.severity, 'elevated');
  // The snapshot keeps it field by field; buildEvents makes it an aviation observation at its point.
  const [row] = airIncidentsOf([incident, { ...incident, type: 'other' }, { ...incident, lat: 200 }]);
  assert.equal(airIncidentsOf([incident, { ...incident, type: 'other' }, { ...incident, lat: 200 }]).length, 1);
  const [event] = buildEvents({ meta: { timestamp: new Date(T0 + 6 * MINUTE).toISOString() }, airIncidents: [row] }, { now: T0 + 6 * MINUTE });
  assert.equal(event.kind, 'aviation');
  assert.equal(event.source.name, 'Air-Watch');
  assert.equal(event.location.method, 'provider');
  const [record] = graphRecordsOf([event]);
  for (const entity of ['flight:LH400', 'aircraft:D-ABYF', 'airline:DLH']) assert.ok(record.entities.some(e => e.id === entity), entity);
  // The graph: a report naming the flight links at full strength; one naming the airline and an incident, with a shared word, more weakly;
  // a business story about the airline not at all.
  const dir = mkdtempSync(join(tmpdir(), 'crucix-air-graph-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = T0 + 3 * 3600000;
  const graph = new GraphStore(dir, { now: () => now });
  const report = (n, title) => ({ id: `event-${String(n).padStart(32, '0')}`, kind: 'news', title, summary: '', location: {}, source: { name: `Outlet ${n}`, hostname: `o${n}.example` },
    publishedAt: new Date(now - 3600000).toISOString(), severity: 'unknown', relatedSources: [] });
  const events = [event, report(1, 'Lufthansa flight LH400 to New York drops 8,000 feet over the Atlantic'),
    report(2, 'Lufthansa jumbo jet in emergency descent on way to New York'), report(3, 'Lufthansa reports record quarterly profit as flights recover')];
  const records = graphRecordsOf(events, createDictionaries());
  const added = graph.ingest(records, { now });
  const edges = linkEvents(added, graph, { now });
  const strength = other => edges.find(edge => [edge.a, edge.b].includes(event.id) && [edge.a, edge.b].includes(other.id) && edge.type === 'co-occurs')?.s ?? 0;
  assert.equal(strength(events[1]), 0.9, 'the same flight');
  assert.equal(strength(events[2]), 0.7, 'the same airline, an incident report, a shared place word');
  assert.equal(strength(events[3]), 0, 'the airline alone never links');
});

test('air watch round: the incidents go into the round file and the sweep serves that round instead of asking OpenSky', async () => {
  resetState();
  const home = process.env.CRUCIX_HOME;
  assert.ok(home, 'tests run in an isolated profile');
  const watch = watchOf();
  const result = { source: 'OpenSky', timestamp: new Date(T0).toISOString(), hotspots: [], grid: [], alerts: [], notable: [], airborne: 1 };
  const states = at => [sv({ icao: 'aaa001', cs: 'THY2', lat: 41, lon: 29, alt: 9000, t: at, sq: at === T0 ? '2200' : '7700' })];
  const round = async ({ now }) => ({ result: { ...result, timestamp: new Date(now).toISOString() }, states: states(now), observedAt: now });
  const lookup = async () => ({ aircraft: { registration: 'TC-JJA', icaoType: 'B77W' }, route: null });
  assert.equal((await airWatchRound(watch, { now: T0, round, lookup, log: null })).found, 0);
  assert.equal((await airWatchRound(watch, { now: T0 + 5 * MINUTE, round, lookup, log: null })).found, 0);
  const third = await airWatchRound(watch, { now: T0 + 10 * MINUTE, round, lookup, log: null });
  assert.equal(third.found, 1);
  assert.equal(third.incidents, 1);
  const served = await briefing({ now: T0 + 12 * MINUTE });
  assert.equal(served.via, 'air-watch');
  assert.equal(served.incidents.length, 1);
  assert.match(served.incidents[0].title, /^Squawk 7700 \(general emergency\): Turkish Airlines TK2 \(TC-JJA, B77W\)/);
  // A restarted watch takes the recent incidents back and does not fire them again.
  const restarted = watchOf();
  const again = await airWatchRound(restarted, { now: T0 + 15 * MINUTE, round: async ({ now }) => ({ result, states: states(now), observedAt: now }), lookup, log: null });
  assert.equal(again.incidents, 1);
  // Without an account the watch turns itself off.
  const off = await airWatchRound(watchOf(), { now: T0, round: async () => ({ error: 'needs an account', disabled: true }), log: null });
  assert.deepEqual(off, { ok: false, error: 'needs an account', disabled: true });
  resetState();
});
