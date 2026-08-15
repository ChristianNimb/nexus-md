import { command } from '../core/registry.js';
import { setAfk, clearAfk, getAfk } from '../db/index.js';

/**
 * AFK: mark yourself away, then auto-reply when mentioned and clear the status
 * as soon as you send a message again. Shows how an `on: 'message'` subscriber
 * runs alongside pattern commands.
 */

command(
  { pattern: 'afk ?(.*)', desc: 'Set yourself away', usage: '<reason>', category: 'utility', fromMe: true },
  async (m, match) => {
    const reason = match?.[1]?.trim() || 'AFK';
    setAfk(m.sender, reason);
    await m.reply(`You are now AFK: ${reason}`);
  },
);

// Runs on every message: clear our own AFK, and notify if an AFK user is mentioned.
command({ on: 'message' }, async (m) => {
  // If the sender was AFK and just spoke, clear it.
  if (getAfk(m.sender) && !m.body.startsWith('.afk')) {
    clearAfk(m.sender);
    await m.reply('Welcome back — AFK removed.');
    return;
  }

  // Notify for any mentioned users who are AFK.
  for (const jid of m.mentioned) {
    const row = getAfk(jid);
    if (row) {
      const mins = Math.floor((Date.now() - row.since) / 60000);
      await m.reply(`@${jid.split('@')[0]} is AFK: ${row.reason ?? 'AFK'} (${mins}m ago)`);
    }
  }
});
