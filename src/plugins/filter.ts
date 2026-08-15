import { command } from '../core/registry.js';
import { setFilter, removeFilter, listFilters } from '../db/index.js';

/**
 * Keyword auto-responder. Owners set filters; when a message contains a
 * filter's keyword, the bot replies with the stored response. Filters are
 * scoped per-group (or "global" in DMs).
 */

function scopeOf(m: import('../core/message.js').Message): string {
  return m.isGroup ? m.chat : 'global';
}

command(
  { pattern: 'filter (.+?):(.+)', fromMe: true, desc: 'Add an auto-reply', usage: '<keyword>:<response>', category: 'automation' },
  async (m, match) => {
    const keyword = match?.[1]?.trim();
    const response = match?.[2]?.trim();
    if (!keyword || !response) return m.reply('Usage: .filter keyword:response');
    setFilter(scopeOf(m), keyword, response);
    await m.reply(`Filter saved: "${keyword}" → "${response}"`);
  },
);

command(
  { pattern: 'stop (.+)', fromMe: true, desc: 'Remove an auto-reply', usage: '<keyword>', category: 'automation' },
  async (m, match) => {
    const keyword = match?.[1]?.trim();
    if (!keyword) return m.reply('Usage: .stop <keyword>');
    const ok = removeFilter(scopeOf(m), keyword);
    await m.reply(ok ? `Removed filter "${keyword}".` : `No filter named "${keyword}".`);
  },
);

command({ pattern: 'filters', desc: 'List auto-replies here', category: 'automation' }, async (m) => {
  const all = listFilters(scopeOf(m));
  const keys = Object.keys(all);
  if (!keys.length) return m.reply('No filters set here.');
  await m.reply('*Filters:*\n' + keys.map((k) => `• ${k} → ${all[k]}`).join('\n'));
});

// Passive trigger: check every incoming message for a matching keyword.
command({ on: 'message' }, async (m) => {
  if (!m.body || m.fromMe) return;
  const all = listFilters(scopeOf(m));
  const text = m.body.toLowerCase();
  for (const [keyword, response] of Object.entries(all)) {
    // whole-word-ish match to avoid accidental substrings
    const re = new RegExp(`(^|\\W)${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`, 'i');
    if (re.test(text)) {
      await m.reply(response);
      break;
    }
  }
});
