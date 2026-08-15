import axios from 'axios';
import { tiktok, pinterest, twitter, instagram, reddit, facebook } from '@nexus21/nexus-api';
import { logger } from '../../logger.js';
import type { Downloader, DownloadOptions, MediaKind, MediaResult, ProgressFn } from './types.js';

/**
 * Fallback provider backed by @nexus21/nexus-api — a self-built, axios/cheerio
 * scraper toolkit for TikTok, Pinterest, Twitter/X, Instagram, Reddit and
 * Facebook. It sits AFTER Cobalt in the registry, so it only runs when Cobalt
 * (or yt-dlp) can't resolve a link. Each helper returns direct media URLs; we
 * fetch the bytes ourselves and hand back a MediaResult.
 *
 * YouTube is deliberately NOT handled here — the package downloads YouTube via
 * yt-dlp too, which the bot already does, so there's nothing to gain.
 */

const SUPPORTED_RE = /(tiktok\.com|instagram\.com|twitter\.com|x\.com|facebook\.com|fb\.watch|reddit\.com|pinterest\.|pin\.it)/i;

function platform(url: string): string | undefined {
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/(twitter\.com|x\.com)/i.test(url)) return 'twitter';
  if (/(facebook\.com|fb\.watch)/i.test(url)) return 'facebook';
  if (/reddit\.com/i.test(url)) return 'reddit';
  if (/pinterest\.|pin\.it/i.test(url)) return 'pinterest';
  return undefined;
}

/** Ask the right scraper for a direct media link, honouring audio vs video. */
async function resolveLink(url: string, kind: MediaKind): Promise<{ link: string; title?: string } | undefined> {
  switch (platform(url)) {
    case 'tiktok': {
      const r = await tiktok(url);
      const link = kind === 'audio' ? r.audio ?? undefined : r.video?.noWatermarkHd || r.video?.noWatermark;
      return link ? { link, title: r.title } : undefined;
    }
    case 'pinterest': {
      const r = await pinterest(url);
      const link = r.videoUrl || r.imageUrl || undefined;
      return link ? { link, title: r.title } : undefined;
    }
    case 'twitter': {
      const r = await twitter(url);
      const link = r.videos?.[0] || r.images?.[0];
      return link ? { link, title: r.text } : undefined;
    }
    case 'instagram': {
      const r = await instagram(url);
      return r.mediaUrl ? { link: r.mediaUrl, title: r.title } : undefined;
    }
    case 'reddit': {
      const r = await reddit(url);
      const link = r.videoUrl || r.externalVideo || r.images?.[0];
      return link ? { link, title: r.title } : undefined;
    }
    case 'facebook': {
      const r = await facebook(url);
      const link = r.video?.hd || r.video?.sd || r.video?.stream || undefined;
      return link ? { link, title: r.title } : undefined;
    }
    default:
      return undefined;
  }
}

async function download(url: string, kind: MediaKind, onProgress?: ProgressFn): Promise<MediaResult> {
  const resolved = await resolveLink(url, kind);
  if (!resolved?.link) throw new Error('nexus-api: no downloadable media found for that link');

  const file = await axios.get<ArrayBuffer>(resolved.link, {
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxContentLength: 100 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
    onDownloadProgress: (e) => {
      if (e.total) onProgress?.(e.loaded / e.total, `${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB`);
    },
  });

  const buffer = Buffer.from(file.data);
  const ct = String(file.headers['content-type'] ?? '');
  const isImage = /image\//i.test(ct) || /\.(jpg|jpeg|png|webp)(\?|$)/i.test(resolved.link);
  const mimetype = ct || (kind === 'audio' ? 'audio/mpeg' : isImage ? 'image/jpeg' : 'video/mp4');
  const ext = kind === 'audio' ? 'mp3' : isImage ? 'jpg' : 'mp4';
  const fileName = resolved.link.split('/').pop()?.split('?')[0]?.replace(/[^\w.\-]/g, '') || `media.${ext}`;
  logger.debug({ url, platform: platform(url), bytes: buffer.length }, 'nexus-api download ok');
  // Images come back as video-kind requests sometimes; report the real kind.
  return { buffer, mimetype, fileName, title: resolved.title, kind: isImage ? 'video' : kind };
}

export const nexusApiDownloader: Downloader = {
  name: 'nexus-api',
  supports: (url) => SUPPORTED_RE.test(url),
  download,
};
