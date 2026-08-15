import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { inspect } from 'node:util';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import axios from 'axios';
import { command } from '../core/registry.js';
import { config } from '../config.js';
import { getSetting, setSetting, deleteSetting } from '../db/index.js';
import { logger } from '../logger.js';
import type { Message } from '../core/message.js';

/**
 * Developer mode — an owner-only console for running code on the bot's own host.
 *
 * SECURITY: this is full control of the machine the bot runs on. It is locked to
 * the OWNER (linked account / OWNERS in .env — NOT sudo), and must be explicitly
 * armed with `.dev on`. It runs on your OWN self-hosted instance; nothing is
 * hidden or remote-controlled by anyone else.
 */

const run = promisify(exec);
const require = createRequire(import.meta.url);
const EXEC_OPTS = { timeout: 60_000, maxBuffer: 1024 * 1024 } as const;

/** Strict owner: the linked account or a number in OWNERS — sudo does NOT count. */
function isStrictOwner(m: Message): boolean {
  return m.fromMe || config.owners.includes(m.senderNumber);
}
const devOn = () => getSetting('devmode') === 'on';

/** Format output as a branded terminal block. */
function term(promptCmd: string, output: string): string {
  const max = 3500;
  const body = output.length > max ? `${output.slice(0, max)}\n… (truncated)` : output;
  return '```\n' + `┌─[nexus@shell]\n└─$ ${promptCmd}\n\n${body || '(no output)'}` + '\n```';
}

/** WhatsApp/iOS turns quotes into “smart” ones which break code — undo that. */
function normalizeCode(s: string): string {
  return s
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ');
}

/** The hidden developer command list, shown when you arm dev mode. */
function devMenu(): string {
  const p = config.prefixes[0] ?? '.';
  return (
    `🛠️ *You are now in DEVELOPER MODE* 👨‍💻\n` +
    `Full shell access to the host — use responsibly.\n\n` +
    `╭─ 🛠️ *DEVELOPER*\n` +
    `│ ▸ ${p}code <task>  — Nexus edits its own code (with approval)\n` +
    `│ ▸ ${p}js <code>    — run JavaScript\n` +
    `│ ▸ ${p}sh <cmd>     — run a shell command\n` +
    `│ ▸ ${p}py <code>    — run Python\n` +
    `│ ▸ ${p}java <code>  — compile & run Java\n` +
    `│ ▸ ${p}dev off       — exit developer mode\n` +
    `╰────────────`
  );
}

/** Guard: allow only when strict-owner AND dev mode is on. Replies otherwise. */
async function guard(m: Message): Promise<boolean> {
  if (!isStrictOwner(m)) {
    await m.reply('🔒 Developer mode is owner-only.');
    return false;
  }
  if (!devOn()) {
    await m.reply('🛠️ Developer mode is off. Arm it first with *.dev on*.');
    return false;
  }
  return true;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

command(
  { pattern: 'dev ?(.*)', desc: 'Toggle developer mode', usage: 'on|off', category: 'developer', fromMe: true, hidden: true },
  async (m, match) => {
    if (!isStrictOwner(m)) return m.reply('🔒 Developer mode is owner-only.');
    const v = match?.[1]?.trim().toLowerCase();
    if (v === 'on') {
      setSetting('devmode', 'on');
      return m.reply(devMenu());
    }
    if (v === 'off') {
      deleteSetting('devmode');
      return m.reply('🛠️ Developer mode: OFF. See you in the shadows 🫡');
    }
    // No arg: show the dev menu if armed, otherwise how to arm it.
    return devOn()
      ? m.reply(devMenu())
      : m.reply('🛠️ Developer mode is *OFF*. Arm it with *.dev on* to unlock the console.');
  },
);

/* -------------------------------- JavaScript ------------------------------- */

command(
  { pattern: 'js (.+)', desc: 'Run JavaScript on the bot', usage: '<code>', category: 'developer', fromMe: true, hidden: true },
  async (m, match) => {
    if (!(await guard(m))) return;
    const code = normalizeCode(match?.[1] ?? '');
    const t0 = Date.now();
    const logs: string[] = [];
    const con = {
      log: (...a: unknown[]) => logs.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 2 }))).join(' ')),
      error: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
    };
    try {
      let fn: (...a: unknown[]) => Promise<unknown>;
      try {
        fn = new AsyncFunction('m', 'sock', 'require', 'console', `return (${code})`);
      } catch {
        fn = new AsyncFunction('m', 'sock', 'require', 'console', code);
      }
      const result = await fn(m, m.client, require, con);
      const rendered = result === undefined ? '' : inspect(result, { depth: 2 });
      const out = [logs.join('\n'), rendered].filter(Boolean).join('\n');
      await m.reply(term('js', `${out}\n\n[ok • ${Date.now() - t0}ms]`));
    } catch (err) {
      const e = err as Error;
      await m.reply(term('js', `❌ ${e.stack ?? e.message ?? String(err)}`));
    }
  },
);

/* ---------------------------------- Shell ---------------------------------- */

command(
  { pattern: 'sh (.+)', desc: 'Run a shell command', usage: '<command>', category: 'developer', fromMe: true, hidden: true },
  async (m, match) => {
    if (!(await guard(m))) return;
    const cmd = normalizeCode(match?.[1] ?? '');
    try {
      const { stdout, stderr } = await run(cmd, EXEC_OPTS);
      await m.reply(term(cmd, `${stdout}${stderr}`.trim()));
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      await m.reply(term(cmd, `${e.stdout ?? ''}${e.stderr ?? ''}\n❌ ${e.message ?? ''}`.trim()));
    }
  },
);

/* --------------------------------- Python ---------------------------------- */

command(
  { pattern: 'py (.+)', desc: 'Run Python code', usage: '<code>', category: 'developer', fromMe: true, hidden: true },
  async (m, match) => {
    if (!(await guard(m))) return;
    const code = normalizeCode(match?.[1] ?? '');
    const dir = await mkdtemp(join(tmpdir(), 'nexus-py-'));
    try {
      const file = join(dir, 'script.py');
      await writeFile(file, code);
      const { stdout, stderr } = await run(`python3 ${file}`, EXEC_OPTS);
      await m.reply(term('python3', `${stdout}${stderr}`.trim()));
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      await m.reply(term('python3', `${e.stdout ?? ''}${e.stderr ?? ''}\n❌ ${e.message ?? ''}`.trim()));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

/* ---------------------------------- Java ----------------------------------- */

command(
  { pattern: 'java (.+)', desc: 'Compile & run Java code', usage: '<code>', category: 'developer', fromMe: true, hidden: true },
  async (m, match) => {
    if (!(await guard(m))) return;
    const raw = normalizeCode(match?.[1] ?? '');
    const classMatch = raw.match(/\bclass\s+(\w+)/);
    const className = classMatch?.[1] ?? 'Main';
    const source = classMatch
      ? raw
      : `public class Main { public static void main(String[] args) throws Exception { ${raw} } }`;
    const dir = await mkdtemp(join(tmpdir(), 'nexus-java-'));
    try {
      await writeFile(join(dir, `${className}.java`), source);
      await run(`javac ${className}.java`, { ...EXEC_OPTS, cwd: dir });
      const { stdout, stderr } = await run(`java ${className}`, { ...EXEC_OPTS, cwd: dir });
      await m.reply(term('java', `${stdout}${stderr}`.trim()));
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      await m.reply(term('java', `${e.stdout ?? ''}${e.stderr ?? ''}\n❌ ${e.message ?? ''}`.trim()));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

/* --------------------------- AI code generation ---------------------------- */

const CODE_SYSTEM =
  'You are an expert software engineer. Write clean, correct, production-quality code for the user\'s request. ' +
  'Respond with ONLY the code inside a single fenced code block — no explanation before or after. ' +
  'Include concise, helpful comments explaining the key parts. Choose a sensible language if none is specified.';

command(
  { pattern: 'codegen (.+)', desc: 'Generate code snippet with AI (reply only)', usage: '<what to build>', category: 'developer', fromMe: true, hidden: true },
  async (m, match) => {
    if (!(await guard(m))) return;
    if (!config.nexus.key) return m.reply('Set NEXUS_API_KEY in .env to use .codegen');
    const request = match?.[1] ?? '';
    try {
      await m.react('🧠');
      const res = await axios.post<{ choices?: { message?: { content?: string } }[] }>(
        config.nexus.url,
        {
          model: config.nexus.codeModel,
          max_tokens: 2048,
          messages: [
            { role: 'system', content: CODE_SYSTEM },
            { role: 'user', content: request },
          ],
        },
        { headers: { Authorization: `Bearer ${config.nexus.key}`, 'content-type': 'application/json' }, timeout: 90_000 },
      );
      const code = (res.data.choices?.[0]?.message?.content ?? '').trim() || 'No code generated.';
      await m.reply(code);
      await m.react('✅');
    } catch (err) {
      logger.error({ err }, 'code generation failed');
      const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
      await m.reply(`❌ Code gen failed: ${e.response?.data?.error?.message ?? e.message ?? 'unknown error'}`);
    }
  },
);

logger.debug('developer mode plugin loaded');
