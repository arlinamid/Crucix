import { readBoundedText } from '../utils/fetch.mjs';
// ACLED — Armed Conflict Location & Event Data
// Auth is separate from data access:
//   1. Bearer from ACLED_ACCESS_TOKEN (optional bootstrap)
//   2. Cached access/refresh tokens (profile cache)
//   3. OAuth refresh_token grant (avoids re-sending password)
//   4. OAuth password grant (email + password + scope=authenticated)
//   5. Cookie login only when OAuth fails for a non-Cloudflare reason
// Cloudflare HTML challenges on /oauth/token are auth_blocked: no cookie
// fallback and a cooldown (no aggressive retries). A JSON 403 on the data
// API is permission_denied (consent / profile / API group), not Cloudflare.
// Set ACLED_EMAIL + ACLED_PASSWORD, and optionally ACLED_ACCESS_TOKEN /
// ACLED_REFRESH_TOKEN. Data: GET https://acleddata.com/api/acled/read

import { createHash } from 'node:crypto';
import { daysAgo } from '../utils/fetch.mjs';
import { readQuota, writeQuota, clearQuota } from '../utils/quota-cache.mjs';
import '../utils/env.mjs';

const LOGIN_URL = 'https://acleddata.com/user/login?_format=json';
const TOKEN_URL = 'https://acleddata.com/oauth/token';
const API_BASE  = 'https://acleddata.com/api/acled/read';
const AUTH_CACHE = 'acled-auth';
const BRIEFING_CACHE = 'acled';
const DENIED_CACHE = 'acled-denied';
// The ACLED_ACCESS_TOKEN of .env lives ~24 hours. Once the API rejects it (HTTP 401) it is remembered here by its hash and skipped,
// so the refresh token and the password grant take over; before 2.51.1 an expired one was sent again every sweep, for good.
const REJECTED_ENV_CACHE = 'acled-env-rejected';
const tokenHash = token => createHash('sha256').update(token).digest('hex').slice(0, 32);
const DENIED_MS = 24 * 60 * 60 * 1000;

/** @typedef {'auth_blocked'|'permission_denied'|'invalid_grant'|'rate_limited'|'upstream_unavailable'|'no_credentials'} AcledFailureCode */

let sessionCache = { cookies: null, token: null, refreshToken: null, method: null, expires: 0 };
let lastGood = { at: 0, result: null };
let authBlockUntil = 0;
let hydrated = false;
const LAST_GOOD_MS = 6 * 60 * 60 * 1000;
const AUTH_BLOCK_MS = 6 * 60 * 60 * 1000;
const TOKEN_SKEW_MS = 60 * 1000;
const ACLED_HEADERS = {
  // No custom User-Agent: acleddata.com's Cloudflare challenges 'Crucix/2.2' (HTTP 403) while the runtime's default UA passes.
  Accept: 'application/json',
};

function hydrateQuota() {
  if (hydrated) return;
  hydrated = true;
  const saved = readQuota(BRIEFING_CACHE);
  if (Number(saved?.at) > 0 && saved.result) lastGood = { at: saved.at, result: saved.result };
  const auth = readQuota(AUTH_CACHE);
  if (Number(auth?.blockUntil) > Date.now()) authBlockUntil = auth.blockUntil;
  if (auth?.accessToken && Number(auth.expiresAt) > Date.now() + TOKEN_SKEW_MS) {
    sessionCache = {
      cookies: null,
      token: auth.accessToken,
      refreshToken: auth.refreshToken || null,
      method: 'oauth',
      expires: auth.expiresAt,
    };
  } else if (auth?.refreshToken) {
    sessionCache = {
      cookies: null,
      token: null,
      refreshToken: auth.refreshToken,
      method: null,
      expires: 0,
    };
  }
}

function persistAuth({ accessToken = null, refreshToken = null, expiresAt = 0, blockUntil = authBlockUntil } = {}) {
  const prev = readQuota(AUTH_CACHE) || {};
  writeQuota(AUTH_CACHE, {
    accessToken: accessToken ?? prev.accessToken ?? null,
    refreshToken: refreshToken ?? prev.refreshToken ?? null,
    expiresAt: expiresAt || prev.expiresAt || 0,
    blockUntil: blockUntil || 0,
  });
}

function clearAuthSession({ clearDiskTokens = false } = {}) {
  sessionCache = { cookies: null, token: null, refreshToken: clearDiskTokens ? null : sessionCache.refreshToken, method: null, expires: 0 };
  if (clearDiskTokens) clearQuota(AUTH_CACHE);
}

export function resetState({ disk = true } = {}) {
  sessionCache = { cookies: null, token: null, refreshToken: null, method: null, expires: 0 };
  lastGood = { at: 0, result: null };
  authBlockUntil = 0;
  hydrated = false;
  if (disk) {
    clearQuota(BRIEFING_CACHE);
    clearQuota(AUTH_CACHE);
    clearQuota(DENIED_CACHE);
    clearQuota(REJECTED_ENV_CACHE);
  }
}

// ACLED's API needs an institutional affiliation; a private person's myACLED account is on the Open tier (no API), so
// the data call answers 403 for good. The source then reports itself disabled and does not ask again for a day.
function deniedPayload(now, detail) {
  return {
    source: 'ACLED',
    timestamp: new Date(now).toISOString(),
    status: 'disabled',
    code: 'permission_denied',
    message: `permission_denied: this ACLED account has no API access (the API is for institutional accounts; the Open tier has none). Optional source, skipped.${detail ? ` [${detail}]` : ''}`,
  };
}

function isChallengeHtml(text) {
  return /just a moment|cf-browser-verification|attention required/i.test(text || '');
}

/**
 * Separate Cloudflare WAF challenges from ACLED account/API JSON errors.
 * Never logs tokens, passwords, or full HTML bodies.
 */
export function classifyHttpFailure(status, headers, text, { phase = 'auth' } = {}) {
  const contentType = String(headers?.get?.('content-type') || headers?.['content-type'] || '');
  const challenge = String(headers?.get?.('cf-mitigated') || headers?.['cf-mitigated'] || '');
  const ray = String(headers?.get?.('cf-ray') || headers?.['cf-ray'] || '') || null;
  const body = String(text || '');
  const isJson = contentType.includes('application/json');

  if (status === 403 && (challenge === 'challenge' || isChallengeHtml(body))) {
    /** @type {AcledFailureCode} */
    const code = 'auth_blocked';
    return {
      code,
      blocked: true,
      ray,
      error: phase === 'data'
        ? `Cloudflare challenge on ACLED data API (HTTP 403${ray ? `, cf-ray ${ray}` : ''})`
        : `Cloudflare challenge (HTTP 403); ACLED is blocking scripted login${ray ? ` [cf-ray ${ray}]` : ''}`,
    };
  }

  let detail = '';
  let parsed = null;
  if (isJson) {
    try {
      parsed = JSON.parse(body);
      detail = parsed.error_description || parsed.error || parsed.message || '';
    } catch { /* ignore */ }
  }

  const lower = String(detail).toLowerCase();
  if (status === 400 && (parsed?.error === 'invalid_grant' || /invalid_grant|credentials were incorrect/i.test(detail))) {
    return { code: /** @type {AcledFailureCode} */ ('invalid_grant'), blocked: false, ray, error: `invalid_grant${detail ? `: ${String(detail).slice(0, 160)}` : ''}` };
  }
  if (status === 429 || /rate.?limit/i.test(detail)) {
    return { code: /** @type {AcledFailureCode} */ ('rate_limited'), blocked: false, ray, error: `rate_limited${detail ? `: ${String(detail).slice(0, 160)}` : ` (HTTP ${status})`}` };
  }
  if (status === 403 || /consent must be accepted|access denied|terms of use|api access/i.test(lower)) {
    const hint = phase === 'data'
      ? '\n→ Fix: Log in at https://acleddata.com/user/login, then:\n'
        + '  1. Accept Terms of Use (profile → Terms of Use)\n'
        + '  2. Complete required profile fields\n'
        + '  3. Confirm the account has API access (contact access@acleddata.com if needed)'
      : '';
    return {
      code: /** @type {AcledFailureCode} */ ('permission_denied'),
      blocked: false,
      ray,
      error: `permission_denied (HTTP ${status}${detail ? `: ${String(detail).slice(0, 160)}` : ''})${hint}`,
    };
  }
  if (status >= 500 || status === 0) {
    return { code: /** @type {AcledFailureCode} */ ('upstream_unavailable'), blocked: false, ray, error: `upstream_unavailable (HTTP ${status}${detail ? `: ${String(detail).slice(0, 120)}` : ''})` };
  }
  return {
    code: /** @type {AcledFailureCode} */ ('upstream_unavailable'),
    blocked: false,
    ray,
    error: `HTTP ${status}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`,
  };
}

function rememberTokens(data) {
  const expiresInSec = Number(data.expires_in) > 0 ? Number(data.expires_in) : 24 * 60 * 60;
  const expiresAt = Date.now() + expiresInSec * 1000;
  sessionCache = {
    cookies: null,
    token: data.access_token,
    refreshToken: data.refresh_token || sessionCache.refreshToken || process.env.ACLED_REFRESH_TOKEN || null,
    method: 'oauth',
    expires: expiresAt,
  };
  persistAuth({
    accessToken: data.access_token,
    refreshToken: sessionCache.refreshToken,
    expiresAt,
    blockUntil: 0,
  });
  authBlockUntil = 0;
  return sessionCache;
}

function markAuthBlocked(failure) {
  authBlockUntil = Date.now() + AUTH_BLOCK_MS;
  persistAuth({ blockUntil: authBlockUntil });
  return { error: failure.error, code: failure.code, blocked: true, ray: failure.ray || null };
}

async function requestToken(params) {
  const signal = AbortSignal.timeout(15000);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { ...ACLED_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal,
  });
  const text = await readBoundedText(res, 64 * 1024);
  if (!res.ok) {
    return { failure: classifyHttpFailure(res.status, res.headers, text, { phase: 'auth' }) };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { failure: { code: 'upstream_unavailable', error: 'OAuth response was not JSON', blocked: false } };
  }
  if (!data.access_token) {
    return { failure: { code: 'upstream_unavailable', error: 'OAuth response missing access_token', blocked: false } };
  }
  return { data };
}

async function loginOAuthPassword(email, password) {
  try {
    const result = await requestToken({
      username: email,
      password,
      grant_type: 'password',
      client_id: 'acled',
      scope: 'authenticated',
    });
    if (result.failure) {
      if (result.failure.blocked) return markAuthBlocked(result.failure);
      return { error: result.failure.error, code: result.failure.code, blocked: false };
    }
    return rememberTokens(result.data);
  } catch (e) {
    const cause = e.cause ? ` → ${e.cause.message || e.cause.code || e.cause}` : '';
    return { error: `OAuth error: ${e.message}${cause}`, code: 'upstream_unavailable' };
  }
}

async function loginOAuthRefresh(refreshToken) {
  try {
    const result = await requestToken({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      client_id: 'acled',
    });
    if (result.failure) {
      if (result.failure.blocked) return markAuthBlocked(result.failure);
      if (result.failure.code === 'invalid_grant') {
        clearAuthSession({ clearDiskTokens: true });
      }
      return { error: result.failure.error, code: result.failure.code, blocked: false };
    }
    return rememberTokens(result.data);
  } catch (e) {
    const cause = e.cause ? ` → ${e.cause.message || e.cause.code || e.cause}` : '';
    return { error: `OAuth refresh error: ${e.message}${cause}`, code: 'upstream_unavailable' };
  }
}

async function loginCookie(email, password) {
  const signal = AbortSignal.timeout(15000);
  try {
    const res = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: { ...ACLED_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: email, pass: password }),
      redirect: 'manual',
      signal,
    });

    const text = await readBoundedText(res, 64 * 1024);
    const redirected = res.status >= 300 && res.status < 400;
    const setCookies = res.headers.getSetCookie?.() || [];
    const cookieStr = setCookies.map(c => c.split(';')[0]).join('; ');

    if ((res.ok || redirected) && cookieStr) {
      return { cookies: cookieStr, method: 'cookie', expires: Date.now() + 12 * 60 * 60 * 1000 };
    }

    const failure = classifyHttpFailure(res.status, res.headers, text, { phase: 'auth' });
    if (failure.blocked) return markAuthBlocked(failure);
    return {
      error: failure.error || `Cookie login failed (HTTP ${res.status})`,
      code: failure.code || 'upstream_unavailable',
    };
  } catch (e) {
    const cause = e.cause ? ` → ${e.cause.message || e.cause.code || e.cause}` : '';
    return { error: `Cookie login error: ${e.message}${cause}`, code: 'upstream_unavailable' };
  }
}

function envBearerSession() {
  const token = process.env.ACLED_ACCESS_TOKEN?.trim();
  if (!token || readQuota(REJECTED_ENV_CACHE)?.hash === tokenHash(token)) return null;
  return {
    fromEnv: true,
    cookies: null,
    token,
    refreshToken: process.env.ACLED_REFRESH_TOKEN?.trim() || sessionCache.refreshToken || null,
    method: 'oauth',
    expires: Date.now() + 23 * 60 * 60 * 1000,
  };
}

async function authenticate() {
  hydrateQuota();
  const email = process.env.ACLED_EMAIL;
  const password = process.env.ACLED_PASSWORD;
  const envRefresh = process.env.ACLED_REFRESH_TOKEN?.trim() || null;
  const debug = process.argv.includes('--debug');

  if (sessionCache.method && sessionCache.token && Date.now() < sessionCache.expires - TOKEN_SKEW_MS) {
    return sessionCache;
  }

  const bearer = envBearerSession();
  if (bearer) {
    sessionCache = bearer;
    if (debug) console.error('[ACLED DEBUG] Using ACLED_ACCESS_TOKEN from environment');
    return sessionCache;
  }

  const refreshToken = sessionCache.refreshToken || envRefresh || readQuota(AUTH_CACHE)?.refreshToken || null;
  if (refreshToken) {
    if (debug) console.error('[ACLED DEBUG] Refreshing OAuth access token');
    const refreshed = await loginOAuthRefresh(refreshToken);
    if (refreshed.token) return refreshed;
    if (refreshed.blocked) {
      return { error: formatAuthFailure([`Refresh: ${refreshed.error}`], refreshed.code), code: refreshed.code };
    }
    if (debug) console.error(`[ACLED DEBUG] Refresh failed: ${refreshed.error}`);
  }

  if (!email || !password) {
    return {
      error: 'No ACLED credentials. Set ACLED_EMAIL and ACLED_PASSWORD (or ACLED_ACCESS_TOKEN) in .env.',
      code: 'no_credentials',
    };
  }

  if (Date.now() < authBlockUntil) {
    const until = new Date(authBlockUntil).toISOString();
    return {
      error: `Cloudflare challenge (HTTP 403); ACLED is blocking scripted login (retry after ${until})`,
      code: 'auth_blocked',
    };
  }

  const errors = [];
  const oauthResult = await loginOAuthPassword(email, password);
  if (oauthResult.token) {
    if (debug) console.error('[ACLED DEBUG] OAuth password grant succeeded');
    return oauthResult;
  }
  errors.push(`OAuth: ${oauthResult.error}`);
  if (debug) console.error(`[ACLED DEBUG] OAuth failed: ${oauthResult.error}`);
  if (oauthResult.blocked || oauthResult.code === 'auth_blocked') {
    return { error: formatAuthFailure(errors, 'auth_blocked'), code: 'auth_blocked' };
  }

  const cookieResult = await loginCookie(email, password);
  if (cookieResult.cookies) {
    if (debug) console.error('[ACLED DEBUG] Cookie authentication succeeded');
    sessionCache = {
      cookies: cookieResult.cookies,
      token: null,
      refreshToken: sessionCache.refreshToken,
      method: 'cookie',
      expires: cookieResult.expires,
    };
    return sessionCache;
  }
  errors.push(`Cookie: ${cookieResult.error}`);
  if (cookieResult.blocked || cookieResult.code === 'auth_blocked') {
    return { error: formatAuthFailure(errors, 'auth_blocked'), code: 'auth_blocked' };
  }

  return {
    error: formatAuthFailure(errors, cookieResult.code || oauthResult.code || 'upstream_unavailable'),
    code: cookieResult.code || oauthResult.code || 'upstream_unavailable',
  };
}

function formatAuthFailure(errors, code) {
  return `All ACLED auth methods failed${code ? ` [${code}]` : ''}.\n${errors.join('\n')}`;
}

function authHeaders(session) {
  const headers = { ...ACLED_HEADERS, 'Content-Type': 'application/json' };
  if (session.method === 'cookie' && session.cookies) {
    headers.Cookie = session.cookies;
  } else if (session.token) {
    headers.Authorization = `Bearer ${session.token}`;
  }
  return headers;
}

export const EVENT_TYPES = [
  'Battles',
  'Explosions/Remote violence',
  'Violence against civilians',
  'Protests',
  'Riots',
  'Strategic developments',
];

export async function getEvents(opts = {}, { retried = false } = {}) {
  const {
    limit = 500,
    eventDateStart,
    eventDateEnd,
    eventType,
    country,
    region,
  } = opts;

  const session = await authenticate();
  if (session.error) return { error: session.error, code: session.code || 'upstream_unavailable' };

  const params = new URLSearchParams({ _format: 'json', limit: String(limit) });
  if (eventDateStart && eventDateEnd) {
    params.set('event_date', `${eventDateStart}|${eventDateEnd}`);
    params.set('event_date_where', 'BETWEEN');
  }
  if (eventType) params.set('event_type', eventType);
  if (country) params.set('country', country);
  if (region) params.set('region', String(region));

  const debug = process.argv.includes('--debug');
  try {
    const url = `${API_BASE}?${params}`;
    const hdrs = authHeaders(session);
    if (debug) {
      console.error(`[ACLED DEBUG] Data request: GET ${url}`);
      console.error(`[ACLED DEBUG] Authentication method: ${session.method}; credential headers redacted`);
    }
    const signal = AbortSignal.timeout(25000);
    const res = await fetch(url, { headers: hdrs, signal });
    const text = await readBoundedText(res, 2 * 1024 * 1024);
    if (debug) console.error(`[ACLED DEBUG] Data response: HTTP ${res.status}`);

    if (!res.ok) {
      const failure = classifyHttpFailure(res.status, res.headers, text, { phase: 'data' });
      // The .env access token has expired: never send it again, and try once more with the refresh token or the password.
      if (res.status === 401 && session.fromEnv && !retried) {
        writeQuota(REJECTED_ENV_CACHE, { hash: tokenHash(session.token), at: Date.now() });
        clearAuthSession();
        if (debug) console.error('[ACLED DEBUG] ACLED_ACCESS_TOKEN rejected (expired); retrying without it');
        return getEvents(opts, { retried: true });
      }
      if (res.status === 401 || failure.code === 'auth_blocked' || failure.code === 'permission_denied') {
        clearAuthSession({ clearDiskTokens: res.status === 401 && !session.fromEnv });
      }
      return { error: failure.error, code: failure.code };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { error: 'ACLED data response was not JSON', code: 'upstream_unavailable' };
    }

    if (data?.status && data.status !== 200) {
      const message = data.message || 'Unknown error';
      const lower = String(message).toLowerCase();
      const code = /consent|access denied|terms/i.test(lower) ? 'permission_denied' : 'upstream_unavailable';
      return { error: `ACLED API error: status ${data.status} — ${message}`, code };
    }

    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      return { error: 'ACLED data request timed out (25s)', code: 'upstream_unavailable' };
    }
    const rootCause = e.cause ? `${e.cause.message || e.cause.code || e.cause}` : '';
    return { error: `ACLED data error: ${e.message}${rootCause ? ' → ' + rootCause : ''}`, code: 'upstream_unavailable' };
  }
}

function groupBy(events, field) {
  const map = {};
  for (const e of events) {
    const key = e[field] || 'Unknown';
    if (!map[key]) map[key] = { count: 0, fatalities: 0 };
    map[key].count += 1;
    map[key].fatalities += parseInt(e.fatalities, 10) || 0;
  }
  return map;
}

function failurePayload(now, error, code) {
  if (lastGood.result && now - lastGood.at < LAST_GOOD_MS) {
    return { ...lastGood.result, stale: true, message: error, code };
  }
  return { source: 'ACLED', timestamp: new Date(now).toISOString(), error, code };
}

export async function briefing({ now = Date.now() } = {}) {
  hydrateQuota();
  const hasPassword = process.env.ACLED_EMAIL && process.env.ACLED_PASSWORD;
  const hasBearer = Boolean(process.env.ACLED_ACCESS_TOKEN?.trim());
  if (!hasPassword && !hasBearer) {
    return {
      source: 'ACLED',
      timestamp: new Date().toISOString(),
      status: 'no_credentials',
      code: 'no_credentials',
      message: 'Set ACLED_EMAIL and ACLED_PASSWORD (or ACLED_ACCESS_TOKEN) in .env. Register at https://acleddata.com/register/',
    };
  }

  const denied = readQuota(DENIED_CACHE);
  if (Number(denied?.until) > now) return deniedPayload(now);

  const start = daysAgo(7);
  const end = daysAgo(0);

  const data = await getEvents({
    eventDateStart: start,
    eventDateEnd: end,
    limit: 2000,
  });

  if (data?.code === 'permission_denied') {
    writeQuota(DENIED_CACHE, { until: now + DENIED_MS });
    return deniedPayload(now, String(data.error || '').split('\n')[0]);
  }
  if (data?.error) {
    return failurePayload(now, data.error, data.code || 'upstream_unavailable');
  }

  let events = data?.data || [];

  events = events.map(e => ({
    ...e,
    lat: parseFloat(e.latitude) || null,
    lon: parseFloat(e.longitude) || null,
  }));

  const totalFatalities = events.reduce(
    (sum, e) => sum + (parseInt(e.fatalities, 10) || 0), 0
  );

  const byRegion = groupBy(events, 'region');
  const byType = groupBy(events, 'event_type');
  const byCountry = groupBy(events, 'country');

  const topCountries = Object.entries(byCountry)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .reduce((obj, [k, v]) => { obj[k] = v; return obj; }, {});

  const deadliestEvents = events
    .filter(e => parseInt(e.fatalities, 10) > 0)
    .sort((a, b) => (parseInt(b.fatalities, 10) || 0) - (parseInt(a.fatalities, 10) || 0))
    .slice(0, 15)
    .map(e => ({
      id: e.event_id_cnty || e.event_id_no_cnty || null,
      date: e.event_date,
      type: e.event_type,
      subType: e.sub_event_type,
      country: e.country,
      location: e.location,
      fatalities: parseInt(e.fatalities, 10) || 0,
      lat: Number.isFinite(parseFloat(e.latitude)) ? parseFloat(e.latitude) : null,
      lon: Number.isFinite(parseFloat(e.longitude)) ? parseFloat(e.longitude) : null,
      locationMethod: 'provider',
      locationPrecision: String(e.geo_precision) === '1' ? 'exact' : e.geo_precision ? 'approximate' : 'unknown',
      notes: e.notes?.slice(0, 200),
    }));

  const result = {
    source: 'ACLED',
    timestamp: new Date(now).toISOString(),
    period: { start, end },
    totalEvents: events.length,
    totalFatalities,
    byRegion,
    byType,
    topCountries,
    deadliestEvents,
  };
  lastGood = { at: now, result };
  writeQuota(BRIEFING_CACHE, lastGood);
  return result;
}

if (process.argv[1]?.endsWith('acled.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
