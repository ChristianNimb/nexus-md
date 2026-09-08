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
    return [{ key: m.raw.key, messageTimestamp: Number(m.raw.messageTimestamp ?? 0) }];
}
async function setArchive(m, archive) {
    try {
        if (archive) {
            await m.reply('📦 Archived. Find it under your *Archived chats*. (WhatsApp auto-unarchives a chat when a new message arrives, unless you turn on "Keep chats archived" in Settings › Chats.)');
            await m.client.chatModify({ archive: true, lastMessages: lastMessages(m) }, m.chat);
            return;
        }
        await m.client.chatModify({ archive: false, lastMessages: lastMessages(m) }, m.chat);
        return m.reply('📂 Chat unarchived.');
    }
    catch (err) {
        logger.warn({ err }, 'archive toggle failed');
        return m.reply('Could not change the archive state.');
    }
}
command({ pattern: 'archi(?:e)?ve', fromMe: true, desc: 'Archive this chat (moves it to Archived chats)', category: 'whatsapp' }, (m) => setArchive(m, true));
command({ pattern: 'unarchi(?:e)?ve', fromMe: true, desc: 'Unarchive this chat', category: 'whatsapp' }, (m) => setArchive(m, false));
async function setPin(m, pin) {
    try {
        await m.client.chatModify({ pin }, m.chat);
        return m.reply(pin ? '📌 Chat pinned to the top of your chat list.' : '📍 Chat unpinned.');
    }
    catch (err) {
        logger.warn({ err }, 'pin toggle failed');
        return m.reply(pin ? 'Could not pin the chat. WhatsApp allows at most three pinned chats.' : 'Could not unpin the chat.');
    }
}
command({ pattern: 'pinchat', fromMe: true, desc: 'Pin this whole chat to the top of your chat list', category: 'whatsapp' }, (m) => setPin(m, true));
command({ pattern: 'unpinchat', fromMe: true, desc: 'Unpin this chat from your chat list', category: 'whatsapp' }, (m) => setPin(m, false));
