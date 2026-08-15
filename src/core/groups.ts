import type { BotContext } from './types.js';
import { groupMeta } from './group.js';
import { getGroupConfig, setGroupConfig, listGroups } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * A small directory of the GROUPS Nexus is a member of (name → jid) — NOT the
 * members inside them. This lets the owner, from their own DM, say things like
 * "send happy new year to the family group" and have Nexus resolve which group
 * that is. Only each group's own name/subject is stored.
 */

export interface GroupMatch {
  jid: string;
  name: string;
}

// Refresh a group's stored name at most this often (subjects rarely change).
const REFRESH_MS = 6 * 60 * 60_000; // 6 hours

/**
 * Remember (or refresh) the name of a group Nexus just saw a message in.
 * Throttled so we don't fetch metadata on every single message.
 */
export async function rememberGroup(ctx: BotContext, jid: string): Promise<void> {
  if (!jid.endsWith('@g.us')) return;
  const cur = getGroupConfig(jid);
  if (cur.subject && cur.nameAt && Date.now() - cur.nameAt < REFRESH_MS) return; // fresh enough
  try {
    const meta = await groupMeta(ctx.sock, jid);
    const subject = meta.subject?.trim();
    if (subject) setGroupConfig(jid, { subject, nameAt: Date.now() });
  } catch (err) {
    logger.debug({ err, jid }, 'rememberGroup: metadata lookup failed');
  }
}

/** Score how well a group name matches the query (0 = no match). */
function score(label: string, q: string): number {
  const l = label.toLowerCase();
  if (l === q) return 100;
  if (l.startsWith(q)) return 70;
  const words = l.split(/\s+/);
  if (words.some((w) => w === q)) return 65;
  if (words.some((w) => w.startsWith(q))) return 55;
  if (l.includes(q)) return 40;
  return 0;
}

/**
 * Find groups matching a name query, best first. The owner often adds the word
 * "group" ("the family group") — we strip it so it doesn't hurt matching.
 */
export function findGroups(query: string, limit = 5): GroupMatch[] {
  const q = query.trim().toLowerCase().replace(/\bgroup(s)?\b/g, '').replace(/\s+/g, ' ').trim();
  if (!q) return [];

  const scored: { jid: string; name: string; s: number }[] = [];
  for (const g of listGroups()) {
    const s = score(g.subject, q);
    if (s > 0) scored.push({ jid: g.jid, name: g.subject, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((g) => ({ jid: g.jid, name: g.name }));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Safety net: scan the owner's request for the name of a group Nexus is in
 *  (whole-word). Returns the group's subject, or undefined. */
export function mentionedGroupName(text: string): string | undefined {
  if (!text) return undefined;
  let best: string | undefined;
  let bestLen = 0;
  for (const g of listGroups()) {
    const subj = g.subject.trim();
    if (subj.length < 2) continue;
    if (new RegExp(`\\b${escapeRegExp(subj)}\\b`, 'i').test(text) && subj.length > bestLen) {
      best = subj;
      bestLen = subj.length;
    }
  }
  return best;
}

/** Every group Nexus can reach (name → jid), alphabetical — for the "which
 *  group?" picker when a send target is generic or couldn't be matched. */
export function allGroupMatches(): GroupMatch[] {
  return listGroups()
    .filter((g) => g.subject && g.subject.trim().length > 0)
    .sort((a, b) => a.subject.localeCompare(b.subject))
    .map((g) => ({ jid: g.jid, name: g.subject }));
}

/** A readable list of the groups Nexus is in (owner diagnostics / display). */
export function groupListText(): string {
  const all = listGroups().sort((a, b) => a.subject.localeCompare(b.subject));
  if (!all.length) return '';
  const shown = all.slice(0, 60);
  const lines = shown.map((g) => `• *${g.subject}*`);
  const more = all.length > shown.length ? `\n…and ${all.length - shown.length} more` : '';
  return `👥 *Groups I'm in* (${all.length}):\n${lines.join('\n')}${more}`;
}
