import test from 'node:test';
import assert from 'node:assert/strict';
import { briefing, resetState, parseRadnetCsv, monitorState, MONITORS } from '../apis/sources/epa.mjs';

const HOUR = 3600000;
const NOW = Date.parse('2026-10-17T14:00:00Z');
const HEADER = 'LOCATION_NAME,SAMPLE COLLECTION TIME,DOSE EQUIVALENT RATE (nSv/h),GAMMA COUNT RATE R02 (CPM),GAMMA COUNT RATE R03 (CPM),GAMMA COUNT RATE R04 (CPM),'
  + 'GAMMA COUNT RATE R05 (CPM),GAMMA COUNT RATE R06 (CPM),GAMMA COUNT RATE R07 (CPM),GAMMA COUNT RATE R08 (CPM),GAMMA COUNT RATE R09 (CPM),STATUS';
const stamp = ms => { const d = new Date(ms); const p = n => String(n).padStart(2, '0'); return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`; };
// Hourly rows for `days` days up to `end`: a dose of `dose(ms)` (null: an empty dose cell) and eight count rates of 100.
function csv(name, { days = 35, end = NOW - HOUR, dose = () => 30 } = {}) {
  const rows = [HEADER];
  for (let at = end - days * 24 * HOUR; at <= end; at += HOUR) {
    const value = dose(at);
    rows.push(`${name},${stamp(at)},${value === null ? '' : value.toFixed(2)},100,100,100,100,100,100,100,100,APPROVED`);
  }
  return rows.join('\n');
}

function serve(t, answer) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    const [state, city] = decodeURIComponent(String(url)).split('/fixed/')[1].split('/');
    const response = answer(state, city, String(url));
    return typeof response === 'string' ? new Response(response, { status: 200 }) : response;
  });
  return calls;
}

test('RadNet CSV: dose rate and summed gamma counts per hour, UTC times, empty cells as null', () => {
  const rows = parseRadnetCsv(`${HEADER}\nCO: DENVER,10/17/2026 13:10:00,,3198.00,1888.00,481.00,260.00,143.00,168.00,104.00,30.00,APPROVED\n`
    + 'CA: LOS ANGELES,10/17/2026 12:52:00,73.00,2996.00,1810.00,517.00,293.00,188.00,214.00,135.00,36.00,APPROVED\nbroken line\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { at: Date.parse('2026-10-17T12:52:00Z'), dose: 73, cpm: 2996 + 1810 + 517 + 293 + 188 + 214 + 135 + 36 });
  assert.equal(rows[1].dose, null);
  assert.equal(rows[1].cpm, 3198 + 1888 + 481 + 260 + 143 + 168 + 104 + 30);
});

test('RadNet monitor: the latest against its own 30-day median; a monitor without a dose rate is judged by its count rate; silent for 48 h is offline', () => {
  const monitor = MONITORS[0];
  const steady = monitorState(monitor, parseRadnetCsv(csv('DC: WASHINGTON', { dose: at => at > NOW - 2 * HOUR ? 60 : 30 })), NOW);
  assert.equal(steady.status, 'online'); assert.equal(steady.result, 60); assert.equal(steady.baseline, 30); assert.equal(steady.ratio, 2); assert.equal(steady.unit, 'nSv/h');
  const counts = monitorState(monitor, parseRadnetCsv(csv('CO: DENVER', { dose: () => null })), NOW);
  assert.equal(counts.analyte, 'Gamma count rate'); assert.equal(counts.unit, 'CPM'); assert.equal(counts.result, 800); assert.equal(counts.ratio, 1);
  const silent = monitorState(monitor, parseRadnetCsv(csv('IL: CHICAGO', { end: NOW - 30 * 24 * HOUR })), NOW);
  assert.equal(silent.status, 'offline');
});

test('RadNet briefing: ten monitors, an elevated one is a signal with the rain caveat, an offline one is a note, not an error; cached for 3 hours', async t => {
  resetState();
  t.after(() => resetState());
  const calls = serve(t, (state, city) => {
    if (city === 'SEATTLE') return csv('WA: SEATTLE', { dose: at => at > NOW - 3 * HOUR ? 54 : 27 });
    if (city === 'ANCHORAGE') return csv('AK: ANCHORAGE', { end: NOW - 72 * HOUR });
    return csv(`${state}: ${city}`);
  });
  const result = await briefing({ now: NOW });
  assert.equal(result.error, undefined);
  assert.equal(result.totalReadings, 9);
  assert.equal(result.readings.length, MONITORS.length);
  assert.equal(result.signals.length, 1);
  assert.match(result.signals[0], /^ELEVATED gamma dose rate at Seattle, WA: 54 nSv\/h, 2x its 30-day median of 27 nSv\/h .*radon washout/);
  assert.match(result.message, /offline .*Anchorage, AK/);
  assert.ok(calls.every(url => url.startsWith('https://radnet.epa.gov/cdx-radnet-rest/api/rest/csv/2026/fixed/')));
  const count = calls.length;
  const cached = await briefing({ now: NOW + 2 * HOUR });
  assert.equal(cached.cached, true); assert.equal(cached.stale, undefined);
  assert.equal(calls.length, count, 'no request within 3 hours');
});

test('RadNet briefing: no monitor answering is an error without a radiation assessment', async t => {
  resetState();
  t.after(() => resetState());
  serve(t, () => new Response('down', { status: 500 }));
  const result = await briefing({ now: NOW });
  assert.match(result.error, /No RadNet monitor answered/);
  assert.deepEqual(result.readings, []);
  assert.doesNotMatch(result.signals.join(' '), /below/);
});
