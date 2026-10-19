import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChart, collect as collectYahoo, YAHOO_SYMBOLS } from '../apis/sources/yfinance.mjs';
import { briefing as fmp, createFmpState, normalizeFmpQuote, FMP_SYMBOLS } from '../apis/sources/fmp.mjs';
import { briefing as finnhub, normalizeFinnhubQuote } from '../apis/sources/finnhub.mjs';
import { buildFx, crossesFor, mergeUsdPer, pairDecimals, parseBaseCurrency, usdPerFromEcb, usdPerFromFmp, usdPerFromYahoo, SUPPORTED_CURRENCIES } from '../lib/markets/fx.mjs';
import { buildMarkets, mergeQuote } from '../lib/markets/build.mjs';

const NOW = Date.parse('2026-10-11T09:00:00Z');
const day = n => Date.parse(`2026-10-0${n}T20:00:00Z`) / 1000;
const chart = (closes, meta = {}) => ({ chart: { result: [{ meta: { currency: 'USD', ...meta }, timestamp: closes.map((_, i) => day(5 + i)), indicators: { quote: [{ close: closes }] } }] } });

test('Yahoo: the day change is against the previous daily bar, not the close before the five-day window', () => {
  const q = parseChart('SHEL', chart([96.52, 97.62, 96.85, 100.2, 100.18], { regularMarketPrice: 100.18, chartPreviousClose: 96.23, regularMarketDayLow: 99.5, regularMarketDayHigh: 101, fiftyTwoWeekLow: 70, fiftyTwoWeekHigh: 104, regularMarketVolume: 1234567, regularMarketTime: day(9) }));
  assert.equal(q.prevClose, 100.2);
  assert.equal(q.changePct, -0.02);
  assert.deepEqual([q.dayLow, q.dayHigh, q.yearLow, q.yearHigh, q.volume, q.source], [99.5, 101, 70, 104, 1234567, 'Yahoo']);
  assert.equal(q.history.length, 5);
  const gap = parseChart('SHEL', chart([null, 97, null, 100, null], { regularMarketPrice: 100.5 }));
  assert.equal(gap.prevClose, 97, 'missing bars are skipped');
  const fx = parseChart('EURUSD=X', chart([1.1213, 1.1206], { regularMarketPrice: 1.120634 }));
  assert.equal(fx.price, 1.120634, 'FX keeps its precision');
  assert.equal(parseChart('X', chart([5], { regularMarketPrice: 5, chartPreviousClose: 4 })).prevClose, 4, 'one bar: the provider value');
  assert.match(parseChart('X', { chart: { result: [] } }).error, /no chart data/);
});

test('Yahoo tracks world indexes (BUX as ^BUX.BD), the sector equities and the USD FX pairs, at most 8 at a time', async () => {
  for (const symbol of ['^GDAXI', '^FTSE', '^N225', '^HSI', '^BUX.BD', 'LMT', 'RHM.DE', 'RTX', 'XOM', 'SHEL', 'TTE', 'TSM', 'NVDA', 'ASML', 'EURUSD=X', 'JPY=X', 'HUF=X']) assert.ok(YAHOO_SYMBOLS[symbol], symbol);
  assert.equal(YAHOO_SYMBOLS['^BUX'], undefined);
  let active = 0;
  let peak = 0;
  const data = await collectYahoo({ fetch: async symbol => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return symbol === 'LMT' ? { symbol, error: 'HTTP 500' } : { symbol, name: symbol, price: 10, prevClose: 9, changePct: 11.11 };
  } });
  assert.ok(peak <= 8);
  assert.equal(data.summary.failed, 1);
  assert.deepEqual(data.worldIndexes.map(q => q.symbol).slice(0, 5), ['^GDAXI', '^FTSE', '^N225', '^HSI', '^BUX.BD']);
  for (const symbol of ['^STOXX50E', '^STOXX', '^FCHI', '^GSPTSE', '^KS11']) assert.ok(data.worldIndexes.some(q => q.symbol === symbol), symbol);
  assert.deepEqual(data.sectors.map(q => q.symbol).slice(0, 3), ['XLE', 'XLF', 'XLK']);
  assert.equal(data.fx.length, 8);
  assert.equal(data.equities.length, 9);
});

test('FX: USD-per-unit tables from Yahoo, FMP and ECB agree, and fill each other in that order', () => {
  const yahoo = usdPerFromYahoo({ 'EURUSD=X': { price: 1.12, prevClose: 1.1 }, 'HUF=X': { price: 325, prevClose: 330 }, 'JPY=X': { price: 158 } });
  assert.equal(yahoo.now.EUR, 1.12);
  assert.ok(Math.abs(yahoo.now.HUF - 1 / 325) < 1e-12);
  assert.equal(yahoo.prev.JPY, undefined);
  const ecb = usdPerFromEcb({ USD: 1.12, HUF: 364, GBP: 0.85, CAD: 1.6 });
  assert.ok(Math.abs(ecb.now.HUF - 1.12 / 364) < 1e-12);
  assert.equal(usdPerFromEcb({}).now.EUR, undefined);
  const fmpTable = usdPerFromFmp([{ symbol: 'EURUSD', price: 1.13, previousClose: 1.12 }, { symbol: 'USDJPY', price: 150, change: 1.5 }, { symbol: 'EUR/GBP', price: 0.85 }]);
  assert.equal(fmpTable.now.EUR, 1.13);
  assert.ok(Math.abs(fmpTable.now.JPY - 1 / 150) < 1e-12);
  assert.ok(Math.abs(fmpTable.prev.JPY - 1 / 148.5) < 1e-12);
  const merged = mergeUsdPer({ name: 'FMP', table: fmpTable }, { name: 'Yahoo', table: yahoo }, { name: 'ECB', table: ecb });
  assert.deepEqual(merged.sources, { EUR: 'FMP', JPY: 'FMP', HUF: 'Yahoo', GBP: 'ECB', CAD: 'ECB' });
  assert.equal(merged.now.USD, 1);
});

test('FX crosses follow the market convention for each base, with 2 decimals for HUF/JPY quotes above 10 and 4 otherwise', () => {
  const usdPer = mergeUsdPer({ name: 'Yahoo', table: { now: { USD: 1, EUR: 1.12, GBP: 1.32, CHF: 1 / 0.83, JPY: 1 / 158, CAD: 1 / 1.425, HUF: 1 / 325, AUD: 0.7, CNY: 1 / 6.69 }, prev: { USD: 1, EUR: 1.1 } } });
  assert.deepEqual(crossesFor('EUR', usdPer).map(row => row.pair), ['EUR/USD', 'EUR/GBP', 'EUR/CHF', 'EUR/JPY', 'EUR/CAD']);
  assert.deepEqual(crossesFor('HUF', usdPer).map(row => row.pair), ['EUR/HUF', 'USD/HUF', 'GBP/HUF', 'CHF/HUF', 'JPY/HUF']);
  assert.deepEqual(crossesFor('USD', usdPer).map(row => row.pair), ['EUR/USD', 'GBP/USD', 'USD/CHF', 'USD/JPY', 'USD/CAD']);
  const eurHuf = crossesFor('HUF', usdPer)[0];
  assert.deepEqual([eurHuf.price, eurHuf.decimals], [364, 2]);
  const jpyHuf = crossesFor('HUF', usdPer)[4];
  assert.deepEqual([jpyHuf.price, jpyHuf.decimals], [2.057, 4], 'a small HUF quote keeps four decimals');
  const eurUsd = crossesFor('EUR', usdPer)[0];
  assert.deepEqual([eurUsd.price, eurUsd.decimals, eurUsd.changePct, eurUsd.source], [1.12, 4, 1.82, 'Yahoo']);
  assert.equal(crossesFor('EUR', usdPer)[1].changePct, null, 'no previous GBP close: no change');
  assert.equal(pairDecimals('JPY'), 2);
  assert.equal(parseBaseCurrency('huf'), 'HUF');
  assert.equal(parseBaseCurrency('XAU'), 'USD');
  const block = buildFx(usdPer, { baseCurrency: 'eur' });
  assert.equal(block.baseCurrency, 'EUR');
  assert.deepEqual(Object.keys(block.crosses), SUPPORTED_CURRENCIES);
  assert.deepEqual(block.benchmarks.map(row => row.pair), ['EUR/USD', 'USD/JPY', 'GBP/USD', 'USD/CHF', 'USD/CAD', 'USD/CNY']);
  assert.deepEqual(crossesFor('EUR', mergeUsdPer({ name: 'ECB', table: { now: { USD: 1, EUR: 1.1 } } })).map(row => row.pair), ['EUR/USD'], 'missing rates leave the pair out');
});

test('FMP quotes map both the stable and the legacy v3 field names', () => {
  const stable = normalizeFmpQuote({ symbol: 'LMT', name: 'Lockheed', price: 470.1, changePercentage: 1.2, change: 5.6, dayLow: 460, dayHigh: 472, yearLow: 400, yearHigh: 520, volume: 900000, marketCap: 1.1e11, priceAvg50: 455, priceAvg200: 440, previousClose: 464.5, timestamp: 1791700000 });
  assert.deepEqual([stable.changePct, stable.prevClose, stable.marketCap, stable.source], [1.2, 464.5, 1.1e11, 'FMP']);
  assert.equal(stable.timestamp, new Date(1791700000 * 1000).toISOString());
  const legacy = normalizeFmpQuote({ symbol: 'XOM', price: 110, changesPercentage: -0.5, change: -0.55, avgVolume: 1.5e7 });
  assert.deepEqual([legacy.changePct, legacy.prevClose, legacy.avgVolume], [-0.5, 110.55, 1.5e7]);
  assert.equal(normalizeFmpQuote({ symbol: 'X', price: 0 }), null);
  assert.equal(normalizeFmpQuote({ price: 5 }), null);
});

test('FMP spends two batch calls per sweep, rests a refused endpoint for a day and stops at the daily budget', async () => {
  assert.equal((await fmp({ apiKey: '' })).status, 'no_key');
  const urls = [];
  const ok = async url => { urls.push(url); return url.includes('batch-quote') ? [{ symbol: 'NVDA', price: 180, changePercentage: 2 }] : [{ symbol: 'EURUSD', price: 1.12 }, { symbol: 'BAD', price: 1 }]; };
  const state = createFmpState();
  const first = await fmp({ apiKey: 'k3y', now: NOW, state, fetchImpl: ok });
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes(`symbols=${encodeURIComponent(FMP_SYMBOLS.join(','))}`));
  assert.ok(urls.every(url => url.startsWith('https://financialmodelingprep.com/stable/') && url.includes('apikey=k3y')));
  assert.equal(first.quotes.NVDA.price, 180);
  assert.deepEqual(first.fx.map(row => row.symbol), ['EURUSD']);
  assert.deepEqual(first.endpoints, { quotes: 'ok', forex: 'ok' });
  assert.equal(first.error, undefined);

  const refused = createFmpState();
  let calls = 0;
  const premium = async url => { calls++; return url.includes('batch-quote') ? { error: 'HTTP 402', status: 402 } : [{ symbol: 'EURUSD', price: 1.12 }]; };
  const partial = await fmp({ apiKey: 'k3y', now: NOW, state: refused, fetchImpl: premium });
  assert.equal(partial.endpoints.quotes, 'not available on this FMP plan');
  assert.equal(partial.error, undefined, 'forex still delivers');
  await fmp({ apiKey: 'k3y', now: NOW + 900_000, state: refused, fetchImpl: premium });
  assert.equal(calls, 3, 'the refused endpoint is not called again within the day');
  await fmp({ apiKey: 'k3y', now: NOW + 86_400_001, state: refused, fetchImpl: premium });
  assert.equal(calls, 5);

  // Both batch endpoints refused by the plan (FMP's free plan since October 2026): disabled, not an error, then and while they rest.
  const free = createFmpState();
  const restricted = async () => ({ error: 'HTTP 402', status: 402 });
  const off = await fmp({ apiKey: 'k3y', now: NOW, state: free, fetchImpl: restricted });
  assert.equal(off.status, 'disabled'); assert.equal(off.error, undefined); assert.match(off.message, /Yahoo covers/);
  const resting = await fmp({ apiKey: 'k3y', now: NOW + 900_000, state: free, fetchImpl: restricted });
  assert.equal(resting.status, 'disabled');

  const budget = createFmpState();
  const both = await fmp({ apiKey: 'k3y', now: NOW, state: budget, dailyLimit: 3, fetchImpl: ok });
  const over = await fmp({ apiKey: 'k3y', now: NOW + 1, state: budget, dailyLimit: 3, fetchImpl: ok });
  assert.deepEqual([both.budget.used, over.endpoints.forex, over.budget.used], [2, 'budget', 3]);
  const nextDay = await fmp({ apiKey: 'k3y', now: NOW + 86_400_000, state: budget, dailyLimit: 3, fetchImpl: ok });
  assert.equal(nextDay.budget.used, 2);

  const denied = await fmp({ apiKey: 'k3y', now: NOW, state: createFmpState(), fetchImpl: async () => ({ error: 'HTTP 401', status: 401 }) });
  assert.equal(denied.error, 'invalid API key');
  assert.doesNotMatch(JSON.stringify(denied), /k3y/, 'the key never lands in the source result');
});

test('Finnhub sends the key in a header, drops unknown symbols and reports a refused key', async () => {
  assert.equal((await finnhub({ apiKey: null })).status, 'no_key');
  const seen = [];
  const result = await finnhub({ apiKey: 'tok', symbols: ['LMT', 'NOPE'], fetchImpl: async (url, opts) => {
    seen.push({ url, token: opts.headers['X-Finnhub-Token'] });
    return url.includes('LMT') ? { c: 470, d: 2, dp: 0.43, h: 472, l: 465, o: 468, pc: 468, t: 1791700000 } : { c: 0, d: null, dp: null };
  } });
  assert.ok(seen.every(call => call.token === 'tok' && !call.url.includes('tok')));
  assert.deepEqual(Object.keys(result.quotes), ['LMT']);
  assert.deepEqual(result.missing, ['NOPE']);
  assert.equal(result.quotes.LMT.prevClose, 468);
  assert.equal(normalizeFinnhubQuote('X', { c: 0 }), null);
  const refused = await finnhub({ apiKey: 'tok', symbols: ['LMT'], fetchImpl: async () => ({ error: 'HTTP 401', status: 401 }) });
  assert.match(refused.error, /refused the key \(HTTP 401\)/);
});

test('the markets block takes the freshest quote per symbol, keeps the Yahoo history and builds the FX block', () => {
  const yahooLmt = { symbol: 'LMT', name: 'Lockheed Martin', price: 469, changePct: 0.1, currency: 'USD', timestamp: '2026-10-09T20:00:00Z', source: 'Yahoo', history: [{ date: '2026-10-09', close: 469 }] };
  const fmpLmt = { symbol: 'LMT', name: 'Lockheed Martin Corporation', price: 470, changePct: 0.3, marketCap: 1.1e11, yearHigh: 520, timestamp: '2026-10-09T20:00:00Z', source: 'FMP' };
  const merged = mergeQuote('LMT', [fmpLmt, null, yahooLmt]);
  assert.deepEqual([merged.price, merged.source, merged.marketCap, merged.currency, merged.history.length], [470, 'FMP', 1.1e11, 'USD', 1]);
  const stale = mergeQuote('LMT', [{ ...fmpLmt, timestamp: '2026-10-08T20:00:00Z' }, null, yahooLmt]);
  assert.equal(stale.source, 'Yahoo', 'a fresher Yahoo quote wins over an older FMP one');
  assert.equal(mergeQuote('X', [{ error: 'x' }, { price: -1 }]), null);

  const markets = buildMarkets({
    YFinance: { summary: { timestamp: '2026-10-11T08:45:00Z' }, quotes: { 'EURUSD=X': { price: 1.12, prevClose: 1.1 }, 'HUF=X': { price: 325 }, '^VIX': { price: 18, change: -1, changePct: -5 } },
      indexes: [{ symbol: '^GSPC', name: 'S&P 500', price: 7811, changePct: 0.59, history: [] }], equities: [yahooLmt], worldIndexes: [], crypto: [], rates: [], commodities: [] },
    FMP: { quotes: { LMT: fmpLmt }, fx: [], timestamp: '2026-10-11T08:45:01Z' },
    Finnhub: { disabled: true, status: 'no_key' },
    ECB: { rates: { USD: 1.12, GBP: 0.85 } },
  }, { baseCurrency: 'HUF' });
  assert.equal(markets.equities[0].source, 'FMP');
  assert.equal(markets.equities[0].marketCap, 1.1e11);
  assert.equal(markets.indexes[0].price, 7811);
  assert.equal(markets.fx.baseCurrency, 'HUF');
  assert.deepEqual(markets.fx.crosses.HUF.map(row => row.pair), ['EUR/HUF', 'USD/HUF', 'GBP/HUF']);
  assert.equal(markets.fx.crosses.HUF[0].price, 364);
  assert.equal(markets.fx.sources.GBP, 'ECB');
  assert.deepEqual(markets.providers, { fmp: 'ok', finnhub: 'no_key' });
  assert.deepEqual(markets.vix, { value: 18, change: -1, changePct: -5 });
  assert.equal(buildMarkets({}).fx.benchmarks.length, 0);
});
