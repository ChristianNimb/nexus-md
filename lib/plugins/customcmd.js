import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { command, commands, commandName } from '../core/registry.js';
import { getSetting, setSetting } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
const INDEX_KEY = 'customCommands';
function dataDir() {
    const d = dirname(config.dbPath);
    return d && d !== '.' ? d : '.';
}
function cmdDir() {
    return join(dataDir(), 'cmds');
}
function loadIndex() {
    try {
        const raw = getSetting(INDEX_KEY);
        return raw ? JSON.parse(raw) : {};
    }
    catch (err) {
        logger.warn({ err }, 'custom command index is corrupt. Starting empty');
        return {};
    }
}
function saveIndex(idx) {
    setSetting(INDEX_KEY, JSON.stringify(idx));
}
function builtinNames() {
    const out = new Set();
    for (const c of commands) {
        if (c.pattern)
            out.add(commandName(c.pattern).toLowerCase());
    }
    return out;
}
function quotedKind(m) {
    const q = m.quoted?.raw;
    if (!q)
        return undefined;
    if (q.imageMessage)
        return { kind: 'image', ext: 'jpg' };
    if (q.videoMessage)
        return { kind: 'video', ext: 'mp4' };
    if (q.audioMessage)
        return { kind: 'audio', ext: 'ogg' };
    if (q.stickerMessage)
        return { kind: 'sticker', ext: 'webp' };
    return undefined;
}
command({
    pattern: 'setcmd(?: (.*))?',
    fromMe: true,
    desc: 'Turn replied media into a command',
    usage: '<name> [| caption]',
    category: 'owner',
}, async (m, match) => {
    const arg = (match?.[1] ?? '').trim();
    if (!arg)
        return m.usage();
    const [rawName, ...capParts] = arg.split('|');
    const name = rawName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!name)
        return m.usage();
    if (name.length > 24)
        return m.reply('That name is too long. Keep it under 24 characters.');
    if (builtinNames().has(name))
        return m.reply(`${name} is already a built-in command. Pick another name.`);
    const kind = quotedKind(m);
    if (!kind)
        return m.usage('<keyword> (reply to an image, video, audio or sticker)');
    const buf = await m.downloadMedia(true);
    if (!buf)
        return m.reply('Could not download that media. Try again.');
    const dir = cmdDir();
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.${kind.ext}`);
    writeFileSync(file, buf);
    const idx = loadIndex();
    const existed = Boolean(idx[name]);
    idx[name] = { kind: kind.kind, file, caption: capParts.join('|').trim() || undefined, at: Date.now() };
    saveIndex(idx);
    const prefix = config.prefixes[0] ?? '';
    return m.reply(`${existed ? '♻️ Replaced' : '✅ Saved'} ${prefix}${name} (${kind.kind}).`);
});
command({ pattern: 'delcmd(?: (.*))?', fromMe: true, desc: 'Delete a custom command', usage: '<name>', category: 'owner' }, async (m, match) => {
    const name = (match?.[1] ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!name)
        return m.usage();
    const idx = loadIndex();
    const entry = idx[name];
    if (!entry)
        return m.reply(`I don't have a custom command called ${name}.`);
    try {
        if (existsSync(entry.file))
            unlinkSync(entry.file);
    }
    catch (err) {
        logger.warn({ err, file: entry.file }, 'delcmd: could not remove file');
    }
    delete idx[name];
    saveIndex(idx);
    return m.reply(`🗑️ Deleted ${name}.`);
});
command({ pattern: 'listcmd', desc: 'List the custom media commands', category: 'tools' }, async (m) => {
    const idx = loadIndex();
    const names = Object.keys(idx).sort();
    if (!names.length)
        return m.reply('No custom commands yet. Reply to media with setcmd <name> to make one.');
    const prefix = config.prefixes[0] ?? '';
    const icon = { image: '🖼️', video: '🎬', audio: '🎵', sticker: '🩹' };
    return m.reply(`📦 Custom commands (${names.length})\n` + names.map((n) => `${icon[idx[n].kind]} ${prefix}${n}`).join('\n'));
});
command({ on: 'message' }, async (m) => {
    if (!m.body)
        return;
    const prefix = config.prefixes.find((p) => p && m.body.startsWith(p));
    if (!prefix)
        return;
    const name = m.body
        .slice(prefix.length)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    if (!name)
        return;
    const entry = loadIndex()[name];
    if (!entry)
        return;
    if (!existsSync(entry.file)) {
        logger.warn({ name, file: entry.file }, 'custom command file is missing');
        return;
    }
    const buf = readFileSync(entry.file);
    switch (entry.kind) {
        case 'image':
            return m.sendImage(buf, entry.caption ?? '');
        case 'video':
            return m.sendVideo(buf, entry.caption ?? '');
        case 'sticker':
            return m.sendSticker(buf);
        case 'audio':
            return m.send({ audio: buf, mimetype: 'audio/mp4', ptt: true }, { quoted: m.raw });
    }
});
