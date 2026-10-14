// The watched maritime chokepoints as entities: the PortWatch slugs (apis/sources/portwatch.mjs), the label the alert metrics use, the names a
// report may use for each passage (English and the main catalogue languages), an approximate centre with a radius for located events, and
// the commodities whose price the passage is considered to move (editorial, like the exposure table: World Monitor's reading, not trade data).
// A `broad` name (Red Sea, English Channel) is a whole sea, not the strait: it links with less strength.

export const CHOKEPOINTS = Object.freeze([
  { slug: 'hormuz', label: 'Strait of Hormuz', lat: 26.57, lon: 56.25, km: 150, commodities: ['brent', 'wti', 'lng'],
    names: ['Strait of Hormuz', 'Hormuz Strait', 'Hormuz', 'Straße von Hormus', 'Hormus', 'Hormuzi-szoros', "détroit d'Ormuz", 'Ormuz', 'Ормузский пролив'],
    broad: ['Persian Gulf', 'Gulf of Oman', 'Perzsa-öböl'] },
  { slug: 'bab_el_mandeb', label: 'Bab el-Mandeb', lat: 12.58, lon: 43.33, km: 200, commodities: ['brent'],
    names: ['Bab el-Mandeb', 'Bab el Mandeb', 'Bab al-Mandab', 'Bab-el-Mandeb', 'Bab-al-Mandab', 'Bab-el-Mandeb-szoros', 'Баб-эль-Мандеб'],
    broad: ['Red Sea', 'Gulf of Aden', 'Vörös-tenger', 'Rotes Meer', 'mer Rouge', 'Mar Rojo', 'Красное море', 'Adeni-öböl'] },
  { slug: 'suez', label: 'Suez Canal', lat: 30.45, lon: 32.35, km: 120, commodities: ['brent'],
    names: ['Suez Canal', 'Suez', 'Szuezi-csatorna', 'Sueskanal', 'canal de Suez', 'Суэцкий канал'], broad: [] },
  { slug: 'malacca', label: 'Malacca Strait', lat: 2.5, lon: 101.2, km: 350, commodities: ['brent', 'lng'],
    names: ['Strait of Malacca', 'Malacca Strait', 'Malacca', 'Malakkai-szoros', 'Straße von Malakka', 'Малаккский пролив'], broad: ['Singapore Strait'] },
  { slug: 'bosporus', label: 'Bosporus', lat: 41.12, lon: 29.07, km: 120, commodities: ['wheat'],
    names: ['Bosporus', 'Bosphorus', 'Boszporusz', 'Bosporus Strait', 'Turkish Straits', 'Босфор'], broad: ['Dardanelles', 'Black Sea', 'Fekete-tenger', 'Schwarzes Meer', 'Чёрное море'] },
  { slug: 'panama', label: 'Panama Canal', lat: 9.08, lon: -79.68, km: 100, commodities: [],
    names: ['Panama Canal', 'Panama-csatorna', 'Panamakanal', 'canal de Panamá', 'Canal de Panamá', 'Панамский канал'], broad: [] },
  { slug: 'gibraltar', label: 'Gibraltar Strait', lat: 35.97, lon: -5.5, km: 100, commodities: [],
    names: ['Strait of Gibraltar', 'Gibraltar Strait', 'Gibraltári-szoros', 'Straße von Gibraltar', 'détroit de Gibraltar', 'estrecho de Gibraltar'], broad: [] },
  { slug: 'dover', label: 'Dover Strait', lat: 51.0, lon: 1.45, km: 80, commodities: [],
    names: ['Dover Strait', 'Strait of Dover', 'Doveri-szoros', 'Straße von Dover', 'Pas de Calais'], broad: ['English Channel', 'La Manche', 'Ärmelkanal', 'La-Manche-csatorna'] },
].map(entry => Object.freeze({ ...entry, commodities: Object.freeze(entry.commodities), names: Object.freeze(entry.names), broad: Object.freeze(entry.broad) })));

export const chokepointBySlug = slug => CHOKEPOINTS.find(entry => entry.slug === slug) ?? null;

const radians = degrees => degrees * Math.PI / 180;
/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const arc = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, arc))));
}

/** The chokepoint whose radius holds the point (the nearest one when two do), or null. */
export function chokepointAt(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  let best = null;
  let bestKm = Infinity;
  for (const entry of CHOKEPOINTS) {
    const km = distanceKm(lat, lon, entry.lat, entry.lon);
    if (km <= entry.km && km < bestKm) { best = entry; bestKm = km; }
  }
  return best;
}
