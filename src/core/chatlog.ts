/**
 * Lightweight rolling log of recent messages per chat, in memory only. Powers the
 * "catch me up" summariser. Bounded so it never grows unbounded.
 */

interface LogEntry {
  name: string;
  text: string;
  at: number;
}

const logs = new Map<string, LogEntry[]>();
const MAX_PER_CHAT = 150;
const MAX_CHATS = 400;

export function logMessage(chat: string, name: string, text: string): void {
  const t = text.trim();
  if (!chat || !t) return;
  const arr = logs.get(chat) ?? [];
  arr.push({ name: name || 'someone', text: t.slice(0, 600), at: Date.now() });
  while (arr.length > MAX_PER_CHAT) arr.shift();
  logs.delete(chat);
  logs.set(chat, arr); // re-insert to keep LRU-ish order
  while (logs.size > MAX_CHATS) {
    const oldest = logs.keys().next().value;
    if (oldest === undefined) break;
    logs.delete(oldest);
  }
}

export function recentMessages(chat: string, n: number): LogEntry[] {
  return (logs.get(chat) ?? []).slice(-n);
}
