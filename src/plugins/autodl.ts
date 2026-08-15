import { command } from '../core/registry.js';
import { ProgressBar } from '../core/progress.js';
import { resolveDownloader, resolveDownloaders, firstUrl, parseQuality, recordDownloadError, drainDownloadErrors } from '../core/downloaders/index.js';
import { getGroupConfig, setGroupConfig } from '../db/index.js';
import { markConsumed } from '../core/pending.js';
import { logger } from '../logger.js';
import type { MediaKind, MediaResult, Quality } from '../core/downloaders/index.js';
import type { Message } from '../core/message.js';

// WhatsApp silently drops inline videos that are too big. Above this we send the
// file as a *document* instead so it still gets through (just not auto-playing).
const INLINE_VIDEO_LIMIT = 60 * 1024 * 1024; // 60 MB

/** Send a downloaded result as the right message type (size-aware for video). */
export async function sendMedia(m: Message, media: MediaResult, caption?: string): Promise<void> {
  if (media.kind === 'audio' || media.mimetype.startsWith('audio')) {
    await m.send({ audio: media.buffer, mimetype: media.mimetype, fileName: media.fileName }, { quoted: m.raw });
  } else if (media.mimetype.startsWith('image')) {
    await m.send({ image: media.buffer, ...(caption ? { caption } : {}) }, { quoted: m.raw });
  } else if (media.buffer.length > INLINE_VIDEO_LIMIT) {
    // Too large to play inline reliably — deliver as a document so it arrives.
    await m.send(
      { document: media.buffer, mimetype: media.mimetype || 'video/mp4', fileName: media.fileName || 'video.mp4' },
      { quoted: m.raw },
    );
    await m.reply('📎 That HD file was large, so I sent it as a document (tap to save/play). Add *sd* for a smaller version.');
  } else {
    await m.send({ video: media.buffer, mimetype: media.mimetype, ...(caption ? { caption } : {}) }, { quoted: m.raw });
  }
}

/**
 * Core: try EVERY provider that supports this URL (yt-dlp first, then Cobalt),
 * download with a live bar, and send it. Trying all providers means a link that
 * yt-dlp can't grab (bot-blocked, region-locked) can still succeed via Cobalt.
 * On total failure the OWNER sees the real per-source error (not just "failed").
 */
async function fetchAndSend(m: Message, url: string, kind: MediaKind, quiet: boolean, quality: Quality = 'hd'): Promise<boolean> {
  const providers = resolveDownloaders(url);
  if (!providers.length) {
    if (!quiet) await m.reply('😕 I don\'t have a downloader that supports that link.');
    return false;
  }

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const more = i < providers.length - 1;
    const bar = await ProgressBar.start(m, `Downloading (${provider.name}, ${quality.toUpperCase()})`, '📥');
    try {
      const media = await provider.download(url, kind, (f, note) => void bar.update(f, note), { quality });
      await bar.finish(`✅ *Downloaded* — ${media.title ?? media.fileName}`);
      await sendMedia(m, media);
      return true;
    } catch (err) {
      logger.error({ err, url, provider: provider.name }, 'download failed');
      recordDownloadError(`Download (${provider.name})`, err);
      await bar.finish(more ? `⚠️ ${provider.name} couldn't get it — trying another source…` : `⚠️ ${provider.name} couldn't get it.`);
    }
  }

  // Every source failed. Show a clear message; for the OWNER, append the REAL
  // errors so we can see exactly why (hidden from regular users).
  if (!quiet) {
    let msg = '❌ Couldn\'t download that link. It may be private, region-locked, or blocked from this server right now.';
    const errs = drainDownloadErrors();
    if (m.isOwner && errs.length) {
      msg += `\n\n🛠️ *why:*\n${errs.slice(-4).map((e) => `• ${e}`).join('\n')}`;
    }
    await m.reply(msg);
  }
  return false;
}

/**
 * Generic downloader. Gets the link from (in order): the command argument, the
 * message you replied to, or anywhere in the current message — so you can just
 * reply `.dl` to any message that contains a link.
 */
// Remember the last link each person asked to download, so after the quality
// menu they can just reply 1/2/3 (or hd/sd/max). Expires after 5 minutes.
const pendingDl = new Map<string, { url: string; at: number }>();
const pendKey = (chat: string, sender: string) => `${chat}:${sender}`;
const PENDING_TTL = 5 * 60_000;

// Maps a reply to a quality tier. Accepts a tapped number OR the word.
const CHOICE: Record<string, Quality> = {
  '1': 'hd', '2': 'sd', '3': 'max',
  hd: 'hd', hq: 'hd', high: 'hd',
  sd: 'sd', low: 'sd', small: 'sd',
  max: 'max', best: 'max',
};

/** Is this message a reply to a pending "which quality?" prompt? (peek only) */
export function isDownloadChoice(m: Message): boolean {
  const pend = pendingDl.get(pendKey(m.chat, m.sender));
  if (!pend || Date.now() - pend.at > PENDING_TTL) return false;
  return CHOICE[m.body.trim().toLowerCase()] !== undefined;
}

// Short platform label for a prettier prompt ("TikTok", "YouTube", …).
function platformOf(url: string): string {
  const m = url.match(/(?:youtu\.?be|tiktok|instagram|facebook|fb\.watch|twitter|x\.com|pinterest|pin\.it|reddit|snapchat|bilibili|vimeo|dailymotion|twitch|soundcloud)/i);
  if (!m) return 'Link';
  const map: Record<string, string> = { youtu: 'YouTube', youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook', 'fb.watch': 'Facebook', twitter: 'X', 'x.com': 'X', pinterest: 'Pinterest', 'pinit': 'Pinterest', reddit: 'Reddit', snapchat: 'Snapchat', bilibili: 'Bilibili', vimeo: 'Vimeo', dailymotion: 'Dailymotion', twitch: 'Twitch', soundcloud: 'SoundCloud' };
  const key = m[0].toLowerCase().replace('.', '');
  return map[key] ?? map[m[0].toLowerCase()] ?? 'Link';
}

/** Best-effort: does this link point to a PHOTO (not a video)? Quality tiers are
 *  meaningless for images, so we skip the HD/SD/Max menu for them. Direct image/
 *  video extensions are obvious; Pinterest/Instagram can be either, so we do a
 *  light metadata probe. Anything else → treat as video (show the menu). */
async function looksLikeImage(url: string): Promise<boolean> {
  if (/\.(jpe?g|png|webp|gif|bmp|heic|avif)(\?|#|$)/i.test(url)) return true;
  if (/\.(mp4|webm|mkv|mov|m4v|avi)(\?|#|$)/i.test(url)) return false;
  try {
    if (/pinterest\.|pin\.it/i.test(url)) {
      const { pinterest } = await import('@nexus21/nexus-api');
      const r = await pinterest(url);
      return r.mediaType === 'image' || (Boolean(r.imageUrl) && !r.videoUrl);
    }
    if (/instagram\.com/i.test(url)) {
      const { instagram } = await import('@nexus21/nexus-api');
      const t = ((await instagram(url)).type ?? '').toLowerCase();
      return /photo|image/.test(t) && !/video|reel|clip/.test(t);
    }
  } catch {
    /* probe failed → fall through and treat as video */
  }
  return false;
}

/**
 * Show the quality pick-menu for a URL and remember it, so the user can reply
 * 1/2/3. Reused by .dl AND by the .video search flow (pick a result → this).
 */
export async function promptQuality(m: Message, url: string, label?: string): Promise<void> {
  pendingDl.set(pendKey(m.chat, m.sender), { url, at: Date.now() });
  await m.react('🎬');
  const head = label ? `🎬 *${label}*\nWhich quality?` : `🎬 *${platformOf(url)} link ready.* Which quality?`;
  await m.reply(
    `${head}\n\n` +
      '   *1* ·  🟢 HD — 1080p, best balance  ⭐\n' +
      '   *2* ·  🔵 SD — smaller & faster (saves data)\n' +
      '   *3* ·  🔴 Max — highest available (big file)\n\n' +
      '_Just reply *1*, *2*, or *3*._',
  );
}

command(
  { pattern: 'dl ?(.*)', desc: 'Download from a link — asks you which quality', usage: '<url>', category: 'downloader' },
  async (m, match) => {
    const rawArg = match?.[1] ?? '';
    // Quality from the words; URL from the RAW arg (parseQuality strips URLs, so
    // never look for the link in its cleaned text — that would lose it).
    const { quality, explicit } = parseQuality(rawArg);
    const url =
      firstUrl(rawArg) ??
      (m.quoted?.text ? firstUrl(m.quoted.text) : undefined) ??
      firstUrl(m.body);
    if (!url) return m.reply('🔗 Send me a link — *.dl <link>* (or reply *.dl* to a message that has one).');

    // If they already said the quality (.dl <link> hd), skip the menu.
    if (explicit) {
      await fetchAndSend(m, url, 'video', false, quality);
      return;
    }
    // A PHOTO has no quality tiers — just grab it, no HD/SD/Max menu.
    if (await looksLikeImage(url)) {
      await m.react('🖼️');
      await fetchAndSend(m, url, 'video', false, 'hd'); // sendMedia detects the image mimetype and sends it as a photo
      return;
    }
    // A video — ASK which quality, like a real downloader.
    await promptQuality(m, url);
  },
);

// Passive: catch the quality reply (1/2/3 or hd/sd/max) to a pending prompt.
// No fromMe guard: the owner's own messages are fromMe on a self-hosted bot, and
// the pending-map gate below already scopes this to a real pending download.
command({ on: 'message' }, async (m) => {
  const key = pendKey(m.chat, m.sender);
  const pend = pendingDl.get(key);
  if (!pend) return;
  if (Date.now() - pend.at > PENDING_TTL) return void pendingDl.delete(key);
  const q = CHOICE[m.body.trim().toLowerCase()];
  if (!q) return; // not a quality reply — leave it for other handlers
  pendingDl.delete(key);
  markConsumed(m.raw?.key?.id); // so DM auto-chat doesn't also reply to "1"
  await fetchAndSend(m, pend.url, 'video', false, q);
});

// Direct quality shortcuts (reply .hd/.sd/.max to a link, or after .dl). Hidden
// from the menu — they're the pick options, not standalone commands to list.
for (const [word, q] of [['hd', 'hd'], ['hq', 'hd'], ['sd', 'sd'], ['max', 'max']] as const) {
  command(
    { pattern: word, desc: `Download the last link in ${q.toUpperCase()}`, category: 'downloader', hidden: true },
    async (m) => {
      const key = pendKey(m.chat, m.sender);
      const pend = pendingDl.get(key);
      const url = (pend && Date.now() - pend.at < PENDING_TTL ? pend.url : undefined) ?? (m.quoted?.text ? firstUrl(m.quoted.text) : undefined);
      if (!url) return m.reply('🔗 Send *.dl <link>* first, then pick — or reply *.hd* directly to a message with a link.');
      pendingDl.delete(key);
      await fetchAndSend(m, url, 'video', false, q as Quality);
    },
  );
}

/** Toggle auto-download of links posted in a group. */
command(
  { pattern: 'autodl ?(.*)', desc: 'Auto-download links in this group', usage: 'on|off', category: 'downloader', groupOnly: true, adminOnly: true },
  async (m, match) => {
    const v = match?.[1]?.trim().toLowerCase();
    if (v === 'on') {
      setGroupConfig(m.chat, { autodl: true });
      return m.reply('✅ Auto-download enabled. I will fetch supported links posted here.');
    }
    if (v === 'off') {
      setGroupConfig(m.chat, { autodl: false });
      return m.reply('Auto-download disabled.');
    }
    await m.reply(`Auto-download is ${getGroupConfig(m.chat).autodl ? 'on' : 'off'}. Use .autodl on|off`);
  },
);

/** Passive: when autodl is on, silently fetch any supported link that appears. */
command({ on: 'message' }, async (m) => {
  if (!m.isGroup || m.fromMe) return;
  if (!getGroupConfig(m.chat).autodl) return;
  const url = firstUrl(m.body);
  if (!url) return;
  if (!resolveDownloader(url)) return; // ignore non-media links
  await fetchAndSend(m, url, 'video', true);
});
