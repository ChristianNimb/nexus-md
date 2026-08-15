import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { logger } from '../../logger.js';
import type { Downloader, DownloadOptions, MediaKind, MediaResult, ProgressFn, Quality } from './types.js';

/**
 * YouTube search + download via **yt-dlp** — the actively-maintained tool that
 * keeps working when YouTube changes its internals (the old ytdl-core/youtube-sr
 * libraries broke every few weeks, which is why .play/.video kept failing).
 *
 * yt-dlp is installed in the Docker image (pip). Override the binary path with
 * the YTDLP_BIN env var if you run outside Docker.
 */

const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';

/**
 * Optional proxy for yt-dlp — the fix for a server behind a firewall (e.g. in
 * mainland China) that can't reach YouTube/TikTok/Instagram/X directly. Point it
 * at your VPN/Clash/v2ray, e.g. NEXUS_PROXY=http://host.docker.internal:7890 or
 * socks5://host.docker.internal:7891. Falls back to the standard HTTPS/HTTP_PROXY
 * env vars. If unset, yt-dlp connects directly (unchanged behaviour).
 * NOTE: from inside Docker, "localhost" is the container — use host.docker.internal
 * (or the host's LAN IP) so the proxy on your computer is reachable.
 */
const PROXY =
  process.env.NEXUS_PROXY ||
  process.env.YTDLP_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;
function proxyArgs(): string[] {
  return PROXY ? ['--proxy', PROXY] : [];
}

/** Optional Netscape cookies.txt path — set YTDLP_COOKIES to defeat YouTube's
 *  "sign in to confirm you're not a bot" wall on blocked hosts. */
const COOKIES = process.env.YTDLP_COOKIES;

// yt-dlp REWRITES the cookies file (to refresh YouTube's rotating session
// tokens), so a read-only mount makes it crash ("Read-only file system"). Copy
// the mounted cookies to a writable temp once and hand yt-dlp the COPY — the
// host file stays pristine, and yt-dlp can update its working copy freely.
let workingCookies: string | undefined;
let cookiesReady = false;
function resolveCookies(): string | undefined {
  if (!COOKIES) return undefined;
  if (cookiesReady) return workingCookies;
  cookiesReady = true;
  try {
    const dest = join(tmpdir(), 'nexus-cookies.txt');
    copyFileSync(COOKIES, dest);
    workingCookies = dest;
  } catch (err) {
    logger.warn({ err }, 'could not copy cookies to a writable temp; using the original path');
    workingCookies = COOKIES;
  }
  return workingCookies;
}
function cookieArgs(): string[] {
  const path = resolveCookies();
  return path ? ['--cookies', path] : [];
}

// When YouTube rejects this host for auth ("sign in to confirm you're not a
// bot"), remember it for a while so callers skip the doomed YouTube attempts and
// go straight to the working fallbacks (TikTok/Bilibili). Cleared after cooldown,
// and never set if cookies are configured.
let ytAuthBlockedUntil = 0;
const YT_BLOCK_COOLDOWN = 15 * 60_000;
export function youtubeNeedsAuth(): boolean {
  return !COOKIES && Date.now() < ytAuthBlockedUntil;
}
function noteYoutubeError(url: string, message: string): void {
  if (isYouTubeUrl(url) && /cookies|sign[\s-]?in|not a bot|\blogin\b|authentication/i.test(message)) {
    ytAuthBlockedUntil = Date.now() + YT_BLOCK_COOLDOWN;
  }
}

// Keep the last few errors so the owner can see WHY things failed (surfaced in
// chat) instead of digging through docker logs.
const recentErrors: string[] = [];
function shortErr(err: unknown): string {
  const e = err as { message?: string };
  return (e?.message ?? String(err))
    .replace(/https?:\/\/\S+/g, '') // drop noisy URLs
    .replace(/^yt-dlp exited \d+:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}
export function recordDownloadError(context: string, err: unknown): void {
  recentErrors.push(`${context}: ${shortErr(err)}`);
  while (recentErrors.length > 8) recentErrors.shift();
}
/** Return and clear the recorded errors (owner diagnostics). */
export function drainDownloadErrors(): string[] {
  const out = [...recentErrors];
  recentErrors.length = 0;
  return out;
}

export interface YtHit {
  url: string;
  title: string;
  duration: string;
  channel?: string;
  views?: string;
}

export function isYouTubeUrl(url: string): boolean {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}

/** Format a duration in seconds as m:ss (or h:mm:ss). */
function fmtDuration(sec: number): string {
  if (!sec || sec < 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Run yt-dlp, collecting stdout. Rejects with a readable error on failure. */
function ytdlp(args: string[], onStderr?: (chunk: string) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => {
      err.push(d);
      onStderr?.(d.toString());
    });
    p.on('error', (e) => reject(new Error(`yt-dlp not found or failed to start (${e.message}). Is yt-dlp installed?`)));
    p.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`yt-dlp exited ${code}: ${Buffer.concat(err).toString().trim().slice(-300) || 'unknown error'}`)),
    );
  });
}

/** Find the top video for a text query. Returns undefined if nothing is found.
 *  NOTE: `--no-playlist` must NOT be passed here — a "ytsearch" result IS a
 *  playlist, and that flag makes yt-dlp return nothing (the "no video found"
 *  bug). `--flat-playlist` keeps it fast (no per-video extraction). */
export async function searchYouTube(query: string): Promise<YtHit | undefined> {
  try {
    const raw = await ytdlp(['-J', '--flat-playlist', '--no-warnings', ...proxyArgs(), ...cookieArgs(), `ytsearch1:${query}`]);
    const data = JSON.parse(raw.toString()) as {
      entries?: { id?: string; webpage_url?: string; url?: string; title?: string; duration?: number }[];
    };
    const v = data.entries?.[0];
    if (!v) return undefined;
    const url = v.webpage_url ?? v.url ?? (v.id ? `https://youtu.be/${v.id}` : undefined);
    if (!url) return undefined;
    return { url, title: v.title ?? 'Unknown', duration: v.duration ? fmtDuration(v.duration) : '' };
  } catch (err) {
    logger.error({ err, query }, 'youtube search failed');
    recordDownloadError('YouTube search', err);
    return undefined;
  }
}

/** Find the TOP N videos for a text query (for the "pick a result" flow). */
export async function searchYouTubeMulti(query: string, n = 5): Promise<YtHit[]> {
  // Primary: @nexus21/nexus-api's Innertube-backed search — richer (channel,
  // duration, views) and fast. Fall back to yt-dlp's ytsearch if it comes up empty.
  try {
    const { youtubeSearch } = await import('@nexus21/nexus-api');
    const vids = await youtubeSearch(query, n);
    const hits: YtHit[] = vids
      .filter((v) => v.url && v.title)
      .slice(0, n)
      .map((v) => ({ url: v.url, title: v.title, duration: v.duration ?? '', channel: v.channel, views: v.views }));
    if (hits.length) return hits;
  } catch (err) {
    logger.warn({ err: (err as { message?: string }).message, query }, 'nexus-api youtube search failed — falling back to yt-dlp');
  }
  try {
    const raw = await ytdlp(['-J', '--flat-playlist', '--no-warnings', ...proxyArgs(), ...cookieArgs(), `ytsearch${n}:${query}`]);
    const data = JSON.parse(raw.toString()) as {
      entries?: { id?: string; webpage_url?: string; url?: string; title?: string; duration?: number }[];
    };
    const hits: YtHit[] = [];
    for (const v of data.entries ?? []) {
      const url = v.webpage_url ?? v.url ?? (v.id ? `https://youtu.be/${v.id}` : undefined);
      if (!url) continue;
      hits.push({ url, title: v.title ?? 'Unknown', duration: v.duration ? fmtDuration(v.duration) : '' });
      if (hits.length >= n) break;
    }
    return hits;
  } catch (err) {
    logger.error({ err, query }, 'youtube multi-search failed');
    recordDownloadError('YouTube search', err);
    return [];
  }
}

/**
 * Other video platforms yt-dlp handles from a LINK (TikTok, Instagram, X/Twitter,
 * Facebook, Reddit, etc.). Keyword search stays YouTube-only (those sites have no
 * free text search), but any of these links can be downloaded and sent to chat.
 */
const GENERIC_VIDEO_SITES =
  /(?:tiktok\.com|vt\.tiktok\.com|instagram\.com|instagr\.am|(?:^|\/\/|\.)(?:twitter|x)\.com|fxtwitter\.com|facebook\.com|fb\.watch|reddit\.com|redd\.it|pinterest\.|pin\.it|twitch\.tv|clips\.twitch|dailymotion\.com|vimeo\.com|streamable\.com|snapchat\.com|tumblr\.com|kick\.com|bilibili\.com)/i;

export function isGenericVideoUrl(url: string): boolean {
  return !isYouTubeUrl(url) && GENERIC_VIDEO_SITES.test(url);
}

/**
 * Fallback keyword search across OTHER platforms (TikTok/IG/X/…), for when
 * YouTube returns nothing (or is blocked on this host). Those sites have no free
 * search API, so we web-search (DuckDuckGo HTML) for the query and pull the first
 * supported video link out of the results, then yt-dlp can download it.
 */
export async function searchOtherPlatforms(query: string): Promise<string | undefined> {
  try {
    const res = await axios.get<string>('https://html.duckduckgo.com/html/', {
      params: { q: `${query} tiktok OR instagram video` },
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      },
      timeout: 15_000,
    });
    const html = typeof res.data === 'string' ? res.data : '';

    // Parse RESULT PAIRS (link text + target URL) so we can rank by how well the
    // title matches the query — instead of blindly grabbing the first link (which
    // is why the downloaded clip often didn't match the search words).
    const results: { title: string; url: string }[] = [];
    const linkRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    for (const m of html.matchAll(linkRe)) {
      const uddg = m[1].match(/uddg=([^&"']+)/);
      let url: string | undefined;
      try {
        url = uddg ? decodeURIComponent(uddg[1]) : m[1];
      } catch {
        continue;
      }
      if (!url || !isGenericVideoUrl(url)) continue;
      const title = m[2].replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
      results.push({ title, url });
    }

    // Backup: if the structured parse found nothing, use raw redirect targets.
    if (!results.length) {
      const raw: string[] = [];
      for (const m of html.matchAll(/uddg=([^&"']+)/g)) {
        try {
          raw.push(decodeURIComponent(m[1]));
        } catch {
          /* skip */
        }
      }
      const supported = raw.filter((u) => isGenericVideoUrl(u));
      return supported.find((u) => /tiktok/i.test(u)) ?? supported[0];
    }

    // Rank: more query words present in the title = better match; break ties by
    // preferring TikTok (downloads without a login, unlike IG/X).
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const score = (t: string) => {
      const lt = t.toLowerCase();
      return words.reduce((n, w) => n + (lt.includes(w) ? 1 : 0), 0);
    };
    results.sort((a, b) => {
      const d = score(b.title) - score(a.title);
      if (d !== 0) return d;
      return (/tiktok/i.test(b.url) ? 1 : 0) - (/tiktok/i.test(a.url) ? 1 : 0);
    });
    // Only accept a result whose title actually shares a word with the query —
    // otherwise it's a mismatch, so return nothing and let the next source try.
    const best = results[0];
    if (!best) return undefined;
    return !words.length || score(best.title) > 0 ? best.url : undefined;
  } catch (err) {
    logger.warn({ err, query }, 'cross-platform video search failed');
    recordDownloadError('Web search (TikTok/IG/X)', err);
    return undefined;
  }
}

/**
 * Bilibili keyword search via yt-dlp's built-in `bilisearch` extractor — a REAL
 * search (like YouTube's), and Bilibili isn't bot-blocked or login-walled the way
 * YouTube/IG/X are, so it's a dependable last-resort source.
 */
export async function searchBilibili(query: string): Promise<YtHit | undefined> {
  try {
    // Pull the top 5 so we can pick the BEST title match (not just #1) — Bilibili
    // ranks non-Chinese queries poorly, which is why the result often didn't match.
    const raw = await ytdlp(['-J', '--flat-playlist', '--no-warnings', ...proxyArgs(), `bilisearch5:${query}`]);
    const data = JSON.parse(raw.toString()) as {
      entries?: { id?: string; webpage_url?: string; url?: string; title?: string; duration?: number }[];
    };
    const entries = data.entries ?? [];
    if (!entries.length) return undefined;

    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const score = (t?: string) => {
      const lt = (t ?? '').toLowerCase();
      return words.reduce((n, w) => n + (lt.includes(w) ? 1 : 0), 0);
    };
    const v = [...entries].sort((a, b) => score(b.title) - score(a.title))[0];

    // Require at least one query word in the title, else skip (better to try the
    // next source / say "not found" than send an unrelated clip).
    if (words.length && score(v.title) === 0) {
      logger.info({ query, title: v.title }, 'bilibili: no title match — skipping');
      return undefined;
    }
    const url = v.webpage_url ?? v.url ?? (v.id ? `https://www.bilibili.com/video/${v.id}` : undefined);
    if (!url) return undefined;
    return { url, title: v.title ?? 'Unknown', duration: v.duration ? fmtDuration(v.duration) : '' };
  } catch (err) {
    logger.error({ err, query }, 'bilibili search failed');
    recordDownloadError('Bilibili search', err);
    return undefined;
  }
}

/**
 * Find a video for a text query: YouTube first, then fall back to other
 * platforms (TikTok/IG/X) automatically. Returns undefined only if nothing at
 * all could be found.
 */
export async function findVideo(query: string): Promise<YtHit | undefined> {
  const yt = await searchYouTube(query);
  if (yt) return yt;
  const url = await searchOtherPlatforms(query);
  if (url) return { url, title: query, duration: '' };
  return undefined;
}

/** Parse a percentage out of a yt-dlp progress line ("[download]  42.3% of ..."). */
function parsePercent(s: string): number | undefined {
  const m = s.match(/(\d+(?:\.\d+)?)%/);
  return m ? Math.min(1, parseFloat(m[1]) / 100) : undefined;
}

/**
 * yt-dlp format selector for a given quality tier. We prefer an mp4 that WhatsApp
 * plays inline, merging separate video+audio streams when needed.
 *   sd  → ≤480p (small)   hd → ≤1080p (default)   max → best available
 */
function videoFormat(quality: Quality): string {
  if (quality === 'sd') {
    return 'best[ext=mp4][height<=480]/best[height<=480]/bestvideo[height<=480]+bestaudio/best';
  }
  if (quality === 'max') {
    return 'best[ext=mp4]/bestvideo+bestaudio/best';
  }
  // hd (default). Prefer a SINGLE ready-made mp4 first (fast, no ffmpeg merge —
  // more reliable on slow/flaky networks); only fall back to a video+audio merge
  // when no progressive file exists.
  return (
    'best[ext=mp4][height<=1080]/' +
    'best[height<=1080]/' +
    'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/' +
    'bestvideo[height<=1080]+bestaudio/best'
  );
}

async function download(url: string, kind: MediaKind, onProgress?: ProgressFn, opts?: DownloadOptions): Promise<MediaResult> {
  const quality: Quality = opts?.quality ?? 'hd';
  const dir = await mkdtemp(join(tmpdir(), 'nexus-yt-'));
  try {
    const outTmpl = join(dir, '%(title).64s.%(ext)s');
    const onErr = (chunk: string) => {
      const f = parsePercent(chunk);
      if (f !== undefined) onProgress?.(f, `${(f * 100).toFixed(0)}%`);
    };
    // YouTube-only args, applied ONLY to YouTube URLs — never to TikTok/Bilibili
    // (a YouTube cookies file on those sites is pointless and can break them).
    //   • with cookies: hand yt-dlp the cookies, use its default cookie-aware client.
    //   • without cookies: try alternate clients to dodge the "not a bot" wall.
    const ytArgs = !isYouTubeUrl(url)
      ? []
      : COOKIES
        ? cookieArgs()
        : ['--extractor-args', 'youtube:player_client=android,web,tv'];
    const common = [
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '--retries',
      '3',
      ...proxyArgs(), // route through a proxy/VPN when configured (e.g. China)
      ...ytArgs,
      '-o',
      outTmpl,
      url,
    ];

    if (kind === 'audio') {
      // Higher audio quality (0 = best VBR) now that we care about quality.
      await ytdlp(['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0', ...common], onErr);
    } else {
      // Quality tier chosen by the caller (default HD/1080p). Prefer a muxed mp4,
      // fall back to best video+audio and merge to mp4.
      await ytdlp(['-f', videoFormat(quality), '--merge-output-format', 'mp4', ...common], onErr);
    }

    const files = await readdir(dir);
    const wantExt = kind === 'audio' ? /\.mp3$/i : /\.(mp4|mkv|webm)$/i;
    const file = files.find((f) => wantExt.test(f)) ?? files[0];
    if (!file) throw new Error('yt-dlp produced no output file');

    const buffer = await readFile(join(dir, file));
    const title = file.replace(/\.[a-z0-9]+$/i, '');
    return kind === 'audio'
      ? { buffer, mimetype: 'audio/mpeg', fileName: `${title}.mp3`, title, kind }
      : { buffer, mimetype: 'video/mp4', fileName: `${title}.mp4`, title, kind };
  } catch (err) {
    noteYoutubeError(url, (err as Error)?.message ?? ''); // learn if YouTube is auth-blocking us
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Provider implementation for the registry. */
export const youtubeDownloader: Downloader = {
  name: 'youtube',
  supports: isYouTubeUrl,
  download,
};

/** Same yt-dlp download engine, for TikTok / Instagram / X / Facebook / etc. */
export const ytdlpDownloader: Downloader = {
  name: 'yt-dlp',
  supports: isGenericVideoUrl,
  download,
};
