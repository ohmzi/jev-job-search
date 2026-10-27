/**
 * The US states a posting's places name, and the code filter that keeps a search to the states
 * the person chose (`preferences.searchStates`). Pure code, before JEV, like the other filters.
 * When code cannot tell where a place is, the posting is kept: the filter only drops a job it is
 * sure is somewhere else.
 */

export const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
} as const;

export type StateCode = keyof typeof US_STATES;

export const isStateCode = (s: string): s is StateCode => Object.hasOwn(US_STATES, s);

/**
 * Cities postings name without their state. A city that is common in more than one state
 * (Portland, Arlington, Columbus, Kansas City) is left out on purpose: it places nothing.
 */
const CITY_STATE: [RegExp, StateCode][] = [
  [/\b(south )?san francisco\b|\bbay area\b|\bpalo alto\b|\bmenlo park\b|\bmountain view\b|\bsunnyvale\b|\bsan jose\b|\bredwood city\b|\bsan mateo\b|\bsanta clara\b|\bcupertino\b|\boakland\b|\bberkeley\b|\blos angeles\b|\bsanta monica\b|\bsan diego\b|\birvine\b/i, "CA"],
  [/\bSF\b/, "CA"],
  [/\bNYC\b|\bbrooklyn\b|\bmanhattan\b/i, "NY"],
  [/\bseattle\b|\bbellevue\b|\bredmond\b|\bkirkland\b/i, "WA"],
  [/\baustin\b|\bdallas\b|\bhouston\b|\bsan antonio\b|\bfort worth\b|\bplano\b|\birving\b|\bfrisco\b/i, "TX"],
  [/\bjersey city\b|\bnewark\b|\bhoboken\b|\bprinceton\b/i, "NJ"],
  [/\bboston\b/i, "MA"],
  [/\bchicago\b/i, "IL"],
  [/\bdenver\b|\bboulder\b/i, "CO"],
  [/\batlanta\b/i, "GA"],
  [/\bmiami\b|\btampa\b|\borlando\b/i, "FL"],
  [/\bphoenix\b|\bscottsdale\b|\btempe\b/i, "AZ"],
  [/\bphiladelphia\b|\bpittsburgh\b/i, "PA"],
  [/\bdetroit\b|\bann arbor\b/i, "MI"],
  [/\bminneapolis\b/i, "MN"],
  [/\bsalt lake\b|\blehi\b/i, "UT"],
  [/\blas vegas\b/i, "NV"],
  [/\braleigh\b|\bdurham\b|\bcharlotte\b/i, "NC"],
  [/\bnashville\b/i, "TN"],
  [/\bbaltimore\b/i, "MD"],
];

const CANADA = /\bCanada\b|\bCAN\b|,\s*(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b/;
const PROVINCE = /\b(ontario|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island)\b/i;
const CANADA_CITY = /toronto|vancouver|montr[eé]al|calgary|edmonton|ottawa|waterloo|kitchener|winnipeg|halifax|qu[eé]bec|mississauga|burnaby|markham/i;
/** Places abroad whose names hold a state's code or name: "Tel Aviv, IL" is not Illinois, "Boston Spa, UK" is not Boston. */
const ABROAD = /\b(UK|united kingdom|england|scotland|wales|ireland|israel|india|germany|france|netherlands|belgium|switzerland|poland|spain|portugal|(?<!new )mexico|brazil|argentina|colombia|japan|singapore|australia|china|south georgia)\b/i;
const DC = /washington,?\s*d\.?\s?c\b\.?|district of columbia|\bD\.C\./gi;

/** "West Virginia" is not Virginia. */
const STATE_NAMES: [StateCode, RegExp][] = (Object.entries(US_STATES) as [StateCode, string][])
  .map(([code, name]) => [code, new RegExp(code === "VA" ? "(?<!west )\\bvirginia\\b" : `\\b${name}\\b`, "i")]);

/** One posting's place can hold several: "New York, NY; Remote", "Austin or Dallas". */
const partsOf = (location: string) => location.split(/;|\||\s\/\s|\s+or\s+|\s+and\s+/).map((s) => s.trim()).filter(Boolean);

/**
 * The states one place is in. "Remote - TX" is in Texas. Remote, the whole United States, a place
 * abroad and a place code cannot read are in none.
 */
export function statesOf(location: string): StateCode[] {
  // "LA" alone is Los Angeles; after a city it is Louisiana.
  if (location.trim() === "LA") return ["CA"];
  const found = new Set<StateCode>();
  const rest = location.replace(DC, () => {
    found.add("DC");
    return " ";
  });
  // Codes count only in capitals: "in", "or", "me" and "ok" are words.
  const codes = [...rest.matchAll(/\b([A-Z]{2})\b/g)].map((m) => m[1] as string).filter(isStateCode);
  for (const code of codes) found.add(code);
  // A name counts only where no code does: "Delaware, OH" and "Washington, PA" are cities.
  if (!codes.length) for (const [code, re] of STATE_NAMES) if (re.test(rest)) found.add(code);
  // "New Brunswick, NJ" and "Vancouver, WA" are in the United States; "Toronto, CA" is not in California.
  if (CANADA.test(location) || ((PROVINCE.test(location) || CANADA_CITY.test(location)) && [...found].every((s) => s === "CA"))) return [];
  if (ABROAD.test(location)) return [];
  if (!found.size) for (const [re, code] of CITY_STATE) if (re.test(location)) found.add(code);
  return [...found];
}

/**
 * Why a posting falls outside the person's states, or null. It is refused only when every one of
 * its places is in a state and none of those is chosen. A place that is remote, the whole United
 * States, abroad, or one code cannot read keeps the posting.
 */
export function outsideStates(locations: string[], states: readonly string[]): string | null {
  if (!states.length || !locations.length) return null;
  const named: StateCode[] = [];
  for (const part of locations.flatMap(partsOf)) {
    const here = statesOf(part);
    if (!here.length) return null;
    named.push(...here);
  }
  const chosen = new Set(states);
  if (named.some((s) => chosen.has(s))) return null;
  const listed = [...new Set(named)];
  return `outside your states (${listed.slice(0, 4).join(", ")}${listed.length > 4 ? ` and ${listed.length - 4} more` : ""})`;
}
