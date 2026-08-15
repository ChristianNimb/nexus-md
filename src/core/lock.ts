import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Single-instance lock.
 *
 * Running two bot processes on the same WhatsApp session corrupts the Signal
 * encryption keys — the symptom is "Waiting for this message. This may take a
 * while." appearing on the bot's own messages. This guard writes a PID lockfile
 * and refuses to start if another live process already holds it.
 *
 * The lock lives IN THE SESSION DIRECTORY, not the working directory.
 *
 * What it protects is the session, so that is where it belongs: two processes
 * pointed at different sessions were never in conflict, and two pointed at the
 * same one now contend for the same lock even if they were started from
 * different directories. It also stops the bot needing a writable working
 * directory at all, which is what lets it run under a container with a
 * read-only root filesystem.
 */

const LOCK_FILE = join(config.sessionDir, 'nexus.lock');

/** True if a process with this PID is currently alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually kill
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function release(): void {
  try {
    if (existsSync(LOCK_FILE) && readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    /* best effort */
  }
}

/**
 * Attempt to claim the lock. Returns false if another instance is running
 * (caller should exit). A stale lock (dead PID) is reclaimed automatically.
 */
export function acquireLock(): boolean {
  // The session directory is created by Baileys on first connect, which happens
  // after this runs — so on a first boot it does not exist yet.
  mkdirSync(config.sessionDir, { recursive: true });

  if (existsSync(LOCK_FILE)) {
    const raw = readFileSync(LOCK_FILE, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (pid && pid !== process.pid && isAlive(pid)) {
      logger.error(
        { pid, lock: LOCK_FILE },
        'another Nexus-MD instance is already running — refusing to start to protect the session',
      );
      return false;
    }
    logger.warn({ stalePid: raw }, 'removing stale lock');
  }

  writeFileSync(LOCK_FILE, String(process.pid));
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
  return true;
}
