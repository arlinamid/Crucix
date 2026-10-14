import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../dashboard/public/air-layer.js', import.meta.url), 'utf8');
function load() {
  const window = {};
  vm.runInNewContext(source, { window });
  return window.CrucixAir;
}
const t = (key, fallback) => fallback;

test('air groups merge the 2° cells, keep the busiest countries and count the notable aircraft inside', () => {
  const air = load();
  const grid = [
    { lat: 47, lon: 3, count: 100, top: [['France', 60], ['Spain', 20]] },
    { lat: 45, lon: 1, count: 50, top: [['France', 30], ['United Kingdom', 15]] },
    { lat: -33, lon: -71, count: 4, top: [['Chile', 4]] },
    { lat: 'x', lon: 1, count: 9 }, null,
  ];
  const notable = [{ lat: 46.2, lon: 2.1, kind: 'military' }, { lat: 47.5, lon: 3.3, kind: 'squawk' }, { lat: 10, lon: 10, kind: 'high' }];
  // The page realm's arrays: compared as plain JSON.
  const groups = JSON.parse(JSON.stringify(air.clusters(grid, notable, 6)));
  assert.equal(groups.length, 2, 'a bin with only notable aircraft and no counted traffic is not drawn');
  const [france, chile] = groups;
  assert.equal(france.count, 150);
  assert.deepEqual(france.top, [['France', 90], ['Spain', 20], ['United Kingdom', 15]]);
  assert.deepEqual(france.kinds, { military: 1, squawk: 1 }); assert.equal(france.notable, 2);
  assert.deepEqual(france.bounds, [0, 44, 4, 48]);
  assert.ok(Math.abs(france.lat - (47 * 100 + 45 * 50) / 150) < 1e-9);
  assert.equal(chile.count, 4);
  assert.equal(air.clusters(undefined, undefined, 6).length, 0);
  assert.deepEqual([air.short(950), air.short(1200), air.short(12960)], ['950', '1.2k', '13k']);
});

test('an aircraft is described with its route, altitude in metres and feet, speed and heading', () => {
  const air = load();
  const row = ['3c6444', 'DLH4AB', 'Germany', 50.1, 8.6, 10668, 230, 271.4, 0, '1000', '', ['FRA', 50.03, 8.57, 'DE'], ['LIS', 38.77, -9.13, 'PT']];
  const a = air.rowObject(row);
  const { head, lines } = JSON.parse(JSON.stringify(air.describe(a, t)));
  assert.equal(head, 'DLH4AB');
  assert.deepEqual(lines, ['Route: FRA (DE) → LIS (PT)', 'Registered in: Germany', 'Altitude: 10,668 m (35,000 ft)', 'Speed: 828 km/h', 'Heading: 271°', 'Squawk 1000', 'ICAO24: 3c6444']);
  const military = air.describe({ icao24: 'ae1234', callsign: 'RCH871', kind: 'military' }, t);
  assert.equal(military.lines[0], 'military');
  assert.match(military.lines.at(-1), /heuristic/);
  const rows = air.rowsIn([row, ['x', '', '', 10, 10]], [0, 45, 10, 55]);
  assert.deepEqual(rows.map(r => r.icao24), ['3c6444']);
});
