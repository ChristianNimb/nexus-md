import { command } from '../core/registry.js';
import { getGroupConfig, setGroupConfig, addWarn, resetWarns } from '../db/index.js';
import { groupMeta, isAdmin, invalidateGroup } from '../core/group.js';
import { unwrapContent } from '../core/message.js';
import { logger } from '../logger.js';
const WARN_LIMIT = 3;
function isMassMention(mentionCount, groupSize) {
    if (mentionCount >= 15)
        return true;
    if (mentionCount < 4)
        return false;
    const others = Math.max(1, groupSize - 1);
    return mentionCount >= Math.ceil(others * 0.5);
}
function countTextMentions(body) {
    const hits = body.match(/@(\d{5,})/g);
    if (!hits)
        return 0;
    return new Set(hits.map((h) => h.slice(1))).size;
}
function hasGroupMention(raw) {
    const content = unwrapContent(raw) ?? {};
    for (const value of Object.values(content)) {
        const gm = value?.contextInfo?.groupMentions;
        if (Array.isArray(gm) && gm.length)
            return true;
    }
    return false;
}
function isStatusMention(raw) {
    const content = unwrapContent(raw) ?? {};
    return Boolean(content.groupStatusMentionMessage);
}
command({
    pattern: 'antitag(?: (on|off|status|show|delete|warn|kick))?',
    desc: 'Block mass @everyone/tagall and status-mention pings',
    usage: 'on | off | delete | warn | kick',
    category: 'group',
    groupOnly: true,
    adminOnly: true,
}, async (m, match) => {
    const arg = (match?.[1] ?? '').trim().toLowerCase();
    const cfg = getGroupConfig(m.chat);
    const action = cfg.antitagAction ?? 'warn';
    if (!arg || arg === 'status' || arg === 'show') {
        return m.reply(`🛡️ antitag is *${cfg.antitag ? 'on' : 'off'}* (action: ${action}).\n` +
            '• Deletes mass @everyone / tagall from non-admins.\n' +
            '• Deletes "… mentioned this group in their status" cards.\n' +
            'Set with *antitag on|off*, or the action with *antitag delete|warn|kick*.\n' +
            '_(I need to be a group admin to delete.)_');
    }
    if (arg === 'on') {
        setGroupConfig(m.chat, { antitag: true });
        return m.reply(`✅ antitag on (action: ${action}). Mass-tags and status-mention cards will be removed.`);
    }
    if (arg === 'off') {
        setGroupConfig(m.chat, { antitag: false });
        return m.reply('antitag off.');
    }
    if (arg === 'delete' || arg === 'warn' || arg === 'kick') {
        setGroupConfig(m.chat, { antitagAction: arg });
        return m.reply(`✅ antitag action set to *${arg}*.${cfg.antitag ? '' : '\nTurn it on with *antitag on*.'}`);
    }
    return m.reply('Use *antitag on|off|delete|warn|kick*.');
});
command({ on: 'message' }, async (m) => {
    if (!m.isGroup || m.fromMe)
        return;
    const cfg = getGroupConfig(m.chat);
    if (!cfg.antitag)
        return;
    const status = isStatusMention(m.raw.message);
    const everyone = !status && hasGroupMention(m.raw.message);
    const mentionCount = Math.max(m.mentioned.length, countTextMentions(m.body));
    const manyMentions = !status && mentionCount >= 4;
    if (!status && !everyone && !manyMentions)
        return;
    let botIsAdmin = false;
    try {
        botIsAdmin = await isAdmin(m.client, m.chat, m.me, m.meLid);
    }
    catch {
        botIsAdmin = false;
    }
    if (status) {
        if (!botIsAdmin)
            return;
        try {
            await m.client.sendMessage(m.chat, { delete: m.raw.key });
        }
        catch (err) {
            logger.warn({ err }, 'antitag: could not delete status-mention card');
        }
        return;
    }
    if (m.isOwner)
        return;
    let size = 0;
    try {
        const meta = await groupMeta(m.client, m.chat);
        size = meta.participants.length;
        if (await isAdmin(m.client, m.chat, m.sender))
            return;
    }
    catch {
    }
    if (!everyone && !isMassMention(mentionCount, size || mentionCount + 1))
        return;
    if (!botIsAdmin) {
        await m.reply('⚠️ Please don\'t tag everyone here. (Make me an admin and I\'ll remove these automatically.)');
        return;
    }
    const tag = `@${m.senderNumber}`;
    try {
        await m.client.sendMessage(m.chat, { delete: m.raw.key });
    }
    catch (err) {
        logger.warn({ err }, 'antitag: could not delete mass-tag');
    }
    const action = cfg.antitagAction ?? 'warn';
    if (action === 'delete') {
        await m.send({ text: `🚫 ${tag}, please don't tag everyone.`, mentions: [m.sender] });
        return;
    }
    if (action === 'kick') {
        await m.send({ text: `🚫 ${tag} tagged everyone and was removed.`, mentions: [m.sender] });
        try {
            await m.client.groupParticipantsUpdate(m.chat, [m.sender], 'remove');
            invalidateGroup(m.chat);
        }
        catch (err) {
            logger.warn({ err }, 'antitag: could not remove sender');
        }
        return;
    }
    const count = addWarn(m.chat, m.sender);
    if (count >= WARN_LIMIT) {
        resetWarns(m.chat, m.sender);
        await m.send({ text: `🚫 ${tag} reached ${WARN_LIMIT} mass-tag warnings. Removing.`, mentions: [m.sender] });
        try {
            await m.client.groupParticipantsUpdate(m.chat, [m.sender], 'remove');
            invalidateGroup(m.chat);
        }
        catch (err) {
            logger.warn({ err }, 'antitag: could not remove sender');
        }
    }
    else {
        await m.send({ text: `⚠️ ${tag}, don't tag everyone here. Warning ${count}/${WARN_LIMIT}.`, mentions: [m.sender] });
    }
});
logger.debug('antitag plugin loaded');
