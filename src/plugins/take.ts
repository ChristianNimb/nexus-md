import { command } from '../core/registry.js';

/**
 * Re-send a replied-to sticker as your own. (Pack/author EXIF renaming would
 * need node-webpmux; kept dependency-free here by simply re-uploading.)
 */
command(
  { pattern: 'take', desc: 'Re-send a replied sticker', usage: '<reply to sticker>', category: 'media' },
  async (m) => {
    const q = m.quoted;
    if (!q || !q.raw?.stickerMessage) return m.reply('Reply to a sticker with .take');
    const buffer = await m.downloadMedia(true);
    if (!buffer) return m.reply('Could not download that sticker.');
    await m.sendSticker(buffer);
  },
);
