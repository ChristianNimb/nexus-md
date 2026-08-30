import os from 'node:os';
import { command } from '../core/registry.js';
import { getStat } from '../db/index.js';
import { unwrapContent } from '../core/message.js';
import { logger } from '../logger.js';
import { vaultJid } from '../core/vault.js';
command({ pattern: 'jid', desc: 'Show the current chat JID', category: 'tools' }, async (m) => {
    await m.reply(`Chat: ${m.chat}\nYou: ${m.sender}`);
});
command({ pattern: 'runtime', desc: 'Host resource usage', category: 'tools' }, async (m) => {
    const mem = process.memoryUsage();
    const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
    await m.reply(`Runtime\n` +
        `• Node: ${process.version}\n` +
        `• Platform: ${os.platform()} ${os.arch()}\n` +
        `• RSS: ${mb(mem.rss)} | Heap: ${mb(mem.heapUsed)}/${mb(mem.heapTotal)}\n` +
        `• CPU: ${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}\n` +
        `• Load: ${os.loadavg().map((n) => n.toFixed(2)).join(', ')}`);
});
command({ pattern: 'mystats', desc: 'Your message count', category: 'tools' }, async (m) => {
    await m.reply(`You've sent ${getStat(m.sender)} messages I've seen.`);
});
async function extractViewOnce(m) {
    const content = unwrapContent(m.quoted?.raw);
    if (!content) {
        await m.usage('<reply to a view-once photo or video>');
        return undefined;
    }
    const img = content.imageMessage;
    const vid = content.videoMessage;
    if (!img && !vid) {
        await m.reply('That message has no photo or video to reveal.');
        return undefined;
    }
    const buffer = await m.downloadContent(content);
    if (!buffer) {
        await m.reply('Could not download it. The media may have expired or already been opened elsewhere.');
        return undefined;
    }
    const from = m.quoted?.sender ? `+${m.quoted.sender.split('@')[0].split(':')[0]}` : 'unknown sender';
    const where = m.isGroup ? 'a group' : 'a DM';
    const original = (img?.caption || vid?.caption) ?? '';
    return {
        isImage: Boolean(img),
        buffer,
        caption: `🔓 View-once from ${from} (in ${where})${original ? `\n\n${original}` : ''}`,
    };
}
command({ pattern: 'vv', desc: 'Reveal a view-once. Privately to your DM', usage: '<reply>', category: 'tools', fromMe: true }, async (m) => {
    const media = await extractViewOnce(m);
    if (!media)
        return;
    const target = vaultJid(m);
    try {
        if (media.isImage)
            await m.client.sendMessage(target, { image: media.buffer, caption: media.caption });
        else
            await m.client.sendMessage(target, { video: media.buffer, caption: media.caption });
        await m.react('📩');
        logger.info({ target }, 'vv: forwarded view-once to DM');
    }
    catch (err) {
        logger.error({ err, target }, 'vv: failed to forward');
        await m.reply(`Could not forward to your DM (${target.split('@')[0]}). Falling back to this chat.`);
        if (media.isImage)
            await m.sendImage(media.buffer, media.caption);
        else
            await m.sendVideo(media.buffer, media.caption);
    }
});
command({ pattern: 'vvhere', desc: 'Reveal a view-once in this chat', usage: '<reply>', category: 'tools', fromMe: true }, async (m) => {
    const media = await extractViewOnce(m);
    if (!media)
        return;
    if (media.isImage)
        await m.sendImage(media.buffer, media.caption);
    else
        await m.sendVideo(media.buffer, media.caption);
});
