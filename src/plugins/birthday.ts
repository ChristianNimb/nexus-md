import type { WASocket } from 'baileys';
import { command } from '../core/registry.js';
import { getSetting, setSetting } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Never forget the people who matter. Save birthdays and Nexus quietly reminds
 * you the morning of (and a day ahead), then offers to send the wish for you.
 *
 *   .bday add Mom 14 Feb        .bday add Khalil 03-25
 *   .bdays                      .bday del Mom
 */

interface Bday { name: string; month: number; day: number }

function load(): Bday[] {
  try {
    const v = JSON.parse(getSetting('birthdays') ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function save(list: Bday[]): void {
  setSetting('birthdays', JSON.stringify(list.slice(0, 500)));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Parse "14 Feb", "Feb 14", "03-25" (MM-DD), "25/03" (DD-MM) → {month, day}. */
function parseDate(s: string): { month: number; day: number } | undefined {
  const t = s.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{1,2})[-/.](\d{1,2})$/))) {
    let a = +m[1];
    let b = +m[2];
    if (a > 12 && b <= 12) [a, b] = [b, a]; // they gave DD/MM
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) return { month: a, day: b };
  }
  if ((m = t.match(/^(\d{1,2})\s+([a-z]{3,})$/))) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3));
    if (mo >= 0) return { month: mo + 1, day: +m[1] };
  }
  if ((m = t.match(/^([a-z]{3,})\s+(\d{1,2})$/))) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3));
    if (mo >= 0) return { month: mo + 1, day: +m[2] };
  }
  return undefined;
}
const fmt = (b: { month: number; day: number }) => `${b.day} ${MONTH_FULL[b.month - 1]}`;

function renderList(list: Bday[]): string {
  if (!list.length) return '🎂 No birthdays saved yet. Add one: *.bday add Mom 14 Feb*.';
  const sorted = [...list].sort((a, b) => a.month - b.month || a.day - b.day);
  return `🎂 *Birthdays* (${list.length}):\n` + sorted.map((b) => `• *${b.name}* — ${fmt(b)}`).join('\n');
}

// pattern uses (?: (.+))? so ".bdays" never matches the ".bday" command.
command({ pattern: 'bday(?: (.+))?', fromMe: true, desc: 'Save & get reminded of birthdays', usage: 'add <name> <date> | del <name>', category: 'tools' }, async (m, match) => {
  if (!m.isRealOwner) return m.reply('🔒 Birthdays are your personal list — owner only.');
  const arg = (match?.[1] ?? '').trim();
  const list = load();
  if (!arg || /^(list|show)$/i.test(arg)) return m.reply(renderList(list));

  const add = arg.match(/^add\s+(.+)/i);
  if (add) {
    const dm = add[1].trim().match(/^(.*?)[\s,]+(\d{1,2}[-/.]\d{1,2}|\d{1,2}\s+[a-z]{3,}|[a-z]{3,}\s+\d{1,2})$/i);
    const date = dm ? parseDate(dm[2]) : undefined;
    const name = dm?.[1]?.trim();
    if (!name || !date) return m.reply('Usage: *.bday add <name> <date>* — e.g. *.bday add Mom 14 Feb* or *.bday add Khalil 03-25*.');
    const existing = list.find((b) => b.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.month = date.month;
      existing.day = date.day;
    } else {
      list.push({ name, ...date });
    }
    save(list);
    return m.reply(`🎂 Saved — *${name}*'s birthday is *${fmt(date)}*. I'll remind you when it's near. 💛`);
  }

  const del = arg.match(/^del(?:ete)?\s+(.+)/i);
  if (del) {
    const name = del[1].trim();
    const kept = list.filter((b) => b.name.toLowerCase() !== name.toLowerCase());
    save(kept);
    return m.reply(kept.length === list.length ? `No birthday saved for *${name}*.` : `🗑️ Removed *${name}*.`);
  }

  return m.reply('Usage: *.bday add <name> <date>*, *.bday del <name>*, or *.bdays* to see them all.');
});

command({ pattern: 'bdays', fromMe: true, desc: 'List saved birthdays', category: 'tools' }, async (m) => {
  if (!m.isRealOwner) return;
  await m.reply(renderList(load()));
});

/* -------------------------- automatic reminder ---------------------------- */

function ownerJid(): string | undefined {
  const n = config.owners[0]?.replace(/\D/g, '');
  return n ? `${n}@s.whatsapp.net` : undefined;
}

/** Arm the daily birthday check (called from connection once online). */
export function attachBirthdayReminders(sock: WASocket): void {
  const check = async () => {
    try {
      const now = new Date();
      const stamp = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
      if (getSetting('bday:last') === stamp) return; // already checked today
      const jid = ownerJid();
      if (!jid) return;
      const list = load();
      const tomorrow = new Date(now.getTime() + 86_400_000);
      const today = list.filter((b) => b.month === now.getMonth() + 1 && b.day === now.getDate());
      const soon = list.filter((b) => b.month === tomorrow.getMonth() + 1 && b.day === tomorrow.getDate());

      if (today.length || soon.length) {
        let msg = '';
        if (today.length) {
          msg += `🎉🎂 *Birthday today!*\n${today.map((b) => `• *${b.name}*`).join('\n')}\n\n` +
            `_Want me to send the wish? Just say: "send ${today[0].name} a voice note wishing happy birthday". 💛_`;
        }
        if (soon.length) msg += `${msg ? '\n\n' : ''}📅 *Tomorrow:* ${soon.map((b) => b.name).join(', ')} — get ready.`;
        await sock.sendMessage(jid, { text: msg });
        logger.info({ today: today.length, soon: soon.length }, 'birthday reminder sent');
      }
      setSetting('bday:last', stamp);
    } catch (err) {
      logger.warn({ err }, 'birthday check failed');
    }
  };
  setTimeout(() => void check(), 20_000); // shortly after startup
  setInterval(() => void check(), 6 * 60 * 60_000); // and every 6h
}

logger.debug('birthday plugin loaded');
