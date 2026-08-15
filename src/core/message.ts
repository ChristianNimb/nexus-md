import {
  downloadMediaMessage,
  getContentType,
  type WASocket,
  type WAMessage,
  type MiscMessageGenerationOptions,
  type AnyMessageContent,
  jidNormalizedUser,
} from 'baileys';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { listSudo } from '../db/index.js';
import type { BotContext } from './types.js';

/** A quoted/replied-to message, exposed in a simplified shape. */
export interface QuotedMessage {
  sender: string | undefined;
  text: string;
  raw: NonNullable<WAMessage['message']>;
}

/**
 * Peel off the common "envelope" wrappers WhatsApp uses so callers see the
 * actual content (imageMessage, videoMessage, ...). Covers view-once (all
 * generations) and disappearing/ephemeral messages.
 */
export function unwrapContent(content: WAMessage['message'] | null | undefined): WAMessage['message'] | undefined {
  if (!content) return undefined;
  const c = content as Record<string, { message?: WAMessage['message'] } | undefined>;
  const inner =
    c.viewOnceMessageV2Extension?.message ??
    c.viewOnceMessageV2?.message ??
    c.viewOnceMessage?.message ??
    c.ephemeralMessage?.message ??
    c.documentWithCaptionMessage?.message;
  return inner ? unwrapContent(inner) : content;
}

/**
 * Friendly wrapper around a raw Baileys message. Plugins receive one of these
 * and use its helpers (`reply`, `react`, `sendImage`, `downloadMedia`, ...)
 * instead of hand-assembling protocol messages.
 */
export class Message {
  readonly raw: WAMessage;
  /** The underlying Baileys socket, for advanced operations (group ops, presence, ...). */
  readonly client: WASocket;
  private readonly ctx: BotContext;

  /** Chat JID (group or DM). */
  readonly chat: string;
  /** JID of whoever sent the message. */
  readonly sender: string;
  readonly isGroup: boolean;
  readonly fromMe: boolean;
  readonly pushName: string;
  /** Plain text body of the message (conversation or extended text / caption). */
  readonly body: string;
  readonly type: string;
  readonly timestamp: number;

  constructor(ctx: BotContext, raw: WAMessage) {
    this.ctx = ctx;
    this.client = ctx.sock;
    this.raw = raw;

    const key = raw.key;
    this.chat = key.remoteJid ?? '';
    this.isGroup = this.chat.endsWith('@g.us');
    this.fromMe = Boolean(key.fromMe);
    this.sender = this.isGroup
      ? jidNormalizedUser(key.participant ?? this.chat)
      : this.fromMe
        ? ctx.selfJid
        : jidNormalizedUser(this.chat);
    this.pushName = raw.pushName ?? '';
    this.timestamp = Number(raw.messageTimestamp ?? 0);

    const content = unwrapContent(raw.message) ?? {};
    this.type = getContentType(content) ?? 'unknown';
    this.body =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      content.documentMessage?.caption ?? // so ".read" works as a document caption
      '';
  }

  /** Digits-only number of the sender (no @-domain). */
  get senderNumber(): string {
    return this.sender.split('@')[0].split(':')[0];
  }

  /** The bot's own phone JID. */
  get me(): string {
    return this.ctx.selfJid;
  }

  /** The bot's own LID, if assigned (used for group admin checks). */
  get meLid(): string | undefined {
    return this.ctx.selfLid;
  }

  /** The logged-in account's WhatsApp display name (the owner's name). */
  get selfName(): string {
    return this.ctx.selfName ?? '';
  }

  /** True if the sender is the linked account, a configured owner, or sudo. */
  get isOwner(): boolean {
    if (this.fromMe) return true;
    const num = this.senderNumber;
    if (num === this.ctx.selfNumber) return true;
    if (config.owners.includes(num)) return true;
    return listSudo().includes(this.sender);
  }

  /** True ONLY for the ACTUAL owner (linked account or configured OWNERS) — NOT
   *  sudo. Gate sensitive/private features (like the saved contact list) on this. */
  get isRealOwner(): boolean {
    if (this.fromMe) return true;
    const num = this.senderNumber;
    return num === this.ctx.selfNumber || config.owners.includes(num);
  }

  /** True if the sender is a SUDO user (elevated helper) but NOT the owner. */
  get isSudo(): boolean {
    return !this.isRealOwner && listSudo().includes(this.sender);
  }

  /** The quoted message, if this one is a reply. Content is unwrapped. */
  get quoted(): QuotedMessage | undefined {
    // The reply info (contextInfo) can sit on ANY message type (extendedText,
    // image, video, sticker, ...) and may be wrapped in an ephemeral/view-once
    // envelope. Unwrap first, then find whichever field carries the quote.
    const content = unwrapContent(this.raw.message);
    let ctxInfo: { quotedMessage?: WAMessage['message']; participant?: string | null } | undefined;
    for (const value of Object.values((content ?? {}) as Record<string, unknown>)) {
      const ci = (value as { contextInfo?: { quotedMessage?: WAMessage['message']; participant?: string | null } } | null | undefined)?.contextInfo;
      if (ci?.quotedMessage) {
        ctxInfo = ci;
        break;
      }
    }
    const rawQuoted = ctxInfo?.quotedMessage;
    if (!rawQuoted) return undefined;
    const q = unwrapContent(rawQuoted) ?? rawQuoted;
    const type = getContentType(q);
    const text =
      q.conversation ??
      q.extendedTextMessage?.text ??
      (type === 'imageMessage' ? q.imageMessage?.caption : '') ??
      (type === 'videoMessage' ? q.videoMessage?.caption : '') ??
      '';
    return {
      sender: ctxInfo?.participant ? jidNormalizedUser(ctxInfo.participant) : undefined,
      text: text ?? '',
      raw: q,
    };
  }

  /** The message ID of the quoted (replied-to) message — used to look up things
   *  like read receipts for that specific message. */
  get quotedId(): string | undefined {
    const content = unwrapContent(this.raw.message);
    for (const value of Object.values((content ?? {}) as Record<string, unknown>)) {
      const ci = (value as { contextInfo?: { stanzaId?: string | null } } | null | undefined)?.contextInfo;
      if (ci?.stanzaId) return ci.stanzaId;
    }
    return undefined;
  }

  /** JIDs mentioned in this message. */
  get mentioned(): string[] {
    return this.raw.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
  }

  /* ------------------------------ sending ------------------------------ */

  async send(content: AnyMessageContent, opts: MiscMessageGenerationOptions = {}) {
    return this.client.sendMessage(this.chat, content, opts);
  }

  /** Reply with text, quoting the original message. */
  async reply(text: string) {
    return this.send({ text }, { quoted: this.raw });
  }

  /** Send text without quoting. */
  async sendText(text: string) {
    return this.send({ text });
  }

  async sendImage(buffer: Buffer, caption = '') {
    return this.send({ image: buffer, caption }, { quoted: this.raw });
  }

  async sendVideo(buffer: Buffer, caption = '') {
    return this.send({ video: buffer, caption }, { quoted: this.raw });
  }

  async sendSticker(buffer: Buffer, quoted?: WAMessage) {
    return this.send({ sticker: buffer }, { quoted: quoted ?? this.raw });
  }

  /** React to this message with an emoji. */
  async react(emoji: string) {
    return this.client.sendMessage(this.chat, { react: { text: emoji, key: this.raw.key } });
  }

  /**
   * Show a live presence in the chat — "typing…" or "recording audio…" — so Nexus
   * feels like a real person composing a reply. Best-effort (never throws).
   *   composing → typing…   recording → recording audio…   paused → stop.
   */
  async setPresence(state: 'composing' | 'recording' | 'paused' | 'available', jid: string = this.chat) {
    try {
      await this.client.sendPresenceUpdate(state, jid);
    } catch {
      /* best effort */
    }
  }

  /**
   * Download the media contained in a specific (already-unwrapped) message
   * content object. Used for view-once reveal and quoted media.
   */
  async downloadContent(content: WAMessage['message']): Promise<Buffer | undefined> {
    try {
      if (!content) return undefined;
      const target = { key: this.raw.key, message: content } as WAMessage;
      const out = await downloadMediaMessage(
        target,
        'buffer',
        {},
        { logger, reuploadRequest: this.client.updateMediaMessage },
      );
      return out as Buffer;
    } catch (err) {
      logger.error({ err }, 'media download failed');
      return undefined;
    }
  }

  /**
   * Download attached media (or the media of the quoted message) to a Buffer.
   * Returns undefined if there is nothing to download.
   */
  async downloadMedia(fromQuoted = false): Promise<Buffer | undefined> {
    const content = fromQuoted ? this.quoted?.raw : unwrapContent(this.raw.message);
    return this.downloadContent(content);
  }
}
