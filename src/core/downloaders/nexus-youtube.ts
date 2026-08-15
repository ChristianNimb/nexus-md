import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { youtubeDownload } from '@nexus21/nexus-api';
import { isYouTubeUrl } from './youtube.js';
import { logger } from '../../logger.js';
import type { Downloader, DownloadOptions, MediaKind, MediaResult, ProgressFn } from './types.js';

/**
 * YouTube downloader backed by @nexus21/nexus-api (yt-dlp under the hood, with
 * its own cookie auto-detection). Sits AFTER the bot's own yt-dlp/ytdl providers
 * as a fallback — when those get bot-blocked, this gives another shot, and it
 * picks up cookies from ~/youtube_cookies.txt (see the Dockerfile symlink).
 *
 * It downloads to a temp file, so we read the bytes back and clean up.
 */

function mapQuality(kind: MediaKind, q?: DownloadOptions['quality']): 'audio' | 'hd' | '4k' | 'combined' {
  if (kind === 'audio') return 'audio';
  if (q === 'max') return '4k';
  if (q === 'sd') return 'combined';
  return 'hd';
}

async function download(url: string, kind: MediaKind, onProgress?: ProgressFn, opts?: DownloadOptions): Promise<MediaResult> {
  const dir = await mkdtemp(join(tmpdir(), 'nexyt-'));
  const savePath = join(dir, 'media.mp4');
  onProgress?.(0.05, 'fetching from YouTube…');
  try {
    const r = await youtubeDownload(url, savePath, { quality: mapQuality(kind, opts?.quality) });
    const buffer = await readFile(r.path);
    if (!buffer.length) throw new Error('nexus-yt produced an empty file');
    logger.debug({ url, bytes: buffer.length }, 'nexus-yt download ok');
    return {
      buffer,
      mimetype: kind === 'audio' ? 'audio/mpeg' : 'video/mp4',
      fileName: basename(r.path),
      kind,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const nexusYoutubeDownloader: Downloader = {
  name: 'nexus-yt',
  supports: (url) => isYouTubeUrl(url),
  download,
};
