import { command } from '../core/registry.js';
import { quickGen } from './chatbot.js';
import { resolveJid } from '../core/lid.js';
import { listContacts } from '../db/index.js';
import type { Message } from '../core/message.js';

/** Best-effort saved/display name for a jid (falls back to the number). */
function nameFor(jid: string): string {
  const num = jid.split('@')[0].split(':')[0];
  const c = listContacts().find((x) => x.jid.split('@')[0].split(':')[0] === num);
  return c?.name || c?.notify || num;
}

/**
 * Fun that actually lands — AI-generated and about the real people / moment, not
 * canned one-liners. Group gold.
 *
 *   .roast [name/@user]   playful roast (light, never cruel)
 *   .ship A and B         compatibility % + a witty verdict
 *   .decide a, b, c       Nexus picks one, confidently and wittily
 */

command({ pattern: 'roast ?(.*)', desc: 'A playful AI roast', usage: '[name] (or reply)', category: 'fun' }, async (m, match) => {
  const target = (match?.[1] ?? '').trim() || (m.quoted?.text ? 'that message' : 'the person who asked (me)');
  await m.react('🔥');
  const out = await quickGen(
    `Write a SHORT, playful, funny roast of "${target}". Rules: clever and teasing with a bit of attitude, 1-2 punchy lines, ` +
      `light-hearted banter only — never cruel, no insults about appearance/race/religion/gender or anything sensitive. Make people laugh WITH them, not at them.`,
  );
  await m.reply(out ? `🔥 ${out}` : '😅 my roast circuits are cold right now, try again.');
});

// deterministic score so the same pair always gets the same number (funnier)
function shipScore(a: string, b: string): number {
  const s = (a + b).toLowerCase().replace(/\s+/g, '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 101;
  return h; // 0..100
}
function bar(pct: number): string {
  const f = Math.round(pct / 10);
  return '█'.repeat(f) + '░'.repeat(10 - f);
}

command({ pattern: 'ship(?: (.+))?', desc: 'Ship two people — compatibility % + verdict', usage: '<A> and <B>, or reply to someone', category: 'fun' }, async (m, match) => {
  const raw = (match?.[1] ?? '').trim();

  // Labels shown in the message, names used for the AI verdict, and any jids to
  // @mention (so the ship actually pings the people).
  let aLabel: string, bLabel: string, aName: string, bName: string;
  const mentions: string[] = [];

  if (m.quoted?.sender) {
    // Reply mode: ship YOU with the person you replied to.
    const other = await resolveJid(m.client, m.quoted.sender, m.isGroup ? m.chat : undefined);
    const otherNum = other.split('@')[0].split(':')[0];
    aName = m.pushName || 'You';
    bName = nameFor(other);
    aLabel = aName;
    bLabel = `@${otherNum}`; // WhatsApp renders this as their name
    mentions.push(other);
  } else {
    const pair = raw.split(/\s+(?:and|&|\+|x|,)\s+|\s{2,}/i).map((s) => s.trim()).filter(Boolean);
    if (pair.length < 2) return m.reply('💘 Usage: *.ship Sara and Deng* — or reply to someone with *.ship* to ship them with you.');
    aName = aLabel = pair[0];
    bName = bLabel = pair[1];
  }

  const pct = shipScore(aName, bName);
  await m.react('💘');
  const verdict = await quickGen(
    `${aName} and ${bName} scored ${pct}% compatible. In ONE short, witty, playful line, give the verdict on them as a couple. Fun and light.`,
  );
  const text = `💘 *${aLabel} + ${bLabel}*\n${bar(pct)}  *${pct}%*\n${verdict || (pct > 60 ? 'the stars kinda approve 😌' : 'eh, keep it as friends 😅')}`;
  await m.client.sendMessage(m.chat, mentions.length ? { text, mentions } : { text }, { quoted: m.raw });
});

command({ pattern: 'decide (.+)', desc: 'Can\'t decide? Let Nexus pick', usage: '<a> or <b> [or c]', category: 'fun' }, async (m, match) => {
  const raw = (match?.[1] ?? '').trim();
  const opts = raw.split(/\s+or\s+|,\s*|\s+vs\.?\s+/i).map((s) => s.trim()).filter(Boolean);
  if (opts.length < 2) return m.reply('🤔 Give me options: *.decide pizza or burger or sushi*.');
  await m.react('🎲');
  const out = await quickGen(
    `The user can't decide between: ${opts.join(', ')}. Pick exactly ONE for them and give a short, confident, witty reason (1-2 lines). Be playful and decisive.`,
  );
  const fallback = opts[Math.floor(Math.random() * opts.length)];
  await m.reply(out ? `🎲 ${out}` : `🎲 Go with *${fallback}* — trust me on this one 😌`);
});
