// Evidence for outbound bot alerts: each alerted signal becomes one short line with the figures that moved
// and a link to where the reader can check it (the OSINT post itself, or the official page of the metric).

export const TIER_ORDER = Object.freeze(['ROUTINE', 'PRIORITY', 'FLASH']);

const FRED = id => ({ source: 'FRED', url: `https://fred.stlouisfed.org/series/${id}` });
const YAHOO = symbol => ({ source: 'Yahoo Finance', url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}` });

export const SIGNAL_SOURCES = Object.freeze({
  vix: FRED('VIXCLS'),
  hy_spread: FRED('BAMLH0A0HYM2'),
  '10y2y': FRED('T10Y2Y'),
  fed_funds: FRED('DFF'),
  '10y_yield': FRED('DGS10'),
  usd_index: FRED('DTWEXBGS'),
  mortgage: FRED('MORTGAGE30US'),
  wti: YAHOO('CL=F'),
  brent: YAHOO('BZ=F'),
  natgas: YAHOO('NG=F'),
  gold: YAHOO('GC=F'),
  silver: YAHOO('SI=F'),
  unemployment: { source: 'BLS', url: 'https://data.bls.gov/timeseries/LNS14000000' },
  thermal_total: { source: 'NASA FIRMS', url: 'https://firms.modaps.eosdis.nasa.gov/map/' },
  air_total: { source: 'OpenSky', url: 'https://opensky-network.org/' },
  who_alerts: { source: 'WHO', url: 'https://www.who.int/emergencies/disease-outbreak-news' },
  conflict_events: { source: 'ACLED', url: 'https://acleddata.com/' },
  conflict_fatalities: { source: 'ACLED', url: 'https://acleddata.com/' },
  nuke_anomaly: { source: 'Safecast', url: 'https://map.safecast.org/' },
  news_count: { source: 'GDELT', url: 'https://www.gdeltproject.org/' },
});

// Why a metric matters, in one line; the reader sees it under the figures.
const WHY = Object.freeze({
  vix: 'Equity volatility: a jump prices in stress across risk assets.',
  hy_spread: 'Credit stress: wider junk spreads mean tighter financing.',
  '10y2y': 'Yield curve: inversion and re-steepening lead recessions.',
  wti: 'Oil feeds straight into inflation and transport costs.',
  brent: 'The global oil benchmark; supply shocks show here first.',
  natgas: 'Gas sets power and heating prices, above all in Europe.',
  gold: 'Safe-haven demand; a spike often follows geopolitical shocks.',
  usd_index: 'A stronger dollar tightens conditions for emerging markets.',
  thermal_total: 'Satellite heat detections: fires, strikes or industrial events.',
  conflict_events: 'Recorded clashes and attacks on the ground.',
  conflict_fatalities: 'Casualty counts from recorded conflict events.',
  nuke_anomaly: 'Radiation readings above the normal background.',
  urgent_posts: 'More urgent OSINT chatter than in the previous sweep.',
});

const SEVERITY_RANK = { critical: 3, high: 2, moderate: 1 };

/** An http(s) link without credentials, at most 500 characters; anything else is null. */
export function safeLink(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The tier name for an env value, or the fallback for anything unknown. */
export function parseMinTier(value, fallback = 'PRIORITY') {
  const tier = String(value ?? '').trim().toUpperCase();
  return TIER_ORDER.includes(tier) ? tier : fallback;
}

export function tierAtLeast(tier, minTier) {
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(minTier);
}

function oneLine(value, max) {
  const text = String(value ?? '').replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function figure(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '--');
  return Math.abs(value) >= 1000 ? Math.round(value).toLocaleString('en-US') : String(Number(value.toFixed(2)));
}

function evidenceOf(signal) {
  const key = String(signal?.key ?? '');
  if (key.startsWith('tg_urgent:')) {
    const post = signal.item ?? {};
    const channel = oneLine(post.channel, 40);
    return {
      text: `${channel ? `[${channel}] ` : ''}${oneLine(signal.text ?? post.text, 160)}`,
      source: 'Telegram', url: safeLink(post.url), why: WHY.urgent_posts,
    };
  }
  const known = SIGNAL_SOURCES[key] ?? null;
  if (signal && signal.from !== undefined && signal.to !== undefined) {
    const pct = typeof signal.pctChange === 'number' ? ` (${signal.pctChange > 0 ? '+' : ''}${signal.pctChange}%)` : '';
    return {
      text: `${oneLine(signal.label || key, 40)}: ${figure(signal.from)} → ${figure(signal.to)}${pct}`,
      source: known?.source ?? null, url: known?.url ?? null, why: WHY[key] ?? null,
    };
  }
  if (signal?.reason) return { text: oneLine(signal.reason, 160), source: known?.source ?? null, url: known?.url ?? null, why: WHY[key] ?? null };
  return null;
}

/** At most `max` evidence lines for the alerted signals, the most severe first. */
export function evidenceForSignals(signals, { max = 5 } = {}) {
  const list = Array.isArray(signals) ? signals : [];
  const ranked = list
    .map((signal, index) => ({ signal, index, rank: SEVERITY_RANK[signal?.severity] ?? (String(signal?.key).startsWith('tg_urgent:') ? 2 : 0) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index);
  const out = [];
  for (const { signal } of ranked) {
    const line = evidenceOf(signal);
    if (line?.text) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}
