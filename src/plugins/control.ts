import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { command, recompileCommands } from '../core/registry.js';
import { config, setPrefixes } from '../config.js';
import { flush, setSetting } from '../db/index.js';
import { logger } from '../logger.js';

const run = promisify(exec);

/**
 * Owner-only process control. `restart` relies on a supervisor (pm2, systemd,
 * nodemon, or `tsx watch`) to bring the process back up. `update` pulls the
 * latest git revision, then restarts.
 */

command({ pattern: 'restart', fromMe: true, desc: 'Restart the bot', category: 'owner' }, async (m) => {
  await m.reply('Restarting...');
  flush();
  logger.info('restart requested by owner');
  setTimeout(() => process.exit(0), 500);
});

command({ pattern: 'update', fromMe: true, desc: 'Git pull latest and restart', category: 'owner' }, async (m) => {
  try {
    await m.reply('Pulling latest changes...');
    const { stdout } = await run('git pull --ff-only');
    if (/Already up to date/i.test(stdout)) return m.reply('Already up to date.');
    await m.reply('Updated:\n```' + stdout.trim().slice(0, 800) + '```\nRestarting...');
    flush();
    setTimeout(() => process.exit(0), 800);
  } catch (err) {
    logger.error({ err }, 'update failed');
    await m.reply('Update failed. Is this a git checkout with a clean tree?');
  }
});

command(
  { pattern: 'setprefix ?(.*)', fromMe: true, desc: 'Change the command prefix (e.g. ! or / or none)', usage: '<char(s) | none>', category: 'owner' },
  async (m, match) => {
    const raw = (match?.[1] ?? '').trim();
    if (!raw) {
      const cur = config.prefixes.length ? config.prefixes.join('') : '(none)';
      return m.reply(`Current prefix: *${cur}*\nChange it with *${config.prefixes[0] ?? ''}setprefix !* (or a few like *.!/*, or *none* for no prefix).`);
    }

    // "none"/"blank"/"off" → no prefix (commands work with just their name).
    const none = /^(none|blank|off|nothing)$/i.test(raw);
    // Each character becomes a valid prefix. Strip spaces; cap length for sanity.
    const chars = none ? [] : [...new Set(raw.replace(/\s+/g, '').split(''))].slice(0, 4);

    if (!none && !chars.length) return m.reply('Give me a prefix character, e.g. *setprefix !* — or *setprefix none*.');

    setPrefixes(chars);
    recompileCommands(); // takes effect immediately, no restart needed
    setSetting('prefix', none ? '' : chars.join('')); // persists across restarts

    const shown = none ? '(none — just type the command name)' : chars.join(' ');
    const eg = chars[0] ?? '';
    await m.reply(`✅ Prefix updated to: *${shown}*\nTry *${eg}menu* now. (Saved — it'll stick after restarts.)`);
  },
);

command({ pattern: 'shutdown', fromMe: true, desc: 'Stop the bot', category: 'owner', hidden: true }, async (m) => {
  await m.reply('Shutting down.');
  flush();
  setTimeout(() => process.exit(0), 300);
});
