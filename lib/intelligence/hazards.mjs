// The natural and technical phenomena a report and an observation can share: an earthquake, a cyclone, a flood ... named in the title words
// (folded and lower-cased, as extract.mjs tokensOf gives them) in the catalogue's main languages, plus the hazard an observation kind always is.
// A word of at least six letters also matches its inflected or plural forms ("földrengésben", "earthquakes"); a shorter one only exactly.
// Generic words that mean other things too ("fire": gunfire, "fire missiles"; "storm": a storm of criticism; "shutdown") are left out.

const WORDS = Object.freeze({
  quake: ['earthquake', 'quake', 'quakes', 'tremor', 'tremors', 'aftershock', 'seismic', 'sismo', 'sismos', 'terremoto', 'temblor', 'seisme',
    'erdbeben', 'foldrenges', 'deprem', 'zemljotres', 'potres', 'cutremur', 'aardbeving', 'землетрясение', 'землетрясения', 'землетрус', 'زلزال'],
  cyclone: ['cyclone', 'hurricane', 'typhoon', 'tropical', 'ciclon', 'huracan', 'tifon', 'ouragan', 'typhon', 'hurrikan', 'wirbelsturm', 'taifun',
    'tajfun', 'hurrikan', 'ciklon', 'kasirga', 'uragan', 'ураган', 'тайфун', 'циклон', 'إعصار'],
  flood: ['flood', 'floods', 'flooding', 'flooded', 'inundacion', 'inundaciones', 'inondation', 'inondations', 'crue', 'crues', 'hochwasser',
    'uberschwemmung', 'arviz', 'arvizek', 'poplava', 'poplave', 'alluvione', 'enchente', 'inundatii', 'наводнение', 'паводок', 'فيضان', 'فيضانات'],
  volcano: ['volcano', 'volcanic', 'eruption', 'erupts', 'erupted', 'volcan', 'volcanica', 'erupcion', 'vulkan', 'vulkanausbruch', 'vulkankitores',
    'vulcano', 'eruzione', 'вулкан', 'извержение', 'بركان'],
  wildfire: ['wildfire', 'wildfires', 'bushfire', 'bushfires', 'incendio', 'incendios', 'incendie', 'incendies', 'waldbrand', 'waldbrande',
    'erdotuz', 'pozar', 'пожар', 'пожары', 'حريق', 'حرائق'],
  tsunami: ['tsunami', 'tsunamis', 'цунами', 'تسونامي'],
  landslide: ['landslide', 'landslides', 'mudslide', 'deslizamiento', 'huayco', 'glissement', 'erdrutsch', 'foldcsuszamlas', 'оползень'],
  outage: ['outage', 'outages', 'blackout', 'blackouts', 'apagon', 'panne', 'stromausfall', 'aramszunet', 'internetkimaradas', 'отключение', 'блэкаут'],
  outbreak: ['outbreak', 'epidemic', 'cholera', 'ebola', 'mpox', 'dengue', 'measles', 'marburg', 'influenza', 'h5n1', 'polio', 'anthrax',
    'colera', 'brote', 'epidemie', 'ausbruch', 'jarvany', 'kolera', 'вспышка', 'эпидемия', 'холера', 'وباء', 'الكوليرا'],
});
// The hazard an observation of these kinds is, whatever its title says.
const KIND_HAZARD = Object.freeze({ earthquake: 'quake', outage: 'outage', network: 'outage', thermal: 'wildfire', health: 'outbreak' });

export const HAZARDS = Object.freeze(Object.keys(WORDS));
const EXACT = new Map();
const PREFIXES = [];
for (const [hazard, list] of Object.entries(WORDS)) {
  for (const word of list) {
    EXACT.set(word, hazard);
    if ([...word].length >= 6) PREFIXES.push([word, hazard]);
  }
}

/** The hazards named by title tokens (and by the record kind, for an observation): a Set of HAZARDS. */
export function hazardsOf(tokens, kind = '') {
  const found = new Set();
  if (Object.hasOwn(KIND_HAZARD, kind)) found.add(KIND_HAZARD[kind]);
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (typeof token !== 'string') continue;
    const exact = EXACT.get(token);
    if (exact) { found.add(exact); continue; }
    for (const [word, hazard] of PREFIXES) if (token.startsWith(word) && token.length - word.length <= 6) { found.add(hazard); break; }
  }
  return found;
}

/** True when the token is a hazard word (it says what happened, not where): such a word never counts as a distinctive shared word. */
export const isHazardWord = token => hazardsOf([token]).size > 0;
