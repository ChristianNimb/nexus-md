import axios from 'axios';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { command } from '../core/registry.js';
import { logger } from '../logger.js';

/** Center-crop any image to a square JPEG suitable for a WhatsApp profile pic. */
async function toSquareJpeg(buffer: Buffer, size = 640): Promise<Buffer> {
  const img = await loadImage(buffer);
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const scale = Math.max(size / img.width, size / img.height); // cover
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
  return canvas.toBuffer('image/jpeg');
}

command(
  {
    pattern: 'setpp ?(.*)',
    desc: "Set the bot's profile picture",
    usage: '<reply to image | image url>',
    category: 'owner',
    fromMe: true,
  },
  async (m, match) => {
    const arg = match?.[1]?.trim();

    let raw: Buffer | undefined;
    if (arg && /^https?:\/\//i.test(arg)) {
      try {
        const res = await axios.get<ArrayBuffer>(arg, {
          responseType: 'arraybuffer',
          timeout: 30_000,
          maxContentLength: 20 * 1024 * 1024,
        });
        raw = Buffer.from(res.data);
      } catch (err) {
        logger.error({ err, arg }, 'setpp: url fetch failed');
        return m.reply('Could not fetch that URL.');
      }
    } else {
      // From a replied image, or an image sent with the command.
      raw = await m.downloadMedia(m.type !== 'imageMessage');
    }

    if (!raw) return m.reply('Reply to an image, or pass an image URL: .setpp <url>');

    try {
      const jpeg = await toSquareJpeg(raw);
      await m.client.updateProfilePicture(m.me, jpeg);
      await m.reply('✅ Bot profile picture updated.');
    } catch (err) {
      logger.error({ err }, 'setpp: update failed');
      await m.reply('❌ Could not update the picture. Try a different image.');
    }
  },
);
