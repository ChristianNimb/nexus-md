import axios from 'axios';
import { command } from '../core/registry.js';
import { logger } from '../logger.js';
const BASE = 'https://image.pollinations.ai/prompt/';
const MODEL = process.env.NEXUS_IMG_MODEL || 'flux';
const STYLE_WORDS = /\b(anime|manga|cartoon|sketch|drawing|doodle|pixel|logo|icon|meme|chibi|watercolou?r|oil painting|line art|flat|minimalist|comic)\b/i;
const CINEMATIC = 'cinematic film still, dramatic cinematic lighting, shallow depth of field, ' +
    'volumetric light, highly detailed, sharp focus, photorealistic, 8k, ' +
    'shot on 35mm, color graded, professional photography';
function pickSize(p) {
    const t = p.toLowerCase();
    if (/\b(portrait|vertical|9:16|phone wallpaper|poster)\b/.test(t))
        return { width: 896, height: 1152 };
    if (/\b(square|1:1|profile pic|avatar)\b/.test(t))
        return { width: 1024, height: 1024 };
    return { width: 1216, height: 832 };
}
async function imagine(m, match) {
    const prompt = match?.[1]?.trim() ?? '';
    if (!prompt)
        return m.reply('🎨 Give me something to draw. E.g. .imagine a neon samurai cat in the rain, cinematic');
    const finalPrompt = STYLE_WORDS.test(prompt) ? prompt : `${prompt}, ${CINEMATIC}`;
    try {
        await m.react('🎨');
        const { width, height } = pickSize(prompt);
        const seed = Math.floor(Math.random() * 1_000_000_000);
        const params = new URLSearchParams({
            width: String(width),
            height: String(height),
            model: MODEL,
            nologo: 'true',
            enhance: 'true',
            seed: String(seed),
        });
        const url = `${BASE}${encodeURIComponent(finalPrompt)}?${params.toString()}`;
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
        const buffer = Buffer.from(res.data);
        if (buffer.length < 1024)
            throw new Error('empty image response');
        await m.send({ image: buffer, caption: `🎨 ${prompt}` }, { quoted: m.raw });
        await m.react('✅');
    }
    catch (err) {
        logger.error({ err }, 'imagine failed');
        await m.reply('❌ Could not generate that image right now. Try again in a moment.');
    }
    return undefined;
}
command({ pattern: 'imagine (.+)', desc: 'Generate an AI image from text', usage: '<prompt>', category: 'ai' }, imagine);
for (const alias of ['img', 'image', 'draw', 'paint', 'generate', 'art', 'gen']) {
    command({ pattern: `${alias} (.+)`, desc: 'Generate an AI image (alias)', usage: '<prompt>', category: 'ai', hidden: true }, imagine);
}
logger.debug('imagine plugin loaded');
