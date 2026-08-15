import type { WASocket, WAMessage } from 'baileys';
import type { Message } from './message.js';

/** Events a plugin can subscribe to instead of a text pattern. */
export type EventType = 'message' | 'text' | 'image' | 'video' | 'sticker' | 'group-update';

/** Handler signature. `match` holds regex capture groups when a pattern is used. */
export type CommandHandler = (message: Message, match: RegExpMatchArray | null) => Promise<unknown> | unknown;

export interface CommandSpec {
  /** Command trigger, e.g. "ping" or "kick ?(.*)". Compiled to a prefixed RegExp. */
  pattern?: string;
  /** Subscribe to a raw event instead of matching text. */
  on?: EventType;
  /** Restrict to owner/sudo only. Defaults to true in private mode. */
  fromMe?: boolean;
  /** One-line description shown in the menu. */
  desc?: string;
  /** Category grouping in the menu. */
  category?: string;
  /** Usage hint, e.g. "<reply to user>". */
  usage?: string;
  /** Hide from the generated menu/command list. */
  hidden?: boolean;
  /** Only run inside groups. */
  groupOnly?: boolean;
  /** Require the bot to be admin (implies groupOnly). */
  botAdmin?: boolean;
  /** Require the sender to be a group admin. */
  adminOnly?: boolean;
}

/** A registered command: the spec plus its compiled matcher and handler. */
export interface RegisteredCommand extends CommandSpec {
  regex?: RegExp;
  handler: CommandHandler;
}

export interface BotContext {
  sock: WASocket;
  /** Bare JID of the logged-in account, e.g. "15551234567@s.whatsapp.net". */
  selfJid: string;
  /**
   * The account's LID (e.g. "12345@lid"), if WhatsApp has assigned one.
   * Groups increasingly identify members by LID rather than phone JID, so
   * admin checks must match against this too.
   */
  selfLid?: string;
  /** Digits-only number of the logged-in account. */
  selfNumber: string;
  /** The logged-in account's WhatsApp display name (owner's name), if known. */
  selfName?: string;
}

export type RawMessage = WAMessage;
