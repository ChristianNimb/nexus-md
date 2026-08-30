import { command } from '../core/registry.js';
import { renderLogo, LOGO_STYLES } from '../core/logo.js';
import { logger } from '../logger.js';
command({ pattern: 'logo(?: (.+))?', desc: 'Make a glowing neon text logo', usage: '[style] <text>', category: 'media' }, async (m, match) => {
    const arg = (match?.[1] ?? '').trim();
    if (!arg) {
        return m.reply(`🎨 Text logo maker\n` +
            `• .logo <text>. Quick neon logo\n` +
            `• .logo <style> <text>. Pick a style\n\n` +
            `Styles: ${LOGO_STYLES.join(', ')}`);
    }
    const [first, ...rest] = arg.split(/\s+/);
    let style = 'neon';
    let text = arg;
    if (LOGO_STYLES.includes(first.toLowerCase()) && rest.length) {
        style = first.toLowerCase();
        text = rest.join(' ');
    }
    await m.react('🎨');
    try {
        const buf = renderLogo(text, style);
        const others = LOGO_STYLES.filter((s) => s !== style).slice(0, 6).join(', ');
        await m.send({ image: buf, caption: `🎨 ${text}. _${style}_\n\n_Try another: .logo <${others}…> ${text}_` }, { quoted: m.raw });
    }
    catch (err) {
        logger.error({ err }, 'logo render failed');
        await m.reply('😕 Couldn\'t make that logo. Try shorter text (a word or two works best).');
    }
});
logger.debug('logo plugin loaded');
