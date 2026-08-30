import { command } from '../core/registry.js';
command({ pattern: 'take', desc: 'Re-send a replied sticker', usage: '<reply to sticker>', category: 'media' }, async (m) => {
    const q = m.quoted;
    if (!q || !q.raw?.stickerMessage)
        return m.usage();
    const buffer = await m.downloadMedia(true);
    if (!buffer)
        return m.reply('Could not download that sticker.');
    await m.sendSticker(buffer);
});
