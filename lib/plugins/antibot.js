import { command } from '../core/registry.js';
import { getGroupConfig, setGroupConfig } from '../db/index.js';
import { isAdmin, invalidateGroup } from '../core/group.js';
import { unwrapContent } from '../core/message.js';
import { logger } from '../logger.js';
const BOT_ONLY_TYPES = new Set([
    'buttonsMessage',
    'buttonsResponseMessage',
    'templateMessage',
    'templateButtonReplyMessage',
    'listMessage',
    'listResponseMessage',
    'interactiveMessage',
    'interactiveResponseMessage',
]);
const COMMAND_RE = /^[.!/#$&+\-;,]\w{2,20}\b/;
const recentCommands = new Map();
const REPLY_WINDOW_MS = 45_000;
function rememberCommand(id) {
    if (!id)
        return;
    recentCommands.set(id, Date.now());
    if (recentCommands.size > 500) {
        const cutoff = Date.now() - REPLY_WINDOW_MS;
        for (const [k, t] of recentCommands)
            if (t < cutoff)
                recentCommands.delete(k);
    }
}
function answersACommand(m) {
    const quoted = m.quotedId;
    if (!quoted)
        return false;
    const at = recentCommands.get(quoted);
    return at !== undefined && Date.now() - at < REPLY_WINDOW_MS;
}
function botSignal(m) {
    const content = unwrapContent(m.raw.message);
    if (content) {
        for (const key of Object.keys(content)) {
            if (BOT_ONLY_TYPES.has(key))
                return 'sent an interactive message only bots can create';
        }
    }
    if (answersACommand(m))
        return 'answered a command meant for a bot';
    return undefined;
}
command({
    pattern: 'antibot(?: (on|off))?',
    desc: 'Remove other bots running commands here',
    usage: 'on|off',
    category: 'group',
    groupOnly: true,
    adminOnly: true,
}, async (m, match) => {
    const v = match?.[1]?.trim().toLowerCase();
    if (v === 'on') {
        setGroupConfig(m.chat, { antibot: true });
        return m.reply('Antibot has been enabled.');
    }
    if (v === 'off') {
        setGroupConfig(m.chat, { antibot: false });
        return m.reply('Antibot has been disabled.');
    }
    await m.reply(`Antibot is ${getGroupConfig(m.chat).antibot ? 'enabled' : 'disabled'}.`);
});
command({ on: 'message' }, async (m) => {
    if (!m.isGroup || m.fromMe)
        return;
    if (m.body && COMMAND_RE.test(m.body.trim())) {
        rememberCommand(m.raw.key.id);
        return;
    }
    if (!getGroupConfig(m.chat).antibot)
        return;
    if (m.isOwner)
        return;
    const signal = botSignal(m);
    if (!signal)
        return;
    try {
        if (await isAdmin(m.client, m.chat, m.sender))
            return;
    }
    catch {
    }
    try {
        if (!(await isAdmin(m.client, m.chat, m.me, m.meLid)))
            return;
    }
    catch {
        return;
    }
    try {
        await m.client.sendMessage(m.chat, {
            text: `🤖 Removing @${m.sender.split('@')[0]}. ${signal}.`,
            mentions: [m.sender],
        });
        await m.client.sendMessage(m.chat, { delete: m.raw.key });
        await m.client.groupParticipantsUpdate(m.chat, [m.sender], 'remove');
        invalidateGroup(m.chat);
    }
    catch (err) {
        logger.warn({ err }, 'antibot: failed to remove');
    }
});
