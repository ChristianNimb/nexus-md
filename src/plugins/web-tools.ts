import { command } from '../core/registry.js';
import { httpGet, httpGetBuffer, httpPost, firstOk } from '../core/net.js';
import { resolveJid } from '../core/lid.js';
import { logger } from '../logger.js';
import type { Message } from '../core/message.js';

/**
 * Web utilities — QR codes, link shortening, website screenshots. Free, no-key,
 * each with a fallback provider, and all routed through NEXUS_PROXY via core/net
 * so they keep working behind a firewall.
 *
 *   .qr <text|url>     .short <url>     .ss <url>
 */

/* ----------------------------------- QR ----------------------------------- */

async function qrQuickChart(text: string): Promise<Buffer | undefined> {
  const buf = await httpGetBuffer(`https://quickchart.io/qr?size=500&margin=2&text=${encodeURIComponent(text)}`);
  return buf.length > 500 ? buf : undefined;
}
async function qrServer(text: string): Promise<Buffer | undefined> {
  const buf = await httpGetBuffer(`https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=8&data=${encodeURIComponent(text)}`);
  return buf.length > 500 ? buf : undefined;
}

// .qr — smart:
//  • reply to a message → that person's WhatsApp click-to-chat QR (wa.me/<num>)
//  • a bare phone number → same click-to-chat QR
//  • any text / link      → a normal QR
command({ pattern: 'qr(?: (.+))?', desc: 'QR code — text, link, or a WhatsApp contact', usage: '<text|url|number> or reply', category: 'utility' }, async (m, match) => {
  let text = (match?.[1] ?? '').trim();
  let caption = '';

  // No text but replying to someone → make a "chat with this person" QR.
  if (!text && m.quoted?.sender) {
    const pn = await resolveJid(m.client, m.quoted.sender, m.isGroup ? m.chat : undefined);
    const num = pn.split('@')[0].split(':')[0];
    if (pn.endsWith('@s.whatsapp.net') && /^\d{7,15}$/.test(num)) {
      text = `https://wa.me/${num}`;
      caption = `🔳 Scan to message *+${num}* on WhatsApp`;
    } else if (m.quoted.text) {
      text = m.quoted.text; // couldn't resolve a number → QR their message text
    } else {
      return m.reply('🔳 Couldn\'t get that person\'s number just now — reply again, or give me one: *.qr <number>*.');
    }
  }
  // A bare phone number → wa.me click-to-chat link.
  if (!caption && /^\+?[\d][\d\s-]{6,}$/.test(text)) {
    const num = text.replace(/\D/g, '');
    if (num.length >= 7) {
      text = `https://wa.me/${num}`;
      caption = `🔳 Scan to message *+${num}* on WhatsApp`;
    }
  }

  if (!text) return m.reply('🔳 *.qr <text/link>*, or reply to a message to get that person\'s WhatsApp QR, or *.qr <number>* for a click-to-chat code.');

  await m.react('🔳');
  const buf = await firstOk<Buffer>([() => qrQuickChart(text), () => qrServer(text)]);
  if (!buf) return m.reply('😕 Couldn\'t make that QR right now — try again shortly.');
  await m.send({ image: buf, caption: caption || `🔳 QR for: ${text.slice(0, 80)}` }, { quoted: m.raw });
});

/* ------------------------------ link shortener ---------------------------- */

async function shortIsGd(url: string): Promise<string | undefined> {
  const r = await httpGet<string>(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { text: true });
  return /^https?:\/\//i.test(r.trim()) ? r.trim() : undefined;
}
async function shortTinyUrl(url: string): Promise<string | undefined> {
  const r = await httpGet<string>(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, { text: true });
  return /^https?:\/\//i.test(r.trim()) ? r.trim() : undefined;
}

command({ pattern: 'short (.+)', desc: 'Shorten a long link', usage: '<url>', category: 'utility' }, async (m, match) => {
  const url = (match?.[1] ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return m.reply('Give me a full link — *.short https://example.com/very/long/path*');
  await m.react('🔗');
  const out = await firstOk([() => shortIsGd(url), () => shortTinyUrl(url)]);
  await m.reply(out ? `🔗 ${out}` : '😕 Couldn\'t shorten that right now.');
});

/* ------------------------------- screenshot ------------------------------- */

async function ssThumIo(url: string): Promise<Buffer | undefined> {
  const buf = await httpGetBuffer(`https://image.thum.io/get/width/1000/crop/1400/${url}`, { timeout: 25_000 });
  return buf.length > 2000 ? buf : undefined;
}
async function ssMicrolink(url: string): Promise<Buffer | undefined> {
  // Microlink's embed feature returns the screenshot image bytes directly.
  const buf = await httpGetBuffer(`https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&embed=screenshot.url`, { timeout: 25_000 });
  return buf.length > 2000 ? buf : undefined;
}

command({ pattern: 'ss (.+)', desc: 'Screenshot a web page', usage: '<url>', category: 'utility' }, async (m, match) => {
  let url = (match?.[1] ?? '').trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  await m.react('📸');
  const buf = await firstOk<Buffer>([() => ssThumIo(url), () => ssMicrolink(url)]);
  if (!buf) return m.reply('😕 Couldn\'t screenshot that page — it may block bots, or be unreachable from here.');
  await m.send({ image: buf, caption: `📸 ${url}` }, { quoted: m.raw });
});

/* ------------------------------- scan (read QR) --------------------------- */

/** Get an image buffer from this message or the one it replies to. */
async function imageBuffer(m: Message): Promise<Buffer | undefined> {
  if (m.type === 'imageMessage') return m.downloadMedia(false);
  const q = m.quoted?.raw;
  if (q && ('imageMessage' in q || 'stickerMessage' in q)) return m.downloadMedia(true);
  return undefined;
}

interface QrRead { symbol?: { data?: string | null; error?: string | null }[] }

command({ pattern: 'scan', desc: 'Read a QR code from an image (reply to it)', category: 'utility' }, async (m) => {
  const buf = await imageBuffer(m);
  if (!buf) return m.reply('📷 Reply to an image with a QR code and I\'ll read it.');
  await m.react('🔍');
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)]), 'qr.png');
    const data = await httpPost<QrRead[]>('https://api.qrserver.com/v1/read-qr-code/', form, { timeout: 20_000 });
    const value = data?.[0]?.symbol?.[0]?.data;
    if (!value) return m.reply('😕 I couldn\'t find a QR code in that image (or it was unreadable).');
    await m.reply(`🔍 *QR content:*\n${value}`);
  } catch (err) {
    logger.warn({ err }, 'qr scan failed');
    await m.reply('😕 Couldn\'t read that QR right now — try a clearer image.');
  }
});

logger.debug('web-tools plugin loaded');
