import cron, { type ScheduledTask } from 'node-cron';
import { command } from '../core/registry.js';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/index.js';
import { normalizeZone, isValidZone } from '../core/timezone.js';
import { logger } from '../logger.js';
import type { WASocket } from 'baileys';
import type { Message } from '../core/message.js';

/**
 * Scheduled messages — send a message to anyone (a number, this chat, or you)
 * at a time you set, once or repeating. Friendly time syntax (no cron needed),
 * but raw 5-field cron still works for power users.
 *
 * Jobs are persisted in the JSON store ("cron:jobs") and re-armed on startup.
 * Repeats use node-cron; one-offs are cron jobs that self-destruct after firing.
 */

interface Job {
  id: string;
  chat: string; // target JID
  text: string;
  expr: string; // cron expression
  once: boolean; // one-time (self-destruct after first fire)
  tz?: string;
  human?: string; // human description of the schedule
  targetLabel?: string; // human description of the recipient
  by?: string;
}

const active = new Map<string, ScheduledTask>();
let sock: WASocket | null = null;

/** Called from the connection layer when WhatsApp connects, so scheduled sends
 *  work immediately after a restart (not only after the first command runs). */
export function attachScheduler(s: WASocket): void {
  sock = s;
  // Ensure persisted jobs are armed (safe to call repeatedly).
  for (const job of loadJobs()) {
    if (!active.has(job.id)) register(job);
  }
}

function loadJobs(): Job[] {
  try {
    return JSON.parse(getSetting('cron:jobs') ?? '[]') as Job[];
  } catch {
    return [];
  }
}
function saveJobs(jobs: Job[]): void {
  setSetting('cron:jobs', JSON.stringify(jobs));
}
function removeJob(id: string): void {
  active.get(id)?.stop();
  active.delete(id);
  saveJobs(loadJobs().filter((j) => j.id !== id));
}

function register(job: Job): boolean {
  if (!cron.validate(job.expr)) return false;
  const task = cron.schedule(
    job.expr,
    () => {
      sock?.sendMessage(job.chat, { text: job.text }).catch((err) => logger.error({ err, id: job.id }, 'scheduled send failed'));
      if (job.once) removeJob(job.id);
    },
    job.tz ? { timezone: job.tz } : undefined,
  );
  active.set(job.id, task);
  return true;
}

/* ------------------------------ time parsing ----------------------------- */

const DOW: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

interface Time {
  h: number;
  m: number;
}
/** Parse "18:30", "9", "9:30", "9pm", "9:30am" → {h, m}. */
function parseTime(s: string): Time | undefined {
  const t = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!t) return undefined;
  let h = Number(t[1]);
  const m = t[2] ? Number(t[2]) : 0;
  const ap = t[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || m > 59) return undefined;
  return { h, m };
}
const fmtT = (t: Time): string => `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The bot's configured timezone, validated. If BOT_TZ is missing or invalid
 * (e.g. "China/Asia", which isn't a real IANA name), fall back gracefully to
 * server time instead of crashing. Tries to auto-correct common names too.
 */
let tzChecked = false;
let tzValue: string | undefined;
function safeTz(): string | undefined {
  if (tzChecked) return tzValue;
  tzChecked = true;
  const raw = config.defaultTz;
  if (raw && isValidZone(raw)) tzValue = raw;
  else if (raw) {
    const fixed = normalizeZone(raw);
    if (fixed && isValidZone(fixed)) tzValue = fixed;
    else logger.warn({ BOT_TZ: raw }, 'invalid BOT_TZ — using server time; set an IANA name like Asia/Shanghai');
  }
  return tzValue;
}

/** Current wall-clock parts in the configured timezone (never throws). */
function nowParts(tz?: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const fmt = (zone?: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = fmt(tz || undefined);
  } catch {
    dtf = fmt(undefined); // bad zone → server time
  }
  const p = dtf.formatToParts(new Date());
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour'), mi: g('minute') };
}
/** Calendar arithmetic: add days to a Y/M/D (handles month/year rollover). */
function addDays(y: number, mo: number, d: number, n: number): { mo: number; d: number } {
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return { mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

type Parsed = { expr: string; once: boolean; human: string } | { error: string };

/** Turn friendly text into a cron expression. */
function parseWhen(spec: string): Parsed {
  const s = spec.trim();

  // Raw 5-field cron (advanced).
  if (/^(\S+\s+){4}\S+$/.test(s)) {
    return cron.validate(s) ? { expr: s, once: false, human: `cron \`${s}\`` } : { error: 'That looks like cron but is invalid.' };
  }

  const lower = s.toLowerCase();

  // Specific date: "YYYY-MM-DD HH:MM" or "DD/MM[/YYYY] HH:MM" → one-time.
  let day: number | undefined;
  let mon: number | undefined;
  let timePart: string | undefined;
  const iso = lower.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(.+)$/);
  const dmy = lower.match(/^(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\s+(.+)$/);
  if (iso) {
    mon = Number(iso[2]);
    day = Number(iso[3]);
    timePart = iso[4];
  } else if (dmy) {
    day = Number(dmy[1]);
    mon = Number(dmy[2]);
    timePart = dmy[3];
  }
  if (day && mon) {
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return { error: 'That date looks off.' };
    const t = parseTime(timePart ?? '');
    if (!t) return { error: "I couldn't read the time. Try like 18:30 or 6:30pm." };
    return { expr: `${t.m} ${t.h} ${day} ${mon} *`, once: true, human: `once on ${day}/${mon} at ${fmtT(t)}` };
  }

  // Weekly: a weekday word appears anywhere.
  const dowMatch = lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|weds?|thur?s?|fri|sat)\b/);
  if (dowMatch) {
    const dow = DOW[dowMatch[1]];
    const rest = lower.replace(dowMatch[0], ' ').replace(/\b(every|weekly|on|at)\b/g, ' ').trim();
    const t = parseTime(rest);
    if (!t) return { error: "I couldn't read the time. Try like: monday 09:00." };
    return { expr: `${t.m} ${t.h} * * ${dow}`, once: false, human: `every ${cap(dowMatch[1])} at ${fmtT(t)}` };
  }

  // Daily.
  const daily = lower.match(/\b(daily|everyday|every ?day)\b/);
  if (daily) {
    const rest = lower.replace(daily[0], ' ').replace(/\b(at)\b/g, ' ').trim();
    const t = parseTime(rest);
    if (!t) return { error: "I couldn't read the time. Try like: daily 08:00." };
    return { expr: `${t.m} ${t.h} * * *`, once: false, human: `every day at ${fmtT(t)}` };
  }

  // "tomorrow HH:MM" / "today HH:MM" / bare time → one-time.
  const isTomorrow = /\btomorrow\b/.test(lower);
  const t = parseTime(lower.replace(/\b(at|once|today|tomorrow|next)\b/g, ' ').trim());
  if (t) {
    const tz = safeTz();
    if (isTomorrow) {
      const now = nowParts(tz);
      const tm = addDays(now.y, now.mo, now.d, 1);
      return { expr: `${t.m} ${t.h} ${tm.d} ${tm.mo} *`, once: true, human: `tomorrow (${tm.d}/${tm.mo}) at ${fmtT(t)}` };
    }
    const now = nowParts(tz);
    const ahead = t.h > now.h || (t.h === now.h && t.m > now.mi);
    return { expr: `${t.m} ${t.h} * * *`, once: true, human: `${ahead ? 'today' : 'tomorrow'} at ${fmtT(t)}` };
  }

  return { error: "I couldn't understand the time." };
}

/** Resolve who to send to: here / me / a phone number. */
function resolveTarget(m: Message, who: string): { jid: string; label: string } | undefined {
  const w = who.trim().toLowerCase();
  if (!w || w === 'here' || w === 'this chat' || w === 'this') return { jid: m.chat, label: 'this chat' };
  if (w === 'me') return { jid: m.sender, label: 'you' };
  const digits = who.replace(/[^0-9]/g, '');
  if (digits.length >= 7) return { jid: `${digits}@s.whatsapp.net`, label: `+${digits}` };
  return undefined;
}

function scheduleHelp(): string {
  return (
    '🗓️ *Schedule a message*\n' +
    'Just type: *.schedule <when> <who> <message>*\n' +
    '(*<who>* is optional — leave it out to send in this chat)\n\n' +
    '*Examples:*\n' +
    '• `.schedule today 6:10pm hey there` — once, later today\n' +
    '• `.schedule daily 7am Good morning! ☀️` — every day\n' +
    '• `.schedule monday 09:30 Standup time!` — every Monday\n' +
    '• `.schedule tomorrow 8pm 231888528059 don\'t forget` — to a number\n' +
    '• `.schedule 2026-07-15 14:00 me dentist appt` — once on a date\n\n' +
    '*When:* `today 6pm` · `tomorrow 9am` · `daily 8:00` · `monday 18:30` · `2026-07-15 14:00`\n' +
    '*Who:* `here` · `me` · a number like `231888528059`\n\n' +
    'List: *.schedules* · Cancel: *.unschedule <id>*'
  );
}

type Split = { whenSpec: string; whoSpec: string; text: string } | { error: true };

/** Explicit pipe form: "when | who | message" (who optional). */
function splitByPipe(raw: string): Split {
  const parts = raw.split('|').map((s) => s.trim());
  if (parts.length < 2 || !parts[0]) return { error: true };
  if (parts.length >= 3) return { whenSpec: parts[0], whoSpec: parts[1], text: parts.slice(2).join('|').trim() };
  return { whenSpec: parts[0], whoSpec: 'here', text: parts[1] };
}

/** Friendly space form: grab the longest leading time phrase that parses, then
 *  an optional recipient (number / here / me), then the rest is the message. */
function splitSmart(raw: string): Split {
  const tokens = raw.split(/\s+/).filter(Boolean);
  let best = -1;
  for (let k = Math.min(5, tokens.length); k >= 1; k--) {
    if (!('error' in parseWhen(tokens.slice(0, k).join(' ')))) {
      best = k;
      break;
    }
  }
  if (best < 0) return { error: true };
  let i = best;
  let whoSpec = 'here';
  if (i < tokens.length) {
    const tk = tokens[i];
    const digits = tk.replace(/[^0-9]/g, '');
    if (/^(here|me)$/i.test(tk) || digits.length >= 7) {
      whoSpec = tk;
      i++;
    }
  }
  const text = tokens.slice(i).join(' ').trim();
  if (!text) return { error: true };
  return { whenSpec: tokens.slice(0, best).join(' '), whoSpec, text };
}

/* -------------------------------- commands ------------------------------- */

command(
  { pattern: 'schedules? (.+)', fromMe: true, desc: 'Schedule a message (once or repeating)', usage: '<when> <who> <message>', category: 'automation' },
  async (m, match) => {
    const raw = (match?.[1] ?? '').trim();
    // Accept the explicit pipe form OR plain spaces ("today 6:10pm 234... hey").
    const split = raw.includes('|') ? splitByPipe(raw) : splitSmart(raw);
    if ('error' in split) return m.reply(scheduleHelp());
    const { whenSpec, whoSpec, text } = split;
    if (!whenSpec || !text) return m.reply(scheduleHelp());

    const parsed = parseWhen(whenSpec);
    if ('error' in parsed) return m.reply(`⏰ ${parsed.error}\n\n${scheduleHelp()}`);

    const target = resolveTarget(m, whoSpec);
    if (!target) return m.reply('🤔 Who should I send it to? Use *here*, *me*, or a number with country code like *2348012345678*.');

    sock = m.client;
    const job: Job = {
      id: Date.now().toString(36),
      chat: target.jid,
      text,
      expr: parsed.expr,
      once: parsed.once,
      tz: safeTz(),
      human: parsed.human,
      targetLabel: target.label,
      by: m.sender,
    };
    if (!register(job)) return m.reply('Could not set that schedule.');
    const jobs = loadJobs();
    jobs.push(job);
    saveJobs(jobs);

    await m.reply(
      `✅ *Scheduled* \`${job.id}\`\n` +
        `📨 to: ${target.label}\n` +
        `🕒 ${parsed.human} ${parsed.once ? '(one-time)' : '(repeats)'}\n` +
        `💬 "${text}"` +
        (safeTz() ? `\n🌍 timezone: ${safeTz()}` : '\n🌍 timezone: server time (set BOT_TZ=Asia/Shanghai for China)'),
    );
  },
);

command({ pattern: 'schedules', fromMe: true, desc: 'List scheduled messages', category: 'automation' }, async (m) => {
  const jobs = loadJobs();
  if (!jobs.length) return m.reply('🗓️ No scheduled messages. Set one with *.schedule* (send *.schedule* for help).');
  const lines = jobs.map(
    (j) => `• \`${j.id}\` — ${j.human ?? j.expr} ${j.once ? '(once)' : '(repeats)'}\n   → ${j.targetLabel ?? j.chat}: "${j.text.slice(0, 40)}${j.text.length > 40 ? '…' : ''}"`,
  );
  await m.reply(`🗓️ *Scheduled messages:*\n${lines.join('\n')}`);
});

command(
  { pattern: 'unschedule (.+)', fromMe: true, desc: 'Cancel a scheduled message', usage: '<id>', category: 'automation' },
  async (m, match) => {
    const id = match?.[1]?.trim();
    if (!id) return m.reply('Usage: .unschedule <id> (see *.schedules*)');
    if (!loadJobs().some((j) => j.id === id)) return m.reply(`No scheduled message with id \`${id}\`.`);
    removeJob(id);
    await m.reply(`🗑️ Cancelled \`${id}\`.`);
  },
);

// Re-arm persisted jobs shortly after startup.
setTimeout(() => {
  for (const job of loadJobs()) register(job);
  if (active.size) logger.info({ jobs: active.size }, 're-armed scheduled jobs');
}, 3_000);
