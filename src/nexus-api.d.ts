/**
 * Minimal type surface for @nexus21/nexus-api (ships no types of its own).
 * We only declare the axios/cheerio-based scrapers we actually call — the
 * puppeteer-backed legacy class is intentionally left out so it never loads.
 */
declare module '@nexus21/nexus-api' {
  interface TikTokResult {
    title?: string;
    video?: { noWatermarkHd?: string; noWatermark?: string; watermark?: string };
    audio?: string | null;
  }
  interface PinterestResult {
    title?: string;
    imageUrl?: string | null;
    videoUrl?: string | null;
    mediaType?: 'video' | 'image';
  }
  interface TwitterResult {
    text?: string;
    videos?: string[];
    images?: string[];
  }
  interface InstagramResult {
    title?: string;
    type?: string;
    mediaUrl?: string | null;
  }
  interface RedditResult {
    title?: string;
    videoUrl?: string | null;
    audioUrl?: string | null;
    externalVideo?: string | null;
    images?: string[];
  }
  interface FacebookResult {
    title?: string;
    video?: { hd?: string | null; sd?: string | null; stream?: string | null };
  }
  interface WebHit {
    title?: string;
    url?: string;
    snippet?: string;
    source?: string;
    time?: string;
    domain?: string;
    pageText?: string | null;
  }
  interface WebInstant {
    answer?: string | null;
    abstract?: string | null;
    source?: string | null;
    url?: string | null;
  }
  interface WebResponse {
    query: string;
    total: number;
    instant: WebInstant | null;
    results: WebHit[];
  }
  interface WebOptions {
    limit?: number;
    deep?: boolean;
  }

  interface YouTubeSearchHit {
    id: string;
    url: string;
    title: string;
    channel?: string;
    duration?: string;
    views?: string;
    thumbnail?: string | null;
    published?: string;
  }
  export function youtubeSearch(query: string, limit?: number): Promise<YouTubeSearchHit[]>;
  export function youtubeDownload(
    url: string,
    savePath: string,
    options?: { quality?: 'audio' | 'hd' | '4k' | 'combined' },
  ): Promise<{ path: string; url: string; size: number }>;

  export function tiktok(url: string): Promise<TikTokResult>;
  export function pinterest(url: string): Promise<PinterestResult>;
  export function twitter(url: string): Promise<TwitterResult>;
  export function instagram(url: string): Promise<InstagramResult>;
  export function reddit(url: string): Promise<RedditResult>;
  export function facebook(url: string): Promise<FacebookResult>;
  export function web(query: string, options?: WebOptions): Promise<WebResponse>;
  export function webSearch(query: string, options?: WebOptions): Promise<WebResponse>;

  // ---- File tools (v1.3.3) ----
  export function textToPdf(
    text: string,
    savePath: string,
    options?: { font?: string; fontSize?: number; margin?: number; pageSize?: string; title?: string },
  ): Promise<{ path: string; size: number }>;
  export function extractZip(
    zipPath: string,
    outputDir: string,
    options?: { overwrite?: boolean },
  ): Promise<{ outputDir: string; files: string[] }>;
  export function createZip(
    sourcePath: string,
    zipPath: string,
    options?: { includeRoot?: boolean },
  ): Promise<{ path: string; size: number; files: string[] }>;
  /** Extract a web page's readable text (up to ~3000 chars), or null. */
  export function fetchPage(url: string): Promise<string | null>;

  // ---- Anime images ----
  interface AnimeImageHit {
    url: string;
    source?: string;
  }
  export function animeImage(opts?: { category?: string; nsfw?: boolean; limit?: number; source?: string }): Promise<AnimeImageHit[]>;

  // ---- Anime / manga info (AniList) ----
  interface AnimeResult {
    id: number;
    malId: number | null;
    title: string;
    titleEn: string | null;
    type: string | null;
    episodes: number | null;
    status: string | null;
    airing: boolean;
    aired: string | null;
    duration: string | null;
    score: string | null;
    synopsis: string | null;
    season: string | null;
    year: number | null;
    studios: string[];
    genres: string[];
    trailer: string | null;
    image: string | null;
    url: string | null;
  }
  export function animeSearch(query: string, limit?: number): Promise<AnimeResult[]>;
  export function animeInfo(id: number): Promise<AnimeResult>;
}
