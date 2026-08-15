import { command } from '../core/registry.js';
import { groupMeta, invalidateGroup } from '../core/group.js';
import { jidNormalizedUser } from 'baileys';
import { quickGen } from './chatbot.js';
import { recentMessages } from '../core/chatlog.js';
import { config } from '../config.js';
import type { Message } from '../core/message.js';

/** Resolve target user(s): quoted sender, mentions, or a raw number argument. */
function targets(m: Message, arg?: string): string[] {
  const out = new Set<string>();
  if (m.quoted?.sender) out.add(jidNormalizedUser(m.quoted.sender));
  for (const j of m.mentioned) out.add(jidNormalizedUser(j));
  const digits = arg?.replace(/[^0-9]/g, '');
  if (digits && digits.length >= 6) out.add(`${digits}@s.whatsapp.net`);
  return [...out];
}

async function apply(
  m: Message,
  users: string[],
  action: 'remove' | 'promote' | 'demote',
): Promise<void> {
  await m.client.groupParticipantsUpdate(m.chat, users, action);
  invalidateGroup(m.chat);
  const verb = { remove: 'Removed', promote: 'Promoted', demote: 'Demoted' }[action];
  await m.reply(`${verb}: ${users.map((u) => u.split('@')[0]).join(', ')}`);
}

command(
  { pattern: 'kick ?(.*)', desc: 'Remove a member', usage: '<reply/mention>', category: 'group', groupOnly: true, adminOnly: true, botAdmin: true },
  async (m, match) => {
    const users = targets(m, match?.[1]);
    if (!users.length) return m.reply('Reply to or mention who to remove.');
    await apply(m, users, 'remove');
  },
);

command(
  { pattern: 'promote ?(.*)', desc: 'Make a member admin', category: 'group', groupOnly: true, adminOnly: true, botAdmin: true },
  async (m, match) => {
    const users = targets(m, match?.[1]);
    if (!users.length) return m.reply('Reply to or mention who to promote.');
    await apply(m, users, 'promote');
  },
);

command(
  { pattern: 'demote ?(.*)', desc: 'Remove admin from a member', category: 'group', groupOnly: true, adminOnly: true, botAdmin: true },
  async (m, match) => {
    const users = targets(m, match?.[1]);
    if (!users.length) return m.reply('Reply to or mention who to demote.');
    await apply(m, users, 'demote');
  },
);

const TAGALL_FALLBACK = [
  '📣 Gather round, everyone!',
  '🚨 Attention, squad!',
  '🔔 Ping! All hands on deck:',
  '📢 Yo, listen up, all of you:',
];

/**
 * The line above the tags. If the owner gave their own message, use it. Otherwise
 * let Nexus write a natural, human rally line on the owner's behalf — casual, in
 * its own voice, lightly aware of what the group's been chatting about — instead
 * of a canned header. Falls back to a preset if the AI is unavailable.
 */
async function tagallHeader(m: Message, note: string): Promise<string> {
  if (note) return note;
  const owner = m.pushName || config.ownerName || 'the boss';
  const recent = recentMessages(m.chat, 6)
    .map((r) => `${r.name}: ${r.text}`)
    .join('\n');
  try {
    const gen = await quickGen(
      `You're Nexus, rallying a WhatsApp group on behalf of ${owner}. Write ONE short, casual, human line (max ~18 words) to get everyone's attention — playful and natural, like a friend, in your own voice. ` +
        `Make it sound like ${owner} asked you to grab everyone (e.g. "${owner} told me to get y'all — no idea what he's plotting but let's see 👀", or "guys, quick one from ${owner}, then back to your day"). ` +
        `${recent ? `Here's the recent chat for flavour — only weave it in if it fits naturally:\n${recent}\n` : ''}` +
        `Reply with ONLY the line, no quotes, no name label.`,
    );
    const clean = (gen || '').trim().replace(/^["']|["']$/g, '').split('\n')[0];
    if (clean) return clean;
  } catch {
    /* fall through to preset */
  }
  return TAGALL_FALLBACK[Math.floor(Math.random() * TAGALL_FALLBACK.length)];
}

command(
  { pattern: 'tagall ?(.*)', desc: 'Mention everyone (Nexus writes a fun rally line)', category: 'group', groupOnly: true, adminOnly: true },
  async (m, match) => {
    const meta = await groupMeta(m.client, m.chat);
    const ids = meta.participants.map((p) => p.id);
    const header = await tagallHeader(m, (match?.[1] ?? '').trim());
    const text = `${header}\n\n` + ids.map((id) => `@${id.split('@')[0]}`).join(' ');
    await m.send({ text, mentions: ids });
  },
);
