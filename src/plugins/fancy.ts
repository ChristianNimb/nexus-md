import { command } from '../core/registry.js';

/**
 * Turn plain text into genuinely pretty styles — not just font swaps, but
 * decorated "aesthetic" looks (elegant frames + fancy letters) that pop. All
 * offline, pure Unicode.
 */

function mapAlphabet(text: string, upperBase: number, lowerBase: number): string {
  return [...text]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      if (c >= 65 && c <= 90) return String.fromCodePoint(upperBase + (c - 65));
      if (c >= 97 && c <= 122) return String.fromCodePoint(lowerBase + (c - 97));
      return ch;
    })
    .join('');
}

const bold = (t: string) => mapAlphabet(t, 0x1d400, 0x1d41a);
const script = (t: string) => mapAlphabet(t, 0x1d49c, 0x1d4b6);
const boldScript = (t: string) => mapAlphabet(t, 0x1d4d0, 0x1d4ea);
const gothic = (t: string) => mapAlphabet(t, 0x1d5d4, 0x1d5ee); // bold sans
const doublestruck = (t: string) => mapAlphabet(t, 0x1d538, 0x1d552);
const monospace = (t: string) => mapAlphabet(t, 0x1d670, 0x1d68a);
const fullwidth = (t: string) =>
  [...t].map((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 33 && c <= 126 ? String.fromCodePoint(0xff01 + (c - 33)) : ch === ' ' ? '　' : ch;
  }).join('');
const smallcaps = (t: string) => {
  const map: Record<string, string> = { a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ѕ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ' };
  return [...t.toLowerCase()].map((c) => map[c] ?? c).join('');
};

// The pretty, decorated looks — this is what makes people go "wow".
const styles: Record<string, (t: string) => string> = {
  aesthetic: (t) => `˗ˏˋ ${t} ˎˊ˗`,
  sparkle: (t) => `✦ ｡ﾟ ${boldScript(t)} ﾟ｡ ✦`,
  stars: (t) => `⋆｡°✩ ${t} ✩°｡⋆`,
  royal: (t) => `꧁ ${bold(t)} ꧂`,
  hearts: (t) => `｡❤︎‧₊˚ ${script(t)} ˚₊‧❤︎｡`,
  neon: (t) => `【 ${gothic(t)} 】`,
  velvet: (t) => `⟡ ${script(t)} ⟡`,
  wave: (t) => `彡★ ${t} ★彡`,
  wide: (t) => fullwidth(t),
  cloud: (t) => `☁︎ ${smallcaps(t)} ☁︎`,
  // classic font swaps too
  bold: (t) => bold(t),
  script: (t) => script(t),
  gothic: (t) => gothic(t),
  smallcaps: (t) => smallcaps(t),
  doublestruck: (t) => doublestruck(t),
  monospace: (t) => monospace(t),
};

// The curated "show off" set for when no style is picked (not the whole list).
const SHOWCASE = ['aesthetic', 'sparkle', 'royal', 'hearts', 'neon', 'velvet', 'stars', 'wide'];

command(
  { pattern: 'fancy ?(.*)', desc: 'Turn text into beautiful styled fonts', usage: '[style] <text>', category: 'fun' },
  async (m, match) => {
    const arg = match?.[1]?.trim() ?? '';
    if (!arg) {
      return m.reply(`✨ *.fancy <text>* to see the pretty styles, or *.fancy <style> <text>* for one.\nStyles: ${Object.keys(styles).join(', ')}`);
    }

    const [maybeStyle, ...rest] = arg.split(' ');
    if (styles[maybeStyle.toLowerCase()] && rest.length) {
      return m.reply(styles[maybeStyle.toLowerCase()](rest.join(' ')));
    }

    // No explicit style → show the curated beautiful set.
    const out = SHOWCASE.map((name) => styles[name](arg)).join('\n');
    await m.reply(`✨ *Pick your vibe* (or *.fancy <style> ${arg}*):\n\n${out}`);
  },
);
