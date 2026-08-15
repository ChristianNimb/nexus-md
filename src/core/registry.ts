import { config } from '../config.js';
import type { CommandSpec, CommandHandler, RegisteredCommand } from './types.js';

/** Global command table populated by plugins at import time. */
export const commands: RegisteredCommand[] = [];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the prefix portion of a command regex from the configured prefixes.
 * With prefixes ['.', '!'] this yields "^(?:\.|!)" so ".ping" or "!ping" match.
 * An empty prefix list means commands match with no prefix.
 */
function prefixPattern(): string {
  const parts = config.prefixes.map(escapeRegex).filter(Boolean);
  if (parts.length === 0) return '^';
  return `^(?:${parts.join('|')})`;
}

/**
 * Register a command or event handler. Plugins call this at module load.
 *
 * @example
 * command({ pattern: 'ping', desc: 'Health check' }, async (m) => m.reply('pong'));
 */
export function command(spec: CommandSpec, handler: CommandHandler): RegisteredCommand {
  // `fromMe` now means ONLY "explicitly owner-only" (e.g. .setsudo, dev tools).
  // Public/private is enforced dynamically at dispatch (see core/mode.ts), so it
  // can be switched at runtime instead of being frozen at startup.
  const entry: RegisteredCommand = {
    ...spec,
    fromMe: spec.fromMe ?? false,
    desc: spec.desc ?? '',
    category: spec.category ?? 'general',
    groupOnly: spec.groupOnly ?? spec.botAdmin ?? spec.adminOnly ?? false,
    handler,
  };

  if (spec.pattern) {
    entry.regex = new RegExp(`${prefixPattern()}${spec.pattern}$`, 'is');
  }

  commands.push(entry);
  return entry;
}

/**
 * Rebuild every command's regex from the CURRENT prefixes. Command patterns bake
 * the prefix into their compiled RegExp at registration time, so changing
 * config.prefixes at runtime has no effect until we recompile — this does that,
 * making a live prefix change (see .setprefix) work without a restart.
 */
export function recompileCommands(): void {
  for (const c of commands) {
    if (c.pattern) c.regex = new RegExp(`${prefixPattern()}${c.pattern}$`, 'is');
  }
}

/** Extract a clean command name from a pattern like "kick ?(.*)" -> "kick". */
export function commandName(pattern?: string): string {
  if (!pattern) return '';
  const m = pattern.match(/^([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}
