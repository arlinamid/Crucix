import { createWorldFeeds } from '../../data/world-rss/world-feeds.js';

// The news feed registry. `tier` follows the public reading of source reliability that World Monitor (koala73/worldmonitor,
// AGPL-3.0) uses: 1 = official bodies and wire services, 2 = major outlets, 3 = specialist, regional and think-tank sources,
// 4 = aggregators and blogs. A tier ranks a source, it does not say a headline is true. `state` marks an outlet that a
// government owns or funds, `lang` the language of its headlines (shown as a tag, headlines are never translated).
// Reachability of every URL was measured from Hungary on 2026-10-08 (HTTP 200).
// `topic` (lib/intelligence/topics.mjs: conflict, politics, technology, health, economy) marks a specialist feed: its headlines count as that
// topic even when a title has none of the topic's words, and they reach the event layer through their own quota (dashboard/inject.mjs topicNews).
const feed = (source, url, tier, extra = {}) => Object.freeze({ source, url, tier, lang: 'en', state: false, topic: null, ...extra });

export const NEWS_FEEDS = Object.freeze([
  // Global and wires
  feed('BBC', 'https://feeds.bbci.co.uk/news/world/rss.xml', 2, { country: 'GB' }),
  feed('NYT', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 2, { country: 'US' }),
  feed('Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml', 2, { state: true, country: 'QA' }),
  feed('Guardian', 'https://www.theguardian.com/world/rss', 2, { country: 'GB' }),
  feed('UN News', 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', 1, { country: 'US' }),
  // USA
  feed('NPR', 'https://feeds.npr.org/1001/rss.xml', 2, { country: 'US' }),
  feed('BBC Tech', 'https://feeds.bbci.co.uk/news/technology/rss.xml', 2, { country: 'GB' }),
  feed('BBC Science', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', 2, { country: 'GB' }),
  feed('NYT Americas', 'https://rss.nytimes.com/services/xml/rss/nyt/Americas.xml', 2, { country: 'US' }),
  // Europe
  feed('DW', 'https://rss.dw.com/rdf/rss-en-all', 2, { country: 'DE' }),
  feed('France 24', 'https://www.france24.com/en/rss', 2, { country: 'FR' }),
  feed('Euronews', 'https://www.euronews.com/rss?format=mrss', 2, { country: 'FR' }),
  feed('Balkan Insight', 'https://balkaninsight.com/feed/', 3),
  feed('Meduza', 'https://meduza.io/rss/en/all', 2, { country: 'LV' }),
  feed('Moscow Times', 'https://www.themoscowtimes.com/rss/news', 2, { country: 'NL' }),
  feed('ERR News', 'https://news.err.ee/rss', 2, { country: 'EE' }),
  // Hungary
  feed('Telex', 'https://telex.hu/rss', 2, { lang: 'hu', country: 'HU' }),
  feed('Index.hu', 'https://index.hu/24ora/rss', 2, { lang: 'hu', country: 'HU' }),
  feed('HVG', 'https://hvg.hu/rss', 2, { lang: 'hu', country: 'HU' }),
  feed('444.hu', 'https://444.hu/feed', 2, { lang: 'hu', country: 'HU' }),
  feed('24.hu', 'https://24.hu/feed/', 2, { lang: 'hu', country: 'HU' }),
  feed('Portfolio.hu', 'https://portfolio.hu/rss/all.xml', 2, { lang: 'hu', country: 'HU' }),
  feed('ATV', 'https://www.atv.hu/rss', 2, { lang: 'hu', country: 'HU' }),
  // Middle East and Turkey
  feed('Jerusalem Post', 'https://www.jpost.com/rss/rssfeedsheadlines.aspx', 2, { country: 'IL' }),
  feed('The National', 'https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml', 2, { country: 'AE' }),
  feed('Daily Sabah', 'https://www.dailysabah.com/rss/home-page', 3, { state: true, country: 'TR' }),
  // Africa
  feed('DW Africa', 'https://rss.dw.com/rdf/rss-en-africa', 2, { country: 'DE' }),
  feed('RFI', 'https://www.rfi.fr/en/rss', 2, { country: 'FR' }),
  feed('Africa News', 'https://www.africanews.com/feed/rss', 3, { country: 'CG' }),
  feed('NYT Africa', 'https://rss.nytimes.com/services/xml/rss/nyt/Africa.xml', 2, { country: 'US' }),
  // Asia-Pacific
  feed('NYT Asia', 'https://rss.nytimes.com/services/xml/rss/nyt/AsiaPacific.xml', 2, { country: 'US' }),
  feed('SBS Australia', 'https://www.sbs.com.au/news/topic/australia/feed', 2, { country: 'AU' }),
  feed('ABC Australia', 'https://www.abc.net.au/news/feed/2942460/rss.xml', 2, { country: 'AU' }),
  feed('CNA', 'https://www.channelnewsasia.com/rssfeeds/8395986', 2, { country: 'SG' }),
  feed('The Diplomat', 'https://thediplomat.com/feed/', 3, { country: 'US' }),
  feed('Dawn', 'https://www.dawn.com/feeds/home/', 2, { country: 'PK' }),
  feed('Indian Express', 'https://indianexpress.com/section/india/feed/', 2, { country: 'IN' }),
  feed('The Hindu', 'https://www.thehindu.com/news/national/feeder/default.rss', 2, { country: 'IN' }),
  // Latin America
  feed('MercoPress', 'https://en.mercopress.com/rss/latin-america', 3),
  feed('Mexico News Daily', 'https://mexiconewsdaily.com/feed/', 3, { country: 'MX' }),
  feed('InSight Crime', 'https://insightcrime.org/feed/', 3),
  // Defence, security and think tanks
  feed('Defense One', 'https://www.defenseone.com/rss/all/', 3, { country: 'US', topic: 'conflict' }),
  feed('The War Zone', 'https://www.twz.com/feed', 3, { country: 'US', topic: 'conflict' }),
  feed('Breaking Defense', 'https://breakingdefense.com/feed/', 3, { country: 'US', topic: 'conflict' }),
  feed('War on the Rocks', 'https://warontherocks.com/feed/', 3, { country: 'US', topic: 'conflict' }),
  feed('Foreign Policy', 'https://foreignpolicy.com/feed/', 3, { country: 'US', topic: 'politics' }),
  feed('Crisis Group', 'https://www.crisisgroup.org/rss', 3, { topic: 'politics' }),
  feed('Oryx', 'https://www.oryxspioenkop.com/feeds/posts/default?alt=rss', 3, { topic: 'conflict' }),
  feed('IAEA', 'https://www.iaea.org/feeds/topnews', 1, { country: 'AT' }),
  feed('WHO News', 'https://www.who.int/rss-feeds/news-english.xml', 1, { country: 'CH', topic: 'health' }),
  feed('Krebs', 'https://krebsonsecurity.com/feed/', 3, { country: 'US', topic: 'technology' }),
  feed('OilPrice', 'https://oilprice.com/rss/main', 4, { country: 'US', topic: 'economy' }),
  // Technology and cyber security (measured from Hungary on 2026-10-14 with the Crucix User-Agent: HTTP 200, fresh items; Rest of World
  // answers 403 and Wired is mostly culture, so both were left out)
  feed('Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index', 2, { country: 'US', topic: 'technology' }),
  feed('The Verge', 'https://www.theverge.com/rss/index.xml', 2, { country: 'US', topic: 'technology' }),
  feed('TechCrunch', 'https://techcrunch.com/feed/', 2, { country: 'US', topic: 'technology' }),
  feed('The Register', 'https://www.theregister.com/headlines.atom', 2, { country: 'GB', topic: 'technology' }),
  feed('MIT Technology Review', 'https://www.technologyreview.com/feed/', 2, { country: 'US', topic: 'technology' }),
  feed('BleepingComputer', 'https://www.bleepingcomputer.com/feed/', 3, { country: 'US', topic: 'technology' }),
  feed('The Record', 'https://therecord.media/feed', 3, { country: 'US', topic: 'technology' }),
  feed('SecurityWeek', 'https://www.securityweek.com/feed/', 3, { country: 'US', topic: 'technology' }),
  feed('The Hacker News', 'https://feeds.feedburner.com/TheHackersNews', 3, { topic: 'technology' }),
  feed('CyberScoop', 'https://cyberscoop.com/feed/', 3, { country: 'US', topic: 'technology' }),
  feed('Dark Reading', 'https://www.darkreading.com/rss.xml', 3, { country: 'US', topic: 'technology' }),
  feed('HWSW', 'https://www.hwsw.hu/xml/latest_news_rss.xml', 3, { lang: 'hu', country: 'HU', topic: 'technology' }),
  // Health and medicine (same measurement; the CIDRAP feed has not changed since 2021, Fierce Healthcare's is empty, The Lancet is weekly)
  feed('STAT', 'https://www.statnews.com/feed/', 2, { country: 'US', topic: 'health' }),
  feed('KFF Health News', 'https://kffhealthnews.org/feed/', 2, { country: 'US', topic: 'health' }),
  feed('Health Policy Watch', 'https://healthpolicy-watch.news/feed/', 3, { country: 'CH', topic: 'health' }),
  feed('Medical Xpress', 'https://medicalxpress.com/rss-feed/', 3, { topic: 'health' }),
  feed('MedPage Today', 'https://www.medpagetoday.com/rss/headlines.xml', 3, { country: 'US', topic: 'health' }),
  // Politics and policy (same measurement; Euractiv and Lawfare answer 403)
  feed('Politico', 'https://rss.politico.com/politics-news.xml', 2, { country: 'US', topic: 'politics' }),
  feed('Politico Europe', 'https://www.politico.eu/feed/', 2, { country: 'BE', topic: 'politics' }),
  feed('The Hill', 'https://thehill.com/news/feed/', 2, { country: 'US', topic: 'politics' }),
  feed('Foreign Affairs', 'https://www.foreignaffairs.com/rss.xml', 3, { country: 'US', topic: 'politics' }),
  feed('Al-Monitor', 'https://www.al-monitor.com/rss', 3, { country: 'US', topic: 'politics' }),
  feed('Just Security', 'https://www.justsecurity.org/feed/', 3, { country: 'US', topic: 'politics' }),
  // Business and markets (same measurement; Yahoo Finance answers 404, Les Echos 403, Nikkei Asia's items carry no date)
  feed('Financial Times', 'https://www.ft.com/rss/home', 2, { country: 'GB', topic: 'economy' }),
  feed('CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html', 2, { country: 'US', topic: 'economy' }),
  feed('MarketWatch', 'https://feeds.marketwatch.com/marketwatch/topstories/', 2, { country: 'US', topic: 'economy' }),
  feed('BBC Business', 'https://feeds.bbci.co.uk/news/business/rss.xml', 2, { country: 'GB', topic: 'economy' }),
  feed('Guardian Business', 'https://www.theguardian.com/business/rss', 2, { country: 'GB', topic: 'economy' }),
  feed('NYT Business', 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', 2, { country: 'US', topic: 'economy' }),
  feed('The Economist', 'https://www.economist.com/business/rss.xml', 2, { country: 'GB', topic: 'economy' }),
  feed('Fortune', 'https://fortune.com/feed/', 3, { country: 'US', topic: 'economy' }),
  feed('Business Insider', 'https://feeds.businessinsider.com/custom/all', 3, { country: 'US', topic: 'economy' }),
  feed('Forbes Business', 'https://www.forbes.com/business/feed/', 3, { country: 'US', topic: 'economy' }),
  feed('Handelsblatt', 'https://www.handelsblatt.com/contentexport/feed/top-themen', 2, { lang: 'de', country: 'DE', topic: 'economy' }),
  feed('Világgazdaság', 'https://www.vg.hu/feed', 2, { lang: 'hu', country: 'HU', topic: 'economy' }),
]);

/** The topics a specialist feed may carry (topics.mjs TOPICS without disaster). */
export const FEED_TOPICS = Object.freeze(['conflict', 'politics', 'technology', 'health', 'economy']);

const BY_SOURCE = new Map(NEWS_FEEDS.map(item => [item.source, item]));

/** The registry entry of a feed, by the source name it is shown under (undefined for an unknown name). */
export const feedBySource = name => BY_SOURCE.get(name);

/** Sources of the "reserve" lists of the selection: one slot each so a busy feed cannot crowd the others out. */
export const HUNGARIAN_SOURCES = Object.freeze(NEWS_FEEDS.filter(item => item.lang === 'hu').map(item => item.source));
export const OFFICIAL_SOURCES = Object.freeze(NEWS_FEEDS.filter(item => item.tier === 1).map(item => item.source));

/** The complete world news catalog covering 191+ countries (539 feeds). */
export const WORLD_FEEDS = Object.freeze(createWorldFeeds(feed));

/** Return feeds published by or focusing on a specific ISO 3166-1 alpha-2 country (e.g. 'FR', 'DE', 'JP', 'HU'). */
export function getFeedsByCountry(countryCode) {
  if (!countryCode) return [];
  const code = countryCode.trim().toUpperCase();
  return WORLD_FEEDS.filter(f => f.country === code);
}

/** Search across the world feed registry by source name, country code or language. */
export function searchWorldFeeds(query) {
  if (!query) return [];
  const q = query.trim().toLowerCase();
  return WORLD_FEEDS.filter(f =>
    f.source.toLowerCase().includes(q) ||
    (f.country && f.country.toLowerCase() === q) ||
    (f.lang && f.lang.toLowerCase() === q)
  );
}
