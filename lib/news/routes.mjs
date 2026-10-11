import { requireSameOriginJson } from '../http-security.mjs';
import { crucixHome, settingsEnvPath } from '../user-paths.mjs';
import { FeedError } from './feed-store.mjs';

// The feed manager API (Settings > RSS feeds). Reads are plain GETs; every change passes requireSameOriginJson like the
// alert routes. `onChange` runs after a successful change (the server refreshes the world RSS cache from it).

const OPML_BODY_LIMIT = '1mb';
// A region switch sends the URLs of every feed in it (a few hundred).
const BATCH_BODY_LIMIT = '256kb';

function fail(res, error) {
  if (error instanceof FeedError) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error('[Feeds] Request failed:', error?.message || error);
  return res.status(503).json({ error: 'The feed settings could not be saved', code: 'FEEDS_UNAVAILABLE' });
}

export function installFeedRoutes(app, { store, security = {}, onChange = () => {} } = {}) {
  const guard = requireSameOriginJson(security);
  const opmlGuard = requireSameOriginJson({ ...security, limit: OPML_BODY_LIMIT });
  const batchGuard = requireSameOriginJson({ ...security, limit: BATCH_BODY_LIMIT });
  const changed = (res, body) => { try { onChange(); } catch { /* a refresh hook never fails the request */ } res.json({ ok: true, ...body }); };

  app.get('/api/feeds', (_req, res) => res.json({
    ...store.list(),
    profile: crucixHome(),
    envFile: settingsEnvPath(),
  }));

  app.post('/api/feeds/toggle', batchGuard, (req, res) => {
    try {
      const { url, urls, enabled, kind } = req.body ?? {};
      if (urls !== undefined) return changed(res, store.setManyEnabled(urls, enabled));
      changed(res, url === undefined && kind ? store.setAllEnabled(kind, enabled) : store.setEnabled(url, enabled));
    } catch (error) { fail(res, error); }
  });

  app.post('/api/feeds/country', guard, (req, res) => {
    try { changed(res, store.setCountry(req.body?.url, req.body?.country)); } catch (error) { fail(res, error); }
  });

  app.post('/api/feeds/custom', guard, (req, res) => {
    try { changed(res, { feed: store.addCustom(req.body ?? {}) }); } catch (error) { fail(res, error); }
  });

  app.post('/api/feeds/custom/update', guard, (req, res) => {
    try {
      const { url, ...changes } = req.body ?? {};
      changed(res, { feed: store.updateCustom(url, changes) });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/feeds/custom/remove', guard, (req, res) => {
    try { changed(res, store.removeCustom(req.body?.url)); } catch (error) { fail(res, error); }
  });

  app.post('/api/feeds/reset', guard, (_req, res) => {
    try { store.reset(); changed(res, {}); } catch (error) { fail(res, error); }
  });

  app.get('/api/feeds/opml', (req, res) => {
    const scope = req.query?.scope === 'all' ? 'all' : 'active';
    res.set('Content-Disposition', `attachment; filename="crucix-feeds-${new Date().toISOString().slice(0, 10)}.opml"`);
    res.type('text/x-opml; charset=utf-8').send(store.exportOpml({ scope }));
  });

  app.post('/api/feeds/opml', opmlGuard, (req, res) => {
    try {
      const opml = req.body?.opml;
      if (typeof opml !== 'string' || !opml.trim()) throw new FeedError('INVALID_OPML', 'Send the OPML document as {"opml": "<opml>...</opml>"}');
      const result = store.importOpml(opml);
      if (result.added || result.enabled) changed(res, result); else res.json({ ok: true, ...result });
    } catch (error) { fail(res, error); }
  });
}
