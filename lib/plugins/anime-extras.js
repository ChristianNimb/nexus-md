import { animeImage } from '@nexus21/nexus-api';
import { command } from '../core/registry.js';
import { httpGetBuffer } from '../core/net.js';
import { logger } from '../logger.js';
const CATEGORIES = [
    'waifu', 'neko', 'kitsune', 'maid', 'uniform', 'hug', 'kiss',
    'dance', 'blush', 'smile', 'cry', 'angry', 'cute', 'chibi', 'fantasy', 'sword', 'magic',
];
command({ pattern: 'waifu ?(.*)', desc: 'Random anime image (SFW)', usage: '[category]', category: 'fun' }, async (m, match) => {
    const cat = (match?.[1] ?? '').trim().toLowerCase() || 'waifu';
    await m.react('🎐');
    try {
        const imgs = await animeImage({ category: cat, nsfw: false, limit: 1 });
        const url = imgs?.[0]?.url;
        if (!url) {
            return m.reply(`😕 No image for ${cat} right now. Try: ${CATEGORIES.slice(0, 8).join(', ')}…`);
        }
        const buf = await httpGetBuffer(url, { timeout: 20_000 });
        if (buf.length < 1000)
            return m.reply('😕 Got a broken image. Try again.');
        await m.send({ image: buf, caption: `🎐 ${cat}` }, { quoted: m.raw });
    }
    catch (err) {
        logger.warn({ err, cat }, 'waifu fetch failed');
        await m.reply(`😕 Couldn't fetch that anime image. Try another category (${CATEGORIES.slice(0, 6).join(', ')}…).`);
    }
});
logger.debug('anime-extras plugin loaded');
