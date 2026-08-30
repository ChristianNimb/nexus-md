import { command } from '../core/registry.js';
import { setAfk, clearAfk, getAfk } from '../db/index.js';
command({ pattern: 'afk ?(.*)', desc: 'Set yourself away', usage: '<reason>', category: 'utility', fromMe: true }, async (m, match) => {
    const reason = match?.[1]?.trim() || 'AFK';
    setAfk(m.sender, reason);
    await m.reply(`You are now AFK: ${reason}`);
});
command({ on: 'message' }, async (m) => {
    if (getAfk(m.sender) && !m.body.startsWith('.afk')) {
        clearAfk(m.sender);
        await m.reply('Welcome back. AFK removed.');
        return;
    }
    for (const jid of m.mentioned) {
        const row = getAfk(jid);
        if (row) {
            const mins = Math.floor((Date.now() - row.since) / 60000);
            await m.reply(`@${jid.split('@')[0]} is AFK: ${row.reason ?? 'AFK'} (${mins}m ago)`);
        }
    }
});
