import type { WAMessage } from 'baileys';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { commands, commandName } from './registry.js';
import { Message } from './message.js';
import { isAdmin } from './group.js';
import { isPrivate } from './mode.js';
import { recordOk, recordFail } from './health.js';
import { learnContact, getSetting } from '../db/index.js';
import { rememberGroup } from './groups.js';
import { logMessage } from './chatlog.js';
import type { BotContext, RegisteredCommand } from './types.js';

/** Commands that Nexus is never allowed to run for the user. */
const AI_BLOCKED = new Set(['nexus', 'ai']);

export type RunResult = 'ran' | 'denied' | 'notfound';

/**
 * Execute a command from plain text (e.g. "play despacito") against a message,
 * enforcing the same guards as normal dispatch. Used by Nexus to act on the
 * user's behalf.
 *
 * If the full text doesn't match (e.g. Nexus appended stray args to a bare
 * command like "setsudo 12345"), it retries with just the command name — many
 * commands take their target from the replied-to message, not from args.
 */
export async function runCommandText(m: Message, commandText: string): Promise<RunResult> {
  // Private mode: only the owner/sudo may run commands (even via Nexus).
  if (isPrivate() && !m.isOwner) {
    await m.reply("🔒 I'm in private mode right now — only my owner can run commands. Ask them to switch me to public!");
    return 'denied';
  }
  const prefix = config.prefixes[0] ?? '.';
  const trimmed = commandText.trim();
  const nameOnly = trimmed.split(/\s+/)[0] ?? '';
  const attempts = nameOnly && nameOnly !== trimmed ? [trimmed, nameOnly] : [trimmed];

  for (const attempt of attempts) {
    const full = `${prefix}${attempt}`;
    for (const cmd of commands) {
      if (!cmd.regex) continue;
      if (AI_BLOCKED.has(commandName(cmd.pattern))) continue;
      const match = full.match(cmd.regex);
      if (!match) continue;

      if (cmd.fromMe && !m.isOwner) {
        await m.reply("😏 Nice try — that one's owner-only, you don't have the keys for it.");
        return 'denied';
      }
      if (cmd.groupOnly && !m.isGroup) {
        await m.reply('That one only works inside a group 🙂');
        return 'denied';
      }
      if (cmd.adminOnly && m.isGroup && !m.isOwner && !(await isAdmin(m.client, m.chat, m.sender))) {
        await m.reply("You'd need to be a group admin for that one 😅");
        return 'denied';
      }
      if (cmd.botAdmin && m.isGroup && !(await isAdmin(m.client, m.chat, m.me, m.meLid))) {
        await m.reply('I need to be a group admin to pull that off 🙏');
        return 'denied';
      }

      try {
        await cmd.handler(m, match);
        recordOk(commandName(cmd.pattern));
      } catch (err) {
        recordFail(commandName(cmd.pattern), err);
        logger.error({ err, cmd: cmd.pattern }, 'AI-run command threw');
        await m.reply('That command hit an error.');
      }
      return 'ran';
    }
  }
  return 'notfound';
}

/** Map a Baileys content type to our simplified EventType set. */
function eventTypeOf(m: Message): string {
  switch (m.type) {
    case 'imageMessage':
      return 'image';
    case 'videoMessage':
      return 'video';
    case 'stickerMessage':
      return 'sticker';
    case 'conversation':
    case 'extendedTextMessage':
      return 'text';
    default:
      return 'other';
  }
}

/** Run one command against one message, enforcing all the guard rails. */
async function runCommand(cmd: RegisteredCommand, msg: Message, match: RegExpMatchArray | null, ctx: BotContext) {
  // Private mode: block non-owners from invoking commands. Passive event
  // handlers (on: 'message', ...) still run so antilink/filters/stats keep working.
  if (!cmd.on && isPrivate() && !msg.isOwner) return;

  // owner gate (explicitly owner-only commands, in any mode)
  if (cmd.fromMe && !msg.isOwner) return;

  // group gates
  if (cmd.groupOnly && !msg.isGroup) {
    await msg.reply('This command only works in groups.');
    return;
  }
  if (cmd.adminOnly && msg.isGroup && !msg.isOwner && !(await isAdmin(ctx.sock, msg.chat, msg.sender))) {
    await msg.reply('You need to be a group admin to use this.');
    return;
  }
  if (cmd.botAdmin && msg.isGroup && !(await isAdmin(ctx.sock, msg.chat, ctx.selfJid, ctx.selfLid))) {
    await msg.reply('I need to be a group admin to do that.');
    return;
  }

  // Track health for named commands only (not passive on:'message' subscribers).
  const cname = cmd.pattern ? commandName(cmd.pattern) : '';
  try {
    await cmd.handler(msg, match);
    if (cname) recordOk(cname);
  } catch (err) {
    if (cname) recordFail(cname, err);
    logger.error({ err, cmd: cmd.pattern ?? cmd.on }, 'command handler threw');
    try {
      await msg.reply('An error occurred while running that command.');
    } catch {
      /* ignore secondary failure */
    }
  }
}

// When this process started. Messages older than this (minus a grace) are
// backlog re-delivered on restart and must NOT be re-executed.
const BOOT_TIME = Date.now();
const STALE_GRACE_MS = 15_000;

// Message IDs we've already dispatched — WhatsApp/Baileys can re-deliver the
// same message (especially while a slow reply is in flight), which would make
// Nexus answer twice. Dedupe so each message is handled exactly once.
const handledIds = new Set<string>();
function alreadyHandled(id: string | null | undefined): boolean {
  if (!id) return false;
  if (handledIds.has(id)) return true;
  handledIds.add(id);
  if (handledIds.size > 1000) handledIds.delete(handledIds.values().next().value as string);
  return false;
}

/**
 * Entry point for every inbound message. Wraps the raw message, then dispatches
 * to pattern-matched commands and event subscribers.
 */
export async function handleMessage(ctx: BotContext, raw: WAMessage): Promise<void> {
  if (!raw.message) return;
  if (alreadyHandled(raw.key?.id)) return; // never process the same message twice

  // Ignore messages sent BEFORE this process started. On a restart / rebuild,
  // WhatsApp re-delivers your recent backlog (history sync), and without this
  // the bot would re-run every command you'd already sent. A small grace covers
  // the boot→connect gap and clock skew.
  const ts = Number(raw.messageTimestamp ?? 0) * 1000;
  if (ts && ts < BOOT_TIME - STALE_GRACE_MS) return;

  const msg = new Message(ctx, raw);
  if (!msg.chat) return;

  // Auto-SAVE people who DM Nexus, using their WhatsApp name — so the owner never
  // has to hard-add them. ONLY from private DMs; group members are never harvested.
  // ...but never auto-save SUDO users — they're helpers, not the owner's contacts.
  if (msg.pushName && !msg.fromMe && !msg.isGroup && !msg.isSudo) learnContact(msg.sender, msg.pushName);

  // Learn the GROUPS Nexus is IN (name → jid) — NOT the members. This lets the
  // owner, from their own DM, say "send X to the family group" and have Nexus
  // resolve which group that is. Only the group's own name is stored.
  if (msg.isGroup) void rememberGroup(ctx, msg.chat);

  // 👤 Human presence: glance "online", then mark their message read after a
  // short, natural delay — like a real person picking up their phone, not a bot
  // that reads instantly. Best-effort; turn off with: .setvar presence off
  if (!msg.fromMe && getSetting('presence') !== 'off') {
    void (async () => {
      try {
        await ctx.sock.sendPresenceUpdate('available', msg.chat);
        await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2200));
        if (raw.key) await ctx.sock.readMessages([raw.key]);
      } catch {
        /* best effort */
      }
    })();
  }

  // Roll a recent-message log (for the "catch me up" summariser). Skip our own
  // messages and command inputs.
  if (msg.body && !msg.fromMe && !config.prefixes.some((p) => p && msg.body.startsWith(p))) {
    logMessage(msg.chat, msg.pushName || msg.senderNumber, msg.body);
  }

  const evt = eventTypeOf(msg);
  let matchedCommand = false;

  for (const cmd of commands) {
    // event subscribers (on: 'message' | 'text' | 'image' | ...)
    if (cmd.on) {
      if (cmd.on === 'message' || cmd.on === evt) {
        await runCommand(cmd, msg, null, ctx);
      }
      continue;
    }

    // pattern commands
    if (cmd.regex) {
      const match = msg.body.match(cmd.regex);
      if (match) {
        matchedCommand = true;
        await runCommand(cmd, msg, match, ctx);
      }
    }
  }

  // A prefixed, command-looking message that matched NOTHING used to vanish in
  // silence — impossible to tell a broken command from an unregistered one.
  // Reply with a hint instead (owner/sudo always; others only in DM, to avoid
  // group spam from stray ".word" messages).
  if (!matchedCommand) await hintUnknownCommand(msg);
}

/** Cheap edit distance for "did you mean?" suggestions. */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

async function hintUnknownCommand(msg: Message): Promise<void> {
  if (!msg.isOwner && msg.isGroup) return; // don't nag groups over random ".x"
  const body = msg.body.trim();
  const active = config.prefixes.filter(Boolean); // non-empty active prefixes
  const activePrefix = active.find((p) => body.startsWith(p));
  const names = [...new Set(commands.filter((c) => c.pattern).map((c) => commandName(c.pattern).toLowerCase()))];

  // A command typed with the WRONG prefix → stay completely silent. We never
  // announce what the prefix is (that's private to the owner, who set it).
  const prefix = activePrefix;
  if (!prefix) return; // not the active prefix → not our business, say nothing
  const name = body.slice(prefix.length).match(/^([a-zA-Z][a-zA-Z0-9]*)/)?.[1]?.toLowerCase();
  if (!name) return;
  if (names.includes(name)) return; // a real command that was blocked by a guard — stay quiet

  // Closest known command, if it's a plausible typo.
  let best = '';
  let bestD = 99;
  for (const n of names) {
    const d = editDistance(name, n);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  const suggest = bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : '';
  await msg.reply(
    `❓ I don't have a *${prefix}${name}* command.` +
      (suggest ? ` Did you mean *${prefix}${suggest}*?` : ` Send *${prefix}menu* to see everything I can do.`),
  );
}
