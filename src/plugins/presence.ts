import type { WASocket } from 'baileys';
import { command } from '../core/registry.js';
import { groupMeta } from '../core/group.js';
import { logger } from '../logger.js';

/**
 * Track who's ONLINE and tag them. WhatsApp broadcasts presence (online / typing
 * / recording) for people who share it with you — we subscribe to the group and
 * collect those signals. Honest limit: anyone who hides "last seen / online"
 * simply never shows up, so this catches the active-and-visible members, not all.
 */

const ONLINE = new Set(['available', 'composing', 'recording']);
const FRESH_MS = 120_000;

// GLOBAL presence: personJid -> { state, at }. A presence.update's inner
// `presences` object is always keyed by the individual's jid (whether the event
// arrived for a contact or a group), so we store per-PERSON and look people up
// when tagging. (Storing per-chat lost everyone we subscribed to individually.)
const seen = new Map<string, { state: string; at: number }>();

/** Register the presence listener. Called from connection once online. */
export function attachPresence(sock: WASocket): void {
  sock.ev.on('presence.update', ({ presences }) => {
    if (!presences) return;
    for (const [jid, data] of Object.entries(presences)) {
      const state = (data as { lastKnownPresence?: string })?.lastKnownPresence ?? 'unavailable';
      seen.set(jid, { state, at: Date.now() });
    }
  });
  logger.debug('presence tracking attached');
}

/** Is this person currently showing online (fresh + an "online" state)? */
export function isOnline(jid?: string | null): boolean {
  if (!jid) return false;
  const p = seen.get(jid);
  return !!p && ONLINE.has(p.state) && Date.now() - p.at < FRESH_MS;
}

const HEADERS = [
  '👀 *Caught you lurking!* The ones online right now:',
  '🟢 *Online and can\'t hide 😏* —',
  '⚡ *The ones actually awake:*',
  '🎯 *Present & accounted for:*',
  '🫡 *Roll call — who\'s really here:*',
];

command({ pattern: 'tagonline ?(.*)', desc: 'Tag members who are online now', usage: '[message]', category: 'group', groupOnly: true, adminOnly: true }, async (m, match) => {
  const note = (match?.[1] ?? '').trim();
  await m.react('👀');

  // Nudge WhatsApp to push fresh presence: subscribe to the group AND to every
  // participant by BOTH their id and their real-number jid (a member's presence
  // can arrive keyed by either), then give it a moment to stream in.
  const meta = await groupMeta(m.client, m.chat);
  try {
    await m.client.presenceSubscribe(m.chat);
    for (const p of meta.participants.slice(0, 120)) {
      void m.client.presenceSubscribe(p.id).catch(() => {});
      const jid = (p as { jid?: string }).jid;
      if (jid && jid !== p.id) void m.client.presenceSubscribe(jid).catch(() => {});
    }
  } catch {
    /* best effort */
  }
  await new Promise((r) => setTimeout(r, 6000));

  // Tag every participant we can see as online, matched by ANY of their ids
  // (id / lid / real-number jid), and mention them by participant.id like
  // .tagall so WhatsApp renders their names — never a raw @lid.
  const online = meta.participants.filter((p) => {
    if (p.id === m.me || p.id === m.meLid) return false; // never tag the bot
    const lid = (p as { lid?: string }).lid;
    const jid = (p as { jid?: string }).jid;
    return isOnline(p.id) || isOnline(lid) || isOnline(jid);
  });
  if (!online.length) {
    return m.reply('👀 Nobody else is showing as online right now.\n_(WhatsApp only tells me who has the app OPEN and shares their online status — most people don\'t, so this catches the actively-online few.)_');
  }
  const ids = online.map((p) => p.id);
  const header = HEADERS[Math.floor(Math.random() * HEADERS.length)];
  const tags = ids.map((id) => `@${id.split('@')[0]}`).join(' ');
  await m.client.sendMessage(m.chat, { text: `${header}${note ? `\n${note}` : ''}\n${tags}`, mentions: ids });
});

logger.debug('presence plugin loaded');
