import test from 'node:test';
import assert from 'node:assert/strict';
import { countriesInText, countryByName } from '../lib/intelligence/countries.mjs';
import { resolveEventCountries } from '../lib/intelligence/entities.mjs';

test('countriesInText: local names of the world-RSS languages name their country', () => {
  assert.deepEqual(countriesInText('Magyarország és Szlovákia között'), ['HUN', 'SVK']);
  assert.deepEqual(countriesInText('La Russie et la Chine signent un accord'), ['RUS', 'CHN']);
  assert.deepEqual(countriesInText('Brasil e Argentina'), ['BRA', 'ARG']);
  assert.deepEqual(countriesInText('Россия и Китай'), ['RUS', 'CHN']);
  assert.deepEqual(countriesInText('السودان وروسيا وبالصين'), ['SDN', 'RUS', 'CHN'], 'Arabic, with a joined conjunction or preposition');
  assert.equal(countryByName('Oroszország')?.iso3, 'RUS');
});

test('countriesInText: Hungarian cases and the German genitive', () => {
  assert.deepEqual(countriesInText('Oroszországban újabb támadás történt'), ['RUS']);
  assert.deepEqual(countriesInText('Ukrajnából jött hír, Iránnal tárgyal Izraellel'), ['UKR', 'IRN', 'ISR']);
  assert.deepEqual(countriesInText('Az Egyesült Államokban választás lesz'), ['USA'], 'the last word of a longer name');
  assert.deepEqual(countriesInText('Oroszországi gázszállítás'), ['RUS']);
  assert.deepEqual(countriesInText('Russlands Armee greift an'), ['RUS']);
});

test('countriesInText: local names that are a word or a name elsewhere stay out', () => {
  for (const text of ['Maurice wins in Granada', 'Grenade attack reported', 'Columbia University protest', 'Chili prices soar',
    'Gana el Real Madrid', 'Kuban region fire', 'Indian Ocean cyclone', 'Chad Smith visits Indiana', 'Chinatown parade']) {
    assert.deepEqual(countriesInText(text), [], text);
  }
  assert.deepEqual(countriesInText('RYUKYU ISLANDS, JAPAN'), ['JPN'], 'the German "Island" (Iceland) never matches "Islands"');
  assert.deepEqual(countriesInText('British Indian Ocean Territory'), ['IOT']);
  assert.deepEqual(countriesInText('Tschad und Kongo'), ['TCD'], 'Kongo is shared by two countries, ambiguous like Congo');
});

test('countriesInText: a label in capitals keeps its country codes', () => {
  assert.deepEqual(countriesInText('US STRIKES IRAN'), ['USA', 'IRN']);
  assert.deepEqual(countriesInText('UAE AND UK SIGN DEAL'), ['ARE', 'GBR']);
  assert.deepEqual(countriesInText('ST. LUCIA STORM'), ['LCA']);
  assert.deepEqual(countriesInText('NEAR COAST OF PERU'), ['PER']);
});

test('resolveEventCountries: a Hungarian news headline is a mention of its country', () => {
  const event = { id: 'event-1', kind: 'news', title: 'Oroszországban drónok csapódtak be', summary: '', location: {} };
  assert.deepEqual(resolveEventCountries(event), { c: ['RUS'], m: 'm' });
});
