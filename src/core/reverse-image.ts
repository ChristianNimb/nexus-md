import axios from 'axios';
import { logger } from '../logger.js';

/**
 * Free reverse-image search by scraping Yandex (best for people/faces) with a
 * Bing fallback. Returns related result titles as a text blob for Nexus to
 * interpret, or undefined if blocked / nothing found.
 *
 * NOTE: this is scraping — it works best from a home/residential connection.
 * From a locked-down datacenter IP it may hit CAPTCHAs and return nothing; that
 * is expected and handled gracefully.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/');
}

/** Pull the most useful, human-readable titles out of a results page. */
function topTitles(html: string, max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(/"(?:title|alt|text|snippet)":"([^"\\]{5,110})"/g)) {
    const t = decodeEntities(m[1]).trim();
    const key = t.toLowerCase();
    if (!t || /^https?:/i.test(t) || /yandex|bing|search|images?$/i.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const isBlocked = (html: string) => /showcaptcha|are you (a )?robot|smartcaptcha|unusual traffic/i.test(html);

/**
 * Proper Yandex reverse image search: upload the image DIRECTLY to Yandex's CBIR
 * endpoint (no public host needed), then fetch and parse the results page.
 * Emits diagnostic logs so failures are debuggable from the container logs.
 */
async function yandexCbir(image: Buffer): Promise<string | undefined> {
  // 1) Upload the image to Yandex CBIR.
  const form = new FormData();
  form.append('upfile', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'blob.jpg');
  const up = await axios.post<{ url?: string; cbir_id?: string }>(
    'https://yandex.com/images-apphost/image-download?cbird=111&images_avatars_size=preview&images_avatars_namespace=images-cbir',
    form,
    { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, timeout: 25_000, validateStatus: () => true },
  );
  const imgUrl = up.data?.url;
  const cbirId = up.data?.cbir_id;
  if (!imgUrl) {
    logger.warn({ status: up.status, body: JSON.stringify(up.data)?.slice(0, 200) }, 'yandex cbir: upload returned no url');
    return undefined;
  }
  const full = imgUrl.startsWith('//') ? `https:${imgUrl}` : imgUrl;

  // 2) Fetch the results page.
  const res = await axios.get<string>(
    `https://yandex.com/images/search?rpt=imageview&cbir_page=sites&url=${encodeURIComponent(full)}${cbirId ? `&cbir_id=${encodeURIComponent(cbirId)}` : ''}`,
    { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, timeout: 25_000, responseType: 'text', validateStatus: () => true },
  );
  const html = typeof res.data === 'string' ? res.data : '';
  if (isBlocked(html)) {
    logger.warn({ status: res.status, len: html.length }, 'yandex cbir: blocked by captcha');
    return undefined;
  }

  // 3) Parse: the "you might be looking for" guess + related site titles.
  const grab = (re: RegExp) => html.match(re)?.[1]?.trim();
  const guess = grab(new RegExp('"cbir_alt_text":"([^"\\\\]{3,120})"', 'i')) || grab(/"query":\{"text":"([^"\\]{3,120})"/i);
  const titles = topTitles(html, 8).filter((t) => t.length > 4);
  const parts = [guess ? `Best guess: ${decodeEntities(guess)}` : '', ...titles.map((t) => `• ${t}`)].filter(Boolean);
  if (!parts.length) {
    logger.warn({ len: html.length, hasCbir: /cbir/i.test(html) }, 'yandex cbir: no results parsed from page');
    return undefined;
  }
  return parts.join('\n');
}

interface TraceResult {
  result?: Array<{
    anilist?: { title?: { english?: string | null; romaji?: string | null; native?: string | null } };
    filename?: string;
    episode?: number | string | null;
    from?: number;
    similarity?: number;
  }>;
}

/** trace.moe — a real free API (no key) that identifies an ANIME scene from a
 *  frame: title, episode, timestamp. Uploads the image directly, so it doesn't
 *  depend on a public host and actually works reliably (unlike scraping). */
async function traceMoe(image: Buffer): Promise<string | undefined> {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'frame.jpg');
  const res = await axios.post<TraceResult>('https://api.trace.moe/search?anilistInfo&cutBorders', form, {
    timeout: 30_000,
    validateStatus: () => true,
  });
  const r = res.data?.result?.[0];
  if (!r || (r.similarity ?? 0) < 0.9) return undefined; // high bar — trace.moe over-matches
  const title = r.anilist?.title?.english || r.anilist?.title?.romaji || r.anilist?.title?.native || r.filename || 'an anime';
  const ep = r.episode !== null && r.episode !== undefined && r.episode !== '' ? ` · Episode ${r.episode}` : '';
  const t = Math.round(r.from ?? 0);
  const mmss = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  return `Anime: ${title}${ep} · scene around ${mmss} (${Math.round((r.similarity ?? 0) * 100)}% match)`;
}

/** Identify what's in an image. `opts.anime === false` means it's definitely a
 *  real photo (skip trace.moe, which matches real photos to anime frames). */
export async function identifyImage(image: Buffer, opts: { anime?: boolean } = {}): Promise<string | undefined> {
  // 1) Anime scenes — only when the image plausibly IS animation.
  if (opts.anime !== false) {
    try {
      const anime = await traceMoe(image);
      if (anime) return anime;
    } catch (err) {
      logger.warn({ err }, 'identify: trace.moe failed');
    }
  }
  // 2) General / real people — Yandex reverse image search (best-effort).
  try {
    const yx = await yandexCbir(image);
    if (yx) return yx;
  } catch (err) {
    logger.warn({ err }, 'identify: yandex cbir failed');
  }
  return undefined;
}
