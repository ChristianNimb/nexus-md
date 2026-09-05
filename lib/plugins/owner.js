import { command } from '../core/registry.js';
import { config } from '../config.js';
import { addSudo, removeSudo, listSudo } from '../db/index.js';
import { displayNumber } from '../core/lid.js';
import { jidNormalizedUser } from 'baileys';
function targetJid(m) {
    if (m.quoted?.sender)
        return jidNormalizedUser(m.quoted.sender);
    if (m.mentioned.length)
        return jidNormalizedUser(m.mentioned[0]);
    return undefined;
}
command({ pattern: 'setsudo', fromMe: true, desc: 'Grant sudo to a user', usage: '<reply or mention>', category: 'owner' }, async (m) => {
    const jid = targetJid(m);
    if (!jid)
        return m.usage();
    addSudo(jid);
    await m.reply(`Added sudo: +${await displayNumber(m.client, jid, m.isGroup ? m.chat : undefined)}`);
});
command({ pattern: 'delsudo', fromMe: true, desc: 'Revoke a user’s sudo', usage: '<reply or mention>', category: 'owner' }, async (m) => {
    const jid = targetJid(m);
    if (!jid)
        return m.usage();
    removeSudo(jid);
    await m.reply(`Removed sudo: +${await displayNumber(m.client, jid, m.isGroup ? m.chat : undefined)}`);
});
command({ pattern: 'listsudo', fromMe: true, desc: 'List sudo users', category: 'owner' }, async (m) => {
    const fromDb = await Promise.all(listSudo().map(async (j) => `• +${await displayNumber(m.client, j)}`));
    const fromEnv = config.sudo.map((n) => `• +${n}  (env)`);
    const lines = [...fromEnv, ...fromDb];
    if (!lines.length)
        return m.reply('No sudo users configured.');
    await m.reply('Sudo users:\n' + lines.join('\n'));
});
