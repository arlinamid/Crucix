import test from 'node:test';
import assert from 'node:assert/strict';

const swpc = await import('../apis/sources/swpc.mjs').catch(() => ({}));
const ecb = await import('../apis/sources/ecb.mjs').catch(() => ({}));
const met = await import('../apis/sources/met-norway.mjs').catch(() => ({}));
const now = Date.parse('2026-10-01T21:10:00Z');
function parser(fn) { assert.equal(typeof fn, 'function', 'source parser must exist'); return fn; }
const scales = {
  '-1': { DateStamp:'2026-10-01', TimeStamp:'20:00:00', R:{Scale:'5'}, S:{Scale:'5'}, G:{Scale:'5'} },
  '0': { DateStamp:'2026-10-01', TimeStamp:'21:01:00', R:{Scale:'0',Text:'none'}, S:{Scale:'0'}, G:{Scale:'0'} },
  '1': { DateStamp:'2026-10-02', TimeStamp:'00:00:00', R:{Scale:'5'}, S:{Scale:'5'}, G:{Scale:'5'} },
};
const xml = `<gesmes:Envelope xmlns:gesmes="urn:gesmes" xmlns="urn:ecb"><gesmes:subject>Reference rates</gesmes:subject><Cube><Cube time="2026-10-01"><Cube currency="USD" rate="1.1298"/><Cube currency="HUF" rate="367.18"/><Cube currency="GBP" rate="0.85373"/><Cube currency="CHF" rate="0.9437"/><Cube currency="JPY" rate="178.49"/></Cube></Cube></gesmes:Envelope>`;
const location = { label:'Budapest', lat:47.4979, lon:19.0402 };
function forecast(updatedAt = '2026-10-01T19:20:23Z', times = ['2026-10-01T21:00:00Z','2026-10-01T22:00:00Z']) {
  return { type:'Feature', geometry:{type:'Point',coordinates:[19.0402,47.4979,105]}, properties:{
    meta:{updated_at:updatedAt,units:{air_temperature:'celsius',wind_speed:'m/s',precipitation_amount:'mm'}},
    timeseries:times.map(time => ({time,data:{instant:{details:{air_temperature:14.7,wind_speed:2.3}},next_1_hours:{summary:{symbol_code:'clearsky_night'},details:{precipitation_amount:0}}}})),
  } };
}

test('SWPC current normal conditions stay available without fabricating alerts from past or forecast scales', () => {
  const out = parser(swpc.parseSWPC)(scales, {now});
  assert.equal(out.status, 'ok'); assert.equal(out.stale, false);
  assert.equal(out.observedAt, '2026-10-01T21:01:00.000Z');
  assert.equal(out.timestamp, '2026-10-01T21:10:00.000Z');
  assert.equal(out.observations.length, 0);
  assert.deepEqual(Object.values(out.metrics).map(value=>value.scale), [0,0,0]);
  assert.equal(out.raw, undefined);
});

test('SWPC emits only current nonzero official 0..5 scale observations', () => {
  const data = structuredClone(scales); data['0'].G.Scale = '3'; data['0'].R.Scale = '1';
  const out = parser(swpc.parseSWPC)(data, {now});
  assert.deepEqual(out.observations.map(row=>row.providerId).sort(), ['G3','R1']);
  assert.ok(out.observations.every(row=>row.kind === 'space-weather' && row.observedAt === out.observedAt && row.lat == null && row.lon == null));
  assert.equal(out.observations.find(row=>row.providerId === 'G3').severity, 'high');
});

test('SWPC rejects missing, malformed, stale and future provider time and invalid scale values', () => {
  for (const [date,time] of [[null,'21:00:00'],['2026-02-30','21:00:00'],['2026-10-01','19:00:00'],['2026-10-02','21:00:00']]) {
    const data = structuredClone(scales); Object.assign(data['0'], {DateStamp:date,TimeStamp:time});
    const out = parser(swpc.parseSWPC)(data,{now});
    assert.notEqual(out.status,'ok'); assert.equal(out.observations.length,0);
    assert.deepEqual(out.metrics, {});
  }
  const data = structuredClone(scales); data['0'].S.Scale = '6';
  assert.equal(parser(swpc.parseSWPC)(data,{now}).status, 'error');
  // 2.51.1: one scale briefly empty (null) leaves only that scale out; all of them empty is an error.
  const partial = structuredClone(scales); partial['0'].S.Scale = null;
  const kept = parser(swpc.parseSWPC)(partial,{now});
  assert.equal(kept.status, 'ok'); assert.equal(kept.metrics.solarRadiationStorms, undefined); assert.ok(kept.metrics.geomagneticStorms);
  const empty = structuredClone(scales); for (const code of ['R','S','G']) empty['0'][code].Scale = null;
  assert.equal(parser(swpc.parseSWPC)(empty,{now}).status, 'error');
  assert.equal(parser(swpc.parseSWPC)({'1':scales['1']},{now}).status, 'error');
});

test('ECB parses namespace XML into daily EUR reference rates with provider date and original quote units', () => {
  const out = parser(ecb.parseECB)(xml,{now});
  assert.equal(out.status,'ok'); assert.equal(out.baseCurrency,'EUR');
  assert.equal(out.observedAt,'2026-10-01T00:00:00.000Z');
  assert.equal(out.providerDate,'2026-10-01'); assert.equal(out.datePrecision,'day');
  assert.deepEqual(out.observations.map(row=>row.currency), ['HUF','USD','GBP','CHF']);
  const huf = out.observations[0];
  assert.equal(huf.rate,367.18); assert.equal(huf.title,'EUR/HUF reference rate');
  assert.equal(huf.kind,'economic'); assert.equal(huf.observedAt,out.observedAt);
  assert.equal(huf.rateType,'daily-reference'); assert.match(huf.summary,/1 EUR = 367\.18 HUF/);
  assert.match(out.usageNote,/information|reference/i); assert.match(out.usageNote,/transaction/i);
});

test('ECB weekend collection preserves Friday provider time and rejects rates after its 120-hour freshness window', () => {
  const friday = xml.replace('2026-10-01','2026-10-02');
  const weekend = parser(ecb.parseECB)(friday,{now:Date.parse('2026-10-04T20:00:00Z')});
  assert.equal(weekend.status,'ok'); assert.equal(weekend.observedAt,'2026-10-02T00:00:00.000Z');
  const old = parser(ecb.parseECB)(friday,{now:Date.parse('2026-10-07T00:00:01Z')});
  assert.equal(old.status,'stale'); assert.equal(old.observations.length,0); assert.deepEqual(old.rates,{});
});

test('ECB only accepts bounded known three-letter currency choices and positive finite rates', () => {
  const selected = parser(ecb.parseECB)(xml,{now,currencies:['JPY','HUF','JPY']});
  assert.deepEqual(selected.observations.map(row=>row.currency),['JPY','HUF']);
  for (const currencies of [['http://evil.test'],['ZZZ'],Array.from({length:40},()=> 'USD'), 'USD']) {
    assert.equal(parser(ecb.parseECB)(xml,{now,currencies}).status,'error');
  }
  const invalidRates = xml.replace('rate="367.18"','rate="-367.18"').replace('rate="1.1298"','rate="Infinity"');
  const out = parser(ecb.parseECB)(invalidRates,{now});
  assert.deepEqual(out.observations.map(row=>row.currency),['GBP','CHF']);
  assert.equal(out.rejectedRates,2);
});

test('ECB rejects unsafe, malformed XML and unknown, old or future provider date', () => {
  for (const value of ['<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///x">]><x/>','<bad>',xml.replace('2026-10-01',''),xml.replace('2026-10-01','2026-10-02'),xml.replace('2026-10-01','2026-09-01')]) {
    const out = parser(ecb.parseECB)(value,{now});
    assert.notEqual(out.status,'ok'); assert.equal(out.observations.length,0);
  }
});

test('MET forecasts keep model issue time distinct from the forecast target and original weather units', () => {
  const out = parser(met.parseMetForecast)(forecast(),{now,location});
  assert.equal(out.status,'ok'); assert.equal(out.observedAt,'2026-10-01T19:20:23.000Z');
  const row = out.observations[0];
  assert.equal(row.kind,'forecast'); assert.equal(row.forecastAt,'2026-10-01T21:00:00.000Z');
  assert.equal(row.observedAt,out.observedAt); assert.equal(row.publishedAt,out.observedAt);
  assert.equal(row.validUntil,'2026-10-01T22:00:00.000Z');
  assert.equal(row.temperature,14.7); assert.equal(row.windSpeed,2.3); assert.equal(row.precipitation,0);
  assert.deepEqual(row.units,{temperature:'celsius',windSpeed:'m/s',precipitation:'mm'});
  assert.equal(row.locationMethod,'configured-point'); assert.equal(row.locationPrecision,'approximate');
  assert.equal(row.lat,47.4979); assert.equal(row.lon,19.0402);
  assert.match(row.title,/forecast/i); assert.equal(out.license,'CC BY 4.0');
});

test('MET future forecast target is allowed while future model-issued time is refused', () => {
  const upcoming = parser(met.parseMetForecast)(forecast(undefined,['2026-10-01T22:00:00Z']),{now,location});
  assert.equal(upcoming.status,'ok'); assert.equal(upcoming.observations[0].forecastAt,'2026-10-01T22:00:00.000Z');
  for (const updatedAt of [null,'2026-09-30T19:20:23Z','2026-10-01T22:00:00Z']) {
    const out = parser(met.parseMetForecast)(forecast(updatedAt),{now,location});
    assert.notEqual(out.status,'ok'); assert.equal(out.observations.length,0); assert.deepEqual(out.forecasts,[]);
  }
});

test('MET skips expired target periods, distant forecasts and invalid numeric metrics', () => {
  const distant = parser(met.parseMetForecast)(forecast(undefined,['2026-10-01T19:00:00Z','2026-10-02T21:00:00Z']),{now,location});
  assert.equal(distant.observations.length,0); assert.equal(distant.forecasts.length,0);
  const invalid = forecast(); invalid.properties.timeseries[0].data.instant.details.air_temperature = '14.7';
  const out = parser(met.parseMetForecast)(invalid,{now,location});
  assert.equal(out.observations[0].temperature,null);
});

test('MET bounds configured locations and rejects coercible, invalid or unrestricted coordinates', () => {
  assert.deepEqual(parser(met.normalizeLocations)(),[location]);
  const good = parser(met.normalizeLocations)([{label:'A',lat:47.123456,lon:-19.123456}]);
  assert.equal(good[0].lat,47.1234); assert.equal(good[0].lon,-19.1234);
  for (const locations of [[{label:'X',lat:'47',lon:19}], [{label:'X',lat:91,lon:19}], [{label:'X',lat:NaN,lon:19}], [{label:'',lat:47,lon:19}],Array.from({length:6},()=>location)]) {
    assert.throws(()=>parser(met.normalizeLocations)(locations));
  }
});

test('source briefing requests are fixed official endpoints, use the required MET identification and surface HTTP failure', async t => {
  parser(swpc.briefing); parser(ecb.briefing); parser(met.briefing);
  const seen = [];
  t.mock.method(globalThis,'fetch',async (url,options)=> {
    seen.push({url:String(url),headers:options.headers});
    if (String(url).includes('noaa-scales.json')) return Response.json(scales);
    if (String(url).includes('eurofxref-daily.xml')) return new Response(xml);
    return Response.json(forecast());
  });
  assert.equal((await swpc.briefing({now,url:'http://evil.test'})).status,'ok');
  assert.equal((await ecb.briefing({now,url:'http://evil.test'})).status,'ok');
  assert.equal((await met.briefing({now,url:'http://evil.test'})).status,'ok');
  assert.deepEqual(seen.map(item=>new URL(item.url).hostname),['services.swpc.noaa.gov','www.ecb.europa.eu','api.met.no']);
  assert.equal(seen[2].headers['User-Agent'],'Crucix/2.7 (https://github.com/mp3pintyo/Crucix)');
  t.mock.method(globalThis,'fetch',async ()=>new Response('not used',{status:404}));
  assert.equal((await swpc.briefing({now})).status,'error');
  assert.equal((await ecb.briefing({now})).status,'error');
});

test('all three source requests refuse bodies larger than 2 MiB', async t => {
  parser(swpc.briefing); parser(ecb.briefing); parser(met.briefing);
  t.mock.method(globalThis,'fetch',async ()=>new Response('x'.repeat(2*1024*1024+1)));
  const freshMet = await import('../apis/sources/met-norway.mjs?oversized-test');
  for (const fn of [swpc.briefing,ecb.briefing,freshMet.briefing]) {
    const out = await fn({now}); assert.equal(out.status,'error'); assert.match(out.error,/limit|exceed/i);
    assert.equal(out.observations.length,0);
  }
});

test('MET reuses a fresh one-hour cache, refreshes after expiry and never falls back to stale forecast data', async t => {
  parser(met.briefing);
  const isolated = await import('../apis/sources/met-norway.mjs?cache-test');
  let calls = 0;
  t.mock.method(globalThis,'fetch',async ()=> { calls++; return Response.json(forecast()); });
  const first = await isolated.briefing({now});
  const reused = await isolated.briefing({now:now+600000});
  assert.equal(first.status,'ok'); assert.equal(reused.status,'ok'); assert.equal(calls,1);
  assert.equal(reused.timestamp,'2026-10-01T21:20:00.000Z');
  t.mock.method(globalThis,'fetch',async ()=> { calls++; return new Response('',{status:503}); });
  const expired = await isolated.briefing({now:now+3600001});
  assert.equal(expired.status,'error'); assert.equal(expired.observations.length,0); assert.equal(calls,2);
  const stale = await isolated.briefing({now:now+9*3600000});
  assert.equal(stale.status,'error'); assert.equal(stale.observations.length,0);
});

test('MET refuses cached data once the model crosses eight hours even inside the one-hour cache lifetime', async t => {
  const isolated = await import('../apis/sources/met-norway.mjs?model-age-cache-test');
  t.mock.method(globalThis,'fetch',async ()=>Response.json(forecast('2026-10-01T13:20:00Z')));
  assert.equal((await isolated.briefing({now})).status,'ok');
  t.mock.method(globalThis,'fetch',async ()=>new Response('',{status:403}));
  const aged = await isolated.briefing({now:now+20*60000});
  assert.equal(aged.status,'error'); assert.equal(aged.observations.length,0);
});

test('MET validates locations before requesting and exposes partial failures without using stale models', async t => {
  const isolated = await import('../apis/sources/met-norway.mjs?locations-test');
  let calls = 0;
  t.mock.method(globalThis,'fetch',async url=>{
    calls++;
    return Response.json(forecast(new URL(url).searchParams.get('lat') === '47.4979' ? '2026-10-01T19:20:23Z' : '2026-09-30T19:20:23Z'));
  });
  assert.equal((await isolated.briefing({now,locations:[{label:'Bad',lat:'47',lon:19}]})).status,'error');
  assert.equal(calls,0);
  const out = await isolated.briefing({now,locations:[location,{label:'Vienna',lat:48.2082,lon:16.3738}]});
  assert.equal(out.status,'ok'); assert.equal(out.observations.length,1); assert.equal(out.observations[0].location,'Budapest');
  assert.deepEqual(out.locationStatus.map(row=>row.status),['ok','stale']);
});

test('MET does not duplicate downloads for repeated coordinates with different display labels', async t => {
  const isolated = await import('../apis/sources/met-norway.mjs?duplicate-point-test');
  let calls = 0;
  t.mock.method(globalThis,'fetch',async ()=>{calls++; return Response.json(forecast());});
  const out = await isolated.briefing({now,locations:[location,{...location,label:'City center'}]});
  assert.equal(out.status,'ok'); assert.equal(calls,1);
  assert.deepEqual(out.observations.map(row=>row.location),['Budapest','City center']);
});

test('MET caller changes to returned observations cannot poison the bounded forecast cache', async t => {
  const isolated = await import('../apis/sources/met-norway.mjs?immutable-cache-test');
  t.mock.method(globalThis,'fetch',async ()=>Response.json(forecast()));
  const first = await isolated.briefing({now});
  first.observations[0].temperature = 1000; first.observations[0].units.temperature = 'injected';
  const next = await isolated.briefing({now:now+60000});
  assert.equal(next.observations[0].temperature,14.7); assert.equal(next.observations[0].units.temperature,'celsius');
});
