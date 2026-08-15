import { command } from '../core/registry.js';
import { addWarn, getWarns, resetWarns } from '../db/index.js';
import { invalidateGroup } from '../core/group.js';
import { jidNormalizedUser } from 'baileys';
import type { Message } from '../core/message.js';

/** Number of warnings before an automatic removal. */
const WARN_LIMIT = 3;

function target(m: Message, arg?: string): string | undefined {
  if (m.quoted?.sender) return jidNormalizedUser(m.quoted.sender);
  if (m.mentioned.length) return jidNormalizedUser(m.mentioned[0]);
  const digits = arg?.replace(/[^0-9]/g, '');
  return digits && digits.length >= 6 ? `${digits}@s.whatsapp.net` : undefined;
}

command(
  { pattern: 'warn(?: (.+))?', desc: 'Warn a member (auto-kick at limit)', category: 'group', groupOnly: true, adminOnly: true },
  async (m, match) => {
    const jid = target(m, match?.[1]);
    if (!jid) return m.reply('Reply to or mention who to warn.');
    const count = addWarn(m.chat, jid);
    if (count >= WARN_LIMIT) {
      await m.send({ text: `@${jid.split('@')[0]} reached ${WARN_LIMIT} warnings — removing.`, mentions: [jid] });
      try {
        await m.client.groupParticipantsUpdate(m.chat, [jid], 'remove');
        invalidateGroup(m.chat);
      } catch {
        await m.reply('Could not remove — am I an admin?');
      }
      resetWarns(m.chat, jid);
    } else {
      await m.send({ text: `⚠️ @${jid.split('@')[0]} warned (${count}/${WARN_LIMIT}).`, mentions: [jid] });
    }
  },
);

command(
  { pattern: 'warns ?(.*)', desc: 'Check a member’s warnings', category: 'group', groupOnly: true },
  async (m, match) => {
    const jid = target(m, match?.[1]) ?? m.sender;
    await m.send({ text: `@${jid.split('@')[0]}: ${getWarns(m.chat, jid)}/${WARN_LIMIT} warnings.`, mentions: [jid] });
  },
);

command(
  { pattern: 'unwarn ?(.*)', desc: 'Clear a member’s warnings', category: 'group', groupOnly: true, adminOnly: true },
  async (m, match) => {
    const jid = target(m, match?.[1]);
    if (!jid) return m.reply('Reply to or mention who to clear.');
    resetWarns(m.chat, jid);
    await m.send({ text: `Cleared warnings for @${jid.split('@')[0]}.`, mentions: [jid] });
  },
);
