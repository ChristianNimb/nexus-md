import { config } from '../config.js';
import type { Message } from './message.js';

/**
 * Where to deliver private copies (revealed view-once, deleted messages, ...):
 * the first configured owner number's DM if set, otherwise the bot's own
 * "message yourself" chat. Digits are sanitised so "+234 812..." style values
 * in .env still produce a valid JID.
 */
export function vaultJid(m: Message): string {
  const owner = config.owners[0]?.replace(/\D/g, '');
  return owner ? `${owner}@s.whatsapp.net` : m.me;
}

/** Short display tag for a JID, e.g. "+2348100000000". */
export function tagOf(jid: string | undefined): string {
  if (!jid) return 'unknown';
  return `+${jid.split('@')[0].split(':')[0]}`;
}
