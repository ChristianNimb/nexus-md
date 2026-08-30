import { command } from '../core/registry.js';
import { getGroupConfig, setGroupConfig, addWarn, resetWarns } from '../db/index.js';
import { isAdmin, invalidateGroup } from '../core/group.js';
import { logger } from '../logger.js';
const WARN_LIMIT = 3;
command({
    pattern: 'antiword(?: (on|off|status|show|list|(?:add|del|remove) .+))?',
    desc: 'Ban words in this group',
    usage: 'on | off | add <word> | del <word> | list',
    category: 'group',
    groupOnly: true,
    adminOnly: true,
}, async (m, match) => {
    const arg = (match?.[1] ?? '').trim();
    const cfg = getGroupConfig(m.chat);
    const words = cfg.antiwords ?? [];
    if (!arg || /^(status|show)$/i.test(arg)) {
        return m.reply(`🛡️ antiword is ${cfg.antiword ? 'on' : 'off'} (${words.length} word${words.length === 1 ? '' : 's'}).\n` +
            'Use antiword add <word>, antiword del <word>, antiword list, *antiword on|off*.');
    }
    if (/^on$/i.test(arg)) {
        if (!words.length)
            return m.reply('Add a word first: antiword add <word>');
        setGroupConfig(m.chat, { antiword: true });
        return m.reply('Antiword has been enabled.');
    }
    if (/^off$/i.test(arg)) {
        setGroupConfig(m.chat, { antiword: false });
        return m.reply('Antiword has been disabled.');
    }
    if (/^list$/i.test(arg)) {
        if (!words.length)
            return m.reply('No banned words yet.');
        return m.reply(`🚫 Banned words (${words.length})\n` + words.map((w) => `• ${w}`).join('\n'));
    }
    const add = arg.match(/^add\s+(.+)$/i);
    if (add) {
        const w = add[1].trim().toLowerCase();
        if (words.includes(w))
            return m.reply('That word is already banned.');
        setGroupConfig(m.chat, { antiwords: [...words, w] });
        return m.reply(`✅ Banned ${w}.${cfg.antiword ? '' : '\nTurn it on with antiword on.'}`);
    }
    const del = arg.match(/^(?:del|rm|remove)\s+(.+)$/i);
    if (del) {
        const w = del[1].trim().toLowerCase();
        const next = words.filter((x) => x !== w);
        if (next.length === words.length)
            return m.reply('That word is not on the list.');
        setGroupConfig(m.chat, { antiwords: next });
        return m.reply(`✅ Removed ${w}.`);
    }
    return m.reply('Use *antiword on|off|add <word>|del <word>|list*.');
});
command({ on: 'message' }, async (m) => {
    if (!m.isGroup || m.fromMe || !m.body)
        return;
    const cfg = getGroupConfig(m.chat);
    if (!cfg.antiword || !cfg.antiwords?.length)
        return;
    if (m.isOwner)
        return;
    const body = m.body.toLowerCase();
    const hit = cfg.antiwords.find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body));
    if (!hit)
        return;
    try {
        if (await isAdmin(m.client, m.chat, m.sender))
            return;
    }
    catch {
    }
    try {
        await m.client.sendMessage(m.chat, { delete: m.raw.key });
    }
    catch (err) {
        logger.warn({ err }, 'antiword: could not delete message');
    }
    const count = addWarn(m.chat, m.sender);
    if (count >= WARN_LIMIT) {
        resetWarns(m.chat, m.sender);
        try {
            await m.client.groupParticipantsUpdate(m.chat, [m.sender], 'remove');
            invalidateGroup(m.chat);
            await m.client.sendMessage(m.chat, { text: `🚫 Removed @${m.senderNumber}. Banned word, ${WARN_LIMIT}/${WARN_LIMIT} warnings.`, mentions: [m.sender] });
        }
        catch (err) {
            logger.warn({ err }, 'antiword: could not remove sender');
        }
        return;
    }
    await m.client.sendMessage(m.chat, {
        text: `⚠️ @${m.senderNumber}, that word isn't allowed here. Warning ${count}/${WARN_LIMIT}.`,
        mentions: [m.sender],
    });
});
command({
    pattern: 'antifake(?: (on|off|status|show|list))?',
    desc: 'Remove joiners from disallowed country codes',
    usage: 'on | off | allow <code,code> | list',
    category: 'group',
    groupOnly: true,
    adminOnly: true,
}, async (m, match) => {
    const arg = (match?.[1] ?? '').trim();
    const cfg = getGroupConfig(m.chat);
    const allow = cfg.antifakeAllow ?? [];
    if (!arg || /^(status|show|list)$/i.test(arg)) {
        return m.reply(`🛡️ antifake is ${cfg.antifake ? 'on' : 'off'}.\n` +
            `Allowed country codes: ${allow.length ? allow.map((c) => `+${c}`).join(', ') : '(none set)'}\n` +
            'Set them with antifake allow 86,1 then antifake on.');
    }
    if (/^on$/i.test(arg)) {
        if (!allow.length)
            return m.reply('Set the allowed country codes first: antifake allow 86,1');
        setGroupConfig(m.chat, { antifake: true });
        return m.reply(`Antifake has been enabled. Only ${allow.map((c) => `+${c}`).join(', ')} may join.`);
    }
    if (/^off$/i.test(arg)) {
        setGroupConfig(m.chat, { antifake: false });
        return m.reply('Antifake has been disabled.');
    }
    const set = arg.match(/^allow\s+(.+)$/i);
    if (set) {
        const codes = [...new Set(set[1].split(/[\s,]+/).map((c) => c.replace(/[^0-9]/g, '')).filter(Boolean))];
        if (!codes.length)
            return m.reply('Give me country codes, e.g. antifake allow 86,1,44');
        setGroupConfig(m.chat, { antifakeAllow: codes });
        return m.reply(`✅ Allowed: ${codes.map((c) => `+${c}`).join(', ')}`);
    }
    return m.reply('Use *antifake on|off|allow <codes>|list*.');
});
