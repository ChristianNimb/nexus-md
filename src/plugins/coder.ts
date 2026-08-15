import axios from 'axios';
import ts from 'typescript';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logger } from '../logger.js';
import { command } from '../core/registry.js';
import { getSetting } from '../db/index.js';
import type { Message } from '../core/message.js';

/**
 * 🧠 Nexus's built-in CODING AGENT (owner-only). Nexus can extend or fix its OWN
 * code from WhatsApp — but NEVER auto-applies. Flow:
 *
 *   .code <what you want>   → the agent drafts the change, syntax-checks it, and
 *                             shows you a summary + preview (staged, not live).
 *   .code approve           → back up the originals and apply the change.
 *   .code reject            → throw the draft away.
 *   .code revert            → restore the last applied change from backup.
 *   .code status            → show what's currently staged.
 *
 * SAFETY: only files under src/ ending in .ts can be written (never package.json,
 * Dockerfile, .env, secrets); every apply is backed up first; and because plugins
 * are isolated (the loader catches a bad one), a broken generated command can't
 * take the whole bot down. After approving, restart Nexus to load the change.
 */

// ---- coding model (separate from chat; Claude / GPT-4 class recommended) ----
const CODER_URL = process.env.NEXUS_CODER_URL || 'https://api.anthropic.com/v1/messages';
const CODER_KEY = process.env.NEXUS_CODER_KEY || '';
const CODER_MODEL = process.env.NEXUS_CODER_MODEL || 'claude-sonnet-5';
const isAnthropic = /anthropic\.com/i.test(CODER_URL);

const REPO = process.cwd(); // /app inside Docker
const SRC = join(REPO, 'src');
const BACKUP_ROOT = join(REPO, 'data', 'code-backups');

interface StagedFile {
  path: string; // repo-relative, e.g. "src/plugins/foo.ts"
  content: string;
}
let staged: { task: string; summary: string; files: StagedFile[]; at: number } | undefined;
let lastBackup: { dir: string; files: { path: string; existed: boolean }[] } | undefined;

/** Route the coder's API call through NEXUS_PROXY when set (needed in China). */
function proxyOpt(): Record<string, unknown> {
  const p =
    process.env.NEXUS_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!p) return {};
  try {
    const u = new URL(p);
    if (/^socks/i.test(u.protocol)) return {}; // axios can't do SOCKS natively
    return { proxy: { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') } };
  } catch {
    return {};
  }
}

/** A compact, accurate guide so the model writes code that fits this codebase. */
const API_GUIDE = `You are editing the "Nexus-MD" WhatsApp bot — a TypeScript project run with tsx (ESM).
KEY RULES:
- Plugins live in src/plugins/*.ts and are auto-loaded. Adding a NEW command = a new self-contained plugin file (safest).
- Register commands with: import { command } from '../core/registry.js';
    command({ pattern: 'name (.+)', desc: 'what it does', category: 'tools' }, async (m, match) => { await m.reply('hi'); });
  • pattern is a regex WITHOUT the prefix (the "." is added automatically). Capture args with (.*) → match[1].
  • add fromMe: true to make it owner-only.
- The Message object 'm' provides: m.reply(text), m.send(content, { quoted: m.raw }), m.react('👍'),
  m.body (text), m.chat, m.sender, m.senderNumber, m.isGroup, m.isOwner, m.isRealOwner, m.quoted (replied msg).
- ALL local imports MUST use a .js extension (ESM), e.g. import { logger } from '../logger.js';
- Use only dependencies already in the project (axios is available). Do NOT add new npm packages.
- Keep handlers in try/catch; reply with a friendly error on failure.
OUTPUT FORMAT: respond with ONLY a JSON object, no prose, no markdown fences:
{"summary":"one or two sentences on what you changed and why","files":[{"path":"src/plugins/foo.ts","content":"<FULL file content>"}]}
Provide the COMPLETE new content for each file (not a diff). Only touch files under src/ ending in .ts.`;

async function callCoder(user: string): Promise<string> {
  const cfg = proxyOpt();
  if (isAnthropic) {
    const r = await axios.post(
      CODER_URL,
      { model: CODER_MODEL, max_tokens: 16000, system: API_GUIDE, messages: [{ role: 'user', content: user }] },
      { headers: { 'x-api-key': CODER_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 180_000, ...cfg },
    );
    return (r.data?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('');
  }
  const r = await axios.post(
    CODER_URL,
    { model: CODER_MODEL, max_tokens: 16000, messages: [{ role: 'system', content: API_GUIDE }, { role: 'user', content: user }] },
    { headers: { authorization: `Bearer ${CODER_KEY}`, 'content-type': 'application/json' }, timeout: 180_000, ...cfg },
  );
  return r.data?.choices?.[0]?.message?.content ?? '';
}

/** Pull the JSON object out of the model reply (tolerates ```fences``` / prose). */
function extractJson(raw: string): { summary: string; files: StagedFile[] } {
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('model did not return JSON');
  s = s.slice(first, last + 1);
  const obj = JSON.parse(s) as { summary?: string; files?: StagedFile[] };
  if (!obj.files?.length) throw new Error('no files in model output');
  return { summary: obj.summary ?? '(no summary)', files: obj.files };
}

/** Guard: a path must live under src/, end in .ts, and not escape the tree. */
function safePath(p: string): string | undefined {
  const abs = resolve(REPO, p);
  if (!abs.startsWith(SRC + '/') && abs !== SRC) return undefined;
  if (!abs.endsWith('.ts')) return undefined;
  return abs;
}

/** Syntax-check TS source (catches the most common breakage before applying). */
function syntaxOk(content: string): string | null {
  const out = ts.transpileModule(content, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  const errs = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (!errs.length) return null;
  return errs.slice(0, 3).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ');
}

/** Read files referenced in the task so the model can edit them accurately. */
async function gatherContext(task: string): Promise<string> {
  const paths = task.match(/src\/[\w/.-]+\.ts/g) ?? [];
  const parts: string[] = [];
  for (const p of [...new Set(paths)].slice(0, 3)) {
    const abs = safePath(p);
    if (abs && existsSync(abs)) {
      try {
        parts.push(`--- current content of ${p} ---\n${(await readFile(abs, 'utf8')).slice(0, 12_000)}`);
      } catch {
        /* ignore */
      }
    }
  }
  return parts.join('\n\n');
}

async function generate(m: Message, task: string): Promise<void> {
  if (!CODER_KEY) {
    await m.reply('🧠 My coding brain isn\'t configured yet. Set *NEXUS_CODER_KEY* (and NEXUS_CODER_URL / NEXUS_CODER_MODEL) in .env, then restart me.');
    return;
  }
  await m.react('🧠');
  await m.reply(`🛠️ Working on it: _${task}_\nGive me a moment to write and check the code…`);
  try {
    const ctx = await gatherContext(task);
    const prompt = `${ctx ? ctx + '\n\n' : ''}TASK: ${task}\n\nWrite the code. Prefer a NEW plugin file for a new command. Return the JSON described in your instructions.`;
    const reply = await callCoder(prompt);
    const { summary, files } = extractJson(reply);

    // Validate paths + syntax.
    const problems: string[] = [];
    for (const f of files) {
      if (!safePath(f.path)) problems.push(`✋ refused to write outside src/*.ts: ${f.path}`);
      else {
        const err = syntaxOk(f.content);
        if (err) problems.push(`⚠️ syntax issue in ${f.path}: ${err}`);
      }
    }
    staged = { task, summary, files, at: Date.now() };

    const list = files.map((f) => `• \`${f.path}\` (${f.content.split('\n').length} lines)`).join('\n');
    const preview = files[0].content.slice(0, 700);
    let msg = `🧠 *Draft ready.*\n\n*What I'll change:* ${summary}\n\n*Files:*\n${list}\n\n*Preview (${files[0].path}):*\n\`\`\`\n${preview}${files[0].content.length > 700 ? '\n…' : ''}\n\`\`\``;
    if (problems.length) msg += `\n\n${problems.join('\n')}\n\n(You can still approve, but I'd fix these first — try rephrasing.)`;
    msg += `\n\nReply *.code approve* to apply (I'll back up the originals), or *.code reject* to discard.`;
    await m.reply(msg);
  } catch (err) {
    logger.error({ err }, 'coder generate failed');
    staged = undefined;
    await m.reply(`❌ Couldn't draft that: ${(err as Error).message}. ${isAnthropic ? '' : ''}If your coder model is Claude/GPT (blocked in China), make sure NEXUS_PROXY is set.`);
  }
}

async function apply(m: Message): Promise<void> {
  if (!staged) return void m.reply('Nothing staged. Use *.code <what you want>* first.');
  const dir = join(BACKUP_ROOT, String(staged.at));
  await mkdir(dir, { recursive: true });
  const backedUp: { path: string; existed: boolean }[] = [];
  try {
    for (const f of staged.files) {
      const abs = safePath(f.path);
      if (!abs) throw new Error(`unsafe path ${f.path}`);
      const existed = existsSync(abs);
      if (existed) await copyFile(abs, join(dir, f.path.replace(/\//g, '__')));
      backedUp.push({ path: f.path, existed });
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, f.content, 'utf8');
    }
    lastBackup = { dir, files: backedUp };
    const applied = staged.files.map((f) => `• \`${f.path}\``).join('\n');
    staged = undefined;
    await m.reply(`✅ Applied:\n${applied}\n\nNow restart me to load it:\n\`docker compose restart nexus\`\n\nIf anything misbehaves, run *.code revert* to roll it back.`);
  } catch (err) {
    logger.error({ err }, 'coder apply failed');
    await m.reply(`❌ Apply failed: ${(err as Error).message}. Nothing was half-written that a *.code revert* can't undo.`);
  }
}

async function revert(m: Message): Promise<void> {
  if (!lastBackup) return void m.reply('No applied change to revert.');
  try {
    const { unlink } = await import('node:fs/promises');
    for (const f of lastBackup.files) {
      const abs = safePath(f.path);
      if (!abs) continue;
      if (f.existed) {
        await copyFile(join(lastBackup.dir, f.path.replace(/\//g, '__')), abs);
      } else if (existsSync(abs)) {
        await unlink(abs); // it was newly created — remove it
      }
    }
    const files = lastBackup.files.map((f) => `• \`${f.path}\``).join('\n');
    lastBackup = undefined;
    await m.reply(`↩️ Reverted:\n${files}\n\nRestart me to load the rollback: \`docker compose restart nexus\``);
  } catch (err) {
    logger.error({ err }, 'coder revert failed');
    await m.reply(`❌ Revert failed: ${(err as Error).message}. Backups are in data/code-backups/.`);
  }
}

command(
  { pattern: 'code ?(.*)', fromMe: true, desc: 'Nexus edits its own code (developer mode, with approval)', usage: '<request | approve | reject | revert | status>', category: 'developer', hidden: true },
  async (m, match) => {
    if (!m.isRealOwner) return m.reply('🔒 Only my owner can touch my code.');
    if (getSetting('devmode') !== 'on') return m.reply('🛠️ The coding agent lives in *developer mode*. Arm it first with *.dev on*.');
    const arg = (match?.[1] ?? '').trim();
    const sub = arg.toLowerCase();

    if (sub === 'approve' || sub === 'apply' || sub === 'yes') return void (await apply(m));
    if (sub === 'reject' || sub === 'no' || sub === 'cancel') {
      staged = undefined;
      return m.reply('🗑️ Draft discarded.');
    }
    if (sub === 'revert' || sub === 'rollback' || sub === 'undo') return void (await revert(m));
    if (sub === 'status' || sub === '') {
      if (!staged) return m.reply('🧠 Nothing staged. Use *.code <what you want>* — e.g. *.code add a .flip command that replies heads or tails*.');
      const list = staged.files.map((f) => `• \`${f.path}\``).join('\n');
      return m.reply(`🧠 *Staged:* ${staged.summary}\n${list}\n\n*.code approve* to apply · *.code reject* to discard.`);
    }
    return void (await generate(m, arg));
  },
);

logger.debug('coder plugin loaded');
