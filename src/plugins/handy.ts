import { command } from '../core/registry.js';
import { httpGet, httpGetBuffer, firstOk } from '../core/net.js';
import { quickGen } from './chatbot.js';
import { logger } from '../logger.js';

/**
 * Handy everyday commands, all backed by FREE, no-key APIs with fallback chains
 * (and, where it makes sense, the local AI as a last resort). Every network call
 * goes through core/net which applies NEXUS_PROXY, so these keep working behind
 * the Great Firewall too.
 *
 *   .weather <city>       .convert 100 USD EUR      .crypto btc
 *   .define <word>        .wiki <topic>             .tr [lang] <text>
 */

/* --------------------------------- weather -------------------------------- */

const WMO: Record<number, string> = {
  0: 'clear sky ☀️', 1: 'mainly clear 🌤️', 2: 'partly cloudy ⛅', 3: 'overcast ☁️',
  45: 'fog 🌫️', 48: 'rime fog 🌫️', 51: 'light drizzle 🌦️', 53: 'drizzle 🌦️', 55: 'heavy drizzle 🌧️',
  61: 'light rain 🌦️', 63: 'rain 🌧️', 65: 'heavy rain 🌧️', 66: 'freezing rain 🌧️', 67: 'freezing rain 🌧️',
  71: 'light snow 🌨️', 73: 'snow 🌨️', 75: 'heavy snow ❄️', 77: 'snow grains 🌨️',
  80: 'showers 🌦️', 81: 'showers 🌧️', 82: 'violent showers ⛈️', 85: 'snow showers 🌨️', 86: 'snow showers 🌨️',
  95: 'thunderstorm ⛈️', 96: 'thunderstorm + hail ⛈️', 99: 'thunderstorm + hail ⛈️',
};

interface GeoResp { results?: { name: string; latitude: number; longitude: number; country?: string; timezone?: string }[] }
interface MeteoResp { current?: { temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; weather_code: number; wind_speed_10m: number } }

async function weatherOpenMeteo(city: string): Promise<string | undefined> {
  const geo = await httpGet<GeoResp>(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`);
  const g = geo.results?.[0];
  if (!g) return undefined;
  const f = await httpGet<MeteoResp>(
    `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m`,
  );
  const c = f.current;
  if (!c) return undefined;
  return (
    `🌦️ *Weather — ${g.name}${g.country ? `, ${g.country}` : ''}*\n${WMO[c.weather_code] ?? 'unknown'}\n` +
    `• Temp: *${Math.round(c.temperature_2m)}°C* (feels ${Math.round(c.apparent_temperature)}°C)\n` +
    `• Humidity: ${c.relative_humidity_2m}%\n• Wind: ${Math.round(c.wind_speed_10m)} km/h`
  );
}

interface WttrResp {
  current_condition?: { temp_C: string; FeelsLikeC: string; humidity: string; windspeedKmph: string; weatherDesc: { value: string }[] }[];
  nearest_area?: { areaName: { value: string }[]; country: { value: string }[] }[];
}

async function weatherWttr(city: string): Promise<string | undefined> {
  const d = await httpGet<WttrResp>(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
  const c = d.current_condition?.[0];
  if (!c) return undefined;
  const a = d.nearest_area?.[0];
  const name = a?.areaName?.[0]?.value ?? city;
  return (
    `🌦️ *Weather — ${name}${a?.country?.[0]?.value ? `, ${a.country[0].value}` : ''}*\n${c.weatherDesc?.[0]?.value ?? ''}\n` +
    `• Temp: *${c.temp_C}°C* (feels ${c.FeelsLikeC}°C)\n• Humidity: ${c.humidity}%\n• Wind: ${c.windspeedKmph} km/h`
  );
}

command({ pattern: 'weather (.+)', desc: 'Current weather for a place', usage: '<city>', category: 'tools' }, async (m, match) => {
  const city = (match?.[1] ?? '').trim();
  await m.react('🌦️');
  const out = await firstOk([() => weatherOpenMeteo(city), () => weatherWttr(city)]);
  await m.reply(out ?? `😕 Couldn't get the weather for *${city}* right now — try again in a bit.`);
});

/* -------------------------------- currency -------------------------------- */

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

async function fxFrankfurter(amt: number, from: string, to: string): Promise<string | undefined> {
  const d = await httpGet<{ rates?: Record<string, number> }>(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
  const r = d.rates?.[to];
  if (r == null) return undefined;
  return `💱 *${fmtMoney(amt)} ${from} = ${fmtMoney(amt * r)} ${to}*\n_1 ${from} = ${r} ${to}_`;
}

async function fxErApi(amt: number, from: string, to: string): Promise<string | undefined> {
  const d = await httpGet<{ rates?: Record<string, number> }>(`https://open.er-api.com/v6/latest/${from}`);
  const r = d.rates?.[to];
  if (r == null) return undefined;
  return `💱 *${fmtMoney(amt)} ${from} = ${fmtMoney(amt * r)} ${to}*\n_1 ${from} = ${r} ${to}_`;
}

// Common currency names → ISO codes, so "yuan", "dollar", "naira" all work.
const CURRENCY_ALIAS: Record<string, string> = {
  dollar: 'USD', dollars: 'USD', usd: 'USD', buck: 'USD', bucks: 'USD',
  euro: 'EUR', euros: 'EUR', eur: 'EUR',
  pound: 'GBP', pounds: 'GBP', gbp: 'GBP', sterling: 'GBP', quid: 'GBP',
  yen: 'JPY', jpy: 'JPY',
  yuan: 'CNY', rmb: 'CNY', renminbi: 'CNY', cny: 'CNY',
  naira: 'NGN', ngn: 'NGN',
  rupee: 'INR', rupees: 'INR', inr: 'INR',
  won: 'KRW', krw: 'KRW',
  ruble: 'RUB', roubles: 'RUB', rub: 'RUB',
  peso: 'MXN', mxn: 'MXN',
  rand: 'ZAR', zar: 'ZAR',
  franc: 'CHF', chf: 'CHF',
  real: 'BRL', reais: 'BRL', brl: 'BRL',
  lira: 'TRY', try: 'TRY',
  dirham: 'AED', aed: 'AED',
  cedi: 'GHS', ghs: 'GHS',
  shilling: 'KES', kes: 'KES',
  cad: 'CAD', aud: 'AUD', nzd: 'NZD', sgd: 'SGD', hkd: 'HKD',
};
function toCurrency(s: string): string | undefined {
  const t = s.trim().toLowerCase().replace(/^(chinese|us|british|japanese|indian|nigerian|canadian|australian)\s+/, '');
  if (/^[a-z]{3}$/.test(t)) return t.toUpperCase();
  return CURRENCY_ALIAS[t];
}

command({ pattern: 'convert (.+)', desc: 'Convert currency at live rates', usage: '<amount> <from> to <to>', category: 'tools' }, async (m, match) => {
  const raw = (match?.[1] ?? '').trim();
  const amt = parseFloat((raw.match(/[\d][\d.,]*/)?.[0] ?? '').replace(/,/g, ''));
  // strip the amount, then split on to/in/into/->/=
  const rest = raw.replace(/[\d][\d.,]*/, ' ').trim();
  let fromStr = '';
  let toStr = '';
  const split = rest.match(/^(.*?)\s+(?:to|in|into|->|→|=)\s+(.*)$/i);
  if (split) {
    fromStr = split[1];
    toStr = split[2];
  } else {
    const parts = rest.split(/\s+/).filter(Boolean);
    fromStr = parts[0] ?? '';
    toStr = parts.slice(1).join(' ');
  }
  const from = toCurrency(fromStr);
  const to = toCurrency(toStr);
  if (!Number.isFinite(amt) || !from || !to) {
    return m.reply('💱 Try: *.convert 20 USD to CNY* — or plain words like *.convert 20 dollars to yuan*.');
  }
  await m.react('💱');
  const out = await firstOk([() => fxFrankfurter(amt, from, to), () => fxErApi(amt, from, to)]);
  await m.reply(out ?? `😕 Couldn't convert *${from} → ${to}* right now — try again in a moment.`);
});

/* --------------------------------- crypto --------------------------------- */

async function cryptoCoinGecko(coin: string): Promise<string | undefined> {
  const d = await httpGet<Record<string, { usd?: number; usd_24h_change?: number }>>(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=usd&include_24hr_change=true`,
  );
  const key = Object.keys(d)[0];
  const p = key ? d[key] : undefined;
  if (!p?.usd) return undefined;
  const ch = p.usd_24h_change ?? 0;
  return `🪙 *${key}* — *$${fmtMoney(p.usd)}*\n${ch >= 0 ? '📈' : '📉'} ${ch.toFixed(2)}% (24h)`;
}

async function cryptoCoinCap(coin: string): Promise<string | undefined> {
  const d = await httpGet<{ data?: { symbol: string; priceUsd: string; changePercent24Hr: string }[] }>(
    `https://api.coincap.io/v2/assets?search=${encodeURIComponent(coin)}&limit=1`,
  );
  const a = d.data?.[0];
  if (!a) return undefined;
  const ch = parseFloat(a.changePercent24Hr);
  return `🪙 *${a.symbol}* — *$${fmtMoney(parseFloat(a.priceUsd))}*\n${ch >= 0 ? '📈' : '📉'} ${ch.toFixed(2)}% (24h)`;
}

command({ pattern: 'crypto (.+)', desc: 'Live crypto price', usage: '<coin, e.g. btc or bitcoin>', category: 'tools' }, async (m, match) => {
  const coin = (match?.[1] ?? '').trim().toLowerCase();
  await m.react('🪙');
  // CoinGecko wants an id (bitcoin); CoinCap searches by symbol (btc) — together they cover both.
  const out = await firstOk([() => cryptoCoinGecko(coin), () => cryptoCoinCap(coin)]);
  await m.reply(out ?? `😕 Couldn't find a price for *${coin}* — try the full name (e.g. *.crypto ethereum*) or the symbol (*.crypto eth*).`);
});

/* ------------------------------- dictionary ------------------------------- */

interface DictEntry { word: string; phonetic?: string; meanings: { partOfSpeech: string; definitions: { definition: string; example?: string }[] }[] }

async function defineApi(word: string): Promise<string | undefined> {
  const d = await httpGet<DictEntry[]>(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  const e = d?.[0];
  if (!e?.meanings?.length) return undefined;
  let out = `📖 *${e.word}*${e.phonetic ? `  _${e.phonetic}_` : ''}`;
  for (const mng of e.meanings.slice(0, 3)) {
    const def = mng.definitions[0];
    if (!def) continue;
    out += `\n\n*${mng.partOfSpeech}* — ${def.definition}`;
    if (def.example) out += `\n_“${def.example}”_`;
  }
  return out;
}

command({ pattern: 'define (.+)', desc: 'Dictionary definition of a word', usage: '<word>', category: 'tools' }, async (m, match) => {
  const word = (match?.[1] ?? '').trim();
  await m.react('📖');
  const out = await firstOk([
    () => defineApi(word),
    async () => {
      const ai = await quickGen(`Define the English word "${word}" briefly: part of speech, a one-line meaning, and a short example sentence. If it isn't a real word, say so.`);
      return ai ? `📖 *${word}*\n\n${ai}` : undefined;
    },
  ]);
  await m.reply(out ?? `😕 Couldn't define *${word}* right now.`);
});

/* -------------------------------- wikipedia ------------------------------- */

async function wikiSummary(topic: string): Promise<string | undefined> {
  // Resolve the best-matching title first, then fetch its summary.
  const s = await httpGet<{ query?: { search?: { title: string }[] } }>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(topic)}&format=json&srlimit=1&origin=*`,
  );
  const title = s.query?.search?.[0]?.title ?? topic;
  const d = await httpGet<{ title: string; extract?: string; content_urls?: { desktop?: { page?: string } } }>(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
  );
  if (!d.extract) return undefined;
  const url = d.content_urls?.desktop?.page;
  const body = d.extract.length > 700 ? `${d.extract.slice(0, 700)}…` : d.extract;
  return `📚 *${d.title}*\n\n${body}${url ? `\n\n🔗 ${url}` : ''}`;
}

command({ pattern: 'wiki (.+)', desc: 'Quick Wikipedia summary', usage: '<topic>', category: 'tools' }, async (m, match) => {
  const topic = (match?.[1] ?? '').trim();
  await m.react('📚');
  const out = await firstOk([
    () => wikiSummary(topic),
    async () => {
      const ai = await quickGen(`Give a short, factual encyclopedia-style summary of "${topic}" in 3-4 sentences. If unsure, say you're not certain.`);
      return ai ? `📚 *${topic}*\n\n${ai}\n\n_(from memory — Wikipedia was unreachable)_` : undefined;
    },
  ]);
  await m.reply(out ?? `😕 Couldn't look up *${topic}* right now.`);
});

/* ------------------------------- translate -------------------------------- */

export const LANG_NAME: Record<string, string> = {
  en: 'English', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese', ko: 'Korean',
  ru: 'Russian', ar: 'Arabic', pt: 'Portuguese', it: 'Italian', hi: 'Hindi', tr: 'Turkish', id: 'Indonesian',
};
// Language NAMES → codes, so ".tr Chinese …" / ".trv French" work (not just codes).
const LANG_ALIAS: Record<string, string> = {
  english: 'en', chinese: 'zh', mandarin: 'zh', spanish: 'es', french: 'fr', german: 'de',
  japanese: 'ja', korean: 'ko', russian: 'ru', arabic: 'ar', portuguese: 'pt', italian: 'it',
  hindi: 'hi', turkish: 'tr', indonesian: 'id', dutch: 'nl', polish: 'pl', swedish: 'sv',
  greek: 'el', hebrew: 'he', thai: 'th', vietnamese: 'vi', ukrainian: 'uk', yoruba: 'yo',
};
/** Resolve a language code OR name → 2-letter code (undefined if unknown). */
export function toLangCode(s: string): string | undefined {
  const t = s.trim().toLowerCase();
  if (LANG_NAME[t]) return t; // already a code
  return LANG_ALIAS[t];
}

async function trGoogle(text: string, to: string): Promise<string | undefined> {
  const d = await httpGet<[[[string]]]>(
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${encodeURIComponent(text)}`,
  );
  const parts = d?.[0];
  if (!Array.isArray(parts)) return undefined;
  return parts.map((p) => p?.[0] ?? '').join('').trim() || undefined;
}

async function trMyMemory(text: string, to: string): Promise<string | undefined> {
  // MyMemory needs a source; guess the opposite of the target for EN<->other.
  const from = to === 'en' ? 'zh' : 'en';
  const d = await httpGet<{ responseData?: { translatedText?: string } }>(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`,
  );
  return d.responseData?.translatedText;
}

/** Translate text to `to` with a full fallback chain: Google → MyMemory → AI.
 *  Shared by the .tr command and voice-note translation. */
export async function translateText(text: string, to: string): Promise<string | undefined> {
  return firstOk([
    () => trGoogle(text, to),
    () => trMyMemory(text, to),
    async () => (await quickGen(`Translate the following into ${LANG_NAME[to] ?? to}. Reply with ONLY the translation, nothing else:\n\n${text}`)) || undefined,
  ]);
}

// NOTE: pattern is `tr(?: (.+))?` (not `tr ?(.*)`) so it never swallows other
// tr-prefixed commands like `.trivia`.
command({ pattern: 'tr(?: (.+))?', desc: 'Translate text (auto-detect, e.g. .tr zh hello)', usage: '[lang] <text>', category: 'tools' }, async (m, match) => {
  let arg = (match?.[1] ?? '').trim() || (m.quoted?.text ?? '').trim();
  if (!arg) return m.reply('Usage: *.tr <text>* (auto), or *.tr <lang> <text>* — e.g. *.tr zh how are you*. You can also reply to a message with *.tr*.');

  // Optional leading language (code OR name — "zh", "chinese", "french") picks
  // the target; else auto-pick.
  let to = '';
  const lead = arg.match(/^([a-z]{2,})\s+/i);
  if (lead) {
    const code = toLangCode(lead[1]);
    if (code) {
      to = code;
      arg = arg.slice(lead[0].length);
    }
  }
  if (!to) to = /[一-鿿]/.test(arg) ? 'en' : 'zh'; // Chinese→English, else →Chinese (owner's common pair)

  await m.react('🌐');
  const out = await translateText(arg, to);
  if (!out) return m.reply('😕 Couldn\'t translate that right now.');
  await m.reply(`🌐 *${LANG_NAME[to] ?? to}:*\n${out}`);
});

/* -------------------------------- country --------------------------------- */

interface CountryResp {
  name?: { common?: string };
  capital?: string[];
  population?: number;
  region?: string;
  currencies?: Record<string, { name?: string }>;
  languages?: Record<string, string>;
  flag?: string;
}

async function countryInfo(name: string): Promise<string | undefined> {
  const d = await httpGet<CountryResp[]>(
    `https://restcountries.com/v3.1/name/${encodeURIComponent(name)}?fields=name,capital,population,region,currencies,languages,flag`,
  );
  const c = d?.[0];
  if (!c?.name?.common) return undefined;
  const cur = c.currencies ? Object.values(c.currencies).map((x) => x.name).filter(Boolean).join(', ') : '—';
  const langs = c.languages ? Object.values(c.languages).join(', ') : '—';
  return (
    `${c.flag ?? '🏳️'} *${c.name.common}*\n` +
    `• Capital: ${c.capital?.[0] ?? '—'}\n• Region: ${c.region ?? '—'}\n` +
    `• Population: ${c.population?.toLocaleString('en-US') ?? '—'}\n• Currency: ${cur || '—'}\n• Languages: ${langs || '—'}`
  );
}

command({ pattern: 'country (.+)', desc: 'Country facts (capital, population…)', usage: '<country>', category: 'tools' }, async (m, match) => {
  const q = (match?.[1] ?? '').trim();
  await m.react('🌍');
  const out = await firstOk([
    () => countryInfo(q),
    async () => {
      const ai = await quickGen(`Give quick facts about the country "${q}": capital, region, rough population, currency, main languages. Short bullet lines.`);
      return ai ? `🌍 *${q}*\n\n${ai}` : undefined;
    },
  ]);
  await m.reply(out ?? `😕 Couldn't find *${q}* right now.`);
});

/* --------------------------------- anime ---------------------------------- */

interface JikanResp {
  data?: {
    title?: string;
    title_english?: string;
    score?: number;
    episodes?: number;
    status?: string;
    synopsis?: string;
    url?: string;
    images?: { jpg?: { image_url?: string } };
  }[];
}

command({ pattern: 'anime (.+)', desc: 'Anime info (score, synopsis, poster)', usage: '<title>', category: 'tools' }, async (m, match) => {
  const q = (match?.[1] ?? '').trim();
  await m.react('🎌');

  // Primary: AniList via @nexus21/nexus-api (richer — genres, studios, trailer).
  try {
    const { animeSearch } = await import('@nexus21/nexus-api');
    const a = (await animeSearch(q, 1))?.[0];
    if (a?.title) {
      const syn = a.synopsis ? (a.synopsis.length > 500 ? `${a.synopsis.slice(0, 500)}…` : a.synopsis) : 'No synopsis available.';
      const bits = [a.score && `⭐ ${a.score}`, a.episodes && `${a.episodes} eps`, a.type, a.status, a.season].filter(Boolean).join(' • ');
      const genres = a.genres?.length ? `\n🏷️ ${a.genres.slice(0, 5).join(', ')}` : '';
      const caption =
        `🎌 *${a.title}*${a.titleEn && a.titleEn !== a.title ? `\n_${a.titleEn}_` : ''}\n${bits}${genres}\n\n${syn}` +
        `${a.trailer ? `\n\n▶️ ${a.trailer}` : ''}${a.url ? `\n🔗 ${a.url}` : ''}`;
      if (a.image) {
        const buf = await httpGetBuffer(a.image).catch(() => undefined);
        if (buf && buf.length > 1000) return void (await m.send({ image: buf, caption }, { quoted: m.raw }));
      }
      return void (await m.reply(caption));
    }
  } catch (err) {
    logger.warn({ err }, 'AniList anime lookup failed; trying Jikan');
  }

  try {
    const d = await httpGet<JikanResp>(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=1&sfw=true`);
    const a = d.data?.[0];
    if (!a?.title) return m.reply(`😕 Couldn't find an anime called "*${q}*".`);
    const syn = a.synopsis ? (a.synopsis.length > 500 ? `${a.synopsis.slice(0, 500)}…` : a.synopsis) : 'No synopsis available.';
    const caption = `🎌 *${a.title_english || a.title}*\n⭐ ${a.score ?? '—'}  •  ${a.episodes ?? '?'} eps  •  ${a.status ?? ''}\n\n${syn}${a.url ? `\n\n🔗 ${a.url}` : ''}`;
    const poster = a.images?.jpg?.image_url;
    if (poster) {
      const buf = await httpGetBuffer(poster).catch(() => undefined);
      if (buf && buf.length > 1000) return void (await m.send({ image: buf, caption }, { quoted: m.raw }));
    }
    await m.reply(caption);
  } catch (err) {
    // Jikan can be unreachable (e.g. from China) — fall back to the local AI.
    logger.warn({ err }, 'anime lookup failed; trying AI');
    const ai = await quickGen(`Give a short info card for the anime "${q}": one line on what it is, its genre, rough rating out of 10, and a 2-sentence synopsis. If it isn't a real anime, say so plainly.`).catch(() => '');
    await m.reply(ai ? `🎌 *${q}*\n\n${ai}\n\n_(couldn't reach the anime database, so this is from memory)_` : `😕 Couldn't look up "*${q}*" right now.`);
  }
});

/* ---------------------------------- time ---------------------------------- */

async function timeIn(city: string): Promise<string | undefined> {
  const geo = await httpGet<GeoResp>(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`);
  const g = geo.results?.[0];
  if (!g?.timezone) return undefined;
  const now = new Date().toLocaleString('en-US', {
    timeZone: g.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  });
  return `🕰️ *${g.name}${g.country ? `, ${g.country}` : ''}*\n${now}\n_${g.timezone}_`;
}

command({ pattern: 'time (.+)', desc: 'Current time in a city', usage: '<city>', category: 'tools' }, async (m, match) => {
  const q = (match?.[1] ?? '').trim();
  await m.react('🕰️');
  const out = await firstOk([() => timeIn(q)]);
  await m.reply(out ?? `😕 Couldn't get the time for *${q}* right now.`);
});

logger.debug('handy plugin loaded');
