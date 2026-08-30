import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { inspect } from 'node:util';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import axios from 'axios';
import { panel } from '../core/ui.js';
import { command } from '../core/registry.js';
import { config } from '../config.js';
import { getSetting, setSetting, deleteSetting } from '../db/index.js';
import { logger } from '../logger.js';
const run = promisify(exec);
const require = createRequire(import.meta.url);
const EXEC_OPTS = { timeout: 60_000, maxBuffer: 1024 * 1024 };
function isStrictOwner(m) {
    return m.fromMe || config.owners.includes(m.senderNumber);
}
const devOn = () => getSetting('devmode') === 'on';
function term(promptCmd, output) {
    const max = 3500;
    const body = output.length > max ? `${output.slice(0, max)}\n… (truncated)` : output;
    return '```\n' + `┌─[nexus@shell]\n└─$ ${promptCmd}\n\n${body || '(no output)'}` + '\n```';
}
function normalizeCode(s) {
    return s
        .replace(/[“”„‟]/g, '"')
        .replace(/[‘’‚‛]/g, "'")
        .replace(/[–—]/g, '-')
        .replace(/ /g, ' ');
}
function devMenu() {
    const p = config.prefixes[0] ?? '.';
    return panel({
        name: 'Developer',
        rows: [
            ['🛠️', 'mode', 'developer'],
            ['⚠️', 'access', 'full shell on the host'],
        ],
        sections: [
            {
                name: 'commands',
                items: [
                    `${p}code <task>. Nexus edits its own code (with approval)`,
                    `${p}js <code>. Run JavaScript`,
                    `${p}sh <cmd>. Run a shell command`,
                    `${p}py <code>. Run Python`,
                    `${p}java <code>. Compile & run Java`,
                    `${p}dev off. Exit developer mode`,
                ],
            },
        ],
        tips: [`${p}dev off`],
    });
}
async function guard(m) {
    if (!isStrictOwner(m)) {
        await m.reply('🔒 Developer mode is owner-only.');
        return false;
    }
    if (!devOn()) {
        await m.reply('🛠️ Developer mode is off. Arm it first with .dev on.');
        return false;
    }
    return true;
}
const AsyncFunction = Object.getPrototypeOf(async () => { }).constructor;
command({ pattern: 'dev(?: (on|off))?', desc: 'Toggle developer mode', usage: 'on|off', category: 'developer', fromMe: true, hidden: true }, async (m, match) => {
    if (!isStrictOwner(m))
        return m.reply('🔒 Developer mode is owner-only.');
    const v = match?.[1]?.trim().toLowerCase();
    if (v === 'on') {
        setSetting('devmode', 'on');
        return m.reply(devMenu());
    }
    if (v === 'off') {
        deleteSetting('devmode');
        return m.reply('🛠️ Developer mode: OFF. See you in the shadows 🫡');
    }
    return devOn()
        ? m.reply(devMenu())
        : m.reply('🛠️ Developer mode is OFF. Arm it with .dev on to unlock the console.');
});
command({ pattern: 'js (.+)', desc: 'Run JavaScript on the bot', usage: '<code>', category: 'developer', fromMe: true, hidden: true }, async (m, match) => {
    if (!(await guard(m)))
        return;
    const code = normalizeCode(match?.[1] ?? '');
    const t0 = Date.now();
    const logs = [];
    const con = {
        log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 2 }))).join(' ')),
        error: (...a) => logs.push(a.map(String).join(' ')),
    };
    try {
        let fn;
        try {
            fn = new AsyncFunction('m', 'sock', 'require', 'console', `return (${code})`);
        }
        catch {
            fn = new AsyncFunction('m', 'sock', 'require', 'console', code);
        }
        const result = await fn(m, m.client, require, con);
        const rendered = result === undefined ? '' : inspect(result, { depth: 2 });
        const out = [logs.join('\n'), rendered].filter(Boolean).join('\n');
        await m.reply(term('js', `${out}\n\n[ok • ${Date.now() - t0}ms]`));
    }
    catch (err) {
        const e = err;
        await m.reply(term('js', `❌ ${e.stack ?? e.message ?? String(err)}`));
    }
});
command({ pattern: 'sh (.+)', desc: 'Run a shell command', usage: '<command>', category: 'developer', fromMe: true, hidden: true }, async (m, match) => {
    if (!(await guard(m)))
        return;
    const cmd = normalizeCode(match?.[1] ?? '');
    try {
        const { stdout, stderr } = await run(cmd, EXEC_OPTS);
        await m.reply(term(cmd, `${stdout}${stderr}`.trim()));
    }
    catch (err) {
        const e = err;
        await m.reply(term(cmd, `${e.stdout ?? ''}${e.stderr ?? ''}\n❌ ${e.message ?? ''}`.trim()));
    }
});
command({ pattern: 'py (.+)', desc: 'Run Python code', usage: '<code>', category: 'developer', fromMe: true, hidden: true }, async (m, match) => {
    if (!(await guard(m)))
        return;
    const code = normalizeCode(match?.[1] ?? '');
    const dir = await mkdtemp(join(tmpdir(), 'nexus-py-'));
    try {
        const file = join(dir, 'script.py');
        await writeFile(file, code);
        const { stdout, stderr } = await run(`python3 ${file}`, EXEC_OPTS);
        await m.reply(term('python3', `${stdout}${stderr}`.trim()));
    }
    catch (err) {
        const e = err;
        await m.reply(term('python3', `${e.stdout ?? ''}${e.stderr ?? ''}\n❌ ${e.message ?? ''}`.trim()));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
command({ pattern: 'java (.+)', desc: 'Compile & run Java code', usage: '<code>', category: 'developer', fromMe: true, hidden: true }, async (m, match) => {
    if (!(await guard(m)))
        return;
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
    }
    catch (err) {
        const e = err;
        await m.reply(term('java', `${e.stdout ?? ''}${e.stderr ?? ''}\n❌ ${e.message ?? ''}`.trim()));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
const CODE_SYSTEM = 'You are an expert software engineer. Write clean, correct, production-quality code for the user\'s request. ' +
    'Respond with ONLY the code inside a single fenced code block. No explanation before or after. ' +
    'Include concise, helpful comments explaining the key parts. Choose a sensible language if none is specified.';
command({ pattern: 'codegen (.+)', desc: 'Generate code snippet with AI (reply only)', usage: '<what to build>', category: 'developer', fromMe: true, hidden: true }, async (m, match) => {
    if (!(await guard(m)))
        return;
    if (!config.nexus.key)
        return m.reply('Set NEXUS_API_KEY in .env to use .codegen');
    const request = match?.[1] ?? '';
    try {
        await m.react('🧠');
        const res = await axios.post(config.nexus.url, {
            model: config.nexus.codeModel,
            max_tokens: 2048,
            messages: [
                { role: 'system', content: CODE_SYSTEM },
                { role: 'user', content: request },
            ],
        }, { headers: { Authorization: `Bearer ${config.nexus.key}`, 'content-type': 'application/json' }, timeout: 90_000 });
        const code = (res.data.choices?.[0]?.message?.content ?? '').trim() || 'No code generated.';
        await m.reply(code);
        await m.react('✅');
    }
    catch (err) {
        logger.error({ err }, 'code generation failed');
        const e = err;
        await m.reply(`❌ Code gen failed: ${e.response?.data?.error?.message ?? e.message ?? 'unknown error'}`);
    }
});
logger.debug('developer mode plugin loaded');
