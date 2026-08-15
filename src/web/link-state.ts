/**
 * The single source of truth about "is the bot linked to WhatsApp, and if not,
 * what does the user need to do about it?"
 *
 * The WhatsApp client (client/connection.ts) PUBLISHES into here; the web server
 * (web/server.ts) SUBSCRIBES. Neither imports the other, so the bot still runs
 * perfectly with the web UI switched off, and the web UI can be developed
 * without touching the connection logic.
 */
import { EventEmitter } from 'node:events';

export type LinkStatus =
  | 'starting' // process is up, socket not yet talking to WhatsApp
  | 'waiting' // socket is up and unregistered — a QR / pairing code is available
  | 'connected' // linked and online
  | 'closed' // dropped; reconnecting
  | 'logged-out'; // WhatsApp revoked the session — needs a fresh link

export interface LinkSnapshot {
  status: LinkStatus;
  /** Raw QR payload straight from Baileys. Rendered to SVG on request. */
  qr?: string;
  /** When the current QR stops being valid (ms epoch). WhatsApp rotates it ~every 20s. */
  qrExpiresAt?: number;
  /** 8-character pairing code, presented as XXXX-XXXX. */
  pairingCode?: string;
  /** The number the pairing code was issued for (digits only). */
  pairingNumber?: string;
  /** The linked account, once connected. */
  user?: { name?: string; number?: string };
  /** Human-readable note for the UI (errors, hints). */
  message?: string;
  updatedAt: number;
}

/** WhatsApp rotates the QR roughly every 20 seconds. */
const QR_TTL_MS = 20_000;

const emitter = new EventEmitter();
// A browser tab per device is plenty, but SSE clients also subscribe here.
emitter.setMaxListeners(50);

let snapshot: LinkSnapshot = { status: 'starting', updatedAt: Date.now() };

/** Set by connection.ts. Undefined while no socket is alive. */
type PairingRequester = (number: string) => Promise<string>;
let requester: PairingRequester | undefined;

export function getLinkState(): LinkSnapshot {
  return snapshot;
}

export function onLinkChange(fn: (s: LinkSnapshot) => void): () => void {
  emitter.on('change', fn);
  return () => emitter.off('change', fn);
}

function publish(patch: Partial<LinkSnapshot>): void {
  snapshot = { ...snapshot, ...patch, updatedAt: Date.now() };
  emitter.emit('change', snapshot);
}

/** A fresh QR arrived from Baileys. Clears any stale pairing code. */
export function publishQr(qr: string): void {
  publish({
    status: 'waiting',
    qr,
    qrExpiresAt: Date.now() + QR_TTL_MS,
    pairingCode: undefined,
    pairingNumber: undefined,
    message: undefined,
  });
}

export function publishConnected(user: { name?: string; number?: string }): void {
  publish({
    status: 'connected',
    user,
    qr: undefined,
    qrExpiresAt: undefined,
    pairingCode: undefined,
    pairingNumber: undefined,
    message: undefined,
  });
}

export function publishClosed(loggedOut: boolean, message?: string): void {
  publish({
    status: loggedOut ? 'logged-out' : 'closed',
    qr: undefined,
    qrExpiresAt: undefined,
    message,
  });
}

export function publishStarting(): void {
  publish({ status: 'starting', qr: undefined, qrExpiresAt: undefined, message: undefined });
}

/**
 * Register the function that actually asks WhatsApp for a pairing code.
 * connection.ts calls this once per socket; passing `undefined` unregisters it
 * when the socket dies, so the web UI reports "not ready" instead of throwing.
 */
export function setPairingRequester(fn: PairingRequester | undefined): void {
  requester = fn;
}

export function pairingAvailable(): boolean {
  return requester !== undefined && snapshot.status !== 'connected';
}

/** Digits only, 7–15 of them (ITU E.164 allows up to 15, incl. country code). */
export function normalizeNumber(raw: string): string | undefined {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : undefined;
}

/** Pretty-print an 8-char code as XXXX-XXXX, which is how WhatsApp shows it. */
export function formatPairingCode(code: string): string {
  const clean = code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/**
 * Ask WhatsApp for a pairing code for `number`.
 * Throws with a message that is safe to show the user.
 */
export async function requestPairingCode(number: string): Promise<string> {
  if (snapshot.status === 'connected') {
    throw new Error('Already linked — unlink from your phone first if you want to re-pair.');
  }
  if (!requester) {
    throw new Error('The WhatsApp socket is not ready yet. Give it a few seconds and try again.');
  }
  const code = formatPairingCode(await requester(number));
  publish({ pairingCode: code, pairingNumber: number, message: undefined });
  return code;
}
