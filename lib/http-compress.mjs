// gzip for the dashboard's responses, with the built-in zlib (no dependency). The snapshot (GET /api/data) is ~4 MB of JSON and the page
// with the snapshot inlined ~4 MB of HTML; gzipped they are ~10-15% of that.
//   - compressResponses(): res.send (and so res.json) bodies of a compressible type and at least MIN_BYTES are gzipped when the client
//     accepts gzip. The work runs on zlib's thread pool, not the main thread. The last large body of each path is kept with its gzip, so
//     the same snapshot asked for again (every open dashboard after a sweep) is compressed once.
//   - staticGzip(dir): the dashboard's static files (scripts, styles, the vendor libraries), gzipped once per file version (mtime) and
//     answered with Last-Modified / 304 like express.static; anything else falls through to express.static.
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const zip = promisify(gzip);
const MIN_BYTES = 4096;
const REUSE_BYTES = 256 * 1024;      // bodies at least this large are kept with their gzip, per path
const MAX_STATIC_BYTES = 16 * 1024 * 1024;
const COMPRESSIBLE = /^(?:application\/(?:json|javascript|manifest\+json|xml)|text\/|image\/svg\+xml)/i;
const STATIC_TYPES = Object.freeze({ '.js': 'application/javascript; charset=UTF-8', '.mjs': 'application/javascript; charset=UTF-8', '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8', '.svg': 'image/svg+xml', '.html': 'text/html; charset=UTF-8', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=UTF-8' });

const acceptsGzip = req => /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));

export function compressResponses({ minBytes = MIN_BYTES } = {}) {
  const reuse = new Map(); // path -> { body, zipped }
  return (req, res, next) => {
    if (!acceptsGzip(req) || req.path === '/events') return next();
    const send = res.send.bind(res);
    res.send = function compressedSend(body) {
      // Only text bodies a handler hands over whole; a stream, a Buffer of unknown type or an encoded body goes out as it is.
      if (typeof body !== 'string' || res.getHeader('Content-Encoding') || req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304) return send(body);
      if (!res.getHeader('Content-Type')) res.type('html');
      const type = String(res.getHeader('Content-Type') || '');
      const size = Buffer.byteLength(body);
      if (size < minBytes || !COMPRESSIBLE.test(type)) return send(body);
      res.vary('Accept-Encoding');
      const kept = size >= REUSE_BYTES ? reuse.get(req.path) : null;
      const finish = zipped => {
        if (res.headersSent) return;
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(zipped.length));
        send(zipped);
      };
      if (kept && kept.body === body) { finish(kept.zipped); return res; }
      zip(body, { level: 6 }).then(zipped => {
        if (size >= REUSE_BYTES) reuse.set(req.path, { body, zipped });
        finish(zipped);
      }).catch(() => { if (!res.headersSent) send(body); });
      return res;
    };
    next();
  };
}

export function staticGzip(dir, { minBytes = MIN_BYTES } = {}) {
  const root = normalize(dir);
  const cache = new Map(); // file -> { mtime, zipped, size }
  return async (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !acceptsGzip(req)) return next();
    const type = STATIC_TYPES[extname(req.path).toLowerCase()];
    if (!type) return next();
    let file;
    try { file = normalize(join(root, decodeURIComponent(req.path))); } catch { return next(); }
    if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) return next();
    let info;
    try { info = await stat(file); } catch { return next(); }
    if (!info.isFile() || info.size < minBytes || info.size > MAX_STATIC_BYTES) return next();
    const modified = new Date(Math.floor(info.mtimeMs / 1000) * 1000);
    const since = Date.parse(req.headers['if-modified-since'] || '');
    res.setHeader('Last-Modified', modified.toUTCString());
    res.setHeader('Cache-Control', 'public, max-age=0');
    res.vary('Accept-Encoding');
    if (Number.isFinite(since) && since >= modified.getTime()) return res.status(304).end();
    let entry = cache.get(file);
    if (!entry || entry.mtime !== info.mtimeMs) {
      try { entry = { mtime: info.mtimeMs, zipped: await zip(await readFile(file), { level: 9 }) }; } catch { return next(); }
      cache.set(file, entry);
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(entry.zipped.length));
    if (req.method === 'HEAD') return res.end();
    res.end(entry.zipped);
  };
}
