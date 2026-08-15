import { command } from '../core/registry.js';
import { getGroupConfig, setGroupConfig } from '../db/index.js';
import { isAdmin, invalidateGroup } from '../core/group.js';
import { logger } from '../logger.js';

/**
 * Anti-bot: remove non-admins whose messages look bot-generated.
 *
 * Heuristic: WhatsApp Web / Baileys clients (which nearly all WhatsApp bots use)
 * generate message IDs prefixed with "3EB0". Real phone-app messages don't.
 *
 * ⚠️ Caveat: people using WhatsApp Web/Desktop *also* produce 3EB0 IDs, so this
 * can catch legitimate linked-device users. It's aimed at bot-deployer groups
 * where that trade-off is acceptable. Admins and the owner are always exempt.
 */

function looksLikeBot(id: string | null | undefined): boolean {
  if (!id) return false;
  return /^3EB0[0-9A-F]{10,}$/i.test(id) || /^[0-9A-F]{32}$/i.test(id);
}

command(
  {
    pattern: 'antibot ?(.*)',
    desc: 'Kick non-admins that look like bots',
    usage: 'on|off',
    category: 'group',
    groupOnly: true,
    adminOnly: true,
  },
  async (m, match) => {
    const v = match?.[1]?.trim().toLowerCase();
    if (v === 'on') {
      setGroupConfig(m.chat, { antibot: true });
      return m.reply('🤖 Anti-bot enabled. Non-admin bot-like accounts will be removed.\n_Note: WhatsApp Web/Desktop users may also be caught._');
    }
    if (v === 'off') {
      setGroupConfig(m.chat, { antibot: false });
      return m.reply('Anti-bot disabled.');
    }
    await m.reply(`Anti-bot is ${getGroupConfig(m.chat).antibot ? 'on' : 'off'}. Use .antibot on|off`);
  },
);

// Passive detector.
command({ on: 'message' }, async (m) => {
  if (!m.isGroup || m.fromMe) return;
  if (!getGroupConfig(m.chat).antibot) return;
  if (!looksLikeBot(m.raw.key.id)) return;
  if (m.isOwner) return;

  // Exempt group admins.
  try {
    if (await isAdmin(m.client, m.chat, m.sender)) return;
  } catch {
    /* proceed */
  }

  // Bot must be admin to remove.
  try {
    if (!(await isAdmin(m.client, m.chat, m.me, m.meLid))) return;
  } catch {
    return;
  }

  try {
    await m.client.sendMessage(m.chat, {
      text: `🤖 ${'@' + m.sender.split('@')[0]} looks like a bot — removing.`,
      mentions: [m.sender],
    });
    await m.client.sendMessage(m.chat, { delete: m.raw.key });
    await m.client.groupParticipantsUpdate(m.chat, [m.sender], 'remove');
    invalidateGroup(m.chat);
  } catch (err) {
    logger.warn({ err }, 'antibot: failed to remove');
  }
});
