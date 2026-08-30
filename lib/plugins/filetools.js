import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textToPdf, extractZip, createZip } from '@nexus21/nexus-api';
import { command } from '../core/registry.js';
import { unwrapContent } from '../core/message.js';
import { logger } from '../logger.js';
command({ pattern: 'topdf ?(.*)', desc: 'Turn text into a PDF', usage: '<text> or reply to a message', category: 'tools' }, async (m, match) => {
    const text = ((match?.[1] ?? '').trim() || m.quoted?.text?.trim() || '').trim();
    if (!text)
        return m.reply('📄 Give me some text. .topdf <your text>, or reply to a message with .topdf.');
    await m.react('📄');
    const dir = await mkdtemp(join(tmpdir(), 'nexpdf-'));
    const savePath = join(dir, 'document.pdf');
    try {
        await textToPdf(text, savePath, { title: 'Nexus Document', fontSize: 12 });
        const buf = await readFile(savePath);
        await m.send({ document: buf, mimetype: 'application/pdf', fileName: 'document.pdf' }, { quoted: m.raw });
    }
    catch (err) {
        logger.error({ err }, 'topdf failed');
        await m.reply('😕 Couldn\'t make that PDF right now.');
    }
    finally {
        await rm(dir, { recursive: true, force: true }).catch(() => { });
    }
});
function zipInfo(m) {
    const own = unwrapContent(m.raw.message)?.documentMessage;
    const quoted = m.quoted?.raw?.documentMessage;
    const node = own ?? quoted;
    if (!node)
        return undefined;
    const name = node.fileName ?? '';
    const isZip = /\.zip$/i.test(name) || /zip/i.test(node.mimetype ?? '');
    if (!isZip)
        return undefined;
    return { fromQuoted: !own, name: name || 'archive.zip' };
}
command({ pattern: 'unzip', desc: 'Extract a .zip file (reply to it)', category: 'tools' }, async (m) => {
    const info = zipInfo(m);
    if (!info)
        return m.reply('📦 Reply to a .zip file with .unzip (or send one with .unzip as the caption).');
    await m.react('📦');
    const buf = await m.downloadMedia(info.fromQuoted);
    if (!buf)
        return m.reply('😕 Couldn\'t download that file. Try again.');
    const dir = await mkdtemp(join(tmpdir(), 'nexzip-'));
    const zipPath = join(dir, 'in.zip');
    const outDir = join(dir, 'out');
    try {
        await writeFile(zipPath, buf);
        const { files } = await extractZip(zipPath, outDir);
        if (!files.length)
            return void (await m.reply('📦 That zip is empty.'));
        const list = files.slice(0, 30).map((f) => `• ${f}`).join('\n');
        await m.reply(`📦 ${info.name}. ${files.length} file(s):\n${list}${files.length > 30 ? `\n…and ${files.length - 30} more` : ''}`);
        let sent = 0;
        for (const rel of files) {
            if (sent >= 10)
                break;
            const fbuf = await readFile(join(outDir, rel)).catch(() => undefined);
            if (!fbuf || !fbuf.length || fbuf.length > 60 * 1024 * 1024)
                continue;
            const name = rel.split('/').pop() || rel;
            if (/\.(jpe?g|png|webp|gif)$/i.test(name))
                await m.send({ image: fbuf }, { quoted: m.raw });
            else
                await m.send({ document: fbuf, fileName: name, mimetype: 'application/octet-stream' }, { quoted: m.raw });
            sent++;
        }
        if (files.length > sent)
            await m.reply(`_(sent the first ${sent}. Grab the rest by unzipping locally.)_`);
    }
    catch (err) {
        logger.error({ err }, 'unzip failed');
        await m.reply('😕 Couldn\'t extract that. It may be corrupt or password-protected.');
    }
    finally {
        await rm(dir, { recursive: true, force: true }).catch(() => { });
    }
});
function fileToZip(m) {
    const own = unwrapContent(m.raw.message);
    const q = m.quoted?.raw;
    const pick = (o) => o?.documentMessage ?? o?.imageMessage ?? o?.videoMessage ?? o?.audioMessage;
    const ownNode = pick(own);
    const node = ownNode ?? pick(q);
    if (!node)
        return undefined;
    const ext = own?.imageMessage || q?.imageMessage ? 'jpg' : own?.videoMessage || q?.videoMessage ? 'mp4' : own?.audioMessage || q?.audioMessage ? 'mp3' : '';
    const name = node.fileName || (ext ? `file.${ext}` : 'file');
    return { fromQuoted: !ownNode, name };
}
command({ pattern: 'zip', desc: 'Compress a file into a .zip (reply to it)', category: 'tools' }, async (m) => {
    const info = fileToZip(m);
    if (!info)
        return m.reply('🗜️ Reply to a file (document, image, video…) with .zip and I\'ll compress it.');
    await m.react('🗜️');
    const buf = await m.downloadMedia(info.fromQuoted);
    if (!buf)
        return m.reply('😕 Couldn\'t download that file. Try again.');
    const dir = await mkdtemp(join(tmpdir(), 'nexzip-'));
    const src = join(dir, info.name.replace(/[^\w.\-]/g, '_'));
    const zipPath = join(dir, `${info.name.replace(/\.[^.]+$/, '') || 'archive'}.zip`);
    try {
        await writeFile(src, buf);
        const { size } = await createZip(src, zipPath);
        const zbuf = await readFile(zipPath);
        const fname = zipPath.split('/').pop() || 'archive.zip';
        await m.send({ document: zbuf, mimetype: 'application/zip', fileName: fname }, { quoted: m.raw });
        await m.reply(`🗜️ Zipped ${info.name} → ${fname} (${(size / 1024).toFixed(0)} KB).`);
    }
    catch (err) {
        logger.error({ err }, 'zip failed');
        await m.reply('😕 Couldn\'t zip that one right now.');
    }
    finally {
        await rm(dir, { recursive: true, force: true }).catch(() => { });
    }
});
logger.debug('filetools plugin loaded');
