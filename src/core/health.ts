/**
 * Lightweight command-health tracker.
 *
 * Every command dispatch records success or failure here (see core/handler.ts).
 * Nexus reads it — both for the .health command and, when someone asks "which
 * command is down?", from the CONTEXT block — so it can honestly say what's
 * currently broken instead of guessing.
 *
 * In-memory only (resets on restart), which is exactly what we want: it reflects
 * the LIVE state of this run.
 */

interface Health {
  fails: number;
  lastError: string;
  lastAt: number;
  lastOk: number;
}

const table = new Map<string, Health>();

function get(name: string): Health {
  let h = table.get(name);
  if (!h) {
    h = { fails: 0, lastError: '', lastAt: 0, lastOk: 0 };
    table.set(name, h);
  }
  return h;
}

function shortError(err: unknown): string {
  const e = err as { message?: string; response?: { status?: number } } | undefined;
  const status = e?.response?.status ? `${e.response.status} ` : '';
  const msg = e?.message ?? String(err);
  return `${status}${msg}`.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Record that a command ran cleanly — clears any prior failure. */
export function recordOk(name: string): void {
  if (!name) return;
  const h = get(name);
  h.fails = 0;
  h.lastError = '';
  h.lastOk = Date.now();
}

/** Record that a command threw. */
export function recordFail(name: string, err: unknown): void {
  if (!name) return;
  const h = get(name);
  h.fails += 1;
  h.lastError = shortError(err);
  h.lastAt = Date.now();
}

export interface DownCommand {
  name: string;
  fails: number;
  error: string;
  at: number;
}

/** Commands that have failed since their last success, newest first. */
export function downCommands(): DownCommand[] {
  const out: DownCommand[] = [];
  for (const [name, h] of table) {
    if (h.fails > 0) out.push({ name, fails: h.fails, error: h.lastError, at: h.lastAt });
  }
  return out.sort((a, b) => b.at - a.at);
}
