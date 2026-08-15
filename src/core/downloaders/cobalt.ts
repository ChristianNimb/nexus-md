import axios from 'axios';
import { config } from '../../config.js';
import type { Downloader, DownloadOptions, MediaKind, MediaResult, ProgressFn, Quality } from './types.js';

/**
 * Provider backed by a Cobalt instance (https://github.com/imputnet/cobalt) —
 * an open-source media downloader that handles TikTok, Instagram, Twitter/X,
 * Facebook, and more behind a single JSON API. Point COBALT_API_URL at your own
 * self-hosted instance (recommended) or a public one. Disabled if unset.
 */

// Cobalt handles YouTube too — important as a FALLBACK when yt-dlp gets
// bot-blocked ("sign in to confirm you're not a bot"), since Cobalt uses its own
// infrastructure and doesn't need cookies on this host.
const SOCIAL_RE =
  /(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|twitter\.com|x\.com|facebook\.com|fb\.watch|pinterest\.|pin\.it|reddit\.com|soundcloud\.com|vimeo\.com|dailymotion\.com|twitch\.tv|bilibili\.com|tumblr\.com|snapchat\.com)/i;

export function cobaltEnabled(): boolean {
  return Boolean(config.cobaltUrl);
}

// Map our quality tiers to Cobalt's `videoQuality` values (max resolution).
function cobaltQuality(q: Quality): string {
  if (q === 'sd') return '480';
  if (q === 'max') return 'max';
  return '1080'; // hd
}

interface CobaltResponse {
  status?: string;
  url?: string;
  picker?: { url: string }[];
  error?: { code?: string };
}

async function cobaltPost(body: Record<string, unknown>): Promise<CobaltResponse> {
  const r = await axios.post<CobaltResponse>(config.cobaltUrl as string, body, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    timeout: 60_000,
  });
  return r.data;
}

async function download(url: string, kind: MediaKind, onProgress?: ProgressFn, opts?: DownloadOptions): Promise<MediaResult> {
  if (!config.cobaltUrl) throw new Error('COBALT_API_URL is not configured');

  // Ask Cobalt to resolve the media URL. Cobalt's request schema differs across
  // versions, so if the richer request is rejected (HTTP 400 = bad field), retry
  // with the minimal body every version accepts.
  const full: Record<string, unknown> = {
    url,
    downloadMode: kind === 'audio' ? 'audio' : 'auto',
    videoQuality: cobaltQuality(opts?.quality ?? 'hd'),
  };
  let data: CobaltResponse;
  try {
    data = await cobaltPost(full);
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 400) {
      data = await cobaltPost({ url }); // minimal, maximally-compatible fallback
    } else {
      throw err;
    }
  }

  const link = data?.url ?? data?.picker?.[0]?.url;
  if (!link) {
    throw new Error(`Cobalt returned no media (status: ${data?.status ?? 'unknown'})`);
  }

  // Stream the actual file, reporting progress.
  const file = await axios.get<ArrayBuffer>(link, {
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxContentLength: 100 * 1024 * 1024,
    onDownloadProgress: (e) => {
      if (e.total) onProgress?.(e.loaded / e.total, `${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB`);
    },
  });

  const buffer = Buffer.from(file.data);
  const mimetype = String(file.headers['content-type'] ?? (kind === 'audio' ? 'audio/mpeg' : 'video/mp4'));
  const fileName = link.split('/').pop()?.split('?')[0] || (kind === 'audio' ? 'audio.mp3' : 'video.mp4');
  return { buffer, mimetype, fileName, kind };
}

export const cobaltDownloader: Downloader = {
  name: 'cobalt',
  supports: (url) => cobaltEnabled() && SOCIAL_RE.test(url),
  download,
};
