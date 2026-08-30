import { command } from '../core/registry.js';
import { getGroupConfig, addWarn, resetWarns } from '../db/index.js';
import { isAdmin, invalidateGroup } from '../core/group.js';
import { logger } from '../logger.js';
const WARN_LIMIT = 3;
const LINK_RE = /(https?:\/\/|www\.)\S+|chat\.whatsapp\.com\/\S+|t\.me\/\S+|\b[a-z0-9-]+\.(?:com|net|org|io|me|xyz|gg|link|info|co|app|dev|tv|to|ru|uk|in|ng)\b(?:\/\S*)?/i;
async function removeSender(m) {
    try {
        await m.client.groupParticipantsUpdate(m.chat, [m.sender], 'remove');
        invalidateGroup(m.chat);
    }
    catch (err) {
        logger.warn({ err }, 'antilink: failed to remove sender');
        await m.reply('Could not remove them. Do I have admin rights?');
    }
}
command({ on: 'message' }, async (m) => {
    if (!m.isGroup || m.fromMe)
        return;
    const cfg = getGroupConfig(m.chat);
    if (!cfg.antilink)
        return;
    if (!m.body || !LINK_RE.test(m.body))
        return;
    if (m.isOwner)
        return;
    try {
        if (await isAdmin(m.client, m.chat, m.sender))
            return;
    }
    catch {
    }
    let botIsAdmin = false;
    try {
        botIsAdmin = await isAdmin(m.client, m.chat, m.me, m.meLid);
    }
    catch {
        botIsAdmin = false;
    }
    if (!botIsAdmin) {
        await m.reply('⚠️ Links are not allowed here. (Make me an admin so I can remove them.)');
        return;
    }
    const tag = `@${m.sender.split('@')[0]}`;
    try {
        await m.client.sendMessage(m.chat, { delete: m.raw.key });
    }
    catch (err) {
        logger.warn({ err }, 'antilink: failed to delete message');
    }
    const action = cfg.antilinkAction ?? 'warn';
    if (action === 'kick') {
        await m.send({ text: `🚫 ${tag} posted a link and was removed.`, mentions: [m.sender] });
        await removeSender(m);
        return;
    }
    const count = addWarn(m.chat, m.sender);
    if (count >= WARN_LIMIT) {
        await m.send({ text: `🚫 ${tag} reached ${WARN_LIMIT} link warnings. Removing.`, mentions: [m.sender] });
        await removeSender(m);
        resetWarns(m.chat, m.sender);
    }
    else {
        await m.send({
            text: `⚠️ ${tag}, links aren't allowed here. Warning ${count}/${WARN_LIMIT}.`,
            mentions: [m.sender],
        });
    }
});
