import { command } from '../core/registry.js';
import { jidNormalizedUser, proto } from 'baileys';
import { logger } from '../logger.js';
function quotedKey(m) {
    const id = m.quotedId;
    if (!id)
        return undefined;
    const participant = m.quoted?.sender ? jidNormalizedUser(m.quoted.sender) : undefined;
    const mine = !!participant && (participant === m.me || participant === m.meLid);
    return {
        remoteJid: m.chat,
        fromMe: mine,
        id,
        ...(m.isGroup && participant ? { participant } : {}),
    };
}
function quotedMessage(m) {
    const key = quotedKey(m);
    if (!key || !m.quoted)
        return undefined;
    return { key, message: m.quoted.raw };
}
command({ pattern: 'del', desc: 'Delete a message I sent', usage: '<reply to my message>', category: 'whatsapp', fromMe: true }, async (m) => {
    const key = quotedKey(m);
    if (!key)
        return m.usage();
    if (!key.fromMe)
        return m.reply('That one is not mine. Use dlt to remove a member’s message.');
    await m.client.sendMessage(m.chat, { delete: key });
});
command({
    pattern: 'dlt',
    desc: "Delete a member's message",
    usage: '<reply to the message>',
    category: 'group',
    groupOnly: true,
    adminOnly: true,
    botAdmin: true,
}, async (m) => {
    const key = quotedKey(m);
    if (!key)
        return m.usage();
    try {
        await m.client.sendMessage(m.chat, { delete: key });
    }
    catch (err) {
        logger.warn({ err }, 'dlt: delete failed');
        await m.reply('Could not delete it. WhatsApp only allows this for recent messages.');
    }
});
const PIN_DURATIONS = { '24h': 86400, '7d': 604800, '30d': 2592000 };
async function pinChat(m, pin) {
    try {
        await m.client.chatModify({ pin }, m.chat);
        await m.reply(pin ? '📌 Chat pinned to the top of your chat list.' : '📍 Chat unpinned.');
    }
    catch (err) {
        logger.warn({ err }, 'pin chat failed');
        await m.reply(pin ? 'Could not pin the chat. WhatsApp allows at most three pinned chats.' : 'Could not unpin the chat.');
    }
}
command({
    pattern: 'pin(?: (24h|7d|30d))?',
    desc: 'Reply to a message to pin it; no reply pins the whole chat',
    usage: '<reply to a message> [24h|7d|30d]',
    category: 'whatsapp',
}, async (m, match) => {
    const key = quotedKey(m);
    if (!key) {
        if (!m.isOwner)
            return m.usage('<reply to the message you want to pin> [24h|7d|30d]');
        return pinChat(m, true);
    }
    const time = PIN_DURATIONS[(match?.[1] ?? '7d').toLowerCase()] ?? 604800;
    try {
        await m.client.sendMessage(m.chat, { pin: key, type: proto.PinInChat.Type.PIN_FOR_ALL, time });
        await m.react('📌');
    }
    catch (err) {
        logger.warn({ err }, 'pin message failed');
        await m.reply(m.isGroup ? "Couldn't pin. In groups I need to be an admin to pin messages." : "Couldn't pin that message.");
    }
});
command({
    pattern: 'unpin',
    desc: 'Reply to a pinned message to unpin it; no reply unpins the chat',
    usage: '<reply to a pinned message>',
    category: 'whatsapp',
}, async (m) => {
    const key = quotedKey(m);
    if (!key) {
        if (!m.isOwner)
            return m.usage('<reply to the pinned message>');
        return pinChat(m, false);
    }
    try {
        await m.client.sendMessage(m.chat, { pin: key, type: proto.PinInChat.Type.UNPIN_FOR_ALL, time: 604800 });
        await m.react('📌');
    }
    catch (err) {
        logger.warn({ err }, 'unpin message failed');
        await m.reply("Couldn't unpin that message.");
    }
});
command({
    pattern: 'edit(?: (.*))?',
    desc: 'Edit a message I sent (reply to it)',
    usage: '<new text>',
    category: 'whatsapp',
    fromMe: true,
}, async (m, match) => {
    const text = (match?.[1] ?? '').trim();
    if (!text)
        return m.usage();
    const key = quotedKey(m);
    if (!key)
        return m.usage();
    if (!key.fromMe)
        return m.reply('I can only edit my own messages.');
    try {
        await m.client.sendMessage(m.chat, { text, edit: key });
    }
    catch (err) {
        logger.warn({ err }, 'edit: failed');
        await m.reply('Could not edit it. WhatsApp only allows edits for about 15 minutes.');
    }
});
command({
    pattern: 'react(?: (.*))?',
    desc: 'React to a message with an emoji (reply to it)',
    usage: '<emoji | clear>',
    category: 'whatsapp',
    fromMe: true,
}, async (m, match) => {
    const arg = (match?.[1] ?? '').trim();
    const key = quotedKey(m);
    if (!key)
        return m.usage();
    if (!arg)
        return m.usage();
    const text = /^(clear|remove|none)$/i.test(arg) ? '' : arg;
    await m.client.sendMessage(m.chat, { react: { text, key } });
});
function destination(m, arg) {
    const a = arg.trim();
    if (!a || /^(me|self)$/i.test(a))
        return m.me;
    if (m.mentioned.length)
        return jidNormalizedUser(m.mentioned[0]);
    const digits = a.replace(/[^0-9]/g, '');
    if (digits.length >= 6)
        return `${digits}@s.whatsapp.net`;
    if (a.endsWith('@g.us') || a.endsWith('@s.whatsapp.net'))
        return a;
    return undefined;
}
command({
    pattern: 'forward(?: (.*))?',
    desc: 'Forward the replied message somewhere else',
    usage: '<number | mention | me>',
    category: 'whatsapp',
    fromMe: true,
}, async (m, match) => {
    const msg = quotedMessage(m);
    if (!msg)
        return m.usage();
    const to = destination(m, match?.[1] ?? '');
    if (!to)
        return m.usage();
    await m.client.sendMessage(to, { forward: msg });
    if (to !== m.chat)
        await m.react('✅');
});
command({ pattern: 'save', desc: 'Forward a message to your own chat', usage: '<reply to the message>', category: 'whatsapp', fromMe: true }, async (m) => {
    const msg = quotedMessage(m);
    if (!msg)
        return m.usage();
    await m.client.sendMessage(m.me, { forward: msg });
    await m.react('📥');
});
command({ pattern: 'quoted', desc: 'Fetch what a replied message was itself replying to', usage: '<reply to a reply>', category: 'whatsapp' }, async (m) => {
    const outer = m.quoted?.raw;
    if (!outer)
        return m.usage();
    let inner;
    let participant;
    let innerId;
    for (const value of Object.values(outer)) {
        const ci = value
            ?.contextInfo;
        if (ci?.quotedMessage) {
            inner = ci.quotedMessage;
            participant = ci.participant ?? undefined;
            innerId = ci.stanzaId ?? undefined;
            break;
        }
    }
    if (!inner)
        return m.reply("That message wasn't replying to anything.");
    await m.client.sendMessage(m.chat, {
        forward: { key: { remoteJid: m.chat, fromMe: false, id: innerId, ...(participant ? { participant } : {}) }, message: inner },
    });
});
const HIDE = '‎'.repeat(4000);
command({
    pattern: 'readmore(?: (.*))?',
    desc: 'Hide text behind a "Read more" link. Split with |',
    usage: '<visible> | <hidden>',
    category: 'whatsapp',
}, async (m, match) => {
    const raw = (match?.[1] ?? '').trim() || m.quoted?.text || '';
    if (!raw)
        return m.usage();
    const [head, ...rest] = raw.split('|');
    if (!rest.length)
        return m.reply('Split the text with a *|*. Everything after it gets hidden.');
    await m.client.sendMessage(m.chat, { text: `${head.trim()}${HIDE}${rest.join('|').trim()}` });
});
command({
    pattern: '(?:iswa|onwa)(?: (.*))?',
    desc: 'Check whether a number is on WhatsApp',
    usage: '<number>',
    category: 'tools',
}, async (m, match) => {
    const arg = (match?.[1] ?? '').trim();
    const digits = (arg || m.quoted?.text || '').replace(/[^0-9]/g, '');
    if (digits.length < 6)
        return m.usage();
    const res = (await m.client.onWhatsApp(`${digits}@s.whatsapp.net`))?.[0];
    return m.reply(res?.exists ? `✅ +${digits} is on WhatsApp.` : `❌ +${digits} is not on WhatsApp.`);
});
