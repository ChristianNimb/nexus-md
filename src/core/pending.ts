/**
 * Tiny shared registry of messages that an INTERACTIVE FLOW has already handled
 * (e.g. answering a "which quality?" prompt with "1"). Other passive handlers —
 * notably DM auto-chat — check this so they don't ALSO reply to that message.
 *
 * This is the backbone for turning single commands into guided flows: a flow
 * marks the user's reply as consumed, and everything else leaves it alone.
 */
const consumed = new Map<string, number>();
const TTL = 20_000;

export function markConsumed(id?: string | null): void {
  if (!id) return;
  consumed.set(id, Date.now());
  if (consumed.size > 300) prune();
}

export function isConsumed(id?: string | null): boolean {
  if (!id) return false;
  const t = consumed.get(id);
  return t !== undefined && Date.now() - t < TTL;
}

function prune(): void {
  const now = Date.now();
  for (const [k, t] of consumed) if (now - t > TTL) consumed.delete(k);
}
