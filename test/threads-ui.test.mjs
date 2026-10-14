import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// The story-thread views (threads.js, and its block in country.js) in a vm realm: the panel and the sheets are markup strings; the dialog runs
// on a minimal fake DOM, and the delegated clicks get a fake target with closest(). Same harness as test/risk-ui.test.mjs.
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const locale = lang => JSON.parse(read(`locales/${lang}.json`));
const tick = () => new Promise(resolve => setImmediate(resolve));
const THREAD = 'thread-0123456789abcdef';
const EVENT = n => 'event-' + n.toString(16).padStart(32, '0');

class El {
  constructor(tag) { Object.assign(this, { tag, kids: [], attrs: {}, listeners: {}, textContent: '', innerHTML: '', open: false, className: '' }); }
  append(...kids) { this.kids.push(...kids); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  showModal() { this.open = true; }
  close() { this.open = false; for (const fn of this.listeners.close || []) fn({}); }
  contains() { return false; }
  focus() {}
}
function realm(files) {
  const listeners = {};
  const document = { body: new El('body'), activeElement: null, createElement: tag => new El(tag), getElementById: () => null,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } };
  const window = { console };
  const context = vm.createContext({ window, document, console, Intl, Promise, setTimeout, clearTimeout });
  for (const file of files) vm.runInContext(read('dashboard/public/' + file), context);
  const target = (attrs, inside = '') => { const node = { getAttribute: name => Object.hasOwn(attrs, name) ? attrs[name] : null,
    closest: selector => (!inside || selector.includes(inside) || !selector.includes(' ')) && Object.keys(attrs).some(name => selector.includes(`[${name}]`)) ? node : null }; return node; };
  const click = attrs => { for (const fn of listeners.click || []) fn({ target: target(attrs, '#storyThreadsPanel') }); };
  const dialog = () => document.body.kids.find(node => node.tag === 'dialog' && node.id === 'thread-sheet');
  const clickIn = attrs => { const body = dialog().kids[0].kids[2]; for (const fn of body.listeners.click || []) fn({ target: target(attrs) }); };
  return { window, document, click, clickIn, dialog };
}
const t = lang => { const data = locale(lang); return (key, fallback) => { const value = key.split('.').reduce((at, part) => at && typeof at === 'object' ? at[part] : undefined, data); return typeof value === 'string' ? value : fallback; }; };
const summary = { at: '2026-10-14T12:00:00.000Z', count: 1, top: [{ id: THREAD, title: 'Iran seizes <b>tanker</b> in the Strait of Hormuz', status: 'emerging', first: '2026-10-14T09:00:00.000Z',
  last: '2026-10-14T11:00:00.000Z', memberCount: 3, kinds: ['maritime', 'news'], sources: 3, reports: 2, observations: 1, maxLevel: 'high',
  countries: [{ iso3: 'IRN', count: 2, located: false }], entities: [{ id: 'chokepoint:hormuz', type: 'chokepoint', label: 'Strait of Hormuz', count: 3 }], members: [EVENT(1)] }] };

test('the threads group has identical keys and placeholders in en, hu and fr, and panels.storyThreads exists', () => {
  const [en, hu, fr] = ['en', 'hu', 'fr'].map(locale);
  const keys = Object.keys(en.threads);
  assert.ok(keys.length > 30);
  for (const [lang, data] of [['hu', hu], ['fr', fr]]) {
    assert.deepEqual(Object.keys(data.threads), keys, `${lang}: threads keys in the en order`);
    for (const key of keys) {
      const placeholders = text => (text.match(/\{\w+\}/g) || []).sort().join();
      assert.ok(typeof data.threads[key] === 'string' && data.threads[key].trim() && !/[<>]/.test(data.threads[key]), `${lang}: threads.${key}`);
      assert.equal(placeholders(data.threads[key]), placeholders(en.threads[key]), `${lang}: threads.${key} placeholders`);
    }
  }
  for (const data of [en, hu, fr]) for (const key of ['thread', 'threadHelp', 'threadOpen']) assert.ok(data.intelligence[key], key);
  for (const data of [en, hu, fr]) assert.ok(data.panels.storyThreads);
});

test('the panel lists the threads escaped, says when there are none or no summary at all, and works without the API', () => {
  const { window } = realm(['threads.js']);
  window.CrucixThreads.mount({ t: t('hu'), locale: 'hu-HU', getThreads: () => summary, isReplay: () => false, fetchJson: () => Promise.resolve({}) });
  const html = window.CrucixThreads.panelHtml(summary);
  assert.ok(html.includes('id="storyThreadsPanel"') && html.includes(`data-thread-open="${THREAD}"`));
  assert.ok(html.includes('Iran seizes &lt;b&gt;tanker&lt;/b&gt;') && !html.includes('<b>tanker'), 'the title is escaped');
  assert.ok(html.includes('Kialakuló') && html.includes('3 rekord · 3 forrás') && html.includes('1 megfigyelés'), 'Hungarian status and counts');
  assert.ok(html.includes('IRN') && html.includes('Strait of Hormuz'));
  assert.ok(window.CrucixThreads.panelHtml({ count: 0, top: [] }).includes('data-threads-state="empty"'));
  assert.ok(window.CrucixThreads.panelHtml(null).includes('data-threads-state="unavailable"'));
  assert.ok(window.CrucixThreads.panelHtml({ top: [{ id: 'thread-x', title: 'bad id' }, 'junk'] }).includes('data-threads-state="empty"'), 'malformed rows are dropped');
  const offline = realm(['threads.js']).window;
  offline.CrucixThreads.mount({ t: t('en'), getThreads: () => summary });
  assert.ok(!offline.CrucixThreads.panelHtml(summary).includes('<button'), 'without the API the rows are plain text');
});

test('a panel row opens the thread sheet; an entity opens in place, a record in the inspector and a country in its sheet', async () => {
  const { window, click, clickIn, dialog } = realm(['threads.js']);
  const calls = [];
  const thread = { ...summary.top[0], countries: [{ iso3: 'IRN', count: 2, displayName: 'Irán' }], edges: { 'same-story': 1, 'co-occurs': 2 },
    events: [{ id: EVENT(1), title: 'Iran seizes tanker', kind: 'news', level: 'high', source: 'Reuters', time: '2026-10-14T11:00:00.000Z', entities: [] }], links: [] };
  const entity = { id: 'chokepoint:hormuz', type: 'chokepoint', label: 'Strait of Hormuz', events: thread.events, neighbors: [{ id: 'country:IRN', type: 'country', label: 'IRN', count: 2 }], threads: [summary.top[0]] };
  window.CrucixThreads.mount({ t: t('en'), locale: 'en-US', now: () => Date.parse('2026-10-14T12:00:00Z'), getThreads: () => summary, isReplay: () => false,
    fetchJson: url => { calls.push(url); return Promise.resolve(url.startsWith('/api/threads/') ? thread : entity); },
    openEvent: id => calls.push(['event', id]), openCountry: iso3 => calls.push(['country', iso3]) });
  click({ 'data-thread-open': THREAD });
  await tick();
  assert.deepEqual(calls, [`/api/threads/${THREAD}`]);
  const sheet = dialog();
  assert.ok(sheet.open);
  const body = sheet.kids[0].kids[2];
  assert.ok(body.innerHTML.includes('1 same-story links · 2 co-occurrence links') && body.innerHTML.includes('data-thread-entity="chokepoint:hormuz"') && body.innerHTML.includes('data-thread-country="IRN"'));
  clickIn({ 'data-thread-entity': 'chokepoint:hormuz' });
  await tick();
  assert.equal(calls.at(-1), '/api/entities/chokepoint%3Ahormuz');
  assert.ok(body.innerHTML.includes('data-thread-back') && body.innerHTML.includes('Named together with'), 'the entity view, with a way back');
  clickIn({ 'data-thread-entity': 'country:IRN' });
  assert.deepEqual(calls.at(-1), ['country', 'IRN'], 'a country opens its sheet');
  assert.equal(sheet.open, false);
  click({ 'data-thread-open': THREAD });
  await tick();
  clickIn({ 'data-thread-event': EVENT(1) });
  assert.deepEqual(calls.at(-1), ['event', EVENT(1)]);
});

test('during a replay the rows are off and the sheet only says why; a failed request says so', async () => {
  const { window, click, dialog } = realm(['threads.js']);
  const calls = [];
  window.CrucixThreads.mount({ t: t('en'), getThreads: () => summary, isReplay: () => true, fetchJson: url => { calls.push(url); return Promise.resolve({}); } });
  const html = window.CrucixThreads.panelHtml(summary);
  assert.ok(html.includes('data-replay="true"') && /aria-disabled="true" aria-describedby="storyThreadsReplay"/.test(html));
  click({ 'data-thread-open': THREAD, 'aria-disabled': 'true' });
  assert.equal(await window.CrucixThreads.open(THREAD), false);
  assert.equal(dialog().getAttribute('data-replay'), 'true');
  assert.deepEqual(calls, []);
  const failing = realm(['threads.js']);
  failing.window.CrucixThreads.mount({ t: t('en'), isReplay: () => false, fetchJson: () => Promise.reject(Object.assign(new Error('gone'), { status: 404 })) });
  assert.equal(await failing.window.CrucixThreads.open(THREAD), false);
  assert.equal(failing.dialog().kids[0].kids[1].textContent, locale('en').threads.notFound);
});

test('the country sheet lists its threads and a thread row hands over to the thread sheet', async () => {
  const { window } = realm(['country.js']);
  const html = window.CrucixCountry.render({ iso3: 'IRN', name: 'Iran', score: null, threads: [{ ...summary.top[0] }, { id: 'nope' }] });
  assert.ok(html.includes(`data-country-thread="${THREAD}"`) && html.includes('3 records · 3 sources'));
  assert.equal((html.match(/data-country-thread=/g) || []).length, 1, 'a malformed thread is dropped');
  assert.ok(!window.CrucixCountry.render({ iso3: 'IRN', name: 'Iran', score: null }).includes('cs-threads'), 'no threads, no section');
});
