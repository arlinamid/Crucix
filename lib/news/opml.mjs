// OPML 2.0 import and export of news feed subscriptions. Import goes through the hardened parseXml (no DOCTYPE or
// entities, 2 MB cap); every outline that carries an xmlUrl is one feed, at any nesting depth.
import { parseXml } from '../../apis/utils/xml.mjs';

const MAX_OUTLINES = 2000;
const MAX_DEPTH = 8;

const escapeXml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const asList = value => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];

/**
 * The feeds of an OPML document as [{source, url, lang?, country?, category?}], in document order, each URL once.
 * `category` is the text of the nearest enclosing outline without an xmlUrl. Throws on XML the parser refuses.
 */
export function parseOpml(xml) {
  const doc = parseXml(xml);
  if (!doc?.opml || typeof doc.opml !== 'object' || !('body' in doc.opml)) throw new Error('Not an OPML document: <opml><body> is missing');
  const body = doc.opml.body;
  if (!body || typeof body !== 'object') return [];
  const feeds = [];
  const seen = new Set();
  const walk = (outlines, category, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const outline of asList(outlines)) {
      if (feeds.length >= MAX_OUTLINES) return;
      const url = typeof outline['@_xmlUrl'] === 'string' ? outline['@_xmlUrl'].trim() : '';
      const label = [outline['@_title'], outline['@_text']].find(value => typeof value === 'string' && value.trim())?.trim() || '';
      if (url) {
        if (!seen.has(url)) {
          seen.add(url);
          const lang = typeof outline['@_language'] === 'string' ? outline['@_language'].trim().slice(0, 2).toLowerCase() : '';
          const country = typeof outline['@_country'] === 'string' ? outline['@_country'].trim().toUpperCase() : '';
          feeds.push({ source: label || url, url, ...(lang ? { lang } : {}), ...(country ? { country } : {}), ...(category ? { category } : {}) });
        }
      }
      if (outline.outline) walk(outline.outline, url ? category : (label || category), depth + 1);
    }
  };
  walk(body.outline, '', 0);
  return feeds;
}

/**
 * An OPML 2.0 document. `groups` is [{title, feeds:[{source, url, lang?, country?}]}]; empty groups are left out.
 */
export function buildOpml(groups, { title = 'Crucix news feeds', now = new Date() } = {}) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeXml(title)}</title>`,
    `    <dateCreated>${now.toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
  ];
  for (const group of groups) {
    if (!group?.feeds?.length) continue;
    lines.push(`    <outline text="${escapeXml(group.title)}" title="${escapeXml(group.title)}">`);
    for (const feed of group.feeds) {
      const extra = `${feed.lang ? ` language="${escapeXml(feed.lang)}"` : ''}${feed.country ? ` country="${escapeXml(feed.country)}"` : ''}`;
      lines.push(`      <outline type="rss" text="${escapeXml(feed.source)}" title="${escapeXml(feed.source)}" xmlUrl="${escapeXml(feed.url)}"${extra}/>`);
    }
    lines.push('    </outline>');
  }
  lines.push('  </body>', '</opml>', '');
  return lines.join('\n');
}
