import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
const slice = name => {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\nfunction ', start + 1));
};
const hu = JSON.parse(readFileSync(new URL('../locales/hu.json', import.meta.url), 'utf8'));
const t = (path, fallback) => { let value = hu; for (const key of path.split('.')) value = value?.[key]; return typeof value === 'string' ? value : fallback; };
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const render = space => vm.runInNewContext(`${slice('spaceCount')}\n${slice('issAltitude')}\n${slice('buildSpaceWatchPanel')}\nbuildSpaceWatchPanel`, { D: { space }, t, esc })();

// The panel of 2026-10-18 showed "ALT NaN km", Starlink 0, OneWeb 0 and every military satellite under "UNK".
test('an old snapshot without altitudes or counts shows no NaN and no false zero', () => {
  const out = render({ totalNewObjects: 250, militarySats: 45, militaryByCountry: { UNK: 45 }, constellations: { starlink: 0, oneweb: 0 }, iss: { name: 'ISS (ZARYA)', inclination: 51.6 } });
  assert.doesNotMatch(out, /NaN/);
  assert.doesNotMatch(out, />UNK</);
  assert.match(out, /Ismeretlen tulajdonos/);
  assert.equal((out.match(/<span class="eval">--<\/span>/g) || []).length, 2, 'Starlink and OneWeb unknown');
  assert.doesNotMatch(out, /ISS magasság/);
});

test('current data shows the ISS altitude, constellation counts and owners in the dashboard language', () => {
  const out = render({ totalNewObjects: 274, militarySats: 52, militaryByCountry: { US: 30, PRC: 12 }, constellations: { starlink: 11124, oneweb: 651 }, iss: { apogee: 425, perigee: 415 } });
  assert.match(out, /ISS magasság<\/span><span class="eval"[^>]*>420 km/);
  assert.match(out, /Új objektumok \(30 n\.\)/);
  assert.match(out, /Katonai műholdak/);
  assert.match(out, /11[,.  ]?124/);
  assert.match(out, />US<\/span><span class="eval" style="font-size:10px">30 kat\. műhold/);
});
