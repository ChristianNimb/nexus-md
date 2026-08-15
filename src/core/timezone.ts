import { config } from '../config.js';
import { getSetting, setSetting, deleteSetting } from '../db/index.js';

/**
 * Best-effort timezone resolution per person, so Nexus tells people the time in
 * THEIR zone instead of the server's (which is UTC/GMT in Docker).
 *
 * Priority:  per-user override (.tz)  ->  phone number (country + US area code)
 *            ->  bot default (BOT_TZ)  ->  UTC.
 *
 * Phone inference is approximate: single-timezone countries are accurate; for
 * the US/Canada we refine by area code. Anyone can fix theirs with `.tz`.
 */

/* US/Canada area code -> US zone key. */
type UsZone = 'ET' | 'CT' | 'MT' | 'PT' | 'AKT' | 'HT' | 'AZ';
const US_ZONE_IANA: Record<UsZone, string> = {
  ET: 'America/New_York',
  CT: 'America/Chicago',
  MT: 'America/Denver',
  PT: 'America/Los_Angeles',
  AKT: 'America/Anchorage',
  HT: 'Pacific/Honolulu',
  AZ: 'America/Phoenix',
};

const US_AREA: Record<string, UsZone> = {};
const addAreas = (zone: UsZone, codes: string[]) => codes.forEach((c) => (US_AREA[c] = zone));
// Eastern
addAreas('ET', ['201','202','203','207','212','215','216','223','229','234','240','267','272','276','301','302','304','305','321','323','330','336','339','340','347','351','352','386','404','407','410','412','413','419','434','440','443','470','475','478','484','516','517','518','540','551','561','567','570','571','585','586','603','607','609','610','614','616','617','631','646','678','680','689','703','704','716','717','718','724','727','732','740','754','757','762','770','772','774','781','786','787','802','803','804','810','813','814','828','843','845','848','856','857','860','862','864','872','878','904','908','910','912','914','917','919','929','937','941','947','954','959','973','980','984','989']);
// Central
addAreas('CT', ['205','214','218','224','225','228','251','254','256','262','270','281','309','312','314','316','318','319','320','331','334','337','346','361','380','385','402','405','409','414','417','430','432','469','479','501','504','507','512','515','531','534','563','573','580','601','608','612','618','620','630','636','651','660','662','682','708','712','713','715','731','737','763','769','773','779','785','801','815','816','830','832','847','870','872','901','903','913','915','918','920','931','936','940','952','956','972','979']);
// Mountain
addAreas('MT', ['303','307','308','406','435','505','575','719','720','970','986']);
// Arizona (no DST)
addAreas('AZ', ['480','520','602','623','928']);
// Pacific
addAreas('PT', ['206','209','213','253','279','310','323','341','360','408','415','424','425','442','510','530','559','562','619','626','628','650','657','661','669','707','714','747','752','760','805','818','820','831','858','909','916','925','949','951','971']);
// Alaska
addAreas('AKT', ['907']);
// Hawaii
addAreas('HT', ['808']);

/* Country calling code -> representative IANA zone (non-NANP). */
const COUNTRY_TZ: Record<string, string> = {
  '44': 'Europe/London', '353': 'Europe/Dublin', '33': 'Europe/Paris', '49': 'Europe/Berlin',
  '34': 'Europe/Madrid', '351': 'Europe/Lisbon', '39': 'Europe/Rome', '31': 'Europe/Amsterdam',
  '32': 'Europe/Brussels', '41': 'Europe/Zurich', '43': 'Europe/Vienna', '30': 'Europe/Athens',
  '48': 'Europe/Warsaw', '46': 'Europe/Stockholm', '47': 'Europe/Oslo', '45': 'Europe/Copenhagen',
  '358': 'Europe/Helsinki', '380': 'Europe/Kyiv', '90': 'Europe/Istanbul', '7': 'Europe/Moscow',
  '234': 'Africa/Lagos', '233': 'Africa/Accra', '254': 'Africa/Nairobi', '27': 'Africa/Johannesburg',
  '20': 'Africa/Cairo', '212': 'Africa/Casablanca', '213': 'Africa/Algiers', '216': 'Africa/Tunis',
  '251': 'Africa/Addis_Ababa', '255': 'Africa/Dar_es_Salaam', '256': 'Africa/Kampala',
  '260': 'Africa/Lusaka', '263': 'Africa/Harare', '237': 'Africa/Douala', '221': 'Africa/Dakar',
  '225': 'Africa/Abidjan', '250': 'Africa/Kigali', '265': 'Africa/Blantyre', '244': 'Africa/Luanda',
  '91': 'Asia/Kolkata', '86': 'Asia/Shanghai', '81': 'Asia/Tokyo', '82': 'Asia/Seoul',
  '62': 'Asia/Jakarta', '63': 'Asia/Manila', '60': 'Asia/Kuala_Lumpur', '65': 'Asia/Singapore',
  '66': 'Asia/Bangkok', '84': 'Asia/Ho_Chi_Minh', '92': 'Asia/Karachi', '880': 'Asia/Dhaka',
  '971': 'Asia/Dubai', '966': 'Asia/Riyadh', '974': 'Asia/Qatar', '965': 'Asia/Kuwait',
  '972': 'Asia/Jerusalem', '98': 'Asia/Tehran', '961': 'Asia/Beirut', '962': 'Asia/Amman',
  '964': 'Asia/Baghdad', '977': 'Asia/Kathmandu', '94': 'Asia/Colombo',
  '61': 'Australia/Sydney', '64': 'Pacific/Auckland',
  '55': 'America/Sao_Paulo', '54': 'America/Argentina/Buenos_Aires', '56': 'America/Santiago',
  '57': 'America/Bogota', '58': 'America/Caracas', '51': 'America/Lima', '52': 'America/Mexico_City',
  '593': 'America/Guayaquil', '591': 'America/La_Paz', '595': 'America/Asuncion', '598': 'America/Montevideo',
  '502': 'America/Guatemala', '503': 'America/El_Salvador', '504': 'America/Tegucigalpa',
  '505': 'America/Managua', '506': 'America/Costa_Rica', '507': 'America/Panama', '509': 'America/Port-au-Prince',
  '592': 'America/Guyana', '597': 'America/Paramaribo', '53': 'America/Havana', '501': 'America/Belize',
  // Asia / East Asia
  '852': 'Asia/Hong_Kong', '853': 'Asia/Macau', '886': 'Asia/Taipei', '850': 'Asia/Pyongyang',
  '976': 'Asia/Ulaanbaatar', '856': 'Asia/Vientiane', '855': 'Asia/Phnom_Penh', '95': 'Asia/Yangon',
  '673': 'Asia/Brunei', '93': 'Asia/Kabul', '960': 'Indian/Maldives', '975': 'Asia/Thimphu',
  '998': 'Asia/Tashkent', '996': 'Asia/Bishkek', '992': 'Asia/Dushanbe', '993': 'Asia/Ashgabat',
  '995': 'Asia/Tbilisi', '374': 'Asia/Yerevan', '994': 'Asia/Baku',
  '963': 'Asia/Damascus', '968': 'Asia/Muscat', '973': 'Asia/Bahrain', '967': 'Asia/Aden',
  // Europe (extra)
  '420': 'Europe/Prague', '421': 'Europe/Bratislava', '36': 'Europe/Budapest', '40': 'Europe/Bucharest',
  '359': 'Europe/Sofia', '385': 'Europe/Zagreb', '386': 'Europe/Ljubljana', '381': 'Europe/Belgrade',
  '382': 'Europe/Podgorica', '389': 'Europe/Skopje', '355': 'Europe/Tirane', '356': 'Europe/Malta',
  '357': 'Asia/Nicosia', '352': 'Europe/Luxembourg', '354': 'Atlantic/Reykjavik', '375': 'Europe/Minsk',
  '370': 'Europe/Vilnius', '371': 'Europe/Riga', '372': 'Europe/Tallinn', '373': 'Europe/Chisinau',
  // Africa (extra)
  '228': 'Africa/Lome', '229': 'Africa/Porto-Novo', '226': 'Africa/Ouagadougou', '227': 'Africa/Niamey',
  '223': 'Africa/Bamako', '224': 'Africa/Conakry', '220': 'Africa/Banjul', '231': 'Africa/Monrovia',
  '232': 'Africa/Freetown', '235': 'Africa/Ndjamena', '236': 'Africa/Bangui', '240': 'Africa/Malabo',
  '241': 'Africa/Libreville', '242': 'Africa/Brazzaville', '243': 'Africa/Kinshasa', '249': 'Africa/Khartoum',
  '211': 'Africa/Juba', '252': 'Africa/Mogadishu', '253': 'Africa/Djibouti', '261': 'Indian/Antananarivo',
  '267': 'Africa/Gaborone', '268': 'Africa/Mbabane', '264': 'Africa/Windhoek', '258': 'Africa/Maputo',
  '230': 'Indian/Mauritius', '248': 'Indian/Mahe', '291': 'Africa/Asmara', '218': 'Africa/Tripoli',
  '222': 'Africa/Nouakchott', '245': 'Africa/Bissau', '238': 'Atlantic/Cape_Verde', '257': 'Africa/Bujumbura',
};

/** Friendly aliases people might type with .tz. */
const ALIASES: Record<string, string> = {
  cst: 'America/Chicago', cdt: 'America/Chicago', central: 'America/Chicago',
  est: 'America/New_York', edt: 'America/New_York', eastern: 'America/New_York',
  mst: 'America/Denver', mdt: 'America/Denver', mountain: 'America/Denver',
  pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pacific: 'America/Los_Angeles',
  akt: 'America/Anchorage', alaska: 'America/Anchorage', hst: 'Pacific/Honolulu', hawaii: 'Pacific/Honolulu',
  arizona: 'America/Phoenix', gmt: 'UTC', utc: 'UTC',
  bst: 'Europe/London', uk: 'Europe/London', london: 'Europe/London',
  cet: 'Europe/Paris', cest: 'Europe/Paris', eet: 'Europe/Athens',
  wat: 'Africa/Lagos', cat: 'Africa/Johannesburg', eat: 'Africa/Nairobi', sast: 'Africa/Johannesburg',
  ist: 'Asia/Kolkata', gst: 'Asia/Dubai', jst: 'Asia/Tokyo', kst: 'Asia/Seoul',
  aest: 'Australia/Sydney', nzst: 'Pacific/Auckland',
  // country / city shortcuts
  china: 'Asia/Shanghai', beijing: 'Asia/Shanghai', shanghai: 'Asia/Shanghai', cst_china: 'Asia/Shanghai',
  hongkong: 'Asia/Hong_Kong', hk: 'Asia/Hong_Kong', taiwan: 'Asia/Taipei',
  singapore: 'Asia/Singapore', dubai: 'Asia/Dubai', uae: 'Asia/Dubai',
  tokyo: 'Asia/Tokyo', japan: 'Asia/Tokyo', seoul: 'Asia/Seoul', korea: 'Asia/Seoul',
  india: 'Asia/Kolkata', delhi: 'Asia/Kolkata', mumbai: 'Asia/Kolkata',
  manila: 'Asia/Manila', philippines: 'Asia/Manila', bangkok: 'Asia/Bangkok', thailand: 'Asia/Bangkok',
  jakarta: 'Asia/Jakarta', indonesia: 'Asia/Jakarta', pakistan: 'Asia/Karachi', karachi: 'Asia/Karachi',
  nigeria: 'Africa/Lagos', lagos: 'Africa/Lagos', ghana: 'Africa/Accra', accra: 'Africa/Accra',
  kenya: 'Africa/Nairobi', nairobi: 'Africa/Nairobi', egypt: 'Africa/Cairo', cairo: 'Africa/Cairo',
  southafrica: 'Africa/Johannesburg', joburg: 'Africa/Johannesburg', morocco: 'Africa/Casablanca',
  ny: 'America/New_York', nyc: 'America/New_York', la: 'America/Los_Angeles',
  chicago: 'America/Chicago', toronto: 'America/Toronto', canada: 'America/Toronto',
  paris: 'Europe/Paris', berlin: 'Europe/Berlin', france: 'Europe/Paris', germany: 'Europe/Berlin',
  spain: 'Europe/Madrid', italy: 'Europe/Rome', brazil: 'America/Sao_Paulo', mexico: 'America/Mexico_City',
};

/** Validate an IANA zone by trying to format with it. */
export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Turn a user-typed zone/alias into a valid IANA zone, or undefined. */
export function normalizeZone(input: string): string | undefined {
  const t = input.trim();
  if (!t) return undefined;
  const alias = ALIASES[t.toLowerCase()];
  if (alias) return alias;
  const candidate = t.replace(/\s+/g, '_');
  return isValidZone(candidate) ? candidate : undefined;
}

/** Guess an IANA zone from a phone number (digits, no +). */
export function zoneFromNumber(num: string): string | undefined {
  if (!num) return undefined;
  if (num.startsWith('1') && num.length >= 4) {
    const area = num.slice(1, 4);
    const z = US_AREA[area];
    if (z) return US_ZONE_IANA[z];
    return undefined; // unknown NANP area -> fall through to default
  }
  if (num.startsWith('7')) return COUNTRY_TZ['7'];
  for (const len of [3, 2]) {
    const code = num.slice(0, len);
    if (COUNTRY_TZ[code]) return COUNTRY_TZ[code];
  }
  return undefined;
}

const tzKey = (num: string) => `tz.${num}`;

/** Save a per-user timezone override. */
export function setUserZone(num: string, zone: string): void {
  setSetting(tzKey(num), zone);
}
export function clearUserZone(num: string): void {
  deleteSetting(tzKey(num));
}

/** Resolve the effective zone for a person. Always returns a valid zone. */
export function resolveZone(num: string): string {
  const override = getSetting(tzKey(num));
  if (override && isValidZone(override)) return override;
  const guessed = zoneFromNumber(num);
  if (guessed) return guessed;
  if (config.defaultTz && isValidZone(config.defaultTz)) return config.defaultTz;
  return 'UTC';
}

/** Whether we actually KNOW this person's zone (they set it), vs merely guessed
 *  it from their phone's country code. Callers should not state a guessed
 *  location as fact. */
export function zoneIsKnown(num: string): boolean {
  const override = getSetting(tzKey(num));
  return Boolean(override && isValidZone(override));
}

/** Friendly names for zones whose IANA city label is misleading (China uses one
 *  nationwide zone labelled "Asia/Shanghai", but people aren't all in Shanghai). */
const ZONE_LABEL: Record<string, string> = {
  'Asia/Shanghai': 'China',
  'Asia/Urumqi': 'China (Xinjiang)',
  'Asia/Kolkata': 'India',
  'Asia/Ho_Chi_Minh': 'Vietnam',
  'America/Sao_Paulo': 'Brazil',
  'Europe/Kyiv': 'Ukraine',
};

/** Current UTC offset of a zone as "UTC+8" / "UTC-5". */
function utcOffset(zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    const raw = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    return raw.replace(/^GMT/, 'UTC').replace(/^UTC$/, 'UTC+0');
  } catch {
    return 'UTC';
  }
}

/** A human, non-confusing label for a zone, e.g. "China (UTC+8)" or
 *  "Tokyo (UTC+9)" — used so Nexus never says "Shanghai" to someone in Beijing. */
export function zoneLabel(zone: string): string {
  const name = ZONE_LABEL[zone] ?? (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
  return `${name} (${utcOffset(zone)})`;
}

/** A human-friendly "now" string for a person, e.g. "Sat, Jul 4, 2026, 6:12 PM
 *  (CDT)". The YEAR is essential: without it the AI fills the year in from its
 *  training data and mistakes today's events for "future-dated fiction". */
export function nowFor(num: string): { text: string; zone: string; label: string } {
  const zone = resolveZone(num);
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date());
  return { text, zone, label: zoneLabel(zone) };
}
