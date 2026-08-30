import os from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, commands, commandName } from '../core/registry.js';
import { config } from '../config.js';
import { botMode, setBotMode } from '../core/mode.js';
import { downCommands } from '../core/health.js';
import { panel } from '../core/ui.js';
const startedAt = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLUGIN_COUNT = (() => {
    try {
        return readdirSync(dirname(fileURLToPath(import.meta.url))).filter((f) => /\.(ts|js)$/.test(f)).length;
    }
    catch {
        return 0;
    }
})();
const VERSION = (() => {
    try {
        return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version ?? '0.1.0';
    }
    catch {
        return '0.1.0';
    }
})();
function hostLabel() {
    return process.env['NEXUS_HOST_PLATFORM']?.trim() || os.platform();
}
function humanUptime(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${sec}s`].filter(Boolean).join(' ');
}
const CATEGORY_ICON = {
    system: '⚙️',
    owner: '👑',
    group: '👥',
    moderation: '🛡️',
    automation: '🤖',
    media: '🎨',
    ai: '🧠',
    fun: '✨',
    tools: '🔧',
    utility: '🧩',
    developer: '🛠️',
    general: '📌',
};
function visibleCommands() {
    return commands.filter((c) => c.pattern && !c.hidden);
}
command({ pattern: 'ping', desc: 'Check bot responsiveness', category: 'system' }, async (m) => {
    const t = Date.now();
    const sent = await m.reply('🏓 pinging...');
    const ms = Date.now() - t;
    await m.client.sendMessage(m.chat, { text: `🏓 Pong!  \`${ms}ms\``, edit: sent?.key });
});
command({ pattern: 'health', desc: 'Show which commands are failing', category: 'system' }, async (m) => {
    const down = downCommands();
    if (!down.length)
        return m.reply('✅ All good. No commands are failing right now.');
    const ago = (t) => {
        const s = Math.floor((Date.now() - t) / 1000);
        if (s < 60)
            return `${s}s ago`;
        if (s < 3600)
            return `${Math.floor(s / 60)}m ago`;
        return `${Math.floor(s / 3600)}h ago`;
    };
    const list = down.map((d) => `• .${d.name}. ${d.error || 'error'} _(${ago(d.at)})_`).join('\n');
    return m.reply(`⚠️ Commands currently failing:\n${list}`);
});
command({ pattern: 'alive', desc: 'Show bot status', category: 'system' }, async (m) => {
    const cpuStart = process.cpuUsage();
    const t0 = Date.now();
    await sleep(120);
    const diff = process.cpuUsage(cpuStart);
    const micros = (Date.now() - t0) * 1000;
    const cpu = Math.max(0, Math.min(100, Math.round(((diff.user + diff.system) / micros) * 100)));
    const mem = process.memoryUsage();
    const rss = `${(mem.rss / 1024 / 1024).toFixed(0)}MB`;
    const heap = `${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`;
    const ramPct = ((mem.rss / os.totalmem()) * 100).toFixed(1);
    const owner = config.ownerName || m.selfName || config.botName;
    const prefix = config.prefixes[0] ?? '.';
    await m.reply(panel({
        name: config.botName,
        rows: [
            ['🟢', 'status', 'online'],
            ['👑', 'owner', owner],
            ['👤', 'user', m.pushName || 'there'],
            ['⏱️', 'uptime', humanUptime(Date.now() - startedAt)],
            ['⚙️', 'mode', botMode()],
            ['📜', 'commands', String(visibleCommands().length)],
            ['🔌', 'plugins', String(PLUGIN_COUNT)],
            ['💾', 'ram', `${rss} (${ramPct}%)`],
            ['📈', 'cpu', `${cpu}% • heap ${heap}`],
            ['🖥️', 'host', hostLabel()],
            ['🏷️', 'version', `v${VERSION}`],
        ],
        tips: [`${prefix}menu`],
    }));
});
command({ pattern: 'help ?(.*)', desc: 'Details about a command', usage: '<command>', category: 'system' }, async (m, match) => {
    const prefix = config.prefixes[0] ?? '';
    const query = match?.[1]?.trim();
    if (!query)
        return m.usage();
    const found = commands.find((c) => c.pattern && commandName(c.pattern) === query);
    if (!found)
        return m.reply(`no command called "${query}"
hint: ${prefix}menu`);
    const name = commandName(found.pattern);
    const icon = CATEGORY_ICON[found.category ?? 'general'] ?? '•';
    await m.reply(panel({
        name: `${prefix}${name}`,
        rows: [
            [icon, 'category', found.category ?? 'general'],
            ['📝', 'about', found.desc || 'No description.'],
            ...(found.usage ? [['💡', 'usage', `${prefix}${name} ${found.usage}`]] : []),
            ['🔒', 'owner', found.fromMe ? 'yes' : 'no'],
        ],
    }));
});
const PUBLIC_MSG = '🌍 Public mode ON. Anyone can use the bot now.';
const PRIVATE_MSG = '🔒 Private mode ON. Only you (owner/sudo) can use the bot.';
command({ pattern: 'mode(?: (public|private))?', desc: 'Show or switch public/private mode', usage: '[public | private]', category: 'owner', fromMe: true }, async (m, match) => {
    const arg = match?.[1]?.trim().toLowerCase();
    if (arg === 'public') {
        setBotMode('public');
        return m.reply(PUBLIC_MSG);
    }
    if (arg === 'private') {
        setBotMode('private');
        return m.reply(PRIVATE_MSG);
    }
    return m.reply(`⚙️ Current mode: ${botMode()}\n\nSwitch with .mode public or .mode private.`);
});
command({ pattern: 'public', desc: 'Switch the bot to public', category: 'owner', fromMe: true, hidden: true }, async (m) => {
    setBotMode('public');
    return m.reply(PUBLIC_MSG);
});
command({ pattern: 'private', desc: 'Switch the bot to private', category: 'owner', fromMe: true, hidden: true }, async (m) => {
    setBotMode('private');
    return m.reply(PRIVATE_MSG);
});
