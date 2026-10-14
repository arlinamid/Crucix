import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { DOMAIN_IDS } from '../lib/domains.mjs';

// The source-health matrix (health-matrix.js) in a vm realm with a small fake DOM: render() is pure and returns markup, the
// dialog is built from nodes (the fake keeps attributes, listeners and the innerHTML the module writes).
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('dashboard/public/jarvis.html');
const tick = () => new Promise(resolve => setImmediate(resolve));
const count = (text, pattern) => (text.match(pattern) || []).length;
const flatten = (value, prefix) => Object.entries(value || {}).flatMap(([key, item]) => item && typeof item === 'object' ? flatten(item, `${prefix}.${key}`) : [[`${prefix}.${key}`, item]]);
const strings = lang => new Map([...flatten(JSON.parse(read(`locales/${lang}.json`)).matrix, 'matrix'), ...flatten(JSON.parse(read(`locales/${lang}.json`)).lenses, 'lenses'), ...flatten(JSON.parse(read(`locales/${lang}.json`)).status, 'status')]);
const localT = lang => { const table = strings(lang); return (key, fallback) => table.has(key) ? table.get(key) : (fallback ?? key); };

// Setting innerHTML parses the markup into nodes (tags, attributes, text: all render() writes), so the keyboard code runs on the real
// table: closest(), querySelector(All)() understand compound selectors such as `tr.hm-row` and `button[data-hm-sweep][tabindex="0"]`.
const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
const decode = text => text.replace(/&(?:lt|gt|quot|#39|amp);/g, entity => ENTITIES[entity]);
function parseMarkup(markup, doc, root) {
  const holder = { kids: [] }, stack = [holder];
  const token = /<(\/?)([a-zA-Z][\w]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>|([^<]+)/g;
  for (let match; (match = token.exec(markup));) {
    const top = stack[stack.length - 1], parent = top === holder ? root : top;
    if (match[4] !== undefined) { const text = new Node('#text', doc); text.textContent = decode(match[4]); text.parentNode = parent; top.kids.push(text); continue; }
    if (match[1]) { while (stack.length > 1 && stack.pop().tag !== match[2]); continue; }
    const node = new Node(match[2], doc);
    for (const attribute of match[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) { node.setAttribute(attribute[1], decode(attribute[2] ?? '')); if (attribute[1] === 'class') node.className = decode(attribute[2] ?? ''); }
    node.parentNode = parent; top.kids.push(node); stack.push(node);
  }
  return holder.kids;
}
class Node {
  constructor(tag, doc) { Object.assign(this, { tag, doc, attrs: new Map(), kids: [], parentNode: null, markup: '', listeners: {}, className: '', id: '', textContent: '', hidden: false, disabled: false, value: '', type: '', open: false, isConnected: true, focused: 0, shown: 0, scrollLeft: 0, scrollWidth: 640 }); }
  get innerHTML() { return this.markup; }
  set innerHTML(value) { this.markup = String(value); this.kids = parseMarkup(this.markup, this.doc, this); }
  get cells() { return this.kids.filter(kid => kid.tag === 'td' || kid.tag === 'th'); }
  get cellIndex() { return this.parentNode ? this.parentNode.cells.indexOf(this) : -1; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); if (name === 'id') this.id = String(value); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name) { this.attrs.delete(name); }
  append(...nodes) { for (const node of nodes) { const child = typeof node === 'string' ? Object.assign(new Node('#text', this.doc), { textContent: node }) : node; child.parentNode = this; this.kids.push(child); } }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, ...event }); }
  focus() { this.focused++; this.doc.activeElement = this; }
  showModal() { if (this.open) throw new Error('InvalidStateError'); this.open = true; this.shown++; }
  close() { if (this.open) { this.open = false; this.fire('close'); } }
  replaceChildren(...nodes) { this.kids = nodes; for (const node of nodes) node.parentNode = this; }
  matches(selector) {
    const [, tag, rest] = /^([\w-]*)(.*)$/.exec(selector);
    if (tag && this.tag !== tag) return false;
    for (const part of rest.match(/\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) || []) {
      if (part[0] === '.') { if (!this.className.split(' ').includes(part.slice(1))) return false; continue; }
      const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
      if (!this.attrs.has(name) || (value !== undefined && this.attrs.get(name) !== value)) return false;
    }
    return true;
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.tag !== '#text' && node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return all(this).slice(1).filter(node => node.tag !== '#text' && node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  text() { return this.textContent + this.kids.map(kid => kid.text()).join(''); }
}
function all(node) { return [node, ...node.kids.flatMap(all)]; }

function realm({ lens = 'all', t, esc, locale = 'en-US', routes = {}, onOpenSweep = () => {}, onAvailability } = {}) {
  const requests = [], errors = [], lensListeners = [];
  const doc = { activeElement: null, listeners: {}, innerHTMLWrites: [] };
  doc.body = new Node('body', doc);
  doc.createElement = tag => new Node(tag, doc);
  doc.getElementById = id => all(doc.body).find(node => node.id === id) || null;
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  const window = { document: doc };
  const context = vm.createContext({ window, document: doc, console: { error: (...args) => errors.push(args) }, Date, Object, Array, Number, JSON, Set, Map, String, Promise });
  vm.runInContext(read('dashboard/public/domains.js'), context);
  vm.runInContext(read('dashboard/public/lens-core.js'), context);
  const state = { lens };
  window.CrucixLens = { get: () => state.lens, onChange: fn => lensListeners.push(fn) };
  vm.runInContext(read('dashboard/public/health-matrix.js'), context);
  // routes: url -> function(url) returning a value, a promise or throwing; the call is logged first.
  const fetchJson = url => { requests.push(url); const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix)); if (!route) return Promise.reject(Object.assign(new Error('HTTP 404'), { status: 404 })); try { return Promise.resolve(route[1](url)); } catch (error) { return Promise.reject(error); } };
  const options = { fetchJson, t, esc, onOpenSweep, locale, onAvailability };
  return { window, doc, matrix: window.CrucixHealthMatrix, requests, errors, state, options, lensListeners, mount: extra => window.CrucixHealthMatrix.mount({ ...options, ...extra }) };
}
const mounted = options => { const r = realm(options); r.mount(); return r; };
const IDS = ['sweep-20261003T090000Z', 'sweep-20261003T091500Z', 'sweep-20261003T093000Z'];
const MODEL = {
  sweeps: IDS.map((id, index) => ({ id, timestamp: `2026-10-03T09:${String(index * 15).padStart(2, '0')}:00.000Z` })),
  sources: [
    { source: 'GDELT', domain: 'security', cells: [[0, 120], [0, 130], [2, 15000]] },
    { source: 'USGS', domain: 'hazards', cells: [[0, 80], [1, 90], [0, 85]] },
    { source: 'GDACS', domain: 'hazards', cells: [null, [3, 0], [0, 70]] },
    { source: 'NOAA-SWPC', domain: 'space', cells: [[0, 50], [0, 60], null] },
    { source: 'Mystery', domain: null, cells: [[0, 5], [0, 6], [0, 7]] },
  ],
};
const ARCHIVE = (count = 96, sweeps = IDS.map(id => ({ id }))) => ({ sweeps, retention: { count, maxMb: 64 } });
const dialogOf = doc => all(doc.body).find(node => node.tag === 'dialog');
const part = (doc, className) => all(dialogOf(doc)).find(node => node.className.split(' ').includes(className));
const clickTarget = id => ({ closest: selector => selector === '[data-hm-sweep]' && id ? { getAttribute: name => name === 'data-hm-sweep' ? id : null } : null });

test('render: a table with a caption, scoped headers, one group per domain in registry order and a cell per sweep', () => {
  const { matrix, window } = mounted({ t: localT('en') });
  const out = matrix.render({ ...MODEL, sources: [...MODEL.sources].reverse() });
  assert.ok(out.startsWith('<table'), 'a table');
  assert.equal(count(out, /<caption[ >]/g), 1);
  assert.ok(out.indexOf('<caption') < out.indexOf('<thead'));
  assert.equal(count(out, /<th scope="col"/g), 3 + 2, 'the corner (source), one per sweep and the ms column');
  assert.equal(count(out, /<th scope="row"/g), 5, 'one row header per source');
  assert.equal(count(out, /<tbody/g), 4, 'one tbody per domain present (plus the unknown group): security, hazards, space, other');
  assert.equal(count(out, /<th scope="rowgroup" colspan="5"/g), 4, 'a group header row spanning source + sweeps + ms');
  const order = [...out.matchAll(/<tbody class="hm-group" data-domain="([^"]*)"/g)].map(match => match[1]);
  assert.deepEqual(order, ['security', 'hazards', 'space', 'other'], 'registry order, the unknown sources last');
  assert.deepEqual(DOMAIN_IDS.slice(0, 3), ['security', 'hazards', 'space']);
  assert.equal(count(out, /<td class="hm-c">/g), 5 * 3, 'a cell per source and sweep');
  assert.equal(count(out, /<button type="button" class="hm-cell"/g), 15, 'every cell is a button');
  assert.ok(out.includes('Security and conflict') && out.includes('Natural hazards and weather') && out.includes('Space') && out.includes('Other sources'), 'groups are labelled with the lenses strings');
  assert.ok(out.includes('<th scope="rowgroup" colspan="5"><span class="hm-gl">Security and conflict</span></th>'), 'the name sits in a span the stylesheet keeps at the left edge of the scrolling box');
  assert.deepEqual(JSON.parse(JSON.stringify(window.CrucixDomains.DOMAIN_IDS)), DOMAIN_IDS);
});

test('render: every state has a glyph and a visually hidden word, never colour alone; a missing cell is "no data"', () => {
  const { matrix } = mounted({ t: localT('en') });
  const cell = (state, glyph, word) => new RegExp(`<button type="button" class="hm-cell" data-state="${state}"[^>]*><span class="hm-g" aria-hidden="true">${glyph}</span><span class="hm-sr">${word}</span></button>`);
  const out = matrix.render(MODEL);
  assert.match(out, cell('ok', '✓', 'OK'));
  assert.match(out, cell('stale', '◔', 'Stale'));
  assert.match(out, cell('error', '✕', 'Error'));
  assert.match(out, cell('disabled', '–', 'Disabled'));
  assert.match(out, cell('nodata', '·', 'No data'));
  assert.equal(count(out, /data-state="ok"/g), 10);
  assert.equal(count(out, /data-state="stale"/g), 1);
  assert.equal(count(out, /data-state="error"/g), 1);
  assert.equal(count(out, /data-state="disabled"/g), 1);
  assert.equal(count(out, /data-state="nodata"/g), 2, 'the null cells of GDACS and NOAA-SWPC');
  // Cells follow their sweep: GDACS has no data for the first sweep and is disabled in the second.
  const row = out.slice(out.indexOf('>GDACS<'), out.indexOf('>NOAA-SWPC<'));
  assert.deepEqual([...row.matchAll(/data-state="(\w+)"/g)].map(match => match[1]), ['nodata', 'disabled', 'ok']);
  assert.deepEqual([...row.matchAll(/data-hm-sweep="([^"]+)"/g)].map(match => match[1]), IDS, 'each cell names its own sweep');
});

test('render: each cell button is named by source, sweep time and state ("GDELT, Oct 3 09:00, OK"), escaped, in the page language', () => {
  const { matrix } = mounted({ t: localT('en') });
  const out = matrix.render(MODEL);
  const labels = [...out.matchAll(/<button type="button" class="hm-cell"[^>]*aria-label="([^"]*)">/g)].map(match => match[1]);
  assert.equal(labels.length, 15, 'every clickable cell has a name');
  const time = (ms, locale = 'en-US') => { const date = new Date(ms); return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); };
  const at = MODEL.sweeps.map(entry => time(Date.parse(entry.timestamp)));
  assert.deepEqual(labels.slice(0, 3), [`GDELT, ${at[0]}, OK`, `GDELT, ${at[1]}, OK`, `GDELT, ${at[2]}, Error`]);
  assert.ok(labels.includes(`GDACS, ${at[0]}, No data`) && labels.includes(`GDACS, ${at[1]}, Disabled`) && labels.includes(`USGS, ${at[1]}, Stale`));
  assert.match(out, /tabindex="-1" aria-label="[^"]*">/, 'the name is the last attribute of the cell (test/structure-chain.test.mjs reads the cells in order)');
  // The page language (a broken list time falls back to the id's time, as the column header does) and a hostile source name.
  const hu = mounted({ t: localT('hu'), locale: 'hu-HU' }).matrix.render({ sweeps: [{ id: IDS[1], timestamp: 'yesterday' }], sources: [{ source: '<img src=x onerror="alert(1)">', domain: 'hazards', cells: [[1, 5]] }] });
  const name = /aria-label="([^"]*)"/.exec(hu)[1];
  assert.equal(name, `&lt;img src=x onerror=&quot;alert(1)&quot;&gt;, ${time(Date.parse('2026-10-03T09:15:00Z'), 'hu-HU')}, ${strings('hu').get('matrix.stateStale')}`);
  assert.ok(!hu.includes('<img'));
  for (const [lang, word] of [['en', /arrow keys/], ['hu', /nyílbillentyű/], ['fr', /flèches/]]) assert.match(strings(lang).get('matrix.openHint'), word, lang + ': the hint names the arrow keys');
});

test('render: unknown codes and short or missing cell lists read as no data and keep the columns aligned', () => {
  const { matrix } = mounted({ t: localT('en') });
  const out = matrix.render({ sweeps: MODEL.sweeps, sources: [{ source: 'USGS', domain: 'hazards', cells: [[0, 1], [9, 1], 'x'] }, { source: 'ECB', domain: 'economy' }, { source: 'FRED', domain: 'economy', cells: [[2, 3]] }] });
  assert.deepEqual([...out.slice(out.indexOf('>USGS<'), out.indexOf('>ECB<')).matchAll(/data-state="(\w+)"/g)].map(match => match[1]), ['ok', 'nodata', 'nodata']);
  assert.equal(count(out.slice(out.indexOf('>ECB<')), /data-state="nodata"/g), 5, 'ECB has no cells at all (3), FRED only the first (2 more)');
  assert.equal(count(out, /<td class="hm-c">/g), 9, 'three sources x three sweeps whatever the cell lists say');
});

test('render: the last column is the newest sweep\'s run time in ms, a dash when it has none', () => {
  const { matrix } = mounted({ t: localT('en') });
  const out = matrix.render(MODEL);
  const ms = name => { const row = out.slice(out.indexOf(`>${name}<`)); return /<td class="hm-ms">(.*?)<\/td>/.exec(row)[1]; };
  assert.equal(ms('GDELT'), '15000');
  assert.equal(ms('USGS'), '85');
  assert.equal(ms('GDACS'), '70');
  assert.match(ms('NOAA-SWPC'), /^<span aria-hidden="true">—<\/span><span class="hm-sr">No data<\/span>$/, 'no cell for the newest sweep');
  const noMs = matrix.render({ sweeps: MODEL.sweeps, sources: [{ source: 'EMSC', domain: 'hazards', cells: [[0, 5], [0, 5], [0, null]] }] });
  assert.match(noMs, /<td class="hm-ms"><span aria-hidden="true">—<\/span>/, 'a run without a measured time');
  const odd = matrix.render({ sweeps: MODEL.sweeps, sources: [{ source: 'EMSC', domain: 'hazards', cells: [[0, 5], [0, 5], [0, '<b>x</b>']] }] });
  assert.ok(!odd.includes('<b>x'), 'a non-numeric time is never printed');
});

test('render: column headers carry a short time, the full time for screen readers and the date where it changes', () => {
  const { matrix } = mounted({ t: localT('en') });
  const model = { sweeps: [{ id: IDS[0], timestamp: '2026-10-03T09:00:00.000Z' }, { id: IDS[1], timestamp: '2026-10-03T09:15:00.000Z' }, { id: 'sweep-20261004T090000Z', timestamp: '2026-10-04T09:00:00.000Z' }], sources: [] };
  const out = matrix.render({ ...model, sources: [{ source: 'USGS', domain: 'hazards', cells: [] }] });
  const found = [...out.matchAll(/<th scope="col" class="hm-time" title="([^"]*)">(.*?)<\/th>/g)], heads = found.map(match => match[2]);
  assert.equal(heads.length, 3);
  const full = ms => new Date(ms).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  heads.forEach((head, index) => assert.ok(head.includes(`<span class="hm-sr">${full(Date.parse(model.sweeps[index].timestamp))}</span>`), `column ${index} full label (the format replay.js uses)`));
  found.forEach((match, index) => assert.equal(match[1], full(Date.parse(model.sweeps[index].timestamp)), `column ${index}: the full label is also the tooltip of the short time`));
  assert.ok(heads.every(head => /<span class="hm-t" aria-hidden="true">\d{2}:\d{2}<\/span>/.test(head)), 'a short 24-hour time');
  const dates = heads.map(head => count(head, /class="hm-d"/g));
  assert.equal(dates[0], 1, 'the first column names its date');
  assert.equal(dates[2], 1, 'the date shows again when the day changes');
  assert.equal(dates[1], 0, 'and not on the columns in between');
});

test('render: hostile source names, domains, times, ids and locale strings never become markup', () => {
  const evil = '<img src=x onerror=alert(1)>', quote = '"><script>alert(2)</script>';
  const { matrix } = mounted({ t: (key, fallback) => key.startsWith('matrix.') ? '<b>' + fallback + '</b>' : fallback });
  const out = matrix.render({
    sweeps: [{ id: IDS[0], timestamp: evil }, { id: quote, timestamp: quote }, { id: IDS[2], timestamp: '2026-10-03T09:30:00.000Z' }],
    sources: [{ source: evil, domain: 'hazards', cells: [[0, 1], [0, 1], [0, 1]] }, { source: quote, domain: evil, cells: [[1, 1], [2, 2], [3, 3]] }, { source: 'USGS', domain: '__proto__', cells: [] }],
  });
  assert.ok(!/<img|<script|<b>/.test(out), 'no raw tag from any dynamic string');
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the name is shown as text');
  assert.ok(out.includes('&quot;&gt;&lt;script&gt;'));
  assert.equal(count(out, /<button /g), 6, 'two valid sweep ids x three sources are clickable');
  assert.ok(!out.includes('data-domain="&lt;'), 'a hostile domain is the unknown group, not echoed');
  assert.ok([...out.matchAll(/data-hm-sweep="([^"]*)"/g)].every(match => /^sweep-\d{8}T\d{6}Z$/.test(match[1])), 'a sweep attribute only ever holds a real sweep id');
});

test('render: a column without a readable time says "unknown time" in the page language (screen reader text and tooltip); the visible mark stays "?"', () => {
  const model = { sweeps: [{ id: IDS[0], timestamp: '2026-10-03T09:00:00.000Z' }, { id: 'latest', timestamp: 'yesterday' }, {}, null], sources: [{ source: 'USGS', domain: 'hazards', cells: [] }] };
  const unknown = (lang, t = localT(lang)) => { const out = mounted({ t }).matrix.render(model); return [...out.matchAll(/<th scope="col" class="hm-time" title="([^"]*)"><span class="hm-sr">([^<]*)<\/span><span class="hm-t" aria-hidden="true">\?<\/span><\/th>/g)].map(match => [match[1], match[2]]); };
  for (const [lang, label] of [['en', 'Unknown time'], ['hu', 'Ismeretlen idő'], ['fr', 'Date inconnue']]) {
    assert.equal(strings(lang).get('status.unknownTime'), label, `${lang}: the status string this reads`);
    assert.deepEqual(unknown(lang), [[label, label], [label, label], [label, label]], lang);
  }
  assert.deepEqual(unknown('en', () => ''), [['Unknown time', 'Unknown time'], ['Unknown time', 'Unknown time'], ['Unknown time', 'Unknown time']], 'an empty page string falls back to the built-in text');
  const withoutT = realm().matrix.render(model);
  assert.equal(count(withoutT, /title="Unknown time"/g), 3, 'without a page `t` too');
  assert.ok(!/title="[^"]*\?/.test(withoutT.replace(/title="Unknown time"/g, '')), 'the "?" is only the visible mark');
});

test('render: a page `t` that throws, returns nothing or a non-string leaves the built-in English text', () => {
  const english = mounted({ t: localT('en'), locale: '' }).matrix.render(MODEL).replace(/<th scope="rowgroup"[^>]*>.*?<\/th>/g, '');
  for (const broken of [() => { throw new Error('locale broke'); }, () => '', () => undefined, () => 42, () => null, () => ({})]) {
    const out = mounted({ t: broken, locale: '' }).matrix.render(MODEL);
    assert.equal(out.replace(/<th scope="rowgroup"[^>]*>.*?<\/th>/g, ''), english, String(broken));
    assert.ok(out.includes('<span class="hm-gl">security</span>'), 'a group name falls back to its id');
  }
});

test('render: a sweep whose id is not a real archive id has cells that cannot be clicked', () => {
  const { matrix } = mounted({ t: localT('en') });
  const out = matrix.render({ sweeps: [{ id: IDS[0], timestamp: '2026-10-03T09:00:00.000Z' }, { id: 'latest', timestamp: '2026-10-03T09:15:00.000Z' }, { timestamp: '2026-10-03T09:30:00.000Z' }], sources: [{ source: 'USGS', domain: 'hazards', cells: [[0, 1], [0, 1], [0, 1]] }] });
  assert.equal(count(out, /<button /g), 1);
  assert.equal(count(out, /<span class="hm-cell" data-state="ok">/g), 2, 'a plain span, same glyph and word');
  assert.equal(count(out, /data-hm-sweep=/g), 1);
});

test('render: the one tab stop is the newest cell of the first row (the table opens scrolled to the newest sweeps); the others use the arrow keys', () => {
  const { matrix } = mounted({ t: localT('en') });
  const out = matrix.render(MODEL);
  assert.equal(count(out, /tabindex="0"/g), 1);
  assert.equal(count(out, /tabindex="-1"/g), 14);
  const firstRow = out.slice(out.indexOf('<tr class="hm-row">'), out.indexOf('</tr>', out.indexOf('<tr class="hm-row">')));
  assert.ok(firstRow.includes('>GDELT<') && firstRow.includes(`data-hm-sweep="${IDS[2]}" tabindex="0"`), 'GDELT, the newest sweep');
  assert.equal(count(firstRow, /tabindex="0"/g), 1);
  // The newest column that can be clicked: a last column that is not a real archive sweep is passed over.
  const odd = matrix.render({ sweeps: [{ id: IDS[0] }, { id: IDS[1] }, { id: 'latest' }], sources: MODEL.sources.slice(0, 2) });
  assert.ok(odd.includes(`data-hm-sweep="${IDS[1]}" tabindex="0"`) && count(odd, /tabindex="0"/g) === 1);
  assert.equal(count(matrix.render({ sweeps: [{ id: 'latest' }], sources: MODEL.sources.slice(0, 2) }), /tabindex=/g), 0, 'no button, no tab stop');
});

// ===== The keyboard: real render output, parsed by the fake DOM =====
async function grid(model = MODEL) {
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => model } });
  r.mount(); await tick(); await r.matrix.open();
  const scroll = part(r.doc, 'hm-scroll'), buttons = scroll.querySelectorAll('button[data-hm-sweep]');
  const ids = model.sweeps.map(sweep => sweep.id);
  const where = button => `${button.closest('tr').querySelector('th').text()}@${ids.indexOf(button.getAttribute('data-hm-sweep'))}`;
  const stops = () => buttons.filter(button => button.getAttribute('tabindex') === '0');
  // Presses a key on the focused cell; reports where the focus is afterwards and whether the default action was prevented.
  const press = (key, extra = {}, from = r.doc.activeElement) => { let prevented = 0; scroll.fire('keydown', { target: from, key, preventDefault: () => { prevented++; }, ...extra }); return { at: where(r.doc.activeElement), prevented, stops: stops().map(where) }; };
  return { r, scroll, buttons, where, stops, press };
}

test('keyboard: the arrow keys walk the grid in all four directions across the domain groups; the edges stay; one tab stop follows the focus', async () => {
  const g = await grid();
  assert.equal(g.buttons.length, 15);
  assert.deepEqual(g.stops().map(g.where), ['GDELT@2']);
  g.stops()[0].focus();
  const walk = [
    ['ArrowDown', 'USGS@2', 1], ['ArrowDown', 'GDACS@2', 1], ['ArrowDown', 'NOAA-SWPC@2', 1], ['ArrowDown', 'Mystery@2', 1], ['ArrowDown', 'Mystery@2', 0],
    ['ArrowLeft', 'Mystery@1', 1], ['ArrowLeft', 'Mystery@0', 1], ['ArrowLeft', 'Mystery@0', 0],
    ['ArrowUp', 'NOAA-SWPC@0', 1], ['ArrowUp', 'GDACS@0', 1], ['ArrowUp', 'USGS@0', 1], ['ArrowUp', 'GDELT@0', 1], ['ArrowUp', 'GDELT@0', 0],
    ['ArrowRight', 'GDELT@1', 1], ['ArrowRight', 'GDELT@2', 1], ['ArrowRight', 'GDELT@2', 0],
  ];
  for (const [key, expected, prevented] of walk) {
    const result = g.press(key);
    assert.equal(result.at, expected, `${key} -> ${expected}`);
    assert.equal(result.prevented, prevented, `${key}: the default action is prevented exactly when the focus moved`);
    assert.deepEqual(result.stops, [expected], `${key}: the focused cell is the only tab stop`);
  }
});

test('keyboard: Home and End go to the ends of the row; other keys and modifier keys do nothing', async () => {
  const g = await grid();
  g.buttons.find(button => g.where(button) === 'USGS@1').focus();
  assert.equal(g.press('End').at, 'USGS@2'); assert.deepEqual(g.stops().map(g.where), ['USGS@2']);
  assert.equal(g.press('Home').at, 'USGS@0'); assert.deepEqual(g.stops().map(g.where), ['USGS@0']);
  assert.equal(g.press('End').prevented, 1);
  g.buttons.find(button => g.where(button) === 'USGS@1').focus();
  for (const modifier of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) for (const key of ['ArrowRight', 'ArrowDown', 'Home', 'End']) {
    const result = g.press(key, { [modifier]: true });
    assert.deepEqual([result.at, result.prevented], ['USGS@1', 0], `${modifier} + ${key} is left to the browser`);
  }
  for (const key of ['Enter', ' ', 'Tab', 'a', 'PageDown', 'Escape', 'ArrowDownn', undefined]) { const result = g.press(key); assert.deepEqual([result.at, result.prevented], ['USGS@1', 0], String(key)); }
  assert.deepEqual(g.stops().map(g.where), ['USGS@2'], 'the tab stop did not move');
  // Not a cell button: a plain cell, the table, nothing.
  const plain = g.scroll.querySelector('th');
  for (const target of [plain, g.scroll, null, {}]) assert.equal(g.press('ArrowRight', {}, target).prevented, 0);
});

test('keyboard: cells that cannot be clicked are passed over', async () => {
  const model = { ...MODEL, sweeps: [{ id: IDS[0] }, { id: 'not-a-sweep' }, { id: IDS[2] }] };
  const g = await grid(model);
  assert.equal(g.buttons.length, 10, 'two clickable columns x five sources');
  assert.deepEqual(g.stops().map(g.where), ['GDELT@2']);
  g.stops()[0].focus();
  assert.equal(g.press('ArrowLeft').at, 'GDELT@0', 'the plain cell in between is skipped');
  assert.equal(g.press('ArrowRight').at, 'GDELT@2');
  assert.equal(g.press('ArrowDown').at, 'USGS@2');
});

test('render: the lens keeps only its own group; an unknown lens is "all"; a lens without sources says so', () => {
  const r = mounted({ t: localT('en') });
  const groups = () => [...r.matrix.render(MODEL).matchAll(/data-domain="([^"]*)"/g)].map(match => match[1]);
  assert.deepEqual(groups(), ['security', 'hazards', 'space', 'other']);
  r.state.lens = 'hazards';
  assert.deepEqual(groups(), ['hazards']);
  const out = r.matrix.render(MODEL);
  assert.ok(out.includes('>USGS<') && out.includes('>GDACS<') && !out.includes('>GDELT<') && !out.includes('>Mystery<'));
  assert.equal(count(out, /<td class="hm-c">/g), 6);
  r.state.lens = 'security';
  assert.deepEqual(groups(), ['security']);
  r.state.lens = 'economy';
  const none = r.matrix.render(MODEL);
  assert.ok(!none.includes('<table') && none.includes('No source reported for this domain in the shown sweeps.'), none);
  for (const value of ['bogus', undefined, null, '__proto__', 7]) { r.state.lens = value; assert.equal(groups().length, 4, String(value)); }
  const bare = realm({ t: localT('en') });
  delete bare.window.CrucixLens;
  assert.equal(count(bare.matrix.render(MODEL), /<tbody/g), 4, 'without the lens module every group shows');
});

test('render: no sweeps (or no model) is the empty state, not a table', () => {
  const { matrix } = mounted({ t: localT('en') });
  for (const model of [{ sweeps: [], sources: [] }, { sweeps: [], sources: MODEL.sources }, {}, null, undefined, 'x', { sweeps: 'x' }]) {
    const out = matrix.render(model);
    assert.ok(!out.includes('<table'), String(JSON.stringify(model)));
    assert.equal(out, '<p class="hm-note">No archived sweeps yet.</p>');
  }
  assert.ok(matrix.render({ sweeps: MODEL.sweeps, sources: [] }).includes('<p class="hm-note">'), 'sweeps without a single source: nothing to show either');
});

test('render without mount uses the built-in English text and equals the locale file', () => {
  const bare = realm().matrix.render(MODEL), fromLocale = mounted({ t: localT('en'), locale: '' }).matrix.render(MODEL);
  assert.equal(count(bare, /<th scope="rowgroup"/g), 4);
  const strip = text => text.replace(/<th scope="rowgroup"[^>]*>.*?<\/th>/g, '');
  assert.equal(strip(bare), strip(fromLocale), 'the English fallback text mirrors locales/en.json (group names aside)');
});

test('mount rejects bad options and mounts once', () => {
  const r = realm({ t: localT('en') });
  assert.equal(r.matrix.mount(), false);
  assert.equal(r.matrix.mount({}), false);
  assert.equal(r.matrix.mount({ fetchJson: 'x' }), false);
  assert.equal(r.mount(), true);
  assert.equal(r.mount(), false, 'a second mount changes nothing');
  assert.deepEqual(Object.keys(r.matrix).sort(), ['button', 'close', 'mount', 'open', 'refresh', 'render']);
  assert.equal(Object.isFrozen(r.matrix), true);
});

test('open: the dialog is a modal with the lens, hint and legend; it reads the archive once, then the series once', async () => {
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(96), '/api/source-health': () => MODEL } });
  r.mount();
  await tick();
  assert.deepEqual(r.requests, ['/api/sweeps'], 'the mount-time probe');
  r.requests.length = 0;
  assert.equal(await r.matrix.open(), true);
  assert.deepEqual(r.requests, ['/api/sweeps', '/api/source-health?sweeps=48'], 'once each per open, 48 by default');
  const dialog = dialogOf(r.doc);
  assert.equal(dialog.open, true); assert.equal(dialog.shown, 1);
  assert.equal(dialog.getAttribute('aria-labelledby'), 'hm-title');
  assert.equal(all(dialog).find(node => node.id === 'hm-title').textContent, 'Source health matrix');
  assert.ok(part(r.doc, 'hm-hint').textContent.includes('Select a cell'));
  const legend = part(r.doc, 'hm-legend').text();
  for (const word of ['✓ OK', '◔ Stale', '✕ Error', '– Disabled', '· No data']) assert.ok(legend.includes(word), word);
  assert.equal(part(r.doc, 'hm-scroll').innerHTML, r.matrix.render(MODEL), 'the table is the pure render of the answer');
  assert.equal(part(r.doc, 'hm-legend').hidden, false); assert.equal(part(r.doc, 'hm-tools').hidden, false);
  assert.equal(part(r.doc, 'hm-status').textContent, '', 'the loading line is gone');
  assert.equal(part(r.doc, 'hm-scroll').scrollLeft, part(r.doc, 'hm-scroll').scrollWidth, 'the newest sweeps (the right edge) are in view');
  r.requests.length = 0;
  await r.matrix.open();
  assert.deepEqual(r.requests, ['/api/sweeps', '/api/source-health?sweeps=48'], 'a second open reads again, once each');
  assert.equal(dialogOf(r.doc).shown, 1, 'an open dialog is not shown twice');
});

test('while the archive is being read the dialog shows a loading line and no empty selector or legend', async () => {
  let release;
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => new Promise(resolve => { release = resolve; }) } });
  r.mount();
  const opening = r.matrix.open();
  await tick();
  assert.equal(part(r.doc, 'hm-tools').hidden, true);
  assert.equal(part(r.doc, 'hm-legend').hidden, true, 'nothing to explain yet');
  assert.equal(part(r.doc, 'hm-status').textContent, 'Loading the matrix…');
  assert.equal(part(r.doc, 'hm-scroll').getAttribute('aria-busy'), 'true');
  release(ARCHIVE(96, []));
  await opening;
  assert.equal(part(r.doc, 'hm-scroll').getAttribute('aria-busy'), 'false');
});

test('a reopened dialog does not show the table of the earlier open while the new answer loads', async () => {
  const pending = [];
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => pending.length ? new Promise(resolve => pending.push(resolve)) : (pending.push(null), MODEL) } });
  r.mount(); await tick(); await r.matrix.open();
  assert.ok(part(r.doc, 'hm-scroll').innerHTML.includes('<table'));
  r.matrix.close();
  const again = r.matrix.open();
  await tick();
  assert.equal(part(r.doc, 'hm-scroll').innerHTML, '', 'nothing stale on screen');
  assert.equal(part(r.doc, 'hm-legend').hidden, true);
  r.lensListeners[0]('security');
  assert.equal(part(r.doc, 'hm-scroll').innerHTML, '', 'a lens change while loading does not bring the old table back');
  pending[1](MODEL);
  assert.equal(await again, true);
  assert.ok(part(r.doc, 'hm-scroll').innerHTML.includes('<table'));
  r.state.lens = 'space'; r.lensListeners[0]('space');
  assert.ok(!part(r.doc, 'hm-scroll').innerHTML.includes('data-domain="security"'), 'the lens applies to the new table');
});

test('open: the sweep-count choices go up to the retention and default to 48 or the retention when smaller', async () => {
  const cases = [[96, [12, 24, 48, 96], 48], [30, [12, 24, 30], 30], [100, [12, 24, 48, 96, 100], 48], [2, [2], 2], [12, [12], 12], [48, [12, 24, 48], 48], [672, [12, 24, 48, 96, 192, 384, 672], 48]];
  for (const [retention, values, chosen] of cases) {
    const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(retention), '/api/source-health': () => MODEL } });
    r.mount(); await tick();
    await r.matrix.open();
    const select = part(r.doc, 'hm-count');
    assert.deepEqual(select.kids.map(option => Number(option.value)), values, `retention ${retention}`);
    assert.equal(Number(select.value), chosen, `default for retention ${retention}`);
    assert.ok(r.requests.includes(`/api/source-health?sweeps=${chosen}`), `retention ${retention} asks for ${chosen}`);
    assert.ok(Math.max(...values) <= retention);
  }
});

test('open: a retention that is missing or invalid falls back to the number of listed sweeps; the series is never over-asked', async () => {
  for (const retention of [undefined, { count: 'x' }, { count: 0 }, { count: -4 }, null]) {
    const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ({ sweeps: IDS.map(id => ({ id })), retention }), '/api/source-health': () => MODEL } });
    r.mount(); await tick();
    await r.matrix.open();
    assert.deepEqual(part(r.doc, 'hm-count').kids.map(option => Number(option.value)), [3], JSON.stringify(retention));
    assert.ok(r.requests.includes('/api/source-health?sweeps=3'));
  }
});

test('changing the sweep count fetches that many once; a late answer for an older count is dropped', async () => {
  const pending = new Map();
  const model = ids => ({ sweeps: ids.map(id => ({ id, timestamp: '2026-10-03T09:00:00.000Z' })), sources: [{ source: 'USGS', domain: 'hazards', cells: ids.map(() => [0, 1]) }] });
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(96), '/api/source-health': url => new Promise(resolve => pending.set(url, resolve)) } });
  r.mount(); await tick();
  const opening = r.matrix.open();
  await tick();
  assert.ok(part(r.doc, 'hm-status').textContent.includes('Loading'), 'a loading line while the first answer is out');
  pending.get('/api/source-health?sweeps=48')(model(IDS));
  await opening;
  assert.equal(count(part(r.doc, 'hm-scroll').innerHTML, /<td class="hm-c">/g), 3);
  const select = part(r.doc, 'hm-count');
  select.value = '12'; select.fire('change');
  select.value = '24'; select.fire('change');
  await tick();
  assert.deepEqual(r.requests.slice(-2), ['/api/source-health?sweeps=12', '/api/source-health?sweeps=24']);
  pending.get('/api/source-health?sweeps=24')(model(IDS.slice(0, 2)));
  await tick();
  assert.equal(count(part(r.doc, 'hm-scroll').innerHTML, /<td class="hm-c">/g), 2, 'the newest choice is shown');
  pending.get('/api/source-health?sweeps=12')(model(IDS.slice(0, 1)));
  await tick();
  assert.equal(count(part(r.doc, 'hm-scroll').innerHTML, /<td class="hm-c">/g), 2, 'the late answer for 12 does not overwrite it');
  assert.equal(part(r.doc, 'hm-status').textContent, '');
});

test('an answer that arrives after the dialog was closed (or reopened) is dropped', async () => {
  const pending = [];
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => new Promise(resolve => pending.push(resolve)) } });
  r.mount(); await tick();
  const first = r.matrix.open();
  await tick();
  r.matrix.close();
  pending[0](MODEL);
  assert.equal(await first, false);
  assert.equal(part(r.doc, 'hm-scroll').innerHTML, '', 'nothing painted into a closed dialog');
  const second = r.matrix.open();
  await tick();
  pending[1]({ sweeps: [], sources: [] });
  assert.equal(await second, true);
  assert.ok(part(r.doc, 'hm-scroll').innerHTML.includes('No archived sweeps yet.'));
});

test('a failed series shows an error line, keeps the dialog usable and recovers on the next choice', async () => {
  let fail = true;
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => { if (fail) throw Object.assign(new Error('HTTP 500'), { status: 500 }); return MODEL; } } });
  r.mount(); await tick();
  assert.equal(await r.matrix.open(), false);
  const dialog = dialogOf(r.doc);
  assert.equal(dialog.open, true, 'still open');
  assert.equal(part(r.doc, 'hm-status').textContent, 'Could not load the source health. Close and reopen this window to try again.');
  assert.equal(part(r.doc, 'hm-scroll').innerHTML, '');
  assert.equal(part(r.doc, 'hm-legend').hidden, true, 'no legend without a table');
  const select = part(r.doc, 'hm-count');
  assert.equal(part(r.doc, 'hm-tools').hidden, false, 'the row with the selector is still shown (a retry by choosing another count stays possible)');
  assert.equal(select.hidden, false); assert.equal(select.disabled, false, 'the selector still works');
  assert.equal(all(dialog).some(node => node.className === 'hm-close'), true, 'and so does Close');
  fail = false;
  select.value = '24'; select.fire('change'); await tick();
  assert.equal(part(r.doc, 'hm-status').textContent, '');
  assert.equal(part(r.doc, 'hm-scroll').innerHTML, r.matrix.render(MODEL));
  fail = true; await r.matrix.open();
  assert.ok(part(r.doc, 'hm-status').textContent.startsWith('Could not load'), 'a new open can fail again');
  assert.equal(r.errors.length, 0, 'a failed fetch is a message, not a console error');
});

test('a failing archive listing is an error line (a network failure) or the empty state (404/503)', async () => {
  for (const [error, expected] of [[Object.assign(new Error('HTTP 500'), { status: 500 }), 'Could not load'], [new Error('offline'), 'Could not load'], [Object.assign(new Error('HTTP 404'), { status: 404 }), 'No archived sweeps yet.'], [Object.assign(new Error('HTTP 503'), { status: 503 }), 'No archived sweeps yet.']]) {
    const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => { throw error; }, '/api/source-health': () => MODEL } });
    r.mount(); await tick();
    await r.matrix.open();
    const shown = part(r.doc, 'hm-status').textContent + part(r.doc, 'hm-scroll').innerHTML;
    assert.ok(shown.includes(expected), `${error.status}: ${shown}`);
    assert.ok(!r.requests.includes('/api/source-health?sweeps=48'), 'no series is asked for when the archive did not list sweeps');
    assert.equal(dialogOf(r.doc).open, true);
    assert.ok(!shown.includes('<table'));
    assert.equal(part(r.doc, 'hm-tools').hidden, true, 'no selector without an archive listing');
  }
});

test('the error line fits the screen: without an archive listing there is no selector, and the text only asks for a reopen', async () => {
  for (const [lang, reopen, selectorWord] of [['en', /reopen/, /count/i], ['hu', /nyisd meg újra/, /lekérdezésszám|darabszám/i], ['fr', /rouvrez/, /nombre/i]]) {
    const r = realm({ t: localT(lang), routes: { '/api/sweeps': () => { throw new Error('offline'); } } });
    r.mount(); await tick();
    assert.equal(await r.matrix.open(), false);
    assert.equal(part(r.doc, 'hm-tools').hidden, true, `${lang}: the selector is not offered`);
    const message = part(r.doc, 'hm-status').textContent;
    assert.equal(message, strings(lang).get('matrix.error'), lang);
    assert.match(message, reopen, `${lang}: tells to reopen`);
    assert.doesNotMatch(message, selectorWord, `${lang}: does not point at a selector that is hidden`);
  }
});

test('an archive listing that fails on a later open hides the selector of the earlier one', async () => {
  let fail = false;
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => { if (fail) throw new Error('offline'); return ARCHIVE(); }, '/api/source-health': () => MODEL } });
  r.mount(); await tick(); await r.matrix.open();
  assert.equal(part(r.doc, 'hm-tools').hidden, false);
  r.matrix.close();
  fail = true;
  assert.equal(await r.matrix.open(), false);
  assert.equal(part(r.doc, 'hm-tools').hidden, true);
  assert.ok(part(r.doc, 'hm-status').textContent.startsWith('Could not load'));
});

test('a failure of an older request does not replace what a newer one showed; a failure ends the table for a later lens change', async () => {
  const pending = new Map();
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': url => new Promise((resolve, reject) => pending.set(url, { resolve, reject })) } });
  r.mount(); await tick();
  const opening = r.matrix.open();
  await tick();
  pending.get('/api/source-health?sweeps=48').resolve(MODEL);
  await opening;
  const select = part(r.doc, 'hm-count');
  select.value = '12'; select.fire('change');
  select.value = '24'; select.fire('change');
  await tick();
  pending.get('/api/source-health?sweeps=24').resolve(MODEL);
  await tick();
  pending.get('/api/source-health?sweeps=12').reject(Object.assign(new Error('HTTP 500'), { status: 500 }));
  await tick();
  assert.equal(part(r.doc, 'hm-status').textContent, '', 'the late failure for 12 is dropped');
  assert.equal(part(r.doc, 'hm-scroll').innerHTML, r.matrix.render(MODEL));
  select.value = '96'; select.fire('change');
  await tick();
  pending.get('/api/source-health?sweeps=96').reject(Object.assign(new Error('HTTP 500'), { status: 500 }));
  await tick();
  assert.ok(part(r.doc, 'hm-status').textContent.startsWith('Could not load'));
  r.lensListeners[0]('space');
  assert.equal(part(r.doc, 'hm-scroll').innerHTML, '', 'the table of an earlier answer does not come back after a failure');
});

test('the archive listing that answers after the dialog was closed starts no series request', async () => {
  let release;
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => new Promise(resolve => { release = resolve; }), '/api/source-health': () => MODEL } });
  r.mount();
  const opening = r.matrix.open();
  await tick();
  r.matrix.close();
  release(ARCHIVE());
  assert.equal(await opening, false);
  assert.ok(!r.requests.some(url => url.startsWith('/api/source-health')), r.requests.join());
});

test('a sweep count that is not a positive whole number asks for nothing', async () => {
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => MODEL } });
  r.mount(); await tick(); await r.matrix.open();
  const before = r.requests.length, select = part(r.doc, 'hm-count');
  for (const value of ['', 'abc', '0', '-3', '2.5']) { select.value = value; select.fire('change'); }
  await tick();
  assert.equal(r.requests.length, before);
});

test('every dynamic string in the markup goes through the page escaper (a tagging escaper shows what was not escaped)', () => {
  const { matrix } = mounted({ t: localT('en'), esc: value => `‹${String(value)}›` });
  // One column with a readable time and one without: the unknown-time label is a page string too.
  const out = matrix.render({ ...MODEL, sweeps: [...MODEL.sweeps.slice(0, 2), { id: IDS[2] }, { id: 'latest', timestamp: 'later' }] });
  assert.ok(out.includes('‹GDELT›') && out.includes('‹Security and conflict›') && out.includes('‹OK›'), 'the page escaper is the one in use');
  // What remains once every escaped piece and every tag is removed can only be the fixed glyphs and the numbers.
  const rest = out.replace(/‹[^›]*›/g, '').replace(/<[^>]*>/g, '');
  assert.match(rest, /^[✓◔✕–·—?\d]*$/u, `unescaped text: ${rest}`);
  const titles = [...out.matchAll(/title="([^"]*)"/g)].map(match => match[1]);
  assert.ok(titles.length >= 3 && titles.every(value => /^‹[^›]*›$/.test(value)), `tooltips are escaped too: ${titles.join('|')}`);
  const failing = mounted({ t: localT('en'), esc: () => { throw new Error('escaper broke'); } }).matrix.render(MODEL);
  assert.ok(failing.includes('>GDELT<'), 'a throwing page escaper falls back to the built-in one');
});

test('an archive without sweeps, or a series without sweeps, is the empty state without a selector or a table', async () => {
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(96, []), '/api/source-health': () => ({ sweeps: [], sources: [] }) } });
  r.mount(); await tick();
  await r.matrix.open();
  assert.equal(part(r.doc, 'hm-scroll').innerHTML, '<p class="hm-note">No archived sweeps yet.</p>');
  assert.equal(part(r.doc, 'hm-tools').hidden, true, 'nothing to choose');
  assert.equal(part(r.doc, 'hm-legend').hidden, true, 'no legend without a table');
  assert.ok(!r.requests.some(url => url.startsWith('/api/source-health')));
  const s = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => ({ sweeps: [], sources: [] }) } });
  s.mount(); await tick(); await s.matrix.open();
  assert.equal(part(s.doc, 'hm-scroll').innerHTML, '<p class="hm-note">No archived sweeps yet.</p>');
});

test('a garbage series is the empty state or a table of what is valid, never an exception', async () => {
  for (const answer of [null, 'x', 7, [], { sweeps: {} }, { sweeps: [null, 3], sources: 'x' }]) {
    const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => answer } });
    r.mount(); await tick();
    await r.matrix.open();
    assert.equal(r.errors.length, 0, JSON.stringify(answer));
    assert.ok(!part(r.doc, 'hm-scroll').innerHTML.includes('<table'), JSON.stringify(answer));
  }
});

test('clicking a cell asks the page to open that sweep; other clicks do nothing; a failing handler is contained', async () => {
  const opened = [];
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => MODEL }, onOpenSweep: id => { opened.push(id); } });
  r.mount(); await tick(); await r.matrix.open();
  const scroll = part(r.doc, 'hm-scroll');
  scroll.fire('click', { target: clickTarget(IDS[1]) });
  scroll.fire('click', { target: clickTarget(IDS[2]) });
  scroll.fire('click', { target: clickTarget(null) });
  scroll.fire('click', { target: clickTarget('../../etc/passwd') });
  scroll.fire('click', { target: clickTarget('<img src=x onerror=alert(1)>') });
  scroll.fire('click', { target: {} });
  scroll.fire('click', { target: null });
  assert.deepEqual(opened, [IDS[1], IDS[2]]);
  assert.equal(dialogOf(r.doc).open, true, 'the page decides whether the dialog closes');
  const boom = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => MODEL }, onOpenSweep: () => { throw new Error('boom'); } });
  boom.mount(); await tick(); await boom.matrix.open();
  assert.doesNotThrow(() => part(boom.doc, 'hm-scroll').fire('click', { target: clickTarget(IDS[0]) }));
  const late = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => MODEL }, onOpenSweep: () => Promise.reject(new Error('later')) });
  late.mount(); await tick(); await late.matrix.open();
  part(late.doc, 'hm-scroll').fire('click', { target: clickTarget(IDS[0]) });
  await tick();
  assert.equal(late.errors.length, 1, 'a rejection is logged, not thrown into the page');
});

test('the trigger button exists only while the archive has a sweep, and the page is told when that changes', async () => {
  let sweeps = [];
  const told = [];
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(96, sweeps) }, onAvailability: () => told.push(r.matrix.button()) });
  assert.equal(r.matrix.button(), '', 'before mount');
  r.mount(); await tick();
  assert.equal(r.matrix.button(), '', 'an empty archive');
  assert.deepEqual(told, []);
  sweeps = IDS.slice(0, 1).map(id => ({ id }));
  await r.matrix.refresh();
  assert.equal(told.length, 1, 'told once when the first sweep shows up');
  const button = r.matrix.button();
  assert.match(button, /^<button type="button" class="hm-open" id="healthMatrixTrigger" data-health-matrix aria-haspopup="dialog" title="Source health matrix">Matrix<\/button>$/);
  assert.deepEqual(told, [button]);
  r.requests.length = 0;
  await r.matrix.refresh(); await r.matrix.refresh();
  assert.deepEqual(r.requests, [], 'no more requests once a sweep was seen');
  assert.equal(told.length, 1);
});

test('a 404 or 503 from the archive keeps the trigger hidden; refresh looks again, one request at a time', async () => {
  let status = 404, calls = 0;
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => { calls++; if (status) throw Object.assign(new Error('HTTP ' + status), { status }); return ARCHIVE(); } } });
  r.mount(); await tick();
  assert.equal(r.matrix.button(), '');
  assert.equal(r.errors.length, 0, 'silent');
  status = 503; await r.matrix.refresh(); assert.equal(r.matrix.button(), '');
  status = 0;
  const before = calls;
  await Promise.all([r.matrix.refresh(), r.matrix.refresh()]);
  assert.equal(calls - before, 1, 'two refreshes in flight share one request');
  assert.ok(r.matrix.button().includes('data-health-matrix'));
  const offline = realm({ t: localT('en'), routes: { '/api/sweeps': () => { throw new Error('offline'); } } });
  offline.mount(); await tick();
  assert.equal(offline.matrix.button(), ''); assert.equal(offline.errors.length, 0);
});

test('the trigger is found by delegation, so a rebuilt panel needs no rebinding', async () => {
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => MODEL } });
  r.mount(); await tick();
  const click = r.doc.listeners.click;
  assert.equal(click.length, 1, 'one document listener');
  const trigger = new Node('button', r.doc);
  click[0]({ target: { closest: selector => selector === '[data-health-matrix]' ? trigger : null } });
  await tick();
  assert.equal(dialogOf(r.doc)?.open, true);
  assert.equal(r.doc.listeners.click.length, 1);
  const before = r.requests.length;
  click[0]({ target: { closest: () => null } }); click[0]({ target: null }); click[0]({});
  await tick();
  assert.equal(r.requests.length, before, 'other clicks do nothing');
});

test('closing returns the focus to the opener, or to the rebuilt trigger when the opener left the page; Esc and the backdrop close', async () => {
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => MODEL } });
  r.mount(); await tick();
  const opener = new Node('button', r.doc);
  r.doc.activeElement = opener;
  await r.matrix.open();
  const dialog = dialogOf(r.doc);
  r.doc.activeElement = part(r.doc, 'hm-close');
  dialog.close();
  assert.equal(opener.focused, 1, 'the opener has the focus again');
  // The panel was rebuilt while the dialog was open: the old opener is gone, the new trigger carries the id.
  const trigger = new Node('button', r.doc); trigger.id = 'healthMatrixTrigger'; r.doc.body.append(trigger);
  const stale = new Node('button', r.doc); stale.isConnected = false;
  r.doc.activeElement = stale;
  await r.matrix.open();
  r.doc.activeElement = part(r.doc, 'hm-close');
  dialog.close(); // what Esc does natively: the dialog closes, then a close event
  assert.equal(stale.focused, 0); assert.equal(trigger.focused, 1);
  // Backdrop: the press and the release both on the dialog itself, then the click.
  r.doc.activeElement = opener;
  await r.matrix.open();
  const backdropClick = () => { dialog.fire('pointerdown', { target: dialog }); dialog.fire('pointerup', { target: dialog }); dialog.fire('click', { target: dialog }); };
  backdropClick();
  assert.equal(dialog.open, false, 'a click on the backdrop closes');
  await r.matrix.open();
  const scroll = part(r.doc, 'hm-scroll');
  dialog.fire('pointerdown', { target: scroll }); dialog.fire('pointerup', { target: scroll }); dialog.fire('click', { target: scroll });
  assert.equal(dialog.open, true, 'a click inside does not');
  part(r.doc, 'hm-close').fire('click');
  assert.equal(dialog.open, false, 'the Close button');
});

test('the backdrop closes the dialog only for a press and a release on it: a selection dragged out of the table does not', async () => {
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => MODEL } });
  r.mount(); await tick(); await r.matrix.open();
  const dialog = dialogOf(r.doc), scroll = part(r.doc, 'hm-scroll');
  // A drag that starts in the table and ends on the backdrop: the click lands on the dialog.
  dialog.fire('pointerdown', { target: scroll }); dialog.fire('pointerup', { target: dialog }); dialog.fire('click', { target: dialog });
  assert.equal(dialog.open, true, 'pressed inside, released on the backdrop');
  // The other way round: pressed on the backdrop, released inside.
  dialog.fire('pointerdown', { target: dialog }); dialog.fire('pointerup', { target: scroll }); dialog.fire('click', { target: dialog });
  assert.equal(dialog.open, true, 'pressed on the backdrop, released inside');
  // A click that no press announced (a synthetic one).
  dialog.fire('click', { target: dialog });
  assert.equal(dialog.open, true, 'no press, no close');
  // The memory of a press does not outlive its click.
  dialog.fire('pointerdown', { target: dialog }); dialog.fire('pointerup', { target: dialog }); dialog.fire('click', { target: scroll });
  dialog.fire('click', { target: dialog });
  assert.equal(dialog.open, true, 'a press is used up by the click that follows it');
  dialog.fire('pointerdown', { target: dialog }); dialog.fire('pointerup', { target: dialog }); dialog.fire('click', { target: dialog });
  assert.equal(dialog.open, false, 'a real backdrop click');
});

test('close({focus:false}) leaves the focus alone (the page is moving it to the replay)', async () => {
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => MODEL } });
  r.mount(); await tick();
  const opener = new Node('button', r.doc);
  r.doc.activeElement = opener;
  await r.matrix.open();
  r.matrix.close({ focus: false });
  assert.equal(dialogOf(r.doc).open, false);
  assert.equal(opener.focused, 0);
  r.doc.activeElement = opener;
  await r.matrix.open();
  r.matrix.close();
  assert.equal(opener.focused, 1, 'the flag applies to one close only');
  assert.doesNotThrow(() => { r.matrix.close(); r.matrix.close({ focus: false }); }, 'closing a closed dialog is a no-op');
});

test('a lens change while the dialog is open redraws the table from the answer already received', async () => {
  const r = realm({ t: localT('en'), routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => MODEL } });
  r.mount(); await tick(); await r.matrix.open();
  assert.equal(r.lensListeners.length, 1);
  r.requests.length = 0;
  r.state.lens = 'space';
  r.lensListeners[0]('space');
  assert.deepEqual([...part(r.doc, 'hm-scroll').innerHTML.matchAll(/data-domain="([^"]*)"/g)].map(match => match[1]), ['space']);
  assert.deepEqual(r.requests, [], 'no new request');
  r.matrix.close();
  const html0 = part(r.doc, 'hm-scroll').innerHTML;
  r.state.lens = 'all'; r.lensListeners[0]('all');
  assert.equal(part(r.doc, 'hm-scroll').innerHTML, html0, 'a closed dialog is left alone');
});

test('the dialog speaks the page language: hu and fr names, group names and the legend', async () => {
  for (const [lang, title, ok] of [['hu', 'Forrásállapot-mátrix', 'Rendben'], ['fr', 'Matrice de santé des sources', 'OK']]) {
    const r = realm({ t: localT(lang), locale: lang === 'hu' ? 'hu-HU' : 'fr-FR', routes: { '/api/sweeps': () => ARCHIVE(), '/api/source-health': () => MODEL } });
    r.mount(); await tick(); await r.matrix.open();
    assert.equal(all(dialogOf(r.doc)).find(node => node.id === 'hm-title').textContent, title, lang);
    const out = part(r.doc, 'hm-scroll').innerHTML;
    assert.ok(out.includes(`<span class="hm-sr">${ok}</span>`), `${lang}: ${ok}`);
    assert.ok(out.includes(strings(lang).get('lenses.hazards')), `${lang}: the group uses the lenses string`);
    assert.notEqual(strings(lang).get('matrix.title'), strings('en').get('matrix.title'));
  }
});

test('the page wires the matrix: scripts after lens.js and replay.js, the stylesheet, the service worker, the panel button and the replay hand-over', () => {
  const at = needle => { const index = html.indexOf(needle); assert.ok(index > 0, needle); return index; };
  assert.ok(at('<script src="lens.js">') < at('<script src="health-matrix.js">') && at('<script src="replay.js">') < at('<script src="health-matrix.js">'));
  assert.ok(at('href="health-matrix.css"') > 0);
  const sw = read('dashboard/public/sw.js'), base = JSON.parse(sw.match(/const BASE = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  assert.ok(base.includes('/health-matrix.js') && base.includes('/health-matrix.css'));
  assert.ok(html.includes('window.CrucixHealthMatrix?.button?.()'), 'the source-health panel header carries the entry point');
  const at0 = html.indexOf('window.CrucixHealthMatrix?.mount(');
  assert.ok(at0 > 0, 'mounted by the page');
  const call = html.slice(html.lastIndexOf('\n', at0) + 1, html.indexOf('\n', at0));
  assert.match(call, /fetchJson:fetchJsonNoStore/);
  assert.match(call, /onOpenSweep:/);
  assert.match(call, /CrucixHealthMatrix\.close\(\{focus:false\}\)/, 'the dialog closes without taking the focus back');
  assert.match(call, /CrucixReplay\?\.open\(id\)/, 'a cell opens that sweep in the replay');
  assert.match(call, /onAvailability:redrawSourceHealth/, 'the panel button appears and disappears with the archive');
  assert.match(call, /!window\.__CRUCIX_OFFLINE_SHELL__|location\.protocol!==/, 'not on file pages or the offline shell');
  assert.match(html, /window\.CrucixHealthMatrix\?\.refresh\(\)/, 'a live snapshot makes an empty archive look again');
});

test('the module has no inline handlers, no innerHTML for the shell and no timers', () => {
  const source = read('dashboard/public/health-matrix.js');
  assert.ok(!/\son(click|change|input|keydown|keyup|error|load|focus|blur)\s*=/i.test(source), 'no inline handler attributes');
  assert.equal(count(source, /\.innerHTML\s*=/g), 1, 'the table is the only innerHTML write');
  assert.ok(!/setTimeout|setInterval/.test(source));
  assert.ok(!/\(\?<[=!]/.test(source));
});

// ===== The page's own helpers, sliced out of jarvis.html like the other dashboard tests do =====
function helper(name, context = {}) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start > 0, name);
  const end = html.indexOf('\nfunction ', start + 1);
  return vm.runInNewContext(`${html.slice(start, end)}\n${name}`, context);
}

test('the source-health panel header carries the matrix button between the title and the badge, and stays as before without it', () => {
  const panel = window => helper('buildSourceHealthPanel', { window, D: { health: [{ n: 'GDELT' }] }, t: (key, fallback) => fallback, esc: String, getAge: String, sourceState: () => 'ok', lensMatchesSource: () => true })();
  const BUTTON = '<button type="button" class="hm-open" id="healthMatrixTrigger" data-health-matrix>Matrix</button>';
  assert.ok(panel({ CrucixHealthMatrix: { button: () => BUTTON } }).includes(`</h3>${BUTTON}<span class="badge">1</span>`));
  for (const window of [{}, { CrucixHealthMatrix: { button: () => '' } }, { CrucixHealthMatrix: {} }, { CrucixHealthMatrix: { button: () => undefined } }]) assert.ok(!panel(window).includes('hm-open'), JSON.stringify(Object.keys(window)));
  assert.match(panel({}), /<div class="sec-head"><h3>Source health<\/h3><span class="badge">1<\/span><\/div>/, 'nothing else in the header changed');
});

test('redrawSourceHealth swaps the panel in place and does nothing when there is none; uiLocale follows the page language', () => {
  const swaps = [];
  const panel = { set outerHTML(value) { swaps.push(value); } };
  helper('redrawSourceHealth', { document: { querySelector: selector => selector === '.source-health-panel' ? panel : null }, buildSourceHealthPanel: () => '<panel>' })();
  assert.deepEqual(swaps, ['<panel>']);
  assert.doesNotThrow(() => helper('redrawSourceHealth', { document: { querySelector: () => null }, buildSourceHealthPanel: () => { throw new Error('no panel, nothing to build'); } })());
  assert.deepEqual([{ meta: { code: 'hu' } }, { meta: { code: 'fr' } }, { meta: { code: 'en' } }, { meta: {} }, {}].map(L => helper('uiLocale', { L })()), ['hu-HU', 'fr-FR', 'en-US', 'en-US', 'en-US']);
});

test('only a live snapshot makes the matrix look at an empty archive again (not a cached or a replayed one)', () => {
  const run = ({ cached = false, replaying = false } = {}) => {
    const refreshed = [];
    const context = { D: { meta: { timestamp: '2020-01-01T00:00:00Z' } }, lastSweepError: 'x', validSnapshot: () => true, normalizeSnapshot: data => data, reinit() {}, updateRuntimeStatus() {},
      window: { CrucixReplay: { active: () => replaying }, CrucixPWA: { markLive() {}, cacheLive() {} }, CrucixHealthMatrix: { refresh: () => refreshed.push(1) } } };
    const applied = helper('applySnapshot', context)({ meta: { timestamp: '2026-10-03T09:00:00Z' } }, { cached, force: replaying });
    return [applied, refreshed.length];
  };
  assert.deepEqual(run(), [true, 1]);
  assert.deepEqual(run({ cached: true }), [true, 0]);
  assert.deepEqual(run({ replaying: true }), [true, 0]);
  assert.doesNotThrow(() => helper('applySnapshot', { D: { meta: {} }, lastSweepError: '', validSnapshot: () => true, normalizeSnapshot: data => data, reinit() {}, updateRuntimeStatus() {}, window: {} })({ meta: { timestamp: '2026-10-03T09:00:00Z' } }), 'the page works without the module');
});

test('the page wires one mount line, and the replay bar and the matrix share the page locale helper', () => {
  assert.equal(count(html, /CrucixHealthMatrix\?\.mount\(/g), 1);
  assert.equal(count(html, /CrucixReplay\?\.mount\(/g), 1);
  assert.ok(html.includes('locale:uiLocale()'));
  assert.equal(count(html, /locale:uiLocale\(\)/g), 7, 'the replay bar, the matrix, the changes panel, the country-risk panel, sheet and briefing and the story threads take their locale from the helper');
});

test('health-matrix.css: the column times keep room between them (measured at 390 px: 1 px padding left 2 px between labels)', () => {
  const css = read('dashboard/public/health-matrix.css'), rule = css.match(/\.hm-time\{([^}]*)\}/)[1];
  const [vertical, horizontal = vertical] = rule.match(/padding:([^;}]+)/)[1].trim().split(/\s+/);
  assert.ok(parseFloat(horizontal) >= 3, 'side padding of a time header: ' + horizontal);
  assert.ok(parseFloat(rule.match(/min-width:(\d+)px/)[1]) >= 36, 'a column fits the five-character time and its padding');
});
