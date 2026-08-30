import { command } from '../core/registry.js';
import { bold, script, boldScript, sansBold, fraktur, doublestruck, monospace, fullwidth, smallcaps } from '../core/text.js';
const styles = {
    aesthetic: (t) => `˗ˏˋ ${t} ˎˊ˗`,
    sparkle: (t) => `✦ ｡ﾟ ${boldScript(t)} ﾟ｡ ✦`,
    stars: (t) => `⋆｡°✩ ${t} ✩°｡⋆`,
    royal: (t) => `꧁ ${bold(t)} ꧂`,
    hearts: (t) => `｡❤︎‧₊˚ ${script(t)} ˚₊‧❤︎｡`,
    neon: (t) => `【 ${sansBold(t)} 】`,
    velvet: (t) => `⟡ ${script(t)} ⟡`,
    wave: (t) => `彡★ ${t} ★彡`,
    wide: (t) => fullwidth(t),
    cloud: (t) => `☁︎ ${smallcaps(t)} ☁︎`,
    bold: (t) => bold(t),
    script: (t) => script(t),
    gothic: (t) => sansBold(t),
    smallcaps: (t) => smallcaps(t),
    doublestruck: (t) => doublestruck(t),
    monospace: (t) => monospace(t),
    fraktur: (t) => fraktur(t),
};
const SHOWCASE = ['aesthetic', 'sparkle', 'royal', 'hearts', 'neon', 'velvet', 'stars', 'wide'];
command({ pattern: 'fancy ?(.*)', desc: 'Turn text into beautiful styled fonts', usage: '[style] <text>', category: 'fun' }, async (m, match) => {
    const arg = match?.[1]?.trim() ?? '';
    if (!arg) {
        return m.reply(`✨ .fancy <text> to see the pretty styles, or .fancy <style> <text> for one.\nStyles: ${Object.keys(styles).join(', ')}`);
    }
    const [maybeStyle, ...rest] = arg.split(' ');
    if (styles[maybeStyle.toLowerCase()] && rest.length) {
        return m.reply(styles[maybeStyle.toLowerCase()](rest.join(' ')));
    }
    const out = SHOWCASE.map((name) => styles[name](arg)).join('\n');
    await m.reply(`✨ Pick your vibe (or .fancy <style> ${arg}):\n\n${out}`);
});
