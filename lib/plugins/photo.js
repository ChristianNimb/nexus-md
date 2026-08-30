import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../core/registry.js';
import { unwrapContent } from '../core/message.js';
import { imageToSticker } from '../core/sticker.js';
import { logger } from '../logger.js';
async function getImage(m) {
    const own = unwrapContent(m.raw.message);
    const quoted = m.quoted?.raw;
    if (!own?.imageMessage && !quoted?.imageMessage)
        return undefined;
    return m.downloadMedia(!own?.imageMessage);
}
function removeBackground(inFile, outFile) {
    const py = 'from rembg import remove\n' +
        'import sys\n' +
        'data = open(sys.argv[1], "rb").read()\n' +
        'open(sys.argv[2], "wb").write(remove(data))\n';
    return new Promise((resolve, reject) => {
        const p = spawn('python3', ['-c', py, inFile, outFile], { stdio: ['ignore', 'ignore', 'pipe'] });
        const err = [];
        p.stderr.on('data', (d) => err.push(d));
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(Buffer.concat(err).toString().slice(-300)))));
    });
}
command({ pattern: 'nobg', desc: 'Remove the background from a photo', category: 'media' }, async (m) => {
    const img = await getImage(m);
    if (!img)
        return m.reply('🖼️ Reply to a photo (or send one) with .nobg and I’ll cut out the background.');
    await m.react('✂️');
    const dir = await mkdtemp(join(tmpdir(), 'nexus-bg-'));
    const inFile = join(dir, 'in.png');
    const outFile = join(dir, 'out.png');
    try {
        await writeFile(inFile, img);
        await removeBackground(inFile, outFile);
        const cut = await readFile(outFile);
        const sticker = await imageToSticker(cut);
        await m.sendSticker(sticker);
    }
    catch (err) {
        logger.error({ err }, 'nobg failed');
        await m.reply('😕 Couldn’t remove the background. If this is the first time, the model may still be downloading. Try again in a minute.');
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
