import { proto } from 'baileys';
import type { WAMessage } from 'baileys';
import { command } from '../core/registry.js';
import { getSetting, setSetting } from '../db/index.js';
import { vaultJid, tagOf } from '../core/vault.js';
import { logger } from '../logger.js';

/**
 * Anti-delete: keep a short rolling cache of recent messages, and when one is
 * deleted for everyone, forward the original to your vault DM with context.
 * Toggle with `.antidelete on|off` (owner only). Off by default.
 */

const REVOKE = proto.Message.ProtocolMessage.Type.REVOKE;

interface Cached {
  raw: WAMessage;
  chat: string;
  author: string;
  pushName: string;
}

const MAX_CACHE = 3000;
const cache = new Map<string, Cached>();

function remember(id: string, entry: Cached): void {
  cache.set(id, entry);
  if (cache.size > MAX_CACHE) {
    // Map preserves insertion order — drop the oldest.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function enabled(): boolean {
  return getSetting('antidelete') === 'on';
}

command(
  { pattern: 'antidelete ?(.*)', desc: 'Forward deleted messages to your DM', usage: 'on|off', category: 'owner', fromMe: true },
  async (m, match) => {
    const v = match?.[1]?.trim().toLowerCase();
    if (v === 'on') {
      setSetting('antidelete', 'on');
      return m.reply('🕵️ Anti-delete enabled. Deleted messages will be forwarded to your DM.');
    }
    if (v === 'off') {
      setSetting('antidelete', 'off');
      return m.reply('Anti-delete disabled.');
    }
    await m.reply(`Anti-delete is ${enabled() ? 'on' : 'off'}. Use .antidelete on|off`);
  },
);

// Passive: cache every message, and act on revokes.
command({ on: 'message' }, async (m) => {
  const protocol = m.raw.message?.protocolMessage;

  // A deletion (revoke-for-everyone).
  if (protocol && protocol.type === REVOKE) {
    if (!enabled()) return;
    const deletedId = protocol.key?.id;
    if (!deletedId) return;
    const original = cache.get(deletedId);
    if (!original) return; // we never saw it (sent before startup, or evicted)

    // Ignore the owner deleting their own messages.
    if (m.fromMe) return;

    const target = vaultJid(m);
    const chatLabel = original.chat.endsWith('@g.us') ? 'a group' : 'a DM';
    const header =
      `🗑️ *Deleted message recovered*\n` +
      `• From: ${tagOf(original.author)}${original.pushName ? ` (${original.pushName})` : ''}\n` +
      `• Deleted by: ${tagOf(m.sender)}\n` +
      `• Where: ${chatLabel}`;
    try {
      await m.client.sendMessage(target, { text: header });
      await m.client.sendMessage(target, { forward: original.raw });
    } catch (err) {
      logger.warn({ err }, 'antidelete: failed to forward original');
    }
    cache.delete(deletedId);
    return;
  }

  // Otherwise, remember it (skip protocol/empty messages).
  const id = m.raw.key.id;
  if (!id || !m.raw.message || protocol) return;
  remember(id, { raw: m.raw, chat: m.chat, author: m.sender, pushName: m.pushName });
});
