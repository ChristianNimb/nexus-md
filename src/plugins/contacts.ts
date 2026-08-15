import { command } from '../core/registry.js';
import { contactListText, saveContactByNumber, forgetContact, findContacts } from '../core/contacts.js';
import { groupListText } from '../core/groups.js';
import { clearContacts } from '../db/index.js';
import type { Message } from '../core/message.js';

/**
 * Contact commands — the saved name→number directory Nexus uses for
 * "send a voice message to Khalil".
 *
 * PRIVACY: this is sensitive personal data. It is gated on the ACTUAL owner only
 * (NOT sudo users), and the list is only ever shown in the owner's private DM —
 * never in a group.
 */

/** Guard: only the real owner (not sudo) may touch contacts. */
function denyIfNotOwner(m: Message): boolean {
  if (m.isRealOwner) return false;
  void m.reply('🔒 Contacts are private — only my owner can access them.');
  return true;
}

command({ pattern: 'contacts ?(.*)', fromMe: true, desc: 'Show the contacts Nexus knows (owner DM only)', category: 'tools' }, async (m, match) => {
  if (denyIfNotOwner(m)) return;

  // .contacts reset — wipe the whole learned directory (address book re-syncs).
  if (/^(reset|clear|wipe)$/i.test((match?.[1] ?? '').trim())) {
    const n = clearContacts();
    return m.reply(`🧹 Cleared *${n}* contact(s). Your address-book contacts will re-sync automatically; DM contacts are learned again as people message.`);
  }

  const text = contactListText();
  if (!text) {
    return m.reply('📇 I don\'t know any contacts yet. Add one with *.addcontact <name> <number>*.');
  }
  // Never reveal contacts in a group — send them to the owner's private DM.
  if (m.isGroup) {
    await m.client.sendMessage(m.sender, { text });
    return m.reply('📇🔒 For privacy, I\'ve sent your contact list to our private DM.');
  }
  await m.reply(text);
});

command({ pattern: 'groups', fromMe: true, desc: 'Show the groups Nexus is in (owner DM only)', category: 'tools' }, async (m) => {
  if (denyIfNotOwner(m)) return;
  const text = groupListText();
  if (!text) {
    return m.reply("👥 I don't know any groups yet. I learn a group's name the first time I see a message in it — so once I've been active in your groups, they'll show up here.");
  }
  if (m.isGroup) {
    await m.client.sendMessage(m.sender, { text });
    return m.reply('👥🔒 Sent the list to our private DM.');
  }
  await m.reply(text);
});

command(
  { pattern: 'addcontact (.+)', fromMe: true, desc: 'Save a contact by name + number', usage: '<name> <number>', category: 'tools' },
  async (m, match) => {
    if (denyIfNotOwner(m)) return;
    const raw = (match?.[1] ?? '').trim();
    const numMatch = raw.match(/\+?\d[\d\s-]{6,}\d/);
    if (!numMatch) return m.reply('Usage: *.addcontact <name> <number>* — e.g. .addcontact Khalil 8613800138000');
    const number = numMatch[0];
    const name = raw.replace(number, '').replace(/\|/g, '').trim();
    if (!name) return m.reply('Give a name too: *.addcontact Khalil 8613800138000*');

    const res = await saveContactByNumber(m.client, name, number);
    if (!res.ok) return m.reply('That number looks too short. Include the country code, e.g. 8613800138000.');
    const warn = res.onWhatsApp ? '' : "\n⚠️ heads up: that number doesn't seem to be on WhatsApp.";
    await m.reply(`✅ ${res.existed ? 'Updated' : 'Saved'} *${name}* (+${res.jid?.split('@')[0]}) in my contacts.${warn}`);
  },
);

command(
  { pattern: 'delcontact (.+)', fromMe: true, desc: 'Remove a saved contact', usage: '<name | number>', category: 'tools' },
  async (m, match) => {
    if (denyIfNotOwner(m)) return;
    const q = (match?.[1] ?? '').trim();
    if (!q) return m.reply('Usage: .delcontact <name | number>');
    const n = forgetContact(q);
    await m.reply(n ? `🗑️ Removed ${n} contact(s) matching *${q}*.` : `No saved contact matched *${q}*.`);
  },
);

command(
  { pattern: 'whois (.+)', fromMe: true, desc: 'Look up a contact by name', usage: '<name>', category: 'tools', hidden: true },
  async (m, match) => {
    if (denyIfNotOwner(m)) return;
    const matches = findContacts((match?.[1] ?? '').trim());
    if (!matches.length) return m.reply('No match.');
    // Also DM-only, to avoid leaking a number into a group.
    const text = matches.map((c) => `• *${c.name}* — +${c.jid.split('@')[0]}`).join('\n');
    if (m.isGroup) {
      await m.client.sendMessage(m.sender, { text });
      return m.reply('🔒 Sent to your DM.');
    }
    await m.reply(text);
  },
);
