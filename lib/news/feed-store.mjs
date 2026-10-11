// User overrides of the news feed registry, stored in the profile's feeds.json (lib/user-paths.mjs): feeds switched
// off by URL, the country group a registry feed is moved to, and the operator's own feeds. The registry itself
// (apis/utils/news-feeds.mjs) is never changed. Without a file every registry feed is on, in its own country, and
// there are no custom feeds, so a fresh install behaves exactly as before.
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEWS_FEEDS, WORLD_FEEDS } from '../../apis/utils/news-feeds.mjs';
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.mjs';
import { buildOpml, parseOpml } from './opml.mjs';
import { feedsSettingsPath, resolveRunsDir } from '../user-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const VERSION = 2;
export const MAX_CUSTOM_FEEDS = 300;
export const MAX_BATCH = 2000;
const MAX_URL = 2048;
const MAX_SOURCE = 80;
// A moved feed with no country: it joins the "Global" group and every region filter skips it.
const NO_COUNTRY = '';

export class FeedError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

/** A two-letter ISO country code, or NO_COUNTRY for "no country" (null, '' or 'GLOBAL'). Throws FeedError. */
function cleanCountry(raw) {
  if (raw === null || raw === undefined) return NO_COUNTRY;
  const value = String(raw).trim().toUpperCase();
  if (value === '' || value === 'GLOBAL') return NO_COUNTRY;
  if (!/^[A-Z]{2}$/.test(value)) throw new FeedError('INVALID_COUNTRY', 'The country must be a two-letter ISO code such as US or HU');
  return value;
}

// Loopback, private, link-local and unspecified literal addresses. Host names are not resolved: this blocks the
// obvious "fetch my router" entries, it is not a full SSRF filter (the routes are same-origin and operator-only).
function isInternalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (family === 6) return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:');
  return false;
}

/** A feed URL as stored: http(s), no credentials, no internal host, at most 2048 characters. Throws FeedError. */
export function normalizeFeedUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_URL) throw new FeedError('INVALID_URL', 'The feed URL must be an http or https address');
  let url;
  try { url = new URL(raw.trim()); } catch { throw new FeedError('INVALID_URL', 'The feed URL must be an http or https address'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new FeedError('INVALID_URL', 'The feed URL must be an http or https address');
  if (url.username || url.password) throw new FeedError('INVALID_URL', 'The feed URL may not carry a user name or password');
  if (isInternalHost(url.hostname)) throw new FeedError('INTERNAL_HOST', 'Feeds on local or private network addresses are not allowed');
  url.hash = '';
  return url.toString();
}

function cleanCustom(input) {
  if (!input || typeof input !== 'object') throw new FeedError('INVALID_FEED', 'A feed needs a source name and a URL');
  const url = normalizeFeedUrl(input.url);
  const source = typeof input.source === 'string' ? input.source.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_SOURCE) : '';
  if (!source) throw new FeedError('INVALID_SOURCE', 'The feed needs a source name (1 to 80 characters)');
  const tier = input.tier === undefined || input.tier === null || input.tier === '' ? 3 : Number(input.tier);
  if (![1, 2, 3, 4].includes(tier)) throw new FeedError('INVALID_TIER', 'The tier must be 1, 2, 3 or 4');
  const lang = typeof input.lang === 'string' && input.lang.trim() ? input.lang.trim().toLowerCase() : 'en';
  if (!/^[a-z]{2}$/.test(lang)) throw new FeedError('INVALID_LANG', 'The language must be a two-letter code such as en or hu');
  const country = typeof input.country === 'string' && input.country.trim() ? input.country.trim().toUpperCase() : null;
  if (country !== null && !/^[A-Z]{2}$/.test(country)) throw new FeedError('INVALID_COUNTRY', 'The country must be a two-letter ISO code such as US or HU');
  return Object.freeze({ source, url, tier, lang, state: false, ...(country ? { country } : {}), custom: true });
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validState = value => isObject(value) && Array.isArray(value.disabled) && Array.isArray(value.custom) && (value.countries === undefined || isObject(value.countries));
const CUSTOM_FIELDS = ['source', 'lang', 'country', 'tier'];

export class FeedStore {
  /**
   * @param {string} file the feeds.json path
   * @param {{core?: object[], world?: object[], legacyFile?: string|null}} [options] the registry (tests), and the
   *   runs/feeds.json of earlier versions: read while `file` does not exist yet, the next change writes `file`
   */
  constructor(file, { core = NEWS_FEEDS, world = WORLD_FEEDS, legacyFile = null } = {}) {
    this.path = file;
    this.legacyPath = legacyFile;
    this.core = core;
    this.world = world;
    this.registry = new Map([...core.map(feed => [feed.url, { feed, kind: 'core' }]), ...world.map(feed => [feed.url, { feed, kind: 'world' }])]);
    this.disabled = new Set();
    this.countries = new Map();
    this.custom = [];
    this.loadError = null;
  }

  /** Reads feeds.json (or its backup). A missing file is the default state; a corrupt one too, with loadError set. */
  load() {
    const current = existsSync(this.path) || existsSync(`${this.path}.bak`);
    const source = !current && this.legacyPath && existsSync(this.legacyPath) ? this.legacyPath : this.path;
    const { value, error } = readJsonWithBackup(source, { maxBytes: 2 * 1024 * 1024, validate: validState });
    this.loadError = error || null;
    this.custom = [];
    for (const entry of value?.custom || []) {
      if (this.custom.length >= MAX_CUSTOM_FEEDS) break;
      try {
        const feed = cleanCustom(entry);
        if (!this.registry.has(feed.url) && this.customIndex(feed.url) < 0) this.custom.push(feed);
      } catch { /* an entry edited into something invalid is dropped */ }
    }
    this.disabled = new Set((value?.disabled || []).filter(url => typeof url === 'string' && this.known(url)));
    this.countries = new Map();
    for (const [url, country] of Object.entries(value?.countries || {})) {
      const entry = this.registry.get(url);
      if (!entry) continue;
      try {
        const clean = cleanCountry(country);
        if (clean !== (entry.feed.country || NO_COUNTRY)) this.countries.set(url, clean);
      } catch { /* an invalid country is dropped: the feed stays in its own */ }
    }
    return this;
  }

  save() {
    writeJsonAtomic(this.path, {
      version: VERSION,
      disabled: [...this.disabled],
      countries: Object.fromEntries(this.countries),
      custom: this.custom.map(({ custom, state, ...feed }) => feed),
    });
  }

  customIndex(url) { return this.custom.findIndex(feed => feed.url === url); }
  known(url) { return this.registry.has(url) || this.customIndex(url) >= 0; }

  /** A registry feed with the country it was moved to (or without one); custom feeds carry their own. */
  effective(feed) {
    const moved = this.countries.get(feed.url);
    if (moved === undefined) return feed;
    const { country, ...rest } = feed;
    return moved === NO_COUNTRY ? rest : { ...rest, country: moved };
  }

  /** Core registry feeds that are on, followed by the custom feeds that are on (they join the dashboard news selection). */
  activeNewsFeeds() {
    const on = feed => !this.disabled.has(feed.url);
    return [...this.core.filter(on).map(feed => this.effective(feed)), ...this.custom.filter(on)];
  }

  /** World catalog feeds that are on (the 30-minute background runner). */
  activeWorldFeeds() { return this.world.filter(feed => !this.disabled.has(feed.url)).map(feed => this.effective(feed)); }

  list() {
    const row = (feed, kind) => ({
      source: feed.source, url: feed.url, tier: feed.tier, lang: feed.lang,
      country: this.effective(feed).country || null,
      defaultCountry: kind === 'custom' ? null : feed.country || null,
      moved: this.countries.has(feed.url),
      state: !!feed.state, kind, enabled: !this.disabled.has(feed.url),
    });
    const core = this.core.map(feed => row(feed, 'core'));
    const world = this.world.map(feed => row(feed, 'world'));
    const custom = this.custom.map(feed => row(feed, 'custom'));
    const on = rows => rows.filter(feed => feed.enabled).length;
    return {
      counts: {
        core: core.length, coreEnabled: on(core),
        world: world.length, worldEnabled: on(world),
        custom: custom.length, customEnabled: on(custom), maxCustom: MAX_CUSTOM_FEEDS,
      },
      core, world, custom,
      file: this.path,
      ...(this.loadError ? { loadError: 'feeds.json could not be read; defaults are in use' } : {}),
    };
  }

  setEnabled(rawUrl, enabled) {
    if (typeof enabled !== 'boolean') throw new FeedError('INVALID_ENABLED', 'enabled must be true or false');
    const url = typeof rawUrl === 'string' ? rawUrl : '';
    if (!this.known(url)) throw new FeedError('UNKNOWN_FEED', 'No feed has this URL', 404);
    if (enabled) this.disabled.delete(url); else this.disabled.add(url);
    this.save();
    return { url, enabled };
  }

  /** Switches a group of feeds (a region or a country in the dashboard) on or off. Unknown URLs are skipped. */
  setManyEnabled(urls, enabled) {
    if (typeof enabled !== 'boolean') throw new FeedError('INVALID_ENABLED', 'enabled must be true or false');
    if (!Array.isArray(urls) || !urls.length || urls.length > MAX_BATCH) throw new FeedError('INVALID_URLS', `urls must be a list of 1 to ${MAX_BATCH} feed URLs`);
    const known = urls.filter(url => typeof url === 'string' && this.known(url));
    if (!known.length) throw new FeedError('UNKNOWN_FEED', 'None of these URLs is a known feed', 404);
    let changed = 0;
    for (const url of known) {
      if (this.disabled.has(url) === enabled) changed++;
      if (enabled) this.disabled.delete(url); else this.disabled.add(url);
    }
    this.save();
    return { enabled, changed, skipped: urls.length - known.length };
  }

  /** Switches every feed of one list (core, world or custom) on or off. */
  setAllEnabled(kind, enabled) {
    if (!['core', 'world', 'custom'].includes(kind)) throw new FeedError('INVALID_KIND', 'kind must be core, world or custom');
    if (typeof enabled !== 'boolean') throw new FeedError('INVALID_ENABLED', 'enabled must be true or false');
    for (const feed of { core: this.core, world: this.world, custom: this.custom }[kind]) {
      if (enabled) this.disabled.delete(feed.url); else this.disabled.add(feed.url);
    }
    this.save();
    return { kind, enabled };
  }

  /**
   * Moves a feed to another country group: a registry feed keeps the move as an override (moving it back to its own
   * country drops the override), a custom feed takes the new country. `country` null, '' or 'GLOBAL' means none.
   */
  setCountry(rawUrl, rawCountry) {
    const url = typeof rawUrl === 'string' ? rawUrl : '';
    const country = cleanCountry(rawCountry);
    const entry = this.registry.get(url);
    if (entry) {
      if (country === (entry.feed.country || NO_COUNTRY)) this.countries.delete(url); else this.countries.set(url, country);
    } else {
      const index = this.customIndex(url);
      if (index < 0) throw new FeedError('UNKNOWN_FEED', 'No feed has this URL', 404);
      this.custom[index] = cleanCustom({ ...this.custom[index], country: country || null });
    }
    this.save();
    return { url, country: country || null };
  }

  addCustom(input) {
    const feed = cleanCustom(input);
    if (this.registry.has(feed.url)) throw new FeedError('DUPLICATE_FEED', 'This URL is already in the built-in registry; switch it on there', 409);
    if (this.customIndex(feed.url) >= 0) throw new FeedError('DUPLICATE_FEED', 'This feed has already been added', 409);
    if (this.custom.length >= MAX_CUSTOM_FEEDS) throw new FeedError('TOO_MANY_FEEDS', `At most ${MAX_CUSTOM_FEEDS} custom feeds can be added`, 409);
    this.custom.push(feed);
    this.save();
    return feed;
  }

  /** Changes the name, language, country or tier of a custom feed; its URL stays (remove and add it to change that). */
  updateCustom(rawUrl, changes) {
    const index = this.customIndex(typeof rawUrl === 'string' ? rawUrl : '');
    if (index < 0) throw new FeedError('UNKNOWN_FEED', 'No custom feed has this URL', 404);
    if (!isObject(changes)) throw new FeedError('INVALID_FEED', 'Send the fields to change');
    const current = this.custom[index];
    const picked = Object.fromEntries(CUSTOM_FIELDS.filter(key => Object.hasOwn(changes, key)).map(key => [key, changes[key]]));
    const feed = cleanCustom({ ...current, ...picked, url: current.url });
    this.custom[index] = feed;
    this.save();
    return feed;
  }

  removeCustom(rawUrl) {
    const index = this.customIndex(rawUrl);
    if (index < 0) throw new FeedError('UNKNOWN_FEED', 'No custom feed has this URL', 404);
    this.custom.splice(index, 1);
    this.disabled.delete(rawUrl);
    this.save();
    return { url: rawUrl, removed: true };
  }

  /** Drops every override: all registry feeds on and in their own country, no custom feeds. */
  reset() {
    this.disabled.clear();
    this.countries.clear();
    this.custom = [];
    this.save();
  }

  /**
   * Merges an OPML document: a known URL is switched on, any other valid URL becomes a custom feed.
   * Returns {added, enabled, skipped, total}; nothing is written when the document changes nothing.
   */
  importOpml(xml) {
    let entries;
    try { entries = parseOpml(xml); } catch (error) { throw new FeedError('INVALID_OPML', `The file is not a usable OPML document: ${error.message}`); }
    if (!entries.length) throw new FeedError('EMPTY_OPML', 'The OPML document lists no feeds (no outline with an xmlUrl)');
    const result = { added: 0, enabled: 0, skipped: 0, total: entries.length, errors: [] };
    for (const entry of entries) {
      let url;
      try { url = normalizeFeedUrl(entry.url); } catch (error) { result.skipped++; if (result.errors.length < 20) result.errors.push({ url: String(entry.url).slice(0, 200), error: error.message }); continue; }
      const knownUrl = this.known(entry.url) ? entry.url : this.known(url) ? url : null;
      if (knownUrl) {
        if (this.disabled.delete(knownUrl)) result.enabled++; else result.skipped++;
        continue;
      }
      if (this.custom.length >= MAX_CUSTOM_FEEDS) { result.skipped++; continue; }
      try {
        this.custom.push(cleanCustom({ source: entry.source, url, lang: entry.lang, country: entry.country }));
        result.added++;
      } catch (error) {
        result.skipped++;
        if (result.errors.length < 20) result.errors.push({ url: url.slice(0, 200), error: error.message });
      }
    }
    if (result.added || result.enabled) this.save();
    return result;
  }

  /** OPML of the feeds that are on: `scope` 'active' (default) or 'all' (also the switched-off ones). */
  exportOpml({ scope = 'active', now } = {}) {
    const keep = feed => scope === 'all' || !this.disabled.has(feed.url);
    return buildOpml([
      { title: 'Crucix core feeds', feeds: this.core.filter(keep).map(feed => this.effective(feed)) },
      { title: 'Custom feeds', feeds: this.custom.filter(keep) },
      { title: 'Crucix world catalog', feeds: this.world.filter(keep).map(feed => this.effective(feed)) },
    ], { title: 'Crucix news feeds', now });
  }
}

/** The store over the profile's feeds.json, reading the old runs/feeds.json until the first change. */
export function openFeedStore({ runsDir = null, file = feedsSettingsPath() } = {}) {
  return new FeedStore(file, { legacyFile: runsDir ? join(runsDir, 'feeds.json') : null }).load();
}

// The store the sweep reads. server.mjs installs its own; anything else (CLI, scripts) opens the profile's on first
// use, so feeds switched off in the dashboard stay off there too.
let activeStore = null;

export function setActiveFeedStore(store) { activeStore = store; }

export function getActiveFeedStore() {
  if (!activeStore) activeStore = openFeedStore({ runsDir: resolveRunsDir({ root: ROOT }) });
  return activeStore;
}

export const activeNewsFeeds = () => getActiveFeedStore().activeNewsFeeds();
export const activeWorldFeeds = () => getActiveFeedStore().activeWorldFeeds();

