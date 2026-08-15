/** What we want back from a provider. */
export type MediaKind = 'audio' | 'video';

/**
 * Video quality tiers.
 *   sd  — up to 480p, smallest files (data-saver)
 *   hd  — up to 1080p (default: what most people want)
 *   max — best available, may be very large (4K etc.)
 */
export type Quality = 'sd' | 'hd' | 'max';

export interface DownloadOptions {
  /** Requested video quality. Ignored for audio. Defaults to 'hd'. */
  quality?: Quality;
}

export interface MediaResult {
  buffer: Buffer;
  mimetype: string;
  fileName: string;
  title?: string;
  kind: MediaKind;
}

/** Progress callback (0..1) passed through to the caller's animated bar. */
export type ProgressFn = (fraction: number, note?: string) => void;

/**
 * A download provider. Each platform (YouTube, TikTok, ...) implements this.
 * When a service changes and breaks, you replace one provider, not the app.
 */
export interface Downloader {
  /** Human name, for logs and menus. */
  readonly name: string;
  /** True if this provider can handle the given URL. */
  supports(url: string): boolean;
  /** Fetch the media. `onProgress`/`opts` are optional and best-effort. */
  download(url: string, kind: MediaKind, onProgress?: ProgressFn, opts?: DownloadOptions): Promise<MediaResult>;
}
