import axios from 'axios';
import { command } from '../core/registry.js';
import { logger } from '../logger.js';
import type { Message } from '../core/message.js';

/**
 * .imagine — text-to-image. Nexus draws whatever you describe.
 *
 * Uses Pollinations (https://pollinations.ai) which is free and needs no API
 * key, so image generation works out of the box. Each call uses a random seed
 * so the same prompt gives you a fresh picture every time.
 */

const BASE = 'https://image.pollinations.ai/prompt/';

// Pollinations' best photoreal model. `flux` gives far more cinematic,
// detailed results than the old default ("turbo"). Override with NEXUS_IMG_MODEL.
const MODEL = process.env.NEXUS_IMG_MODEL || 'flux';

// If the user already asked for a specific look (anime, sketch, cartoon…) we
// don't force cinematic on them. Otherwise we push the prompt toward a rich,
// film-still quality that Pollinations otherwise won't reach on its own.
const STYLE_WORDS = /\b(anime|manga|cartoon|sketch|drawing|doodle|pixel|logo|icon|meme|chibi|watercolou?r|oil painting|line art|flat|minimalist|comic)\b/i;
const CINEMATIC = 'cinematic film still, dramatic cinematic lighting, shallow depth of field, ' +
  'volumetric light, highly detailed, sharp focus, photorealistic, 8k, ' +
  'shot on 35mm, color graded, professional photography';

// Rough aspect handling: a cinematic frame looks best widescreen. Users can say
// "portrait"/"square"/"wide" in the prompt and we pick sensible dimensions.
function pickSize(p: string): { width: number; height: number } {
  const t = p.toLowerCase();
  if (/\b(portrait|vertical|9:16|phone wallpaper|poster)\b/.test(t)) return { width: 896, height: 1152 };
  if (/\b(square|1:1|profile pic|avatar)\b/.test(t)) return { width: 1024, height: 1024 };
  // default → widescreen cinematic
  return { width: 1216, height: 832 };
}

async function imagine(m: Message, match: RegExpMatchArray | null): Promise<unknown> {
  const prompt = match?.[1]?.trim() ?? '';
  if (!prompt) return m.reply('🎨 Give me something to draw — e.g. *.imagine a neon samurai cat in the rain, cinematic*');

  // Build the final prompt: keep the user's words, add cinematic polish unless
  // they clearly asked for a non-photoreal style.
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
      enhance: 'true', // Pollinations' own LLM enriches the prompt for better output
      seed: String(seed),
    });
    const url = `${BASE}${encodeURIComponent(finalPrompt)}?${params.toString()}`;
    const res = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 120_000 });
    const buffer = Buffer.from(res.data);
    if (buffer.length < 1024) throw new Error('empty image response');

    await m.send({ image: buffer, caption: `🎨 *${prompt}*` }, { quoted: m.raw });
    await m.react('✅');
  } catch (err) {
    logger.error({ err }, 'imagine failed');
    await m.reply('❌ Could not generate that image right now. Try again in a moment.');
  }
  return undefined;
}

command({ pattern: 'imagine (.+)', desc: 'Generate an AI image from text', usage: '<prompt>', category: 'ai' }, imagine);
// Synonyms so Nexus's AI (and users) reliably hit image generation.
for (const alias of ['img', 'image', 'draw', 'paint', 'generate', 'art', 'gen']) {
  command({ pattern: `${alias} (.+)`, desc: 'Generate an AI image (alias)', usage: '<prompt>', category: 'ai', hidden: true }, imagine);
}

logger.debug('imagine plugin loaded');
