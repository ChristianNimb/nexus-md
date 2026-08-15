import { jidNormalizedUser, type WASocket, type GroupMetadata } from 'baileys';

/**
 * Small cache so we don't re-fetch group metadata on every message.
 * Invalidated automatically after `TTL` ms.
 */
const TTL = 60_000;
const cache = new Map<string, { at: number; data: GroupMetadata }>();

export async function groupMeta(sock: WASocket, jid: string): Promise<GroupMetadata> {
  const hit = cache.get(jid);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await sock.groupMetadata(jid);
  cache.set(jid, { at: Date.now(), data });
  return data;
}

/** Drop a cached entry (call after promote/demote/participant changes). */
export function invalidateGroup(jid: string): void {
  cache.delete(jid);
}

function norm(jid?: string | null): string {
  return jid ? jidNormalizedUser(jid) : '';
}

/**
 * Is any of the given identities an admin of the group?
 *
 * Accepts several JIDs for the same user because WhatsApp may list a member by
 * their LID (`@lid`) in the participant list while we hold their phone JID
 * (`@s.whatsapp.net`) — or vice versa. Passing both avoids false negatives.
 */
export async function isAdmin(
  sock: WASocket,
  groupJid: string,
  ...userJids: (string | undefined)[]
): Promise<boolean> {
  const meta = await groupMeta(sock, groupJid);
  const targets = new Set(userJids.map(norm).filter(Boolean));
  if (targets.size === 0) return false;

  return meta.participants.some((p) => {
    if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
    const pid = norm(p.id);
    // Some Baileys versions also expose a phone JID on `.jid` alongside the LID `.id`.
    const pjid = norm((p as { jid?: string | null }).jid);
    return targets.has(pid) || (pjid !== '' && targets.has(pjid));
  });
}
