import { spawn } from 'node:child_process';
import { command } from '../core/registry.js';
import { Progress } from '../core/progress.js';
function toSticker(input) {
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
        const chunks = [];
        const errChunks = [];
        ff.stdout.on('data', (c) => chunks.push(c));
        ff.stderr.on('data', (c) => errChunks.push(c));
        ff.on('error', reject);
        ff.on('close', (code) => {
            if (code === 0)
                resolve(Buffer.concat(chunks));
            else
                reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString().slice(-300)}`));
        });
        ff.stdin.write(input);
        ff.stdin.end();
    });
}
command({ pattern: 'sticker', desc: 'Turn an image/video into a sticker', usage: '<reply to media>', category: 'media' }, async (m) => {
    const hasOwnMedia = m.type === 'imageMessage' || m.type === 'videoMessage';
    const buffer = await m.downloadMedia(!hasOwnMedia);
    if (!buffer)
        return m.usage();
    const progress = await Progress.start(m, '⏳');
    try {
        const webp = await toSticker(buffer);
        await progress.done();
        await m.sendSticker(webp);
    }
    catch (err) {
        await progress.fail();
        await m.reply('❌ Could not create the sticker. Is ffmpeg installed?');
        throw err;
    }
});
