import { animeImage } from '@nexus21/nexus-api';
import { command } from '../core/registry.js';
import { httpGetBuffer } from '../core/net.js';
import { logger } from '../logger.js';

/**
 * Random anime images via @nexus21/nexus-api. Always SFW — nsfw is hard-forced
 * to false regardless of category. Built-in categories plus any booru tag work.
 *
 *   .waifu            a random waifu pic
 *   .waifu neko       a specific category (neko, hug, chibi, sword, cute …)
 */

const CATEGORIES = [
  'waifu', 'neko', 'kitsune', 'maid', 'uniform', 'hug', 'kiss',
  'dance', 'blush', 'smile', 'cry', 'angry', 'cute', 'chibi', 'fantasy', 'sword', 'magic',
];

command({ pattern: 'waifu ?(.*)', desc: 'Random anime image (SFW)', usage: '[category]', category: 'fun' }, async (m, match) => {
  const cat = (match?.[1] ?? '').trim().toLowerCase() || 'waifu';
  await m.react('🎐');
  try {
    const imgs = await animeImage({ category: cat, nsfw: false, limit: 1 }); // nsfw ALWAYS off
    const url = imgs?.[0]?.url;
    if (!url) {
      return m.reply(`😕 No image for *${cat}* right now. Try: ${CATEGORIES.slice(0, 8).join(', ')}…`);
    }
    const buf = await httpGetBuffer(url, { timeout: 20_000 });
    if (buf.length < 1000) return m.reply('😕 Got a broken image — try again.');
    await m.send({ image: buf, caption: `🎐 ${cat}` }, { quoted: m.raw });
  } catch (err) {
    logger.warn({ err, cat }, 'waifu fetch failed');
    await m.reply(`😕 Couldn't fetch that anime image — try another category (${CATEGORIES.slice(0, 6).join(', ')}…).`);
  }
});

logger.debug('anime-extras plugin loaded');
