import type { WASocket } from 'baileys';
import { groupMeta } from './group.js';
import { listGroups } from '../db/index.js';

/**
 * Resolve WhatsApp's hidden @lid ids to the real phone-number jid
 * (@s.whatsapp.net). WhatsApp pairs them in three places we can tap:
 *   • the contacts store (Contact.lid ↔ Contact.jid) — cached here,
 *   • a group's participant list (participant.jid holds the number),
 *   • onWhatsApp(), which returns the pairing.
 *
 * Use for DISPLAYING numbers (sudo list, contact info, etc.). For @mentions,
 * keep the original jid so WhatsApp still links the tag.
 */

const cache = new Map<string, string>(); // lid -> phone-number jid

/** Remember a lid↔number pairing (call from contacts sync / participant lists). */
export function rememberLid(lid?: string | null, pn?: string | null): void {
  if (lid && lid.endsWith('@lid') && pn && pn.endsWith('@s.whatsapp.net')) cache.set(lid, pn);
}

/** Resolve any jid (incl. @lid) to a real phone-number jid. Best-effort. */
export async function resolveJid(sock: WASocket, jid: string, groupJid?: string): Promise<string> {
  if (!jid || jid.endsWith('@s.whatsapp.net')) return jid;
  if (!jid.endsWith('@lid')) return jid;

  const cached = cache.get(jid);
  if (cached) return cached;

  // Look in a participant list for the pairing. The real number can live in
  // EITHER field depending on the group's addressing mode: participant.jid in a
  // lid-addressed group, or participant.id in a pn-addressed one. Check both.
  const fromGroup = async (g: string): Promise<string | undefined> => {
    try {
      const meta = await groupMeta(sock, g);
      const p = meta.participants.find((x) => x.id === jid || (x as { lid?: string }).lid === jid);
      if (!p) return undefined;
      for (const cand of [(p as { jid?: string }).jid, p.id]) {
        if (typeof cand === 'string' && cand.endsWith('@s.whatsapp.net')) return cand;
      }
    } catch {
      /* ignore */
    }
    return undefined;
  };

  // 1) the specific group we're in, if any.
  if (groupJid) {
    const pn = await fromGroup(groupJid);
    if (pn) {
      cache.set(jid, pn);
      return pn;
    }
  }

  // 2) any other group the bot knows — the person is likely in one of them.
  for (const g of listGroups()) {
    if (g.jid === groupJid) continue;
    const pn = await fromGroup(g.jid);
    if (pn) {
      cache.set(jid, pn);
      return pn;
    }
  }

  // 3) ask WhatsApp directly (last resort).
  try {
    const res = await sock.onWhatsApp(jid);
    const pn = res?.[0]?.jid;
    if (typeof pn === 'string' && pn.endsWith('@s.whatsapp.net')) {
      cache.set(jid, pn);
      return pn;
    }
  } catch {
    /* give up */
  }
  return jid;
}

/** Digits to show a user: the real number when resolvable, else the raw id. */
export async function displayNumber(sock: WASocket, jid: string, groupJid?: string): Promise<string> {
  const r = await resolveJid(sock, jid, groupJid);
  return r.split('@')[0].split(':')[0];
}
