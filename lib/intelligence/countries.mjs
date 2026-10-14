// ISO 3166-1 gazetteer (249 entries plus Kosovo, which has the user-assigned code XK/XKX and no ISO numeric code)
// and a bounded, regex-free country-name scan for free text. Codes were checked against the CLDR territory aliases;
// every shape of the vendored world-atlas topojson resolves here (see test/intelligence-risk.test.mjs).

// [iso2, iso3, ISO numeric, English short name]
const TABLE = [
  ['AF', 'AFG', 4, 'Afghanistan'], ['AX', 'ALA', 248, 'Åland Islands'], ['AL', 'ALB', 8, 'Albania'], ['DZ', 'DZA', 12, 'Algeria'],
  ['AS', 'ASM', 16, 'American Samoa'], ['AD', 'AND', 20, 'Andorra'], ['AO', 'AGO', 24, 'Angola'], ['AI', 'AIA', 660, 'Anguilla'],
  ['AQ', 'ATA', 10, 'Antarctica'], ['AG', 'ATG', 28, 'Antigua and Barbuda'], ['AR', 'ARG', 32, 'Argentina'], ['AM', 'ARM', 51, 'Armenia'],
  ['AW', 'ABW', 533, 'Aruba'], ['AU', 'AUS', 36, 'Australia'], ['AT', 'AUT', 40, 'Austria'], ['AZ', 'AZE', 31, 'Azerbaijan'],
  ['BS', 'BHS', 44, 'Bahamas'], ['BH', 'BHR', 48, 'Bahrain'], ['BD', 'BGD', 50, 'Bangladesh'], ['BB', 'BRB', 52, 'Barbados'],
  ['BY', 'BLR', 112, 'Belarus'], ['BE', 'BEL', 56, 'Belgium'], ['BZ', 'BLZ', 84, 'Belize'], ['BJ', 'BEN', 204, 'Benin'],
  ['BM', 'BMU', 60, 'Bermuda'], ['BT', 'BTN', 64, 'Bhutan'], ['BO', 'BOL', 68, 'Bolivia'], ['BQ', 'BES', 535, 'Caribbean Netherlands'],
  ['BA', 'BIH', 70, 'Bosnia and Herzegovina'], ['BW', 'BWA', 72, 'Botswana'], ['BV', 'BVT', 74, 'Bouvet Island'], ['BR', 'BRA', 76, 'Brazil'],
  ['IO', 'IOT', 86, 'British Indian Ocean Territory'], ['BN', 'BRN', 96, 'Brunei'], ['BG', 'BGR', 100, 'Bulgaria'], ['BF', 'BFA', 854, 'Burkina Faso'],
  ['BI', 'BDI', 108, 'Burundi'], ['CV', 'CPV', 132, 'Cabo Verde'], ['KH', 'KHM', 116, 'Cambodia'], ['CM', 'CMR', 120, 'Cameroon'],
  ['CA', 'CAN', 124, 'Canada'], ['KY', 'CYM', 136, 'Cayman Islands'], ['CF', 'CAF', 140, 'Central African Republic'], ['TD', 'TCD', 148, 'Chad'],
  ['CL', 'CHL', 152, 'Chile'], ['CN', 'CHN', 156, 'China'], ['CX', 'CXR', 162, 'Christmas Island'], ['CC', 'CCK', 166, 'Cocos (Keeling) Islands'],
  ['CO', 'COL', 170, 'Colombia'], ['KM', 'COM', 174, 'Comoros'], ['CG', 'COG', 178, 'Congo'], ['CD', 'COD', 180, 'Democratic Republic of the Congo'],
  ['CK', 'COK', 184, 'Cook Islands'], ['CR', 'CRI', 188, 'Costa Rica'], ['CI', 'CIV', 384, "Côte d'Ivoire"], ['HR', 'HRV', 191, 'Croatia'],
  ['CU', 'CUB', 192, 'Cuba'], ['CW', 'CUW', 531, 'Curaçao'], ['CY', 'CYP', 196, 'Cyprus'], ['CZ', 'CZE', 203, 'Czechia'],
  ['DK', 'DNK', 208, 'Denmark'], ['DJ', 'DJI', 262, 'Djibouti'], ['DM', 'DMA', 212, 'Dominica'], ['DO', 'DOM', 214, 'Dominican Republic'],
  ['EC', 'ECU', 218, 'Ecuador'], ['EG', 'EGY', 818, 'Egypt'], ['SV', 'SLV', 222, 'El Salvador'], ['GQ', 'GNQ', 226, 'Equatorial Guinea'],
  ['ER', 'ERI', 232, 'Eritrea'], ['EE', 'EST', 233, 'Estonia'], ['SZ', 'SWZ', 748, 'Eswatini'], ['ET', 'ETH', 231, 'Ethiopia'],
  ['FK', 'FLK', 238, 'Falkland Islands'], ['FO', 'FRO', 234, 'Faroe Islands'], ['FJ', 'FJI', 242, 'Fiji'], ['FI', 'FIN', 246, 'Finland'],
  ['FR', 'FRA', 250, 'France'], ['GF', 'GUF', 254, 'French Guiana'], ['PF', 'PYF', 258, 'French Polynesia'], ['TF', 'ATF', 260, 'French Southern Territories'],
  ['GA', 'GAB', 266, 'Gabon'], ['GM', 'GMB', 270, 'Gambia'], ['GE', 'GEO', 268, 'Georgia'], ['DE', 'DEU', 276, 'Germany'],
  ['GH', 'GHA', 288, 'Ghana'], ['GI', 'GIB', 292, 'Gibraltar'], ['GR', 'GRC', 300, 'Greece'], ['GL', 'GRL', 304, 'Greenland'],
  ['GD', 'GRD', 308, 'Grenada'], ['GP', 'GLP', 312, 'Guadeloupe'], ['GU', 'GUM', 316, 'Guam'], ['GT', 'GTM', 320, 'Guatemala'],
  ['GG', 'GGY', 831, 'Guernsey'], ['GN', 'GIN', 324, 'Guinea'], ['GW', 'GNB', 624, 'Guinea-Bissau'], ['GY', 'GUY', 328, 'Guyana'],
  ['HT', 'HTI', 332, 'Haiti'], ['HM', 'HMD', 334, 'Heard Island and McDonald Islands'], ['VA', 'VAT', 336, 'Holy See'], ['HN', 'HND', 340, 'Honduras'],
  ['HK', 'HKG', 344, 'Hong Kong'], ['HU', 'HUN', 348, 'Hungary'], ['IS', 'ISL', 352, 'Iceland'], ['IN', 'IND', 356, 'India'],
  ['ID', 'IDN', 360, 'Indonesia'], ['IR', 'IRN', 364, 'Iran'], ['IQ', 'IRQ', 368, 'Iraq'], ['IE', 'IRL', 372, 'Ireland'],
  ['IM', 'IMN', 833, 'Isle of Man'], ['IL', 'ISR', 376, 'Israel'], ['IT', 'ITA', 380, 'Italy'], ['JM', 'JAM', 388, 'Jamaica'],
  ['JP', 'JPN', 392, 'Japan'], ['JE', 'JEY', 832, 'Jersey'], ['JO', 'JOR', 400, 'Jordan'], ['KZ', 'KAZ', 398, 'Kazakhstan'],
  ['KE', 'KEN', 404, 'Kenya'], ['KI', 'KIR', 296, 'Kiribati'], ['KP', 'PRK', 408, 'North Korea'], ['KR', 'KOR', 410, 'South Korea'],
  ['KW', 'KWT', 414, 'Kuwait'], ['KG', 'KGZ', 417, 'Kyrgyzstan'], ['LA', 'LAO', 418, 'Laos'], ['LV', 'LVA', 428, 'Latvia'],
  ['LB', 'LBN', 422, 'Lebanon'], ['LS', 'LSO', 426, 'Lesotho'], ['LR', 'LBR', 430, 'Liberia'], ['LY', 'LBY', 434, 'Libya'],
  ['LI', 'LIE', 438, 'Liechtenstein'], ['LT', 'LTU', 440, 'Lithuania'], ['LU', 'LUX', 442, 'Luxembourg'], ['MO', 'MAC', 446, 'Macao'],
  ['MG', 'MDG', 450, 'Madagascar'], ['MW', 'MWI', 454, 'Malawi'], ['MY', 'MYS', 458, 'Malaysia'], ['MV', 'MDV', 462, 'Maldives'],
  ['ML', 'MLI', 466, 'Mali'], ['MT', 'MLT', 470, 'Malta'], ['MH', 'MHL', 584, 'Marshall Islands'], ['MQ', 'MTQ', 474, 'Martinique'],
  ['MR', 'MRT', 478, 'Mauritania'], ['MU', 'MUS', 480, 'Mauritius'], ['YT', 'MYT', 175, 'Mayotte'], ['MX', 'MEX', 484, 'Mexico'],
  ['FM', 'FSM', 583, 'Micronesia'], ['MD', 'MDA', 498, 'Moldova'], ['MC', 'MCO', 492, 'Monaco'], ['MN', 'MNG', 496, 'Mongolia'],
  ['ME', 'MNE', 499, 'Montenegro'], ['MS', 'MSR', 500, 'Montserrat'], ['MA', 'MAR', 504, 'Morocco'], ['MZ', 'MOZ', 508, 'Mozambique'],
  ['MM', 'MMR', 104, 'Myanmar'], ['NA', 'NAM', 516, 'Namibia'], ['NR', 'NRU', 520, 'Nauru'], ['NP', 'NPL', 524, 'Nepal'],
  ['NL', 'NLD', 528, 'Netherlands'], ['NC', 'NCL', 540, 'New Caledonia'], ['NZ', 'NZL', 554, 'New Zealand'], ['NI', 'NIC', 558, 'Nicaragua'],
  ['NE', 'NER', 562, 'Niger'], ['NG', 'NGA', 566, 'Nigeria'], ['NU', 'NIU', 570, 'Niue'], ['NF', 'NFK', 574, 'Norfolk Island'],
  ['MK', 'MKD', 807, 'North Macedonia'], ['MP', 'MNP', 580, 'Northern Mariana Islands'], ['NO', 'NOR', 578, 'Norway'], ['OM', 'OMN', 512, 'Oman'],
  ['PK', 'PAK', 586, 'Pakistan'], ['PW', 'PLW', 585, 'Palau'], ['PS', 'PSE', 275, 'Palestine'], ['PA', 'PAN', 591, 'Panama'],
  ['PG', 'PNG', 598, 'Papua New Guinea'], ['PY', 'PRY', 600, 'Paraguay'], ['PE', 'PER', 604, 'Peru'], ['PH', 'PHL', 608, 'Philippines'],
  ['PN', 'PCN', 612, 'Pitcairn Islands'], ['PL', 'POL', 616, 'Poland'], ['PT', 'PRT', 620, 'Portugal'], ['PR', 'PRI', 630, 'Puerto Rico'],
  ['QA', 'QAT', 634, 'Qatar'], ['RE', 'REU', 638, 'Réunion'], ['RO', 'ROU', 642, 'Romania'], ['RU', 'RUS', 643, 'Russia'],
  ['RW', 'RWA', 646, 'Rwanda'], ['BL', 'BLM', 652, 'Saint Barthélemy'], ['SH', 'SHN', 654, 'Saint Helena, Ascension and Tristan da Cunha'], ['KN', 'KNA', 659, 'Saint Kitts and Nevis'],
  ['LC', 'LCA', 662, 'Saint Lucia'], ['MF', 'MAF', 663, 'Saint Martin'], ['PM', 'SPM', 666, 'Saint Pierre and Miquelon'], ['VC', 'VCT', 670, 'Saint Vincent and the Grenadines'],
  ['WS', 'WSM', 882, 'Samoa'], ['SM', 'SMR', 674, 'San Marino'], ['ST', 'STP', 678, 'São Tomé and Príncipe'], ['SA', 'SAU', 682, 'Saudi Arabia'],
  ['SN', 'SEN', 686, 'Senegal'], ['RS', 'SRB', 688, 'Serbia'], ['SC', 'SYC', 690, 'Seychelles'], ['SL', 'SLE', 694, 'Sierra Leone'],
  ['SG', 'SGP', 702, 'Singapore'], ['SX', 'SXM', 534, 'Sint Maarten'], ['SK', 'SVK', 703, 'Slovakia'], ['SI', 'SVN', 705, 'Slovenia'],
  ['SB', 'SLB', 90, 'Solomon Islands'], ['SO', 'SOM', 706, 'Somalia'], ['ZA', 'ZAF', 710, 'South Africa'], ['GS', 'SGS', 239, 'South Georgia and the South Sandwich Islands'],
  ['SS', 'SSD', 728, 'South Sudan'], ['ES', 'ESP', 724, 'Spain'], ['LK', 'LKA', 144, 'Sri Lanka'], ['SD', 'SDN', 729, 'Sudan'],
  ['SR', 'SUR', 740, 'Suriname'], ['SJ', 'SJM', 744, 'Svalbard and Jan Mayen'], ['SE', 'SWE', 752, 'Sweden'], ['CH', 'CHE', 756, 'Switzerland'],
  ['SY', 'SYR', 760, 'Syria'], ['TW', 'TWN', 158, 'Taiwan'], ['TJ', 'TJK', 762, 'Tajikistan'], ['TZ', 'TZA', 834, 'Tanzania'],
  ['TH', 'THA', 764, 'Thailand'], ['TL', 'TLS', 626, 'Timor-Leste'], ['TG', 'TGO', 768, 'Togo'], ['TK', 'TKL', 772, 'Tokelau'],
  ['TO', 'TON', 776, 'Tonga'], ['TT', 'TTO', 780, 'Trinidad and Tobago'], ['TN', 'TUN', 788, 'Tunisia'], ['TR', 'TUR', 792, 'Türkiye'],
  ['TM', 'TKM', 795, 'Turkmenistan'], ['TC', 'TCA', 796, 'Turks and Caicos Islands'], ['TV', 'TUV', 798, 'Tuvalu'], ['UG', 'UGA', 800, 'Uganda'],
  ['UA', 'UKR', 804, 'Ukraine'], ['AE', 'ARE', 784, 'United Arab Emirates'], ['GB', 'GBR', 826, 'United Kingdom'], ['US', 'USA', 840, 'United States'],
  ['UM', 'UMI', 581, 'United States Minor Outlying Islands'], ['UY', 'URY', 858, 'Uruguay'], ['UZ', 'UZB', 860, 'Uzbekistan'], ['VU', 'VUT', 548, 'Vanuatu'],
  ['VE', 'VEN', 862, 'Venezuela'], ['VN', 'VNM', 704, 'Vietnam'], ['VG', 'VGB', 92, 'British Virgin Islands'], ['VI', 'VIR', 850, 'U.S. Virgin Islands'],
  ['WF', 'WLF', 876, 'Wallis and Futuna'], ['EH', 'ESH', 732, 'Western Sahara'], ['YE', 'YEM', 887, 'Yemen'], ['ZM', 'ZMB', 894, 'Zambia'],
  ['ZW', 'ZWE', 716, 'Zimbabwe'], ['XK', 'XKX', null, 'Kosovo'],
];

// Common and official alternative names. The world-atlas abbreviations (W. Sahara, Dem. Rep. Congo, ...) are included so
// every topojson `properties.name` is a known name of the country its id resolves to.
const ALIASES = {
  ATG: ['Antigua'], BHS: ['The Bahamas'], BIH: ['Bosnia', 'Bosnia-Herzegovina', 'Bosnia and Herz.'], BRN: ['Brunei Darussalam'],
  BES: ['Bonaire', 'Sint Eustatius', 'Bonaire, Sint Eustatius and Saba'], BOL: ['Plurinational State of Bolivia'],
  IOT: ['Chagos Islands', 'Diego Garcia'], CPV: ['Cape Verde'], CAF: ['Central African Rep.'], TCD: ['Republic of Chad'],
  CCK: ['Cocos Islands', 'Keeling Islands'], COG: ['Republic of the Congo', 'Republic of Congo', 'Congo-Brazzaville', 'Congo Republic'],
  COD: ['DR Congo', 'D.R. Congo', 'DRC', 'Democratic Republic of Congo', 'Congo-Kinshasa', 'Dem. Rep. Congo'],
  CIV: ["Cote d'Ivoire", 'Ivory Coast'], CUW: ['Curacao'], CYP: ['Northern Cyprus', 'N. Cyprus'], CZE: ['Czech Republic'],
  DOM: ['Dominican Rep.'], GNQ: ['Eq. Guinea'], SWZ: ['Swaziland', 'eSwatini'], FLK: ['Falklands', 'Malvinas', 'Falkland Is.'],
  FRO: ['Faroes', 'Faeroe Islands'], ATF: ['French Southern and Antarctic Lands', 'Fr. S. Antarctic Lands'], GMB: ['The Gambia'],
  GIN: ['Republic of Guinea', 'Guinea-Conakry'], VAT: ['Vatican', 'Vatican City'], HKG: ['Hong Kong SAR'], IRN: ['Islamic Republic of Iran'],
  IRL: ['Republic of Ireland'], JEY: ['Bailiwick of Jersey'], JOR: ['Kingdom of Jordan', 'Hashemite Kingdom of Jordan'],
  PRK: ['DPRK', "Democratic People's Republic of Korea"], KOR: ['Republic of Korea'], KGZ: ['Kyrgyz Republic'], LAO: ['Lao PDR'],
  MAC: ['Macau'], FSM: ['Federated States of Micronesia'], MDA: ['Republic of Moldova'], MMR: ['Burma'],
  NLD: ['The Netherlands', 'Holland'], NGA: ['Niger Delta', 'Niger State'], MKD: ['Macedonia', 'Republic of North Macedonia'],
  MNP: ['Northern Marianas'], PSE: ['State of Palestine', 'Palestinian Territories', 'Gaza', 'Gaza Strip', 'West Bank'],
  PCN: ['Pitcairn'], REU: ['La Réunion', 'Reunion Island'], RUS: ['Russian Federation'], BLM: ['St. Barthélemy', 'St Barts', 'St. Barths'],
  SHN: ['Saint Helena', 'St. Helena'], KNA: ['St. Kitts and Nevis', 'St Kitts', 'Saint Kitts'], LCA: ['St. Lucia'],
  MAF: ['St. Martin', 'Saint-Martin'], SPM: ['St. Pierre and Miquelon'], VCT: ['St. Vincent and the Grenadines', 'Saint Vincent', 'St. Vincent'],
  STP: ['Sao Tome', 'São Tomé'], SAU: ['Saudi'], SLB: ['Solomon Is.'], SOM: ['Somaliland'], SSD: ['S. Sudan'], SGS: ['South Georgia and South Sandwich Islands'],
  SJM: ['Svalbard'], SYR: ['Syrian Arab Republic'], TWN: ['Taiwan, Province of China'], TZA: ['United Republic of Tanzania'],
  TLS: ['East Timor'], TTO: ['Trinidad'], TUR: ['Turkey', 'Turkiye', 'Republic of Türkiye'], TCA: ['Turks and Caicos'],
  ARE: ['UAE', 'U.A.E.'], GBR: ['UK', 'U.K.', 'Britain', 'Great Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland'],
  USA: ['US', 'U.S.', 'USA', 'U.S.A.', 'United States of America'], UMI: ['U.S. Minor Outlying Islands'], VEN: ['Bolivarian Republic of Venezuela'],
  VNM: ['Viet Nam'], VGB: ['Virgin Islands (British)'], VIR: ['US Virgin Islands', 'United States Virgin Islands'], WLF: ['Wallis and Futuna Islands'],
  ESH: ['W. Sahara'],
};

// The plain name is ambiguous in free text (a US state, a first name, an island shared by two countries, an English word):
// it never matches a title or summary, only a structured field. Aliases of these countries still match.
const AMBIGUOUS = new Set(['GEO', 'JOR', 'TCD', 'GIN', 'COG', 'JEY', 'REU']);

// Phrases that contain a country name but do not mean that country. They consume their words and yield nothing, so the
// longest-match scan never falls back to the shorter name inside them.
const BLOCKERS = ['Korea', 'America', 'North America', 'South America', 'Latin America', 'Central America', 'New Mexico', 'Gulf of Mexico',
  'New Guinea', 'New Jersey', 'New South Wales', 'South Georgia', 'Benin City', 'Strait of Gibraltar', 'Virgin Islands', 'Indian Ocean'];

const MAX_SCAN = 600;
const MAX_WORDS = 8;

export const COUNTRIES = Object.freeze(TABLE.map(([iso2, iso3, num, name]) => Object.freeze({
  iso3, iso2, num, name, aliases: Object.freeze([...(ALIASES[iso3] || [])]), ambiguous: AMBIGUOUS.has(iso3),
})));

const BY_ISO3 = new Map(COUNTRIES.map(country => [country.iso3, country]));
const BY_ISO2 = new Map(COUNTRIES.map(country => [country.iso2, country]));
const BY_NUM = new Map(COUNTRIES.filter(country => country.num !== null).map(country => [country.num, country]));

export const countryByIso3 = code => typeof code === 'string' ? BY_ISO3.get(code.toUpperCase()) ?? null : null;
export const countryByIso2 = code => typeof code === 'string' ? BY_ISO2.get(code.toUpperCase()) ?? null : null;
export function countryByNum(n) {
  const value = typeof n === 'string' && /^\d{1,3}$/.test(n) ? Number(n) : n;
  return Number.isInteger(value) ? BY_NUM.get(value) ?? null : null;
}

// One Intl.DisplayNames per language (null: ICU has no data for it). The language is the server's, so the cache stays tiny;
// the cap only guards a caller that passes arbitrary tags.
const DISPLAY = new Map();
function displayNamesFor(language) {
  if (DISPLAY.has(language)) return DISPLAY.get(language);
  let names = null;
  try { if (Intl.DisplayNames.supportedLocalesOf([language]).length) names = new Intl.DisplayNames([language], { type: 'region', fallback: 'code' }); } catch { names = null; }
  if (DISPLAY.size < 16) DISPLAY.set(language, names);
  return names;
}

/**
 * The country's name for display in `language` (CLDR, via Intl), or null for an unknown code. Display only: `name` stays the
 * English key every text match uses. English, a language ICU lacks and a region it does not name (it echoes the code) give `name`.
 */
export function countryDisplayName(iso3, language = 'en') {
  const country = countryByIso3(iso3);
  if (!country) return null;
  if (typeof language !== 'string' || !language || /^en(?:-|$)/i.test(language)) return country.name;
  let label = null;
  try { label = displayNamesFor(language)?.of(country.iso2) ?? null; } catch { label = null; }
  return typeof label === 'string' && label && label.toUpperCase() !== country.iso2 ? label : country.name;
}

// Words of a text: letters/digits with inner apostrophes and dots; diacritics folded, dots removed ("U.S." -> "US"),
// a possessive "'s" dropped. Hyphens, commas and brackets separate words. Case is kept.
export function words(value) {
  const out = [];
  const folded = value.replace(/[‘’]/g, "'").replace(/&/g, ' and ').normalize('NFKD').replace(/\p{M}/gu, '');
  for (const match of folded.matchAll(/[\p{L}\p{N}][\p{L}\p{N}.']*/gu)) {
    let word = match[0].replace(/'s$/, '').replace(/'+$/, '').replaceAll('.', '');
    if (word) out.push(word);
  }
  return out;
}

// A capital letter, or a letter of a script without case (Arabic): such a script has no capitalised names to look for.
export const isCapital = word => { const first = word[0]; return first === first.toLowerCase() ? first === first.toUpperCase() && /\p{L}/u.test(first) : first === first.toUpperCase(); };

// Connecting words inside a name match in any case ("Democratic Republic Of The Congo" in a provider's title case).
const CONNECTORS = new Set(['of', 'the', 'and', 'da', 'de', 'du']);
export function keyOf(list, start, size) {
  let key = list[start];
  for (let j = 1; j < size; j++) {
    const word = list[start + j];
    const lower = word.toLowerCase();
    key += ' ' + (CONNECTORS.has(lower) ? lower : word);
  }
  return key;
}

// phrase -> {iso3, ambiguous} for names and aliases; blockers map to null.
const PHRASES = new Map();
const phraseKey = phrase => { const list = words(phrase); return list.length ? keyOf(list, 0, list.length) : ''; };
for (const phrase of BLOCKERS) PHRASES.set(phraseKey(phrase), null);
for (const country of COUNTRIES) {
  for (const [index, phrase] of [country.name, ...country.aliases].entries()) {
    const key = phraseKey(phrase);
    if (key && !PHRASES.has(key)) PHRASES.set(key, { iso3: country.iso3, ambiguous: index === 0 && country.ambiguous });
  }
}

// Country names in the languages of the world-RSS catalogue (CLDR, via Intl), so that a Telex, Le Monde or Meduza headline names
// a country too. English keys, aliases and blockers come first and are never replaced. A local name that is a common word or a
// first name somewhere is left out; a name shared by two countries (Congo, Guinea) stays ambiguous as in English. Short Latin names
// (Çin, Fas, Čad) are too easily a word or a ticker.
const LOCAL_LANGUAGES = ['hu', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'ro', 'pl', 'cs', 'hr', 'sv', 'tr', 'ru', 'uk', 'bg', 'el', 'ar'];
const LOCAL_SKIP = new Set(['Maurice', 'Mauricio', 'Granada', 'Grenade', 'Indie', 'Gana', 'Mısır', 'Island', 'Columbia', 'Salvador', 'Dominique',
  'Norfolk', 'Georgie', 'Chili', 'Guadalupe', 'Kena']);
const LOCAL_AMBIGUOUS = new Set(['COG', 'GIN']);
// Names whose inflected forms are read too (Hungarian cases, the German genitive): stem key -> {iso3, ambiguous}.
const STEM_LANGUAGES = new Set(['hu', 'de']);
const STEMS = new Map();
for (const language of LOCAL_LANGUAGES) {
  let names = null;
  try { names = new Intl.DisplayNames([language], { type: 'region', fallback: 'none' }); } catch { names = null; }
  if (!names) continue;
  for (const country of COUNTRIES) {
    let label;
    try { label = names.of(country.iso2); } catch { label = undefined; }
    const key = typeof label === 'string' ? phraseKey(label) : '';
    if (!key || LOCAL_SKIP.has(key) || (/^[A-Za-z]{1,3}$/.test(key) && key !== key.toUpperCase())) continue;
    const entry = { iso3: country.iso3, ambiguous: LOCAL_AMBIGUOUS.has(country.iso3) };
    if (!PHRASES.has(key)) PHRASES.set(key, entry);
    const own = PHRASES.get(key);
    if (STEM_LANGUAGES.has(language) && own?.iso3 === country.iso3 && !STEMS.has(key) && key.split(' ').at(-1).length >= 4) STEMS.set(key, own);
  }
}

// Case endings that may follow a stem, diacritics folded: Hungarian ("Oroszországban", "Ukrajnából", "Izraelt", "oroszországi")
// and the German genitive ("Russlands"). The Hungarian instrumental doubles the last consonant ("Iránnal", "Izraellel").
const STEM_ENDINGS = ['kent', 'ban', 'ben', 'bol', 'rol', 'tol', 'hoz', 'hez', 'nak', 'nek', 'val', 'vel', 'nal', 'nel', 'ert',
  'ba', 'be', 'ra', 're', 'on', 'en', 'ot', 'et', 'at', 'ig', 'es', 't', 'n', 'i', 's'];
const STEM_BLOCKED = new Set(['Kuban']);
const ARABIC_PREFIX = new Set(['و', 'ب', 'ل', 'ف']);
// One-word keys written in capitals (US, UAE, DRC, DPRK, ОАЭ): kept as they are when a whole label is read as title case.
const CAPITAL_CODES = new Set([...PHRASES.keys()].filter(key => !key.includes(' ') && key === key.toUpperCase() && key !== key.toLowerCase()));
export function stemsOf(word) {
  const out = [];
  if (word.length < 5 || STEM_BLOCKED.has(word)) return out;
  for (const ending of STEM_ENDINGS) if (word.length - ending.length >= 4 && word.endsWith(ending)) out.push(word.slice(0, -ending.length));
  const n = word.length;
  if (n >= 7 && (word.endsWith('al') || word.endsWith('el')) && word[n - 3].toLowerCase() === word[n - 4].toLowerCase()) out.push(word.slice(0, -3));
  return out;
}

const LONGEST = Math.min(MAX_WORDS, Math.max(...[...PHRASES.keys()].map(key => key.split(' ').length)));

// Every word of a country name or alias in any language, folded and lower-cased ("united", "states", "panama", "magyarorszag").
let NAME_WORDS = null;
/** True when `token` (folded, lower case, as tokensOf gives it) is a word of some country's name: it says where, not which event. */
export function isCountryNameWord(token) {
  if (!NAME_WORDS) {
    NAME_WORDS = new Set();
    for (const [key, hit] of PHRASES) if (hit) for (const word of key.split(' ')) NAME_WORDS.add(word.toLowerCase());
  }
  return typeof token === 'string' && NAME_WORDS.has(token);
}

/** The country whose name or alias equals `name` exactly (after folding), or null. Ambiguous names count. */
export function countryByName(name) {
  if (typeof name !== 'string') return null;
  const hit = PHRASES.get(phraseKey(name.slice(0, 200)));
  return hit ? BY_ISO3.get(hit.iso3) : null;
}

/**
 * ISO3 codes of the countries named in `text`, in order of first appearance, at most `limit`. Only the first 600
 * characters are read. Phrases of up to 8 words starting with a capital letter are looked up case-sensitively, longest
 * first. Ambiguous names are skipped unless `ambiguous` is true (structured fields only). No regex is built from input.
 * Local names (Oroszország, Russland, Russie, Россия) count like English ones; Hungarian and German names also inflected.
 */
export function countriesInText(text, { limit = 3, ambiguous = false } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const max = Number.isInteger(limit) && limit > 0 ? limit : 3;
  let scan = text.slice(0, MAX_SCAN);
  // A label written in capitals (EMSC: "RYUKYU ISLANDS, JAPAN") is read as title case: names are matched on capitalised words only.
  // A code written in capitals anyway (US, UAE, DRC) stays one, so "US STRIKES IRAN" still names the United States.
  if (scan === scan.toUpperCase() && scan !== scan.toLowerCase()) {
    scan = scan.replace(/\p{L}[\p{L}']*/gu, word => CAPITAL_CODES.has(word) ? word : word[0] + word.slice(1).toLowerCase());
  }
  const list = words(scan);
  const found = [];
  const add = hit => { if (hit && (ambiguous || !hit.ambiguous) && !found.includes(hit.iso3)) found.push(hit.iso3); };
  for (let i = 0; i < list.length && found.length < max;) {
    let step = 1;
    if (isCapital(list[i])) {
      for (let size = Math.min(LONGEST, list.length - i); size >= 1; size--) {
        const key = keyOf(list, i, size);
        if (PHRASES.has(key)) {
          add(PHRASES.get(key));
          step = size;
          break;
        }
        // An inflected last word ("Egyesült Államokban", "Russlands") of a local name.
        const head = size > 1 ? keyOf(list, i, size - 1) + ' ' : '';
        const stem = stemsOf(list[i + size - 1]).map(candidate => head + candidate).find(candidate => STEMS.has(candidate));
        if (stem) {
          add(STEMS.get(stem));
          step = size;
          break;
        }
        // An Arabic name with a joined conjunction or preposition ("وروسيا", "بالسودان").
        if (size === 1 && ARABIC_PREFIX.has(list[i][0])) {
          const bare = [list[i].slice(1), list[i].slice(2)].find(candidate => PHRASES.get(candidate));
          if (bare) { add(PHRASES.get(bare)); break; }
        }
      }
    }
    i += step;
  }
  return found;
}
