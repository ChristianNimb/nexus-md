import { command } from '../core/registry.js';
import { listBanned, addBan, removeBan, isBanned } from '../db/index.js';
import { jidNormalizedUser } from 'baileys';
import { logger } from '../logger.js';
function target(m, arg) {
    if (m.quoted?.sender)
        return jidNormalizedUser(m.quoted.sender);
    if (m.mentioned.length)
        return jidNormalizedUser(m.mentioned[0]);
    const digits = (arg ?? '').replace(/[^0-9]/g, '');
    return digits.length >= 6 ? `${digits}@s.whatsapp.net` : undefined;
}
command({
    pattern: 'ban(?: (.*))?',
    fromMe: true,
    desc: 'Stop someone from using the bot',
    usage: '<reply | mention | number>',
    category: 'owner',
}, async (m, match) => {
    const jid = target(m, match?.[1]);
    if (!jid)
        return m.usage();
    if (jid === m.me)
        return m.reply("You can't ban yourself 🙂");
    if (isBanned(jid))
        return m.reply('They are already banned.');
    addBan(jid);
    return m.reply(`🚫 Banned ${jid.split('@')[0]}. I'll ignore their commands from now on.`);
});
command({
    pattern: 'unban(?: (.*))?',
    fromMe: true,
    desc: 'Let someone use the bot again',
    usage: '<reply | mention | number>',
    category: 'owner',
}, async (m, match) => {
    const jid = target(m, match?.[1]);
    if (!jid)
        return m.usage();
    if (!removeBan(jid))
        return m.reply('They were not banned.');
    return m.reply(`✅ Unbanned ${jid.split('@')[0]}.`);
});
command({ pattern: 'listban', fromMe: true, desc: 'Show everyone the bot is ignoring', category: 'owner' }, async (m) => {
    const list = listBanned();
    if (!list.length)
        return m.reply('Nobody is banned.');
    return m.reply(`🚫 Banned (${list.length})\n` + list.map((b) => `• ${b.split('@')[0]}`).join('\n'));
});
async function setBlock(m, arg, action) {
    const jid = target(m, arg) ?? (m.isGroup ? undefined : m.chat);
    if (!jid)
        return m.usage();
    if (jid === m.me)
        return m.reply(`You can't ${action} yourself 🙂`);
    try {
        await m.client.updateBlockStatus(jid, action);
        return m.reply(`${action === 'block' ? '🚫 Blocked' : '✅ Unblocked'} ${jid.split('@')[0]}.`);
    }
    catch (err) {
        logger.warn({ err, action }, 'block status update failed');
        return m.reply(`Could not ${action} them.`);
    }
}
command({ pattern: 'block(?: (.*))?', fromMe: true, desc: 'Block someone on WhatsApp', usage: '<reply | mention | number>', category: 'owner' }, (m, match) => setBlock(m, match?.[1], 'block'));
command({ pattern: 'unblock(?: (.*))?', fromMe: true, desc: 'Unblock someone on WhatsApp', usage: '<reply | mention | number>', category: 'owner' }, (m, match) => setBlock(m, match?.[1], 'unblock'));
function lastMessages(m) {
    return [{ key: m.raw.key, messageTimestamp: m.raw.messageTimestamp }];
}
async function setArchive(m, archive) {
    try {
        await m.client.chatModify({ archive, lastMessages: lastMessages(m) }, m.chat);
        return m.reply(archive ? '📦 Chat archived.' : '📂 Chat unarchived.');
    }
    catch (err) {
        logger.warn({ err }, 'archive toggle failed');
        return m.reply('Could not change the archive state.');
    }
}
command({ pattern: 'archive', fromMe: true, desc: 'Archive this chat', category: 'whatsapp' }, (m) => setArchive(m, true));
command({ pattern: 'unarchive', fromMe: true, desc: 'Unarchive this chat', category: 'whatsapp' }, (m) => setArchive(m, false));
async function setPin(m, pin) {
    try {
        await m.client.chatModify({ pin }, m.chat);
        return m.reply(pin ? '📌 Chat pinned.' : '📍 Chat unpinned.');
    }
    catch (err) {
        logger.warn({ err }, 'pin toggle failed');
        return m.reply(pin ? 'Could not pin. You may already have three pinned chats.' : 'Could not unpin.');
    }
}
command({ pattern: 'pin', fromMe: true, desc: 'Pin this chat', category: 'whatsapp' }, (m) => setPin(m, true));
command({ pattern: 'unpin', fromMe: true, desc: 'Unpin this chat', category: 'whatsapp' }, (m) => setPin(m, false));
