// The world order of the live news ticker, for the terminal (crucix --live). It is the dashboard's order
// (dashboard/public/jarvis.html: newsAgeBucket, rankNewsItem, diversifyByCountry), which test/news-ticker-diversity.test.mjs
// holds equal: headlines of the last LIVE_HOURS first, then older ones, then undated ones; inside each, tier 1 before 2, 3, 4
// (an item without a tier counts as 1 when urgent, else 3), newest first; then each publisher country (a source without a
// country counts as its own) holds at most PER_COUNTRY of the first places and the rest follow in that order.
export const LIVE_HOURS = 12;
export const PER_COUNTRY = 4;

const timeOf = item => (item?.timestamp ? Date.parse(item.timestamp) || 0 : 0);
const tierOf = item => (Number.isInteger(item?.tier) && item.tier >= 1 ? item.tier : (item?.urgent ? 1 : 3));

function ageBucket(item, now) {
  const ts = item?.timestamp ? Date.parse(item.timestamp) : NaN;
  if (!Number.isFinite(ts)) return 2;
  return now - ts > LIVE_HOURS * 3600000 ? 1 : 0;
}

/** A new array: `items` in the ticker's world order. */
export function rankTicker(items, { now = Date.now(), perCountry = PER_COUNTRY } = {}) {
  const ranked = (Array.isArray(items) ? items : []).filter(item => item && typeof item === 'object').slice();
  ranked.sort((a, b) => (ageBucket(a, now) - ageBucket(b, now)) || (tierOf(a) - tierOf(b)) || (timeOf(b) - timeOf(a)));
  const counts = new Map();
  const diverse = [];
  const overflow = [];
  for (const item of ranked) {
    const key = item.country || 'source:' + (item.source || '');
    const count = counts.get(key) || 0;
    if (count < perCountry) {
      diverse.push(item);
      counts.set(key, count + 1);
    } else {
      overflow.push(item);
    }
  }
  return [...diverse, ...overflow];
}
