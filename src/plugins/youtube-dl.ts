import { command } from '../core/registry.js';
import { ProgressBar } from '../core/progress.js';
import { searchYouTube, searchYouTubeMulti, searchOtherPlatforms, searchBilibili, youtubeNeedsAuth, recordDownloadError, drainDownloadErrors, youtubeDownloader, resolveDownloaders, firstUrl, parseQuality } from '../core/downloaders/index.js';
import { sendMedia, promptQuality } from './autodl.js';
import { markConsumed } from '../core/pending.js';
import { logger } from '../logger.js';
import type { MediaKind, Quality, YtHit } from '../core/downloaders/index.js';
import type { Message } from '../core/message.js';

/** Pull a URL from the argument, the replied-to message, or the message body. */
function pickUrl(m: Message, arg?: string): string | undefined {
  return firstUrl(arg ?? '') ?? (m.quoted?.text ? firstUrl(m.quoted.text) : undefined) ?? firstUrl(m.body);
}

/** A text query from the argument, or the replied-to message's text. */
function pickQuery(m: Message, arg?: string): string | undefined {
  return arg?.trim() || m.quoted?.text?.trim() || undefined;
}

/**
 * Try to download one URL and send it. Returns true on success. On failure it
 * fails QUIETLY (so the caller can try another source) — the caller shows the
 * final error only if every source is exhausted.
 */
async function tryFetch(m: Message, url: string, title: string, kind: MediaKind, quality: Quality = 'hd'): Promise<boolean> {
  // Try EVERY capable provider for this URL. Crucially, if yt-dlp is bot-blocked
  // on YouTube, this falls through to Cobalt (own infra, no cookies needed).
  const providers = resolveDownloaders(url);
  if (!providers.length) providers.push(youtubeDownloader);

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const more = i < providers.length - 1;
    const label = kind === 'video' ? `${title} (${quality.toUpperCase()})` : title;
    const bar = await ProgressBar.start(m, `Downloading: ${label}`, '📥');
    try {
      const media = await provider.download(url, kind, (f, note) => void bar.update(f, note), { quality });
      await bar.finish(`✅ *${media.title ?? title}*`);
      // Size-aware send (big HD videos go out as documents so they don't vanish).
      await sendMedia(m, media, kind === 'video' ? (media.title ?? title) : undefined);
      return true;
    } catch (err) {
      logger.error({ err, url, provider: provider.name }, 'download attempt failed');
      recordDownloadError(`Download (${provider.name})`, err);
      await bar.finish(more ? `⚠️ ${provider.name} failed — trying another source…` : `⚠️ ${provider.name} couldn’t get it.`);
    }
  }
  return false;
}

/**
 * Keyword or link → media. Order: a pasted link → YouTube search → automatic
 * fallback to other platforms (TikTok/IG/X) if YouTube can't be found OR can't be
 * downloaded (e.g. YouTube is bot-blocking this host).
 */
async function fetchFlow(m: Message, q: string, kind: MediaKind, quality: Quality = 'hd'): Promise<void> {
  const link = firstUrl(q);
  if (link) {
    if (!(await tryFetch(m, link, q, kind, quality))) {
      await m.reply('❌ Couldn’t download that link — it may be private, region-locked, or unsupported.');
    }
    return;
  }

  let found = false;

  // 1) YouTube — UNLESS we've learned it's auth-blocking this host (skip the
  //    doomed wait and go straight to sources that actually work here).
  if (!youtubeNeedsAuth()) {
    const yt = await searchYouTube(q);
    if (yt) {
      found = true;
      if (await tryFetch(m, yt.url, yt.title, kind, quality)) return;
    }
  }

  // 2) TikTok / IG / X (web-search for a link, then download).
  const alt = await searchOtherPlatforms(q);
  if (alt) {
    found = true;
    if (await tryFetch(m, alt, q, kind, quality)) return;
  }

  // 3) Bilibili keyword search (reliable — no login/bot-block).
  const bili = await searchBilibili(q);
  if (bili) {
    found = true;
    if (await tryFetch(m, bili.url, bili.title, kind, quality)) return;
  }

  // Nothing worked. Build the base message…
  let msg: string;
  if (!found) {
    msg = '❌ Couldn’t find that anywhere. Try different words, or paste a video *link*.';
  } else if (youtubeNeedsAuth()) {
    msg =
      '❌ Couldn’t grab it. YouTube is blocking this server (it needs a login/cookies — see COOKIES_SETUP.md), and the other sites didn’t have a working copy. Paste a TikTok/Bilibili *link* and I’ll fetch it.';
  } else {
    msg = '❌ Found it, but every source failed to download right now. Try again shortly, or paste a direct *link*.';
  }

  // …and, for the OWNER only, append the real per-source errors so we can see
  // exactly what's wrong instead of guessing. (Hidden from regular users.)
  const errs = drainDownloadErrors();
  if (m.isOwner && errs.length) {
    msg += `\n\n🛠️ *diagnostics:*\n${errs.slice(-5).map((e) => `• ${e}`).join('\n')}`;
  }
  await m.reply(msg);
}

// ---- Search → pick a result → (video: pick quality) → download ----------------
// A guided flow: a text query shows the top results; the user replies with a
// number to choose; audio downloads straight away, video chains into the quality
// picker (see autodl.promptQuality).
const pendingSearch = new Map<string, { results: YtHit[]; kind: MediaKind; at: number }>();
const sKey = (m: Message) => `${m.chat}:${m.sender}`;
const SEARCH_TTL = 5 * 60_000;

/** Peek: is this message a valid pick (1..N) for a pending result list? */
export function isSearchChoice(m: Message): boolean {
  const p = pendingSearch.get(sKey(m));
  if (!p || Date.now() - p.at > SEARCH_TTL) return false;
  const n = parseInt(m.body.trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= p.results.length;
}

function resultsMenu(results: YtHit[], kind: MediaKind): string {
  const emoji = kind === 'audio' ? '🎵' : '🎬';
  const lines = results.map((r, i) => {
    const meta = [r.channel, r.duration, r.views && `${r.views}`].filter(Boolean).join(' · ');
    return `*${i + 1}.* ${r.title}${meta ? `\n     _${meta}_` : ''}`;
  });
  return `${emoji} *Top results — which one?*\n\n${lines.join('\n\n')}\n\n_Reply with the number (1–${results.length})._`;
}

/** Show a result menu for a query, or fall back to the classic one-shot flow. */
async function searchPicker(m: Message, query: string, kind: MediaKind): Promise<void> {
  await m.react('🔎');
  const results = await searchYouTubeMulti(query, 5);
  if (!results.length) {
    // YouTube empty/blocked → classic auto-pick across other platforms.
    await fetchFlow(m, query, kind);
    return;
  }
  pendingSearch.set(sKey(m), { results, kind, at: Date.now() });
  await m.reply(resultsMenu(results, kind));
}

// Passive: catch the number reply that picks a search result.
command({ on: 'message' }, async (m) => {
  const key = sKey(m);
  const p = pendingSearch.get(key);
  if (!p) return;
  if (Date.now() - p.at > SEARCH_TTL) return void pendingSearch.delete(key);
  const n = parseInt(m.body.trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > p.results.length) return; // not a pick
  pendingSearch.delete(key);
  markConsumed(m.raw?.key?.id); // so DM auto-chat doesn't also reply
  const hit = p.results[n - 1];
  if (p.kind === 'audio') {
    if (!(await tryFetch(m, hit.url, hit.title, 'audio'))) await m.reply('❌ Couldn\'t grab that one — try another number or search again.');
  } else {
    await promptQuality(m, hit.url, hit.title); // → quality picker → download
  }
});

/** Search + audio. Accepts a query (shows a pick list), a link, or a reply. */
command(
  { pattern: 'play ?(.*)', desc: 'Play a song — search & pick, or a link', usage: '<song | link>', category: 'downloader' },
  async (m, match) => {
    const rawArg = match?.[1] ?? '';
    const link = firstUrl(rawArg);
    if (link) return void (await fetchFlow(m, link, 'audio'));
    const q = pickQuery(m, rawArg);
    if (!q) return m.reply('🎵 What should I play? *.play <song name>* — or paste a link.');
    await searchPicker(m, q, 'audio');
  },
);

/** Search + video. Query → pick a result → pick quality → download. */
command(
  { pattern: 'video ?(.*)', desc: 'Find a video — search & pick, or a link', usage: '<query | link>', category: 'downloader' },
  async (m, match) => {
    const rawArg = match?.[1] ?? '';
    const link = firstUrl(rawArg);
    if (link) {
      const { quality } = parseQuality(rawArg);
      return void (await fetchFlow(m, link, 'video', quality));
    }
    const { text } = parseQuality(rawArg);
    const q = pickQuery(m, text);
    if (!q) return m.reply('🎬 What video? *.video <search words>* — or paste a link.');
    await searchPicker(m, q, 'video');
  },
);

/** Direct URL variants — accept a link, or reply to a message containing one. */
command(
  { pattern: 'ytmp3 ?(.*)', desc: 'Audio from a YouTube link', usage: '<url | reply>', category: 'downloader' },
  async (m, match) => {
    const url = pickUrl(m, match?.[1]);
    if (!url || !youtubeDownloader.supports(url)) return m.reply('Reply to a YouTube link, or use .ytmp3 <url>');
    if (!(await tryFetch(m, url, 'audio', 'audio'))) await m.reply('❌ Download failed — YouTube may be blocking this host right now.');
  },
);

command(
  { pattern: 'ytmp4 ?(.*)', desc: 'Video from a YouTube link (add hd/sd/max)', usage: '<url | reply> [hd|sd|max]', category: 'downloader' },
  async (m, match) => {
    const rawArg = match?.[1] ?? '';
    // URL from the RAW arg (parseQuality strips URLs); quality from the words.
    const { quality } = parseQuality(rawArg);
    const url = pickUrl(m, rawArg);
    if (!url || !youtubeDownloader.supports(url)) return m.reply('Reply to a YouTube link, or use .ytmp4 <url> (add *hd*, *sd*, or *max*)');
    if (!(await tryFetch(m, url, 'video', 'video', quality))) await m.reply('❌ Download failed — YouTube may be blocking this host right now.');
  },
);
