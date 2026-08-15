import { youtubeDownloader, ytdlpDownloader, isYouTubeUrl, isGenericVideoUrl } from './youtube.js';
import { cobaltDownloader } from './cobalt.js';
import { nexusApiDownloader } from './nexusapi.js';
import { nexusYoutubeDownloader } from './nexus-youtube.js';
import type { Downloader, Quality } from './types.js';

export * from './types.js';
export { searchYouTube, searchYouTubeMulti, searchOtherPlatforms, searchBilibili, findVideo, youtubeNeedsAuth, recordDownloadError, drainDownloadErrors, isYouTubeUrl, isGenericVideoUrl, youtubeDownloader, ytdlpDownloader } from './youtube.js';
export { cobaltEnabled, cobaltDownloader } from './cobalt.js';
export type { YtHit } from './youtube.js';

/**
 * Provider registry, in priority order. The first provider whose `supports()`
 * returns true handles the URL. yt-dlp covers YouTube + TikTok/IG/X/etc.; Cobalt
 * is the fallback for anything it misses (if COBALT_API_URL is configured).
 */
export const downloaders: Downloader[] = [youtubeDownloader, ytdlpDownloader, nexusYoutubeDownloader, cobaltDownloader, nexusApiDownloader];

/** Find a provider for a URL, or undefined if none applies. */
export function resolveDownloader(url: string): Downloader | undefined {
  return downloaders.find((d) => d.supports(url));
}

/** ALL providers that can handle a URL, in priority order — so a caller can try
 *  the next one if the first fails (e.g. yt-dlp bot-blocked → fall back to Cobalt). */
export function resolveDownloaders(url: string): Downloader[] {
  return downloaders.filter((d) => d.supports(url));
}

/** First http(s) URL found in a block of text. */
export function firstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/i)?.[0];
}

/**
 * Pull a quality keyword out of a command argument and return the cleaned text
 * (keyword removed) plus the chosen tier. Recognises: hd/hq/1080/full/high,
 * sd/low/normal/data/480, and max/best/4k/2k. Defaults to 'hd'.
 *
 * ⚠️ URL-SAFE: URLs are stripped BEFORE scanning for quality words. A link can
 * contain tokens like "hd"/"720p"/"best" at word boundaries (hyphens/slashes) —
 * e.g. "youtu.be/ab-hd-cd12" or "youtu.be/best-of-2024" — and removing those
 * would corrupt the link and break the download. Callers detect the URL
 * separately (firstUrl), so dropping it from the returned text is safe: they use
 * the link for the URL and this text only for a search query / leftover words.
 */
export function parseQuality(arg: string): { text: string; quality: Quality; explicit: boolean } {
  let quality: Quality = 'hd';
  let explicit = false;

  const text = arg
    .replace(/https?:\/\/\S+/gi, ' ') // remove URLs first so they're never mangled
    .replace(/\b(max|best|4k|2160p?|2k|1440p?)\b/i, () => { quality = 'max'; explicit = true; return ''; })
    .replace(/\b(hd|hq|1080p?|720p?|full ?hd|high(?: ?quality)?)\b/i, () => { quality = 'hd'; explicit = true; return ''; })
    .replace(/\b(sd|low|normal|data ?saver?|small|480p?|360p?)\b/i, () => { quality = 'sd'; explicit = true; return ''; })
    .replace(/\s+/g, ' ')
    .trim();

  return { text, quality, explicit };
}

/** Any URL we can (potentially) handle — used by autodl to decide whether to act. */
export function isDownloadableUrl(url: string): boolean {
  return isYouTubeUrl(url) || resolveDownloader(url) !== undefined;
}
