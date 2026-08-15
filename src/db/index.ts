import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Zero-dependency JSON store.
 *
 * A single self-hosted bot doesn't need a real database engine, and avoiding a
 * native module (better-sqlite3) means `npm install` never has to compile
 * anything — no Visual Studio Build Tools, no prebuild-install timeouts.
 *
 * The whole state lives in memory and is flushed to disk atomically (write to a
 * temp file, then rename) on a short debounce so bursts of writes coalesce.
 */

interface Store {
  settings: Record<string, string>;
  sudo: string[];
  afk: Record<string, { reason: string; since: number }>;
  /** groupJid -> userJid -> warn count */
  warns: Record<string, Record<string, number>>;
  /** scope ("global" or groupJid) -> keyword -> response */
  filters: Record<string, Record<string, string>>;
  /** groupJid -> per-group toggles/messages */
  groups: Record<string, GroupConfig>;
  /** jid -> message count */
  stats: Record<string, number>;
  /** stickerId -> caption metadata (files live on disk under data/stickers/) */
  stickers: Record<string, StickerMeta>;
  /** "chat::subject" -> durable facts Nexus remembers about a person/group */
  memories: Record<string, MemoryNote[]>;
  /** jid -> saved/known contact names, so Nexus can resolve "send to Khalil". */
  contacts: Record<string, ContactRow>;
}

export interface ContactRow {
  /** Saved address-book name (best for lookup). */
  name?: string;
  /** WhatsApp push name (their self-set display name). */
  notify?: string;
  at: number;
}

export interface MemoryNote {
  fact: string;
  at: number;
}

export interface StickerMeta {
  desc: string;
  tags: string[];
  at: number;
}

export interface GroupConfig {
  welcome?: boolean;
  welcomeMsg?: string;
  goodbye?: boolean;
  goodbyeMsg?: string;
  antilink?: boolean;
  /** What to do when a non-admin posts a link: warn (then auto-kick) or kick immediately. */
  antilinkAction?: 'warn' | 'kick';
  autodl?: boolean;
  /** Kick non-admins whose messages look bot-generated. */
  antibot?: boolean;
  /** The group's name/subject — learned so the owner can reference it by name. */
  subject?: string;
  /** When the subject was last refreshed (throttles metadata lookups). */
  nameAt?: number;
}

const EMPTY: Store = {
  settings: {},
  sudo: [],
  afk: {},
  warns: {},
  filters: {},
  groups: {},
  stats: {},
  stickers: {},
  memories: {},
  contacts: {},
};

const path = config.dbPath.endsWith('.db') ? config.dbPath.replace(/\.db$/, '.json') : config.dbPath;

function load(): Store {
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      return { ...EMPTY, ...raw };
    }
  } catch (err) {
    logger.error({ err }, 'failed to read store, starting fresh');
  }
  return structuredClone(EMPTY);
}

const store: Store = load();

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 250);
}

/** Force an immediate write to disk. */
export function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const dir = dirname(path);
    if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    logger.error({ err }, 'failed to persist store');
  }
}

// Best-effort flush on shutdown.
for (const sig of ['SIGINT', 'SIGTERM', 'beforeExit'] as const) {
  process.on(sig, () => {
    flush();
    if (sig !== 'beforeExit') process.exit(0);
  });
}

logger.info({ path }, 'json store ready');

/* ----------------------------- settings kv ----------------------------- */

export function getSetting(key: string): string | undefined {
  return store.settings[key];
}
export function setSetting(key: string, value: string): void {
  store.settings[key] = value;
  scheduleSave();
}
export function deleteSetting(key: string): void {
  delete store.settings[key];
  scheduleSave();
}

/* ------------------------------- sudo list ------------------------------ */

export function listSudo(): string[] {
  return [...store.sudo];
}
export function addSudo(jid: string): void {
  if (!store.sudo.includes(jid)) {
    store.sudo.push(jid);
    scheduleSave();
  }
}
export function removeSudo(jid: string): void {
  store.sudo = store.sudo.filter((j) => j !== jid);
  scheduleSave();
}

/* --------------------------------- afk ---------------------------------- */

export interface AfkRow {
  reason: string;
  since: number;
}
export function getAfk(jid: string): AfkRow | undefined {
  return store.afk[jid];
}
export function setAfk(jid: string, reason: string): void {
  store.afk[jid] = { reason, since: Date.now() };
  scheduleSave();
}
export function clearAfk(jid: string): void {
  delete store.afk[jid];
  scheduleSave();
}

/* -------------------------------- warns --------------------------------- */

export function addWarn(groupJid: string, userJid: string): number {
  const g = (store.warns[groupJid] ??= {});
  g[userJid] = (g[userJid] ?? 0) + 1;
  scheduleSave();
  return g[userJid];
}
export function getWarns(groupJid: string, userJid: string): number {
  return store.warns[groupJid]?.[userJid] ?? 0;
}
export function resetWarns(groupJid: string, userJid: string): void {
  if (store.warns[groupJid]) {
    delete store.warns[groupJid][userJid];
    scheduleSave();
  }
}

/* ------------------------------- filters -------------------------------- */

export function setFilter(scope: string, keyword: string, response: string): void {
  const s = (store.filters[scope] ??= {});
  s[keyword.toLowerCase()] = response;
  scheduleSave();
}
export function removeFilter(scope: string, keyword: string): boolean {
  const s = store.filters[scope];
  if (s && keyword.toLowerCase() in s) {
    delete s[keyword.toLowerCase()];
    scheduleSave();
    return true;
  }
  return false;
}
export function listFilters(scope: string): Record<string, string> {
  return { ...(store.filters[scope] ?? {}) };
}

/* --------------------------- per-group config --------------------------- */

export function getGroupConfig(groupJid: string): GroupConfig {
  return store.groups[groupJid] ?? {};
}
export function setGroupConfig(groupJid: string, patch: Partial<GroupConfig>): GroupConfig {
  const cur = (store.groups[groupJid] ??= {});
  Object.assign(cur, patch);
  scheduleSave();
  return cur;
}

/** Every group Nexus knows a NAME for (jid + subject). Powers "send to the
 *  <group name> group" from the owner's DM. */
export function listGroups(): { jid: string; subject: string }[] {
  return Object.entries(store.groups)
    .filter(([, g]) => g.subject)
    .map(([jid, g]) => ({ jid, subject: g.subject as string }));
}

/* -------------------------------- stats --------------------------------- */

export function bumpStat(jid: string): void {
  store.stats[jid] = (store.stats[jid] ?? 0) + 1;
  scheduleSave();
}
export function getStat(jid: string): number {
  return store.stats[jid] ?? 0;
}

/* ---------------------------- sticker library --------------------------- */

/** Keep the collected sticker library bounded. */
const MAX_STICKERS = 300;

export function hasSticker(id: string): boolean {
  return id in store.stickers;
}
export function addSticker(id: string, meta: StickerMeta): void {
  store.stickers[id] = meta;
  const ids = Object.keys(store.stickers);
  if (ids.length > MAX_STICKERS) {
    // drop the oldest by timestamp
    ids.sort((a, b) => store.stickers[a].at - store.stickers[b].at);
    delete store.stickers[ids[0]];
  }
  scheduleSave();
}
export function removeSticker(id: string): void {
  delete store.stickers[id];
  scheduleSave();
}
/** Set the mood tags on an already-saved sticker. Returns false if unknown. */
export function setStickerTags(id: string, tags: string[]): boolean {
  const s = store.stickers[id];
  if (!s) return false;
  s.tags = tags;
  if (!s.desc && tags.length) s.desc = tags.join(', ');
  s.at = Date.now();
  scheduleSave();
  return true;
}
/** Stickers that have no mood tags yet (need curating). */
export function untaggedStickers(): string[] {
  return Object.entries(store.stickers).filter(([, m]) => !m.tags?.length).map(([id]) => id);
}
export function listStickers(): { id: string; desc: string; tags: string[] }[] {
  return Object.entries(store.stickers).map(([id, m]) => ({ id, desc: m.desc, tags: m.tags }));
}

/* ------------------------- long-term memory (facts) --------------------- */

/** Max facts kept per person/group before the oldest is dropped. */
const MAX_MEMORIES = 40;
const memKey = (chat: string, subject: string) => `${chat}::${subject}`;

/** Remember a durable fact about a person (subject = number) or a group
 *  (subject = "group"). De-duplicates near-identical facts. */
export function addMemory(chat: string, subject: string, fact: string): void {
  const clean = fact.trim();
  if (!clean) return;
  const k = memKey(chat, subject);
  const arr = (store.memories[k] ??= []);
  const norm = clean.toLowerCase();
  if (arr.some((m) => m.fact.toLowerCase() === norm)) return; // already known
  arr.push({ fact: clean, at: Date.now() });
  while (arr.length > MAX_MEMORIES) arr.shift();
  scheduleSave();
}
export function listMemories(chat: string, subject: string): MemoryNote[] {
  return [...(store.memories[memKey(chat, subject)] ?? [])];
}

/**
 * Everything remembered about ONE PERSON, from every chat they've appeared in.
 *
 * Memories are stored per chat:person, so the same human met in a group and in
 * a DM would otherwise look like two strangers. WhatsApp gives each person a
 * stable id, so we can gather their facts across chats and recognise them
 * anywhere. Newest first; `exceptChat` skips the chat we're already showing.
 */
export function listPersonMemories(subject: string, exceptChat?: string): { fact: string; at: number; chat: string }[] {
  const out: { fact: string; at: number; chat: string }[] = [];
  const suffix = `::${subject}`;
  for (const [k, notes] of Object.entries(store.memories)) {
    if (!k.endsWith(suffix)) continue;
    const chat = k.slice(0, -suffix.length);
    if (exceptChat && chat === exceptChat) continue;
    for (const n of notes) out.push({ fact: n.fact, at: n.at, chat });
  }
  return out.sort((a, b) => b.at - a.at);
}
export function forgetMemories(chat: string, subject: string): number {
  const k = memKey(chat, subject);
  const n = store.memories[k]?.length ?? 0;
  if (n) {
    delete store.memories[k];
    scheduleSave();
  }
  return n;
}

/* ------------------------------- contacts ------------------------------- */

/** Record/refresh a contact's known names. Only real phone-number contacts
 *  (@s.whatsapp.net) are stored — never groups, broadcast, or LID-only ids — so
 *  the list always maps to an actual number. */
export function upsertContact(jid: string, info: { name?: string; notify?: string }): void {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return;
  const name = info.name?.trim();
  const notify = info.notify?.trim();
  if (!name && !notify && !store.contacts[jid]) return; // nothing to store
  const cur = (store.contacts[jid] ??= { at: Date.now() });
  if (name) cur.name = name;
  if (notify) cur.notify = notify;
  cur.at = Date.now();
  scheduleSave();
}

export function listContacts(): { jid: string; name?: string; notify?: string }[] {
  return Object.entries(store.contacts).map(([jid, c]) => ({ jid, name: c.name, notify: c.notify }));
}

/**
 * Auto-learn a contact from a DM: adopt their WhatsApp name as the saved NAME so
 * they become a first-class contact (resolvable + shown as saved) WITHOUT the
 * owner adding them by hand — the "save them automatically" behaviour. If the
 * owner already set a custom name (via .addcontact), we keep it and only refresh
 * the push name. Only real phone-number jids are stored. */
export function learnContact(jid: string, pushName: string): void {
  const name = pushName.trim();
  if (!jid || !name) return;
  // Accept real phone-number JIDs AND WhatsApp's newer hidden @lid DM ids — many
  // DM senders now arrive as @lid, and rejecting those meant they were never
  // saved (the "auto-save isn't working" bug). Groups/broadcast are still skipped.
  if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) {
    logger.debug({ jid }, 'learnContact: skipped non-DM jid');
    return;
  }
  const cur = store.contacts[jid];
  if (cur?.name) {
    // Keep the owner's chosen name; just keep the push name fresh.
    if (cur.notify !== name) {
      cur.notify = name;
      cur.at = Date.now();
      scheduleSave();
    }
    return;
  }
  store.contacts[jid] = { ...(cur ?? {}), name, notify: name, at: Date.now() };
  logger.info({ jid, name }, 'learnContact: auto-saved a DM contact');
  scheduleSave();
}

export function removeContact(jid: string): boolean {
  if (store.contacts[jid]) {
    delete store.contacts[jid];
    scheduleSave();
    return true;
  }
  return false;
}

/** Wipe the entire learned contact directory. Returns how many were removed. */
export function clearContacts(): number {
  const n = Object.keys(store.contacts).length;
  store.contacts = {};
  scheduleSave();
  return n;
}
