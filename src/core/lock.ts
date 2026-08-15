import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, unlinkSync } from 'node:fs';
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

interface LockRecord {
  pid: number;
  /** The PID namespace the pid is meaningful in. */
  ns: string;
}

/**
 * Which PID namespace this process lives in.
 *
 * A bare PID is not an identity. It is an index into a namespace, and the
 * lockfile lives on a volume that outlives the namespace that wrote it. Restart
 * a container and the new one starts counting from 1 again, so the recorded pid
 * is very likely to exist again — belonging to something else entirely.
 *
 * That is not hypothetical: a restarted bot recorded pid 32, the replacement
 * container's own process tree reached pid 32, the liveness check said "still
 * running", and the bot refused to start for good. Recording the namespace makes
 * the pid checkable instead of merely plausible.
 *
 * Non-Linux hosts have no such file; there the empty string is honest and every
 * process agrees on it, which reduces to the old pid-only behaviour.
 */
function pidNamespace(): string {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return '';
  }
}

const NS = pidNamespace();

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

/** Parses a lockfile, tolerating the older plain-PID format. */
function readLock(): LockRecord | null {
  try {
    const raw = readFileSync(LOCK_FILE, 'utf8').trim();
    if (raw.startsWith('{')) return JSON.parse(raw) as LockRecord;
    // Legacy: a bare pid with no namespace, so it cannot be verified. Treat it
    // as ours to reclaim — an unverifiable lock that strands the bot forever is
    // a worse failure than the duplicate start it was meant to prevent, and the
    // format below makes this the last time the question comes up.
    const pid = Number.parseInt(raw, 10);
    return pid ? { pid, ns: NS } : null;
  } catch {
    return null;
  }
}

function release(): void {
  try {
    const held = readLock();
    if (held && held.pid === process.pid && held.ns === NS) unlinkSync(LOCK_FILE);
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
    const held = readLock();
    // A pid from another namespace says nothing about a process in ours, and the
    // holder cannot outlive the namespace that contained it.
    const sameNamespace = held !== null && held.ns === NS;
    if (held && sameNamespace && held.pid !== process.pid && isAlive(held.pid)) {
      logger.error(
        { pid: held.pid, lock: LOCK_FILE },
        'another Nexus-MD instance is already running — refusing to start to protect the session',
      );
      return false;
    }
    logger.warn({ stale: held, reason: sameNamespace ? 'dead pid' : 'lock from a dead container' }, 'removing stale lock');
  }

  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ns: NS } satisfies LockRecord));
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
  return true;
}
