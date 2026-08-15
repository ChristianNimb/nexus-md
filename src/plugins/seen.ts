import type { WASocket } from 'baileys';
import { command } from '../core/registry.js';
import { resolveJid } from '../core/lid.js';
import { logger } from '../logger.js';

/**
 * "Who's seen my message?" — WhatsApp sends the account read receipts for the
 * messages IT sent (that's the message-info / blue-tick data). Since Nexus runs
 * on the owner's account, it receives those receipts and remembers who read what.
 * Reply to one of your messages with .seen and it tags everyone who's read it.
 *
 * Honest limits: only works for messages YOU sent, and only for readers who have
 * read receipts (blue ticks) ON — WhatsApp simply doesn't report the rest.
 */

interface Seen {
  chat: string;
  readers: Set<string>;
  at: number;
}
const store = new Map<string, Seen>(); // messageId -> who read it
const lastSent = new Map<string, string>(); // chat -> most recent of our tracked messages
const MAX = 800;

/** Long/number timestamp → number (0 if none). */
function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const n = (v as { toNumber?: () => number }).toNumber?.();
  return typeof n === 'number' ? n : Number(v) || 0;
}

/** Register the read-receipt listener. Called from connection once online. */
export function attachSeenTracking(sock: WASocket): void {
  sock.ev.on('message-receipt.update', (updates) => {
    for (const u of updates) {
      const key = u.key;
      const r = u.receipt;
      if (!key?.fromMe || !key.id) continue; // only messages WE sent
      if (!(num(r?.readTimestamp) || num(r?.playedTimestamp))) continue; // only actual reads
      if (!r.userJid) continue;
      const chat = key.remoteJid ?? '';
      let s = store.get(key.id);
      if (!s) {
        s = { chat, readers: new Set(), at: Date.now() };
        store.set(key.id, s);
        if (store.size > MAX) {
          const first = store.keys().next().value;
          if (first) store.delete(first);
        }
      }
      s.readers.add(r.userJid);
      s.at = Date.now();
      if (chat) lastSent.set(chat, key.id);
    }
  });
  logger.debug('seen-tracking attached');
}

command({ pattern: 'seen', desc: 'Who has read your message (reply to it)', category: 'group' }, async (m) => {
  const targetId = m.quotedId || lastSent.get(m.chat);
  if (!targetId) {
    return m.reply('👀 Reply to one of *your own* messages with *.seen* and I\'ll show who has read it.');
  }
  const s = store.get(targetId);
  if (!s || s.readers.size === 0) {
    return m.reply('👀 No read receipts for that message yet.\n_(I can only see this when the reader has read receipts / blue ticks turned ON.)_');
  }
  const resolvedReaders = await Promise.all([...s.readers].map((j) => resolveJid(m.client, j, m.isGroup ? m.chat : undefined)));
  // Only tag readers we can show as a real number — never a raw @lid.
  const jids = resolvedReaders.filter((j) => j.endsWith('@s.whatsapp.net'));
  if (!jids.length) {
    return m.reply('👀 Some people read it, but I couldn\'t resolve their real numbers to tag them cleanly right now.');
  }
  const headers = [
    `👀 *Busted! ${jids.length} of you saw this:*`,
    `🕵️ *These ${jids.length} read it and stayed quiet:*`,
    `📖 *Seen by ${jids.length} — I have receipts:*`,
    `👁️ *${jids.length} caught reading:*`,
  ];
  const header = headers[Math.floor(Math.random() * headers.length)];
  const tags = jids.map((j) => `@${j.split('@')[0].split(':')[0]}`).join(' ');
  await m.client.sendMessage(m.chat, { text: `${header}\n${tags}`, mentions: jids });
});

logger.debug('seen plugin loaded');
