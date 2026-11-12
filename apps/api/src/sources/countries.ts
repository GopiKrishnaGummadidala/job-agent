/**
 * Countries for a job, inferred from its free-text location ("Stuttgart, BW, Germany", "Remote - US",
 * "Göttingen"). Codes are ISO 3166-1 alpha-2; "EU" stands for a Europe-wide posting
 * ("Remote - European Union", "EMEA"), which people living anywhere in Europe can take.
 */

export const EUROPE_WIDE = 'EU';

/** European countries a Europe-wide posting is open to. */
export const EUROPE = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB', 'CH', 'NO', 'IS',
];

/** Lower-case names that refer to a whole country or region. */
const NAMES: Record<string, string[]> = {
  germany: ['DE'], deutschland: ['DE'], austria: ['AT'], 'österreich': ['AT'], switzerland: ['CH'], schweiz: ['CH'],
  dach: ['DE', 'AT', 'CH'],
  netherlands: ['NL'], 'the netherlands': ['NL'], nederland: ['NL'], holland: ['NL'], belgium: ['BE'],
  france: ['FR'], spain: ['ES'], 'españa': ['ES'], portugal: ['PT'], italy: ['IT'], italia: ['IT'],
  ireland: ['IE'], 'united kingdom': ['GB'], 'great britain': ['GB'], england: ['GB'], scotland: ['GB'],
  wales: ['GB'], 'northern ireland': ['GB'], poland: ['PL'], polska: ['PL'], 'czech republic': ['CZ'],
  czechia: ['CZ'], slovakia: ['SK'], hungary: ['HU'], romania: ['RO'], bulgaria: ['BG'], greece: ['GR'],
  croatia: ['HR'], slovenia: ['SI'], serbia: ['RS'], sweden: ['SE'], denmark: ['DK'], norway: ['NO'],
  finland: ['FI'], iceland: ['IS'], estonia: ['EE'], latvia: ['LV'], lithuania: ['LT'], luxembourg: ['LU'],
  malta: ['MT'], cyprus: ['CY'], ukraine: ['UA'], turkey: ['TR'], 'türkiye': ['TR'],
  'united states': ['US'], 'united states of america': ['US'], canada: ['CA'], mexico: ['MX'], brazil: ['BR'],
  argentina: ['AR'], colombia: ['CO'], chile: ['CL'], india: ['IN'], china: ['CN'], japan: ['JP'],
  'south korea': ['KR'], korea: ['KR'], singapore: ['SG'], vietnam: ['VN'], thailand: ['TH'], malaysia: ['MY'],
  philippines: ['PH'], indonesia: ['ID'], australia: ['AU'], 'new zealand': ['NZ'], israel: ['IL'],
  'united arab emirates': ['AE'], 'south africa': ['ZA'], egypt: ['EG'], nigeria: ['NG'], kenya: ['KE'],
  morocco: ['MA'], tunisia: ['TN'], 'saudi arabia': ['SA'], pakistan: ['PK'], bangladesh: ['BD'],
  'sri lanka': ['LK'],
  europe: [EUROPE_WIDE], 'european union': [EUROPE_WIDE], emea: [EUROPE_WIDE],
};

/** Upper-case abbreviations; matched case-sensitively so "in" or "us" in prose do not count. */
const ABBREVIATIONS: Record<string, string> = { US: 'US', USA: 'US', 'U.S.': 'US', UK: 'GB', UAE: 'AE', KSA: 'SA', EU: EUROPE_WIDE };

const CITIES: Record<string, string[]> = {
  DE: [
    'Berlin', 'Hamburg', 'München', 'Muenchen', 'Munich', 'Köln', 'Koeln', 'Cologne', 'Frankfurt', 'Stuttgart',
    'Düsseldorf', 'Duesseldorf', 'Dortmund', 'Essen', 'Leipzig', 'Bremen', 'Bremerhaven', 'Dresden', 'Hannover',
    'Hanover', 'Nürnberg', 'Nuremberg', 'Duisburg', 'Bochum', 'Wuppertal', 'Bielefeld', 'Bonn', 'Münster',
    'Karlsruhe', 'Mannheim', 'Augsburg', 'Wiesbaden', 'Mönchengladbach', 'Gelsenkirchen', 'Aachen',
    'Braunschweig', 'Kiel', 'Chemnitz', 'Magdeburg', 'Freiburg', 'Krefeld', 'Mainz', 'Lübeck', 'Erfurt',
    'Rostock', 'Kassel', 'Potsdam', 'Saarbrücken', 'Oldenburg', 'Osnabrück', 'Heidelberg', 'Darmstadt',
    'Regensburg', 'Ingolstadt', 'Würzburg', 'Wolfsburg', 'Ulm', 'Heilbronn', 'Pforzheim', 'Göttingen',
    'Reutlingen', 'Erlangen', 'Jena', 'Koblenz', 'Trier', 'Siegen', 'Gütersloh', 'Hildesheim', 'Paderborn',
    'Fürth', 'Offenbach', 'Ludwigshafen', 'Leverkusen', 'Neuss', 'Remscheid', 'Solingen', 'Walldorf',
    'Gerlingen', 'Sindelfingen', 'Böblingen', 'Ludwigsburg', 'Esslingen', 'Tübingen', 'Konstanz', 'Lüneburg',
    'Flensburg', 'Schwerin', 'Cottbus', 'Bamberg', 'Bayreuth', 'Passau', 'Landshut', 'Rosenheim', 'Garching',
    'Unterföhring', 'Eschborn', 'Norderstedt',
  ],
  AT: ['Vienna', 'Wien', 'Graz', 'Linz', 'Salzburg', 'Innsbruck'],
  CH: ['Zurich', 'Zürich', 'Geneva', 'Genf', 'Basel', 'Bern', 'Lausanne', 'Zug'],
  NL: ['Amsterdam', 'Rotterdam', 'Utrecht', 'Eindhoven', 'The Hague', 'Den Haag'],
  GB: ['London', 'Manchester', 'Edinburgh', 'Glasgow', 'Bristol', 'Belfast'],
  FR: ['Paris', 'Lyon', 'Toulouse', 'Marseille'],
  IE: ['Dublin', 'Cork'],
  ES: ['Madrid', 'Barcelona', 'Málaga'],
  PT: ['Lisbon', 'Lisboa', 'Porto'],
  PL: ['Warsaw', 'Warszawa', 'Krakow', 'Kraków', 'Wroclaw', 'Wrocław', 'Gdansk', 'Gdańsk'],
  CZ: ['Prague', 'Praha', 'Brno'],
  SE: ['Stockholm', 'Gothenburg', 'Malmö'],
  DK: ['Copenhagen', 'København'],
  NO: ['Oslo'],
  FI: ['Helsinki'],
  BE: ['Brussels', 'Antwerp'],
  IT: ['Milan', 'Milano', 'Rome', 'Roma', 'Turin'],
  HU: ['Budapest'],
  RO: ['Bucharest', 'Cluj-Napoca'],
  US: ['New York', 'San Francisco', 'Seattle', 'Austin', 'Boston', 'Chicago', 'Los Angeles', 'Denver', 'Atlanta'],
  CA: ['Toronto', 'Vancouver', 'Montreal', 'Montréal'],
  IN: ['Bangalore', 'Bengaluru', 'Hyderabad', 'Pune', 'Chennai', 'Mumbai', 'Delhi', 'Gurgaon', 'Gurugram', 'Noida'],
  SG: ['Singapore'],
  AU: ['Sydney', 'Melbourne'],
  JP: ['Tokyo'],
  IL: ['Tel Aviv'],
  AE: ['Dubai', 'Abu Dhabi'],
};

const US_STATES = new Set(
  ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA ' +
    'RI SC SD TN TX UT VT VA WA WV WI WY DC').split(' '),
);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (term: string, flags: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, flags);

const NAME_RES = Object.entries(NAMES).map(([name, codes]) => [wordRe(name, 'iu'), codes] as const);
const ABBR_RES = Object.entries(ABBREVIATIONS).map(([abbr, code]) => [wordRe(abbr, 'u'), code] as const);
const CITY_RES = Object.entries(CITIES).flatMap(([code, cities]) => cities.map((c) => [wordRe(c, 'iu'), code] as const));

export function inferCountries(location: string): string[] {
  const text = location ?? '';
  const found = new Set<string>();
  for (const [re, codes] of NAME_RES) if (re.test(text)) codes.forEach((c) => found.add(c));
  for (const [re, code] of ABBR_RES) if (re.test(text)) found.add(code);
  for (const [re, code] of CITY_RES) if (re.test(text)) found.add(code);
  if (!found.size) {
    // "Sunnyvale, CA" or "New York, NY (HQ)": a US state code after a comma.
    for (const m of text.matchAll(/,\s*([A-Z]{2})\b/g)) if (US_STATES.has(m[1])) found.add('US');
  }
  return [...found].sort();
}

/**
 * Countries for a job: from the location, or, when that says only "Remote", from a region suffix
 * in the title ("Site Reliability Engineer — US", "Staff Engineer - EU").
 */
export function jobCountries(location: string, title: string): string[] {
  const fromLocation = inferCountries(location);
  if (fromLocation.length) return fromLocation;
  const suffix = /[-–—|]\s*([^-–—|]+)$/.exec(title ?? '')?.[1] ?? '';
  return suffix.length <= 30 ? inferCountries(suffix) : [];
}

/**
 * Codes for a preference that names a country or region ("Germany", "DACH", "Europe"), or [] for
 * anything else, such as a city. "Europe" means every European country plus Europe-wide postings.
 */
export function countriesOfName(name: string): string[] {
  const s = name.trim();
  const codes = NAMES[s.toLowerCase()] ?? (ABBREVIATIONS[s] ? [ABBREVIATIONS[s]] : []);
  return codes.includes(EUROPE_WIDE) ? [...EUROPE, EUROPE_WIDE] : codes;
}

/** True when a job in jobCountries can be taken by someone living in country. */
export function coversCountry(jobCountries: string[], country: string): boolean {
  return jobCountries.includes(country) || (jobCountries.includes(EUROPE_WIDE) && EUROPE.includes(country));
}

/**
 * The country nearly all of a board's located jobs are in, used for postings that name only a
 * small town ("Remscheid") or just "Remote". Null for international employers.
 */
export function boardHomeCountry(perJob: string[][]): string | null {
  const located = perJob.filter((c) => c.length === 1 && c[0] !== EUROPE_WIDE);
  if (located.length < 3) return null;
  const counts = new Map<string, number>();
  for (const [c] of located) counts.set(c, (counts.get(c) ?? 0) + 1);
  const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return n / located.length >= 0.9 ? top : null;
}
