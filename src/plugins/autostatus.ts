import type { WASocket } from 'baileys';
import { command } from '../core/registry.js';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Auto status view — opens every status update the moment it arrives, so the
 * owner always shows up among the first viewers.
 *
 * WhatsApp delivers status posts as messages to `status@broadcast`; marking one
 * read with readMessages() is exactly what "viewing" a status is, so the poster
 * sees you in their viewer list. Off by default; toggle with .autostatus on|off.
 */

const KEY = 'autostatus';

export const autoStatusOn = (): boolean => getSetting(KEY) === 'on';

/** Register the status listener. Called from connection once online. */
export function attachAutoStatus(sock: WASocket): void {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !autoStatusOn()) return;
    for (const msg of messages) {
      const key = msg.key;
      if (!key || key.remoteJid !== 'status@broadcast') continue;
      if (key.fromMe) continue; // never "view" our own status
      if (!msg.message) continue; // protocol/empty envelope
      try {
        // The key carries `participant` (whose status it is) — readMessages
        // needs that to register the view against the right person.
        await sock.readMessages([key]);
        logger.debug({ from: key.participant }, 'auto-viewed a status');
      } catch (err) {
        logger.debug({ err, from: key.participant }, 'auto status view failed');
      }
    }
  });
  logger.debug('auto status view attached');
}

command(
  {
    pattern: 'autostatus(?: (.+))?',
    fromMe: true,
    desc: 'Auto-view everyone’s status updates',
    usage: '[on | off]',
    category: 'owner',
  },
  async (m, match) => {
    const arg = (match?.[1] ?? '').trim().toLowerCase();
    const prefix = config.prefixes[0] ?? '';

    if (/^(on|enable|start)$/.test(arg)) {
      setSetting(KEY, 'on');
      return m.reply(
        '👀 *Auto status view: ON*\nI’ll open every status the moment it lands — you’ll be among the first viewers, every time.',
      );
    }
    if (/^(off|disable|stop)$/.test(arg)) {
      setSetting(KEY, 'off');
      return m.reply('🚫 *Auto status view: OFF*\nI’ll stop opening statuses.');
    }

    return m.reply(
      `👀 *Auto status view:* ${autoStatusOn() ? '*ON*' : '*OFF*'}\n\n` +
        `Turn it on with *${prefix}autostatus on* — or off with *${prefix}autostatus off*.\n` +
        `_When on, I open each status as it arrives so you're always one of the first viewers._`,
    );
  },
);

logger.debug('autostatus plugin loaded');
