import { config } from '../config.js';
import { getSetting, setSetting } from '../db/index.js';

/**
 * Runtime public/private mode.
 *
 * The MODE env var is only the INITIAL default. The live value is stored in the
 * database so it can be switched at runtime (.mode / .public / .private) without
 * restarting — the old design baked the mode into every command at startup,
 * which made runtime switching impossible.
 *
 *   public  -> anyone can use non-owner commands
 *   private -> only the owner/sudo can use the bot
 */

export type BotMode = 'public' | 'private';

export function botMode(): BotMode {
  const m = getSetting('bot.mode');
  return m === 'public' || m === 'private' ? m : (config.mode as BotMode);
}

export function setBotMode(m: BotMode): void {
  setSetting('bot.mode', m);
}

export function isPrivate(): boolean {
  return botMode() === 'private';
}
