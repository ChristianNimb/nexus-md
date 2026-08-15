import { spawn } from 'node:child_process';
import { command } from '../core/registry.js';
import { Spinner } from '../core/progress.js';

/**
 * Convert an arbitrary image/video buffer into a WhatsApp-compatible WebP
 * sticker using ffmpeg (a documented prerequisite). Runs ffmpeg via a pipe so
 * we never touch the filesystem.
 */
function toSticker(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', 'pipe:0',
      '-vf',
      "scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=#00000000",
      '-vcodec', 'libwebp',
      '-lossless', '0',
      '-q:v', '60',
      '-loop', '0',
      '-preset', 'default',
      '-an', '-vsync', '0',
      '-f', 'webp',
      'pipe:1',
    ];
    const ff = spawn('ffmpeg', args);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => errChunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString().slice(-300)}`));
    });
    ff.stdin.write(input);
    ff.stdin.end();
  });
}

command(
  { pattern: 'sticker', desc: 'Turn an image/video into a sticker', usage: '<reply to media>', category: 'media' },
  async (m) => {
    const hasOwnMedia = m.type === 'imageMessage' || m.type === 'videoMessage';
    const buffer = await m.downloadMedia(!hasOwnMedia);
    if (!buffer) return m.reply('Reply to an image or short video, or send one with the caption `.sticker`.');
    const spinner = await Spinner.start(m, 'Making sticker');
    try {
      const webp = await toSticker(buffer);
      await spinner.stop('✅ *Sticker ready*');
      await m.sendSticker(webp);
    } catch (err) {
      await spinner.stop('❌ Could not create the sticker. Is ffmpeg installed?');
      throw err;
    }
  },
);
