import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser,
  type WASocket,
  type WAMessage,
  type WAMessageContent,
} from 'baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { logger, waLogger } from '../logger.js';
import { handleMessage } from '../core/handler.js';
import { handleGroupParticipants } from '../core/events.js';
import { attachScheduler } from '../plugins/schedule.js';
import { attachBirthdayReminders } from '../plugins/birthday.js';
import { attachSeenTracking } from '../plugins/seen.js';
import { attachPresence } from '../plugins/presence.js';
import { attachMemberTools } from '../plugins/member-tools.js';
import { attachAutoStatus } from '../plugins/autostatus.js';
import { rememberLid } from '../core/lid.js';
import { upsertContact, getSetting } from '../db/index.js';
import { synthesizeResult, ttsReady } from '../core/voice.js';
import { quickGen } from '../plugins/chatbot.js';
import {
  publishQr,
  publishConnected,
  publishClosed,
  setPairingRequester,
} from '../web/link-state.js';
import type { BotContext } from '../core/types.js';

/**
 * Cache of recently-seen messages by id. When a recipient's phone can't decrypt
 * a message, it asks us to RE-SEND — Baileys can only do that if we can look the
 * message up here. Without it, the recipient is stuck on "Waiting for this
 * message… this may take a while" forever. Survives reconnects (module scope).
 */
const msgCache = new Map<string, WAMessageContent>();
function cacheMessage(m: WAMessage): void {
  const id = m.key?.id;
  if (!id || !m.message) return;
  msgCache.set(id, m.message);
  if (msgCache.size > 3000) msgCache.delete(msgCache.keys().next().value as string);
}

/**
 * Establish (and keep alive) the WhatsApp connection.
 * Auth state is persisted to `config.sessionDir` via multi-file auth, so the
 * QR only needs to be scanned once per device.
 */
export async function startBot(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, 'using WA web version');

  const sock: WASocket = makeWASocket({
    version,
    auth: state,
    logger: waLogger,
    printQRInTerminal: false, // we render it ourselves below
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Give init/sync queries more room on a slow/unstable link to WhatsApp (the
    // "init queries → Timed Out" errors) so the contact sync can finish.
    defaultQueryTimeoutMs: 90_000,
    connectTimeoutMs: 90_000,
    keepAliveIntervalMs: 25_000,
    // Lets Baileys re-send a message when the recipient couldn't decrypt it
    // (fixes the endless "Waiting for this message…").
    getMessage: async (key) => (key.id ? msgCache.get(key.id) : undefined),
  });

  let ctx: BotContext | null = null;

  /**
   * Pairing-code support for the web panel.
   *
   * requestPairingCode() sends an IQ, so the websocket must already be up —
   * calling it the instant the process boots fails with "Connection Closed".
   * The QR event is our proof that the socket is connected but not yet
   * authenticated, which is exactly the window a pairing code is valid in, so a
   * request that arrives early waits for that instead of failing.
   */
  let socketReady = false;
  const readyWaiters: Array<() => void> = [];
  function markSocketReady(): void {
    socketReady = true;
    while (readyWaiters.length) readyWaiters.shift()?.();
  }
  function whenSocketReady(timeoutMs = 20_000): Promise<void> {
    if (socketReady) return Promise.resolve();
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Still connecting to WhatsApp — try again in a few seconds.')),
        timeoutMs,
      );
      readyWaiters.push(() => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }

  setPairingRequester(async (number: string) => {
    if (sock.authState.creds.registered) {
      throw new Error('This bot is already registered. Unlink it from your phone first, then try again.');
    }
    await whenSocketReady();
    return await sock.requestPairingCode(number);
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // The panel is the better place for this whenever it exists, and printing
      // to the terminal as well is not merely redundant — a QR in a log stream
      // is a LIVE CREDENTIAL. Anyone who can read the logs can scan it and link
      // their own phone as this bot. Under the hosting platform the log stream
      // is piped straight into a browser, so it goes to the panel alone.
      markSocketReady();
      publishQr(qr);

      if (config.web.enabled) {
        logger.info('scan the QR at /link — it is deliberately not printed here');
      } else {
        logger.info('scan the QR code below with WhatsApp > Linked devices');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      const selfJid = jidNormalizedUser(sock.user?.id ?? '');
      const selfLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : undefined;
      ctx = {
        sock,
        selfJid,
        selfLid,
        selfNumber: selfJid.split('@')[0].split(':')[0],
        selfName: sock.user?.name ?? (sock.user as { verifiedName?: string } | undefined)?.verifiedName ?? '',
      };
      logger.info({ user: selfJid, lid: selfLid }, `${config.botName} connected`);
      publishConnected({ name: ctx.selfName || undefined, number: ctx.selfNumber });
      attachScheduler(sock); // arm scheduled messages now that we're online
      attachBirthdayReminders(sock); // arm the daily birthday check
      attachSeenTracking(sock); // remember who reads the owner's messages (.seen)
      attachPresence(sock); // track who's online for .tagonline
      attachMemberTools(sock); // join-date tracking + join-request approvals
      attachAutoStatus(sock); // auto-view status updates (.autostatus on)
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      logger.warn({ code, loggedOut }, 'connection closed');
      // This socket is done: stop offering pairing codes through it. A reconnect
      // registers a fresh requester below.
      setPairingRequester(undefined);
      publishClosed(
        loggedOut,
        loggedOut ? 'WhatsApp logged this session out. Delete the session folder, then link again.' : undefined,
      );
      if (!loggedOut) {
        // transient drop — reconnect
        setTimeout(() => void startBot(), 2_000);
      } else {
        logger.error('logged out — delete the session folder and re-scan the QR');
      }
    }
  });

  // Keep a local name→number directory so Nexus can resolve "send to Khalil".
  // WhatsApp pushes the address book (with SAVED names) via these sync events at
  // link time and as contacts change — that's how we get names like "Khalil".
  const rememberContacts = (list: { id?: string | null; name?: string | null; notify?: string | null; lid?: string | null; jid?: string | null }[], src: string) => {
    let total = 0;
    let withNames = 0;
    for (const c of list) {
      if (!c?.id) continue;
      // Learn the lid↔real-number pairing so we can show real numbers later.
      rememberLid(c.lid, c.jid ?? (c.id.endsWith('@s.whatsapp.net') ? c.id : undefined));
      total++;
      if (c.name) withNames++;
      upsertContact(jidNormalizedUser(c.id), { name: c.name ?? undefined, notify: c.notify ?? undefined });
    }
    if (total) logger.info({ src, total, withSavedNames: withNames }, 'synced WhatsApp contacts');
  };
  sock.ev.on('contacts.upsert', (contacts) => rememberContacts(contacts, 'upsert'));
  sock.ev.on('contacts.update', (updates) => rememberContacts(updates, 'update'));
  sock.ev.on('messaging-history.set', ({ contacts }) => rememberContacts(contacts ?? [], 'history'));

  // 🔥 Auto-answer calls: WhatsApp can't do live call audio via Baileys, so when
  // someone CALLS the bot we politely decline and instantly reply with a
  // personalised VOICE NOTE — as if Nexus "picked up". Toggle: .callreply off
  sock.ev.on('call', async (events) => {
    for (const c of events) {
      if (c.status !== 'offer') continue; // only brand-new incoming calls
      if (getSetting('call.answer') === 'off') continue;
      try {
        await sock.rejectCall(c.id, c.from);
      } catch (err) {
        logger.warn({ err }, 'rejectCall failed');
      }
      try {
        const line =
          (await quickGen(
            "Someone just tried to voice/video CALL you on WhatsApp, but you can't take live calls yet. Reply with ONE short, playful, friendly line — acknowledge that they called and invite them to just chat or leave a message here. Natural and warm.",
          )) || 'hey! saw you calling 😄 I can’t do live calls yet — but I’m right here, talk to me!';
        if (ttsReady()) {
          const v = await synthesizeResult(line);
          if (v.ok) {
            await sock.sendMessage(c.from, { audio: v.audio, ptt: true, mimetype: v.mimetype });
            continue;
          }
        }
        await sock.sendMessage(c.from, { text: line });
      } catch (err) {
        logger.warn({ err }, 'call auto-answer failed');
      }
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    if (!ctx) return;
    try {
      await handleGroupParticipants(ctx, update);
    } catch (err) {
      logger.error({ err }, 'error in group-participants handler');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Cache ALL messages (incoming AND our own sent) so getMessage can resend.
    for (const raw of messages) cacheMessage(raw);

    if (type !== 'notify' || !ctx) return;
    for (const raw of messages) {
      // ignore protocol/empty messages and our own status broadcasts
      if (!raw.message || raw.key.remoteJid === 'status@broadcast') continue;
      enqueue(ctx, raw);
    }
  });
}

/**
 * One queue per chat.
 *
 * Handling messages one-after-another globally meant a single slow reply (an AI
 * answer, a big download) froze the bot for EVERYONE — another person's command
 * just sat there until yours finished. Queuing per chat fixes that: different
 * chats run at the same time, while messages within one chat still run in order
 * (so replies never arrive out of sequence).
 */
const chatQueues = new Map<string, Promise<void>>();

function enqueue(ctx: BotContext, raw: WAMessage): void {
  const chat = raw.key.remoteJid ?? 'unknown';
  const prev = chatQueues.get(chat) ?? Promise.resolve();
  const next = prev
    .then(() => handleMessage(ctx, raw))
    .catch((err) => logger.error({ err, chat }, 'unhandled error in message handler'))
    .finally(() => {
      // Drop the queue once this chat goes idle, so the map can't grow forever.
      if (chatQueues.get(chat) === next) chatQueues.delete(chat);
    });
  chatQueues.set(chat, next);
}
