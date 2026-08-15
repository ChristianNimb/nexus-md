import type { WASocket } from 'baileys';
import { command } from '../core/registry.js';
import { getSetting, setSetting } from '../db/index.js';
import { logger } from '../logger.js';
import type { Message } from '../core/message.js';

/**
 * Member tools:
 *   • .joined  (reply/tag someone) → tag them + the date they joined
 *   • join-request flow → when someone asks to join, Nexus announces it and the
 *     admins reply .accept / .reject
 *
 * Honest note on join dates: WhatsApp doesn't hand over historical join dates, so
 * Nexus records them from the moment it's in the group. Anyone already present is
 * marked "before I started keeping track".
 */

/* ----------------------------- join-date store ---------------------------- */

const joinsKey = (group: string) => `joins:${group}`;
function loadJoins(group: string): Record<string, number> {
  try {
    const v = JSON.parse(getSetting(joinsKey(group)) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function saveJoins(group: string, data: Record<string, number>): void {
  setSetting(joinsKey(group), JSON.stringify(data));
}

/* --------------------------- pending-request store ------------------------ */

const reqKey = (group: string) => `joinreq:${group}`;
function loadPending(group: string): string[] {
  try {
    const v = JSON.parse(getSetting(reqKey(group)) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function savePending(group: string, jids: string[]): void {
  setSetting(reqKey(group), JSON.stringify([...new Set(jids)]));
}

const REQ_LINES = [
  '🚪 *Knock knock!* Someone new wants into our little corner',
  '👀 We\'ve got a hopeful at the door',
  '✨ Fresh face incoming — someone\'s asking to join the fam',
  '🔔 Psst… somebody wants a seat at our table',
];

/** Wire up join tracking + join-request announcements. Called from connection. */
export function attachMemberTools(sock: WASocket): void {
  // Record when people join (going forward).
  sock.ev.on('group-participants.update', (u) => {
    if (u.action !== 'add') return;
    const data = loadJoins(u.id);
    let changed = false;
    for (const jid of u.participants) {
      if (!data[jid]) {
        data[jid] = Date.now();
        changed = true;
      }
    }
    if (changed) saveJoins(u.id, data);
  });

  // Announce join requests and remember them for .accept / .reject.
  sock.ev.on('group.join-request', async (req) => {
    try {
      if (req.action !== 'created') return; // only brand-new requests
      const group = req.id;
      const requester = req.participant;
      savePending(group, [...loadPending(group), requester]);
      const num = requester.split('@')[0];
      const line = REQ_LINES[Math.floor(Math.random() * REQ_LINES.length)];
      await sock.sendMessage(group, {
        text: `${line} — *+${num}*.\nShould I let them in? Admins, reply *.accept* or *.reject* 🙂`,
        mentions: [requester],
      });
    } catch (err) {
      logger.warn({ err }, 'join-request handler failed');
    }
  });

  logger.debug('member-tools attached');
}

/* -------------------------------- commands -------------------------------- */

/** Resolve who the user means: replied sender, a mention, or a number arg. */
function target(m: Message, arg: string): string | undefined {
  if (m.quoted?.sender) return m.quoted.sender;
  if (m.mentioned[0]) return m.mentioned[0];
  const digits = arg.replace(/[^0-9]/g, '');
  return digits.length >= 7 ? `${digits}@s.whatsapp.net` : undefined;
}

command({ pattern: 'joined ?(.*)', desc: 'When a member joined (reply or tag them)', category: 'group', groupOnly: true }, async (m, match) => {
  const jid = target(m, match?.[1] ?? '');
  if (!jid) return m.reply('👤 Reply to a member (or tag them) with *.joined* and I\'ll tell you when they joined.');
  const num = jid.split('@')[0];
  const when = loadJoins(m.chat)[jid];
  if (!when) {
    return m.client.sendMessage(m.chat, { text: `@${num} was already here before I started keeping track 🕰️`, mentions: [jid] });
  }
  const date = new Date(when).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  await m.client.sendMessage(m.chat, { text: `@${num} joined on *${date}* 🎉`, mentions: [jid] });
});

command({ pattern: 'accept ?(.*)', desc: 'Approve pending join request(s)', category: 'group', groupOnly: true, adminOnly: true }, async (m) => {
  const pending = loadPending(m.chat);
  if (!pending.length) return m.reply('🤔 No pending join requests right now.');
  try {
    await m.client.groupRequestParticipantsUpdate(m.chat, pending, 'approve');
    savePending(m.chat, []);
    await m.client.sendMessage(m.chat, { text: `✅ Welcome in! ${pending.length} new member${pending.length === 1 ? '' : 's'} — glad to have you 🎉`, mentions: pending });
  } catch (err) {
    logger.warn({ err }, 'accept failed');
    await m.reply('😕 Couldn\'t approve — make sure I\'m an admin here.');
  }
});

command({ pattern: 'reject ?(.*)', desc: 'Reject pending join request(s)', category: 'group', groupOnly: true, adminOnly: true }, async (m) => {
  const pending = loadPending(m.chat);
  if (!pending.length) return m.reply('🤔 No pending join requests right now.');
  try {
    await m.client.groupRequestParticipantsUpdate(m.chat, pending, 'reject');
    savePending(m.chat, []);
    await m.reply(`🚫 Turned away ${pending.length} request${pending.length === 1 ? '' : 's'}.`);
  } catch (err) {
    logger.warn({ err }, 'reject failed');
    await m.reply('😕 Couldn\'t reject — make sure I\'m an admin here.');
  }
});

logger.debug('member-tools plugin loaded');
