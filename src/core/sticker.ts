import { spawn } from 'node:child_process';

/**
 * Convert an image buffer into a WhatsApp-compatible WebP sticker via ffmpeg.
 * Lossless keeps text/emoji crisp and preserves transparency.
 */
export function imageToSticker(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', 'pipe:0',
      '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=#00000000',
      '-vcodec', 'libwebp',
      '-lossless', '1',
      '-q:v', '80',
      '-loop', '0',
      '-preset', 'default',
      '-an', '-vsync', '0',
      '-f', 'webp',
      'pipe:1',
    ];
    const ff = spawn('ffmpeg', args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on('data', (c: Buffer) => out.push(c));
    ff.stderr.on('data', (c: Buffer) => err.push(c));
    ff.on('error', reject);
    ff.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-200)}`)),
    );
    ff.stdin.write(input);
    ff.stdin.end();
  });
}
