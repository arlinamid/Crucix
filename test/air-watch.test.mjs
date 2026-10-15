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
const watchOf = () => new AirWatch({ routeOf: callsign => ROUTES[callsign] ?? null });

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

test('air watch: a fast fall at cruise far from the destination fires; an approach, a reused flight number, a gentle descent, a jet trainer and an altitude error do not', () => {
  const watch = watchOf();
  const first = [
    sv({ icao: '3c4b26', cs: 'DLH400', lat: 53, lon: -15, alt: 11000, t: T0 }),            // mid-Atlantic, FRA -> JFK
    sv({ icao: '3c4b27', cs: 'DLH401', lat: 50.5, lon: 6, alt: 11000, t: T0 }),              // ~190 km before Frankfurt
    sv({ icao: 'a1b2c3', cs: 'N123AB', lat: 40, lon: -100, alt: 11000, t: T0 }),             // no route
    sv({ icao: 'a1b2c4', cs: 'AAL9999', lat: 41, lon: -100, alt: 11000, t: T0 }),            // no route
    sv({ icao: 'a1b2c6', cs: 'N212UT', lat: 33, lon: -111, alt: 9400, t: T0 }),               // a jet trainer, no airline callsign
    sv({ icao: '3c4b28', cs: 'DLH402', lat: 54, lon: -20, alt: 11000, t: T0 }),
    sv({ icao: '3c4b30', cs: 'DLH404', lat: 50.5, lon: 2, alt: 11000, t: T0 }),               // "FRA -> JFK", but flying east: another leg
    sv({ icao: '3c4b31', cs: 'DLH400', lat: 52, lon: -30, alt: 11000, t: T0 }),               // on the route, an ordinary step down
    sv({ icao: 'a1b2c5', cs: 'N3242C', lat: 29, lon: -82, alt: 11300, speed: 60, t: T0 }),    // a light aircraft "at FL370": an altitude error
  ];
  assert.deepEqual(watch.update(first, { now: T0 }), [], 'one point is no descent');
  const t = T0 + 5 * MINUTE;
  const found = watch.update([
    sv({ icao: '3c4b26', cs: 'DLH400', lat: 52.9, lon: -16.2, alt: 7000, vr: -12, t }),
    sv({ icao: '3c4b27', cs: 'DLH401', lat: 50.3, lon: 7, alt: 8000, vr: -12, t }),
    sv({ icao: 'a1b2c3', cs: 'N123AB', lat: 40, lon: -100.5, alt: 8000, vr: -10, t }),
    sv({ icao: 'a1b2c4', cs: 'AAL9999', lat: 41, lon: -100.5, alt: 4500, vr: -30, t }),
    sv({ icao: 'a1b2c6', cs: 'N212UT', lat: 33.1, lon: -111.3, alt: 4500, vr: -30, t }),
    sv({ icao: '3c4b28', cs: 'DLH402', lat: 54, lon: -21, alt: 8000, geo: 11000, vr: 0, t }), // barometric and geometric 3 km apart
    sv({ icao: '3c4b30', cs: 'DLH404', lat: 50.4, lon: 3.2, alt: 7700, vr: -12, t }),
    sv({ icao: '3c4b31', cs: 'DLH400', lat: 51.9, lon: -31.2, alt: 8500, vr: -8, t }),         // 2,500 m at 1,600 ft/min
    sv({ icao: 'a1b2c5', cs: 'N3242C', lat: 29.1, lon: -82.1, alt: 850, speed: 60, t }),
  ], { now: t });
  assert.deepEqual(found.map(f => `${f.type}:${f.callsign}`).sort(), ['descent:AAL9999', 'descent:DLH400']);
  const dlh = found.find(f => f.callsign === 'DLH400');
  assert.equal(dlh.evidence.from - dlh.evidence.to, 4000);
  assert.equal(dlh.severity, 'elevated', '13 m/s on average and no steep vertical rate');
  assert.equal(found.find(f => f.callsign === 'AAL9999').severity, 'high');
  // Once per aircraft and kind within three hours.
  assert.deepEqual(watch.update([sv({ icao: '3c4b26', cs: 'DLH400', lat: 52.8, lon: -17, alt: 5000, vr: -12, t: t + 5 * MINUTE })], { now: t + 5 * MINUTE }), []);
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
});

test('air watch: turning off the route and landing far from both ends is a diversion; landing back at the origin a return; landing on the course is not', () => {
  const watch = watchOf();
  // Positions every 5 minutes: [lat, lon, altitude m | 'ground', vertical rate].
  const tracks = {
    // FRA -> JFK out over the Atlantic, then back east and a gradual descent (~1,000 ft/min) to Shannon.
    '3c4b28': ['DLH402', [[53.5, -14, 11000], [53.3, -20, 11000], [53.2, -16, 10000, -3], [53.0, -13, 8500, -5], [52.9, -11, 7000, -5], [52.8, -9.8, 5000, -6],
      [52.7, -9.3, 3000, -6], [52.68, -9.0, 1200, -4]]],
    // FRA -> JFK over Ireland and down to Shannon on the course to New York: the wrong leg of a flight number looks just like this.
    '3c4b2b': ['DLH404', [[52.0, -2.0, 11000], [52.3, -6.0, 11000], [52.4, -7.0, 9000, -5], [52.5, -7.6, 7500, -5], [52.55, -8.0, 6000, -5], [52.6, -8.3, 4500, -5],
      [52.62, -8.5, 3000, -5], [52.65, -8.7, 1200, -4]]],
    // FRA -> JFK, turned back to Frankfurt.
    '3c4b29': ['DLH403', [[50.5, 6.0, 9000], [51.0, 3.0, 11000], [50.8, 5.0, 9000, -5], [50.5, 6.5, 7000, -6], [50.3, 7.4, 5000, -6], [50.2, 8.0, 3500, -5],
      [50.1, 8.4, 1400, -5], [50.05, 8.6, 'ground']]],
    // "On the ground" at cruise: an error, not a landing.
    '3c4b2a': ['DLH402', [[50.0, 0.0, 11000], [50.3, -3.0, 11000], [50.5, -6.0, 'ground']]],
  };
  let found = [];
  for (let i = 0; i < 8; i++) {
    const t = T0 + i * 5 * MINUTE;
    const states = Object.entries(tracks).filter(([, [, points]]) => points[i]).map(([icao, [cs, points]]) => {
      const [lat, lon, alt, vr = 0] = points[i];
      return alt === 'ground' ? sv({ icao, cs, lat, lon, ground: true, t }) : sv({ icao, cs, lat, lon, alt, vr, t });
    });
    found = found.concat(watch.update(states, { now: t }));
  }
  // The diversion fires on approach (low and descending), the return on the ground after a low contact; the false landing never.
  assert.deepEqual(found.map(f => `${f.type}:${f.callsign}`).sort(), ['diversion:DLH402', 'return:DLH403']);
  // An aircraft first seen on the ground is not followed at all.
  assert.deepEqual(watchOf().update([sv({ icao: 'bbb001', cs: 'DLH402', lat: 52.70, lon: -8.92, ground: true, t: T0 })], { now: T0 }), []);
});

test('air watch: an incident names its flight, aircraft and airline, becomes an aviation event, and a report of the same flight links to it', t => {
  const watch = watchOf();
  watch.update([sv({ icao: '3c4b26', cs: 'DLH400', lat: 53, lon: -15, alt: 11000, t: T0 })], { now: T0 });
  const [finding] = watch.update([sv({ icao: '3c4b26', cs: 'DLH400', lat: 52.9, lon: -16.2, alt: 7000, vr: -12, t: T0 + 5 * MINUTE })], { now: T0 + 5 * MINUTE });
  const incident = describe(finding, {
    aircraft: { registration: 'D-ABYF', icaoType: 'B748', manufacturer: 'Boeing', type: '747 830' },
    route: { flight: 'LH400', airline: { name: 'Lufthansa' }, origin: { iata: 'FRA', city: 'Frankfurt am Main' }, destination: { iata: 'JFK', city: 'New York' } },
  });
  assert.match(incident.title, /^Rapid descent: Lufthansa LH400 \(D-ABYF, B748\) lost 13,100 ft in 5 min/);
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
