/**
 * The command menu — a banner (image or video) with the command list as its
 * caption, in one bubble.
 *
 *   .menu        public commands, grouped by category
 *   .menu owner  the owner-only commands (owner/sudo only)
 *   .setmenu     reply to an image/video to use it as the banner
 *
 * The boxed layout below is intentional and hand-tuned — leave the styling be.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { command, commands, commandName } from '../core/registry.js';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/index.js';
import { unwrapContent } from '../core/message.js';
import { renderNameBanner } from '../core/render.js';
import { logger } from '../logger.js';

const CATEGORY_ICON: Record<string, string> = {
  system: '⚙️',
  owner: '👑',
  group: '👥',
  moderation: '🛡️',
  automation: '🤖',
  downloader: '📥',
  media: '🎨',
  nexus: '🧠',
  ai: '🧠',
  fun: '✨',
  tools: '🔧',
  utility: '🧩',
  developer: '🛠️',
  general: '📌',
};

function dataDir(): string {
  const d = dirname(config.dbPath);
  return d && d !== '.' ? d : '.';
}
function menuFile(ext: string): string {
  return join(dataDir(), `menu.${ext}`);
}

/** Our own framed menu: a light header + the command list by category.
 *  `ownerView` = list ONLY owner-only commands; otherwise ONLY public ones
 *  (owner-only commands are hidden from the menu everyone sees). */
function buildMenu(userName: string, ownerView = false): string {
  const prefix = config.prefixes[0] ?? '';
  const groups = new Map<string, string[]>();
  for (const c of commands) {
    if (!c.pattern || c.hidden) continue;
    // Split cleanly: owner menu = ONLY owner-only; public menu = ONLY public.
    if (ownerView ? !c.fromMe : c.fromMe) continue;
    const name = commandName(c.pattern);
    if (!name) continue;
    const cat = c.category ?? 'general';
    const arr = groups.get(cat) ?? [];
    if (!arr.includes(name)) arr.push(name);
    groups.set(cat, arr);
  }
  const total = [...groups.values()].reduce((a, b) => a + b.length, 0);
  if (ownerView && total === 0) return '👑 No owner-only commands are registered.';

  let text =
    `╭─────「 *${config.botName}* 」\n` +
    (ownerView ? `│ 👑 Owner View\n` : '') +
    `│ 👋 Hello ${userName}\n` +
    `│ 🔧 Prefix   : ${prefix}\n` +
    `│ 📜 ${ownerView ? 'Owner cmds' : 'Commands'} : ${total}\n` +
    `╰─────────────────\n`;

  for (const [cat, names] of [...groups.entries()].sort()) {
    const icon = CATEGORY_ICON[cat] ?? '•';
    text += `\n╭─ ${icon} *${cat.toUpperCase()}*\n`;
    text += names.sort().map((n) => `│ ▸ ${prefix}${n}`).join('\n');
    text += `\n╰────────────`;
  }

  text += ownerView
    ? `\n\n_👑 Owner-only commands — regular users don't see these._`
    : `\n\n_Type ${prefix}help <command> for details • ${prefix}alive for status._`;
  return text;
}

function customMenuMedia(): { buffer: Buffer; kind: 'image' | 'video' } | undefined {
  const type = getSetting('menu.type');
  const ext = getSetting('menu.ext');
  if (type && ext && existsSync(menuFile(ext))) {
    return { buffer: readFileSync(menuFile(ext)), kind: type === 'video' ? 'video' : 'image' };
  }
  return undefined;
}

async function defaultBanner(): Promise<Buffer | undefined> {
  try {
    const bgPath = join(process.cwd(), 'assets', 'menu-bg.jpg');
    const bg = existsSync(bgPath) ? readFileSync(bgPath) : undefined;
    return await renderNameBanner(config.botName, 'WhatsApp Bot', bg);
  } catch (err) {
    logger.warn({ err }, 'menu: banner render failed');
    return undefined;
  }
}

/** .menu — the banner (image or video) with the command list as its CAPTION,
 *  in ONE bubble. If the media can't be sent, the list still goes out as text.
 *  .menu owner (owner/sudo) — shows the OWNER-ONLY commands instead. */
command({ pattern: 'menu ?(.*)', desc: 'Show the command menu (.menu owner for owner-only)', category: 'system' }, async (m, match) => {
  const arg = (match?.[1] ?? '').trim().toLowerCase();
  const wantsOwner = /^(owner|admin|sudo|hidden|dev)$/.test(arg);
  if (wantsOwner) {
    if (!m.isOwner) return m.reply('👑 The owner-only command list is for the owner. The public menu is just *.menu*.');
    return m.reply(buildMenu(m.pushName || 'boss', true));
  }

  const caption = buildMenu(m.pushName || 'there');

  try {
    const custom = customMenuMedia();
    if (custom) {
      // gifPlayback → the video loops silently, like an animated banner.
      if (custom.kind === 'video') await m.send({ video: custom.buffer, caption, gifPlayback: true }, { quoted: m.raw });
      else await m.send({ image: custom.buffer, caption }, { quoted: m.raw });
      return;
    }

    const banner = await defaultBanner();
    if (banner) {
      await m.send({ image: banner, caption }, { quoted: m.raw });
      return;
    }
  } catch (err) {
    logger.warn({ err }, 'menu: media send failed — falling back to text');
  }

  await m.reply(caption);
});

command(
  { pattern: 'setmenu', desc: 'Set the menu image/video', usage: '<reply to image/video>', category: 'owner', fromMe: true },
  async (m) => {
    const own = m.type === 'imageMessage' || m.type === 'videoMessage';
    const q = unwrapContent(m.quoted?.raw);
    const isVideo = m.type === 'videoMessage' || Boolean(q?.videoMessage);
    const isImage = m.type === 'imageMessage' || Boolean(q?.imageMessage);
    if (!isImage && !isVideo) return m.reply('Reply to an image or video with .setmenu');

    const buffer = await m.downloadMedia(!own);
    if (!buffer) return m.reply('Could not download that media.');

    const ext = isVideo ? 'mp4' : 'jpg';
    try {
      const dir = dataDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(menuFile(ext), buffer);
      setSetting('menu.type', isVideo ? 'video' : 'image');
      setSetting('menu.ext', ext);
      await m.reply('✅ Menu media set. Try .menu');
    } catch (err) {
      logger.error({ err }, 'setmenu: failed to save');
      await m.reply('❌ Could not save the menu media.');
    }
  },
);
