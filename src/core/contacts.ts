import type { WASocket } from 'baileys';
import { jidNormalizedUser } from 'baileys';
import { listContacts, upsertContact, removeContact } from '../db/index.js';

/**
 * Resolve a person by NAME to their WhatsApp JID, using the synced contact list
 * (saved names) plus everyone who has messaged the bot (push names). Powers
 * "send a voice message to Khalil".
 */

export interface ContactMatch {
  jid: string;
  name: string;
}

/** Score how well a saved/known label matches the query (0 = no match). */
function score(label: string, q: string): number {
  const l = label.toLowerCase();
  if (l === q) return 100;
  const words = l.split(/\s+/);
  if (words[0] === q) return 85; // first name exact
  if (words.some((w) => w === q)) return 75; // any word exact
  if (l.startsWith(q)) return 60;
  if (words.some((w) => w.startsWith(q))) return 55;
  if (l.includes(q)) return 40;
  return 0;
}

/** Find contacts matching a name query, best first. */
export function findContacts(query: string, limit = 5): ContactMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: { jid: string; name: string; s: number }[] = [];
  for (const c of listContacts()) {
    // Prefer the saved address-book name; fall back to the push name.
    // ⚠️ The saved-name boost must ONLY apply when the name actually matches —
    // adding +5 to a zero score made EVERY saved contact match EVERY query
    // (that's why "Christian" was also matching "Khalil").
    const nameScore = c.name ? score(c.name, q) : 0;
    const savedScore = nameScore > 0 ? nameScore + 5 : 0;
    const notifyScore = c.notify ? score(c.notify, q) : 0;
    const best = Math.max(savedScore, notifyScore);
    if (best > 0) scored.push({ jid: c.jid, name: c.name || c.notify || c.jid.split('@')[0], s: best });
  }

  scored.sort((a, b) => b.s - a.s);
  const seen = new Set<string>();
  const out: ContactMatch[] = [];
  for (const m of scored) {
    if (seen.has(m.jid)) continue;
    seen.add(m.jid);
    out.push({ jid: m.jid, name: m.name });
    if (out.length >= limit) break;
  }
  return out;
}

/** A readable list of everyone Nexus knows, saved names first, alphabetical. */
export function contactListText(): string {
  const all = listContacts()
    .map((c) => ({
      label: c.name || c.notify || c.jid.split('@')[0],
      num: c.jid.split('@')[0],
      saved: Boolean(c.name),
      // @lid ids are NOT phone numbers — show the name only, no misleading +digits.
      hasNumber: c.jid.endsWith('@s.whatsapp.net') && /^\d+$/.test(c.jid.split('@')[0]),
    }))
    .sort((a, b) => Number(b.saved) - Number(a.saved) || a.label.localeCompare(b.label));

  if (!all.length) return '';
  const savedCount = all.filter((c) => c.saved).length;
  const learnedCount = all.length - savedCount;
  const shown = all.slice(0, 80);
  const lines = shown.map((c) => {
    const numPart = c.hasNumber ? ` — +${c.num}` : '';
    const tag = c.saved ? '' : ' _(from chat)_';
    return `• *${c.label}*${numPart}${tag}`;
  });
  const more = all.length > shown.length ? `\n…and ${all.length - shown.length} more` : '';
  const breakdown = `_${savedCount} known by name · ${learnedCount} number-only_`;
  return `📇 *Contacts I know* (${all.length}):\n${breakdown}\n${lines.join('\n')}${more}`;
}

/**
 * Save a contact by NAME + number. Resolves the number to its real WhatsApp JID
 * first, so if that person is ALREADY known (e.g. only by push name, or from a
 * chat), we attach the name to the SAME entry instead of creating a duplicate.
 */
export async function saveContactByNumber(
  sock: WASocket,
  name: string,
  number: string,
): Promise<{ ok: boolean; jid?: string; existed?: boolean; onWhatsApp?: boolean }> {
  const digits = number.replace(/[^0-9]/g, '');
  if (digits.length < 7) return { ok: false };

  let jid = `${digits}@s.whatsapp.net`;
  let onWhatsApp = true;
  try {
    const res = await sock.onWhatsApp(digits);
    const info = res?.[0];
    if (info?.jid) jid = jidNormalizedUser(info.jid);
    onWhatsApp = Boolean(info?.exists);
  } catch {
    /* best effort — assume the plain format */
  }

  const existed = listContacts().some((c) => c.jid === jid);
  upsertContact(jid, { name: name.trim() }); // merges by jid → no duplicate
  return { ok: true, jid, existed, onWhatsApp };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Safety net for "send to <name>": scan the owner's raw request for a SAVED
 * contact whose name (full or first name) is actually mentioned as a whole word.
 * Returns the matched contact's display name, or undefined. Used to catch the
 * model substituting the wrong recipient (e.g. copying an example name).
 */
export function mentionedContactName(text: string): string | undefined {
  if (!text) return undefined;
  let best: string | undefined;
  let bestLen = 0;
  for (const c of listContacts()) {
    const label = (c.name || c.notify || '').trim();
    if (!label) continue;
    for (const cand of [label, label.split(/\s+/)[0]]) {
      if (cand.length < 2) continue;
      if (new RegExp(`\\b${escapeRegExp(cand)}\\b`, 'i').test(text) && cand.length > bestLen) {
        best = label; // return the full saved label for a clean lookup
        bestLen = cand.length;
      }
    }
  }
  return best;
}

/** Forget a saved contact by name or number. Returns how many were removed. */
export function forgetContact(query: string): number {
  const q = query.trim().toLowerCase();
  const digits = query.replace(/[^0-9]/g, '');
  let n = 0;
  for (const c of listContacts()) {
    const label = (c.name || c.notify || '').toLowerCase();
    const num = c.jid.split('@')[0];
    if ((digits.length >= 7 && num === digits) || (q && label === q)) {
      if (removeContact(c.jid)) n++;
    }
  }
  return n;
}
