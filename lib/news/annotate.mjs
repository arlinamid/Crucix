// What a news item is about, for the dashboard's lens and region filters: its topics (lib/intelligence/topics.mjs: conflict, politics,
// technology, ...; a specialist feed's own topic first) and the countries its title and summary name (ISO 3166-1 alpha-2, at most 3).
// `country` stays the PUBLISHER's country: a Ukrainian outlet's story about Hungary is about HU, not UA.
import { countriesInText, countryByIso3 } from '../intelligence/countries.mjs';
import { tokensOf } from '../intelligence/extract.mjs';
import { topicsOf } from '../intelligence/topics.mjs';

/** Adds `topics` and `about` to a news item in place (title from `title` or `headline`); returns it. Never throws. */
export function annotateNews(item) {
  try {
    if (!item || typeof item !== 'object') return item;
    const title = typeof item.title === 'string' ? item.title : typeof item.headline === 'string' ? item.headline : '';
    const summary = typeof item.summary === 'string' ? item.summary : '';
    item.topics = [...topicsOf(tokensOf(title), 'news', item.topic ?? null)];
    item.about = countriesInText(`${title}\n${summary}`, { limit: 3 }).map(iso3 => countryByIso3(iso3)?.iso2).filter(Boolean);
  } catch { /* an odd item keeps what it has */ }
  return item;
}
