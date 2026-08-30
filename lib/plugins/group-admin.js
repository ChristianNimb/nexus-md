import { command } from '../core/registry.js';
import { groupMeta, invalidateGroup } from '../core/group.js';
import { jidNormalizedUser } from 'baileys';
import { logger } from '../logger.js';
function targets(m, arg) {
    const out = new Set();
    if (m.quoted?.sender)
        out.add(jidNormalizedUser(m.quoted.sender));
    for (const j of m.mentioned)
        out.add(jidNormalizedUser(j));
    for (const chunk of (arg ?? '').split(/[\s,]+/)) {
        const digits = chunk.replace(/[^0-9]/g, '');
        if (digits.length >= 6)
            out.add(`${digits}@s.whatsapp.net`);
    }
    return [...out];
}
const ADD_STATUS = {
    '200': 'added',
    '403': 'has invites blocked by their privacy settings. Send them the link instead',
    '408': 'recently left; they have to rejoin themselves',
    '409': 'is already in the group',
    '500': 'could not be added',
};
command({
    pattern: 'add(?: (.*))?',
    desc: 'Add someone to the group',
    usage: '<number | reply | mention>',
    category: 'group',
    groupOnly: true,
    adminOnly: true,
    botAdmin: true,
}, async (m, match) => {
    const users = targets(m, match?.[1]);
    if (!users.length)
        return m.usage();
    const res = await m.client.groupParticipantsUpdate(m.chat, users, 'add');
    invalidateGroup(m.chat);
    const lines = res.map((r) => {
        const num = String(r.jid ?? '').split('@')[0];
        const note = ADD_STATUS[String(r.status)] ?? `failed (${r.status})`;
        return `${String(r.status) === '200' ? '✅' : '⚠️'} ${num}. ${note}`;
    });
    return m.reply(lines.join('\n') || 'Nothing happened.');
});
async function setting(m, value, done) {
    await m.client.groupSettingUpdate(m.chat, value);
    invalidateGroup(m.chat);
    return m.reply(done);
}
command({ pattern: 'mute', desc: 'Only admins can send messages', category: 'group', groupOnly: true, adminOnly: true, botAdmin: true }, (m) => setting(m, 'announcement', '🔇 Group muted. Only admins can send messages now.'));
command({ pattern: 'unmute', desc: 'Let everyone send messages again', category: 'group', groupOnly: true, adminOnly: true, botAdmin: true }, (m) => setting(m, 'not_announcement', '🔊 Group unmuted. Everyone can send messages.'));
command({ pattern: 'lock', desc: 'Only admins can edit group info', category: 'group', groupOnly: true, adminOnly: true, botAdmin: true }, (m) => setting(m, 'locked', '🔒 Locked. Only admins can change the group name, icon and description.'));
command({ pattern: 'unlock', desc: 'Let members edit group info', category: 'group', groupOnly: true, adminOnly: true, botAdmin: true }, (m) => setting(m, 'unlocked', '🔓 Unlocked. Members can change the group info.'));
command({
    pattern: 'gname(?: (.*))?',
    desc: "Change the group's name",
    usage: '<new name>',
    category: 'group',
    groupOnly: true,
    adminOnly: true,
    botAdmin: true,
}, async (m, match) => {
    const name = (match?.[1] ?? '').trim();
    if (!name)
        return m.usage();
    if (name.length > 100)
        return m.reply('That name is too long. WhatsApp caps it at 100 characters.');
    await m.client.groupUpdateSubject(m.chat, name);
    invalidateGroup(m.chat);
    return m.reply(`✅ Group renamed to ${name}.`);
});
command({
    pattern: 'gdesc(?: (.*))?',
    desc: "Change the group's description",
    usage: '<new description | clear>',
    category: 'group',
    groupOnly: true,
    adminOnly: true,
    botAdmin: true,
}, async (m, match) => {
    const desc = (match?.[1] ?? '').trim();
    if (!desc)
        return m.usage();
    const next = /^clear$/i.test(desc) ? '' : desc;
    await m.client.groupUpdateDescription(m.chat, next);
    invalidateGroup(m.chat);
    return m.reply(next ? '✅ Description updated.' : '✅ Description cleared.');
});
command({ pattern: 'invite', desc: "Get the group's invite link", category: 'group', groupOnly: true, adminOnly: true, botAdmin: true }, async (m) => {
    const code = await m.client.groupInviteCode(m.chat);
    if (!code)
        return m.reply('Could not fetch the invite link.');
    return m.reply(`🔗 https://chat.whatsapp.com/${code}`);
});
command({ pattern: 'revoke', desc: 'Reset the invite link (the old one stops working)', category: 'group', groupOnly: true, adminOnly: true, botAdmin: true }, async (m) => {
    const code = await m.client.groupRevokeInvite(m.chat);
    if (!code)
        return m.reply('Could not reset the invite link.');
    return m.reply(`♻️ Invite link reset. The old one no longer works.\n\n🔗 https://chat.whatsapp.com/${code}`);
});
function inviteCode(input) {
    return input
        .trim()
        .replace(/^https?:\/\/chat\.whatsapp\.com\//i, '')
        .split(/[?\s]/)[0];
}
command({
    pattern: 'ginfo(?: (.*))?',
    desc: 'Show info about this group, or preview an invite link',
    usage: '[invite link]',
    category: 'group',
}, async (m, match) => {
    const arg = (match?.[1] ?? '').trim();
    const meta = arg
        ? await m.client.groupGetInviteInfo(inviteCode(arg))
        : m.isGroup
            ? await groupMeta(m.client, m.chat)
            : undefined;
    if (!meta)
        return m.usage();
    const admins = meta.participants.filter((p) => p.admin).length;
    const made = meta.creation ? new Date(meta.creation * 1000).toISOString().slice(0, 10) : 'unknown';
    return m.reply(`📋 ${meta.subject}\n` +
        `Members: ${meta.participants.length} (${admins} admin${admins === 1 ? '' : 's'})\n` +
        `Created: ${made}\n` +
        `Announcement-only: ${meta.announce ? 'yes' : 'no'}\n` +
        `Info locked: ${meta.restrict ? 'yes' : 'no'}` +
        (meta.desc ? `\n\n${String(meta.desc).slice(0, 400)}` : ''));
});
command({ pattern: 'join(?: (.*))?', fromMe: true, desc: 'Join a group by invite link', usage: '<invite link>', category: 'group' }, async (m, match) => {
    const arg = (match?.[1] ?? '').trim() || m.quoted?.text || '';
    const code = inviteCode(arg);
    if (!code)
        return m.usage();
    try {
        const jid = await m.client.groupAcceptInvite(code);
        return m.reply(jid ? '✅ Joined.' : 'Could not join. The link may be expired or revoked.');
    }
    catch (err) {
        logger.warn({ err }, 'join: failed to accept invite');
        return m.reply('Could not join. The link may be expired, revoked, or I am already a member.');
    }
});
command({ pattern: 'left', fromMe: true, desc: 'Leave this group', category: 'group', groupOnly: true }, async (m) => {
    await m.reply('👋 Leaving. Thanks for having me!');
    await m.client.groupLeave(m.chat);
    invalidateGroup(m.chat);
});
