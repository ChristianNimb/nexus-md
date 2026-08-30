import { command } from '../core/registry.js';
import { transcribe } from '../core/voice.js';
import { translateText, LANG_NAME, toLangCode } from './handy.js';
import { logger } from '../logger.js';
async function voiceBuffer(m) {
    if (m.type === 'audioMessage')
        return m.downloadMedia(false);
    const q = m.quoted?.raw;
    if (q && 'audioMessage' in q)
        return m.downloadMedia(true);
    return undefined;
}
command({ pattern: 'transcribe', desc: 'Turn a voice note into text (reply to it)', category: 'tools' }, async (m) => {
    const buf = await voiceBuffer(m);
    if (!buf)
        return m.reply('🎧 Reply to a voice note with .transcribe and I\'ll write out what it says.');
    await m.react('🎧');
    const text = await transcribe(buf);
    await m.reply(text ? `🎧 Transcript:\n${text}` : '😕 Couldn\'t make out that voice note. It may be too quiet or unclear.');
});
command({ pattern: 'trv(?: (.+))?', desc: 'Transcribe + translate a voice note', usage: '[lang] (reply to a voice note)', category: 'tools' }, async (m, match) => {
    const buf = await voiceBuffer(m);
    if (!buf)
        return m.reply('🎧 Reply to a voice note with .trv (add a language too, e.g. .trv zh).');
    const langArg = (match?.[1] ?? '').trim();
    const to = (langArg && toLangCode(langArg)) || 'en';
    await m.react('🎧');
    try {
        const text = await transcribe(buf);
        if (!text)
            return m.reply('😕 Couldn\'t make out that voice note.');
        const translated = await translateText(text, to);
        await m.reply(`🎧 Heard:\n${text}\n\n🌐 ${LANG_NAME[to] ?? to}:\n${translated ?? '(translation unavailable right now)'}`);
    }
    catch (err) {
        logger.warn({ err }, 'trv failed');
        await m.reply('😕 Something went wrong with that one. Try again.');
    }
});
logger.debug('voice-tools plugin loaded');
