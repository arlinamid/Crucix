// The world-RSS headlines (lib/world-rss-runner.mjs, its own 30-minute background sweep) appended to a synthesized snapshot's
// newsFeed. Runs before the events are built, in the server sweep, at server start and in the terminal sweep, so the
// headlines become news events and their country mentions reach the risk model in all three.
import { annotateNews } from './annotate.mjs';
import { feedTimestamp } from './feed-time.mjs';

const MAX_PER_COUNTRY = 12;

/**
 * Appends `items` (world-RSS cache rows: title, source, url, date, country, lang, tier, state, summary) to `snapshot.newsFeed`,
 * skipping a URL or a title start (40 characters) the feed already holds. A date that cannot be read or lies in the future
 * leaves the headline without a time (feed-time.mjs), never with the fetch time. Never throws; returns the number added.
 */
export function enrichNewsFeed(snapshot, items, { now = Date.now() } = {}) {
  try {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(items) || !items.length) return 0;
    if (!Array.isArray(snapshot.newsFeed)) snapshot.newsFeed = [];
    const urls = new Set(snapshot.newsFeed.map(row => row?.url).filter(Boolean));
    const titles = new Set(snapshot.newsFeed.map(row => String(row?.headline || '').substring(0, 40).toLowerCase()));
    let added = 0;
    for (const item of items) {
      if (!item || typeof item.title !== 'string' || !item.title) continue;
      const titleKey = item.title.substring(0, 40).toLowerCase();
      if ((item.url && urls.has(item.url)) || titles.has(titleKey)) continue;
      const iso = feedTimestamp(item.date, now);
      snapshot.newsFeed.push({
        headline: item.title,
        ...(typeof item.summary === 'string' && item.summary ? { summary: item.summary } : {}),
        source: item.source,
        type: 'rss',
        timestamp: iso,
        publishedAt: iso,
        region: item.country || 'Global',
        urgent: false,
        url: item.url,
        tier: item.tier || 3,
        ...(item.state ? { state: true } : {}),
        lang: item.lang,
        country: item.country,
      });
      annotateNews(snapshot.newsFeed.at(-1));
      if (item.url) urls.add(item.url);
      titles.add(titleKey);
      added++;
    }
    return added;
  } catch (error) {
    try { console.warn('[NewsFeed] Enrich error:', error?.message); } catch { /* logging never breaks a sweep */ }
    return 0;
  }
}

export { MAX_PER_COUNTRY as WORLD_NEWS_PER_COUNTRY };
