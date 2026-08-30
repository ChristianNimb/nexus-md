import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, commands, commandName } from '../core/registry.js';
import { smallcaps } from '../core/text.js';
import { panel } from '../core/ui.js';
import { version, hostPlatform, uptime } from '../core/botinfo.js';
import { nowFor } from '../core/timezone.js';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/index.js';
import { unwrapContent } from '../core/message.js';
import { renderNameBanner } from '../core/render.js';
import { logger } from '../logger.js';
function dataDir() {
    const d = dirname(config.dbPath);
    return d && d !== '.' ? d : '.';
}
function menuFile(ext) {
    return join(dataDir(), `menu.${ext}`);
}
function buildMenu(userName, dateText, ownerView = false) {
    const prefix = config.prefixes[0] ?? '';
    const groups = new Map();
    for (const c of commands) {
        if (!c.pattern || c.hidden)
            continue;
        if (ownerView ? !c.fromMe : c.fromMe)
            continue;
        const name = commandName(c.pattern);
        if (!name)
            continue;
        const cat = c.category ?? 'general';
        const arr = groups.get(cat) ?? [];
        if (!arr.includes(name))
            arr.push(name);
        groups.set(cat, arr);
    }
    const total = [...groups.values()].reduce((a, b) => a + b.length, 0);
    if (ownerView && total === 0)
        return '👑 No owner-only commands are registered.';
    return panel({
        name: config.botName,
        ...(ownerView ? { tag: `👑 ${smallcaps('owner panel')}` } : {}),
        rows: [
            ['👤', 'user', userName],
            ['📅', 'date', dateText],
            ['🏷️', 'version', `v${version()}`],
            ['🖥️', 'host', hostPlatform()],
            ['⏱️', 'uptime', uptime()],
            ['🔧', 'prefix', prefix || '(none)'],
            ['📜', ownerView ? 'owner cmds' : 'commands', String(total)],
        ],
        sections: [...groups.entries()]
            .sort()
            .map(([cat, names]) => ({ name: cat, items: names.sort().map((n) => `${prefix}${n}`) })),
        tips: ownerView
            ? [`${smallcaps('owner only')}`]
            : [`${prefix}help <command>`, `${prefix}alive`],
    });
}
function customMenuMedia() {
    const type = getSetting('menu.type');
    const ext = getSetting('menu.ext');
    if (type && ext && existsSync(menuFile(ext))) {
        return { buffer: readFileSync(menuFile(ext)), kind: type === 'video' ? 'video' : 'image' };
    }
    return undefined;
}
async function defaultBanner() {
    const assets = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
    for (const name of ['nexus-default.jpg', 'nexus-default.png', 'nexus-default.jpeg']) {
        const file = join(assets, name);
        if (!existsSync(file))
            continue;
        try {
            return readFileSync(file);
        }
        catch (err) {
            logger.warn({ err, file }, 'menu: bundled image could not be read');
        }
    }
    try {
        return await renderNameBanner(config.botName, 'WhatsApp Bot', undefined);
    }
    catch (err) {
        logger.warn({ err }, 'menu: banner render failed');
        return undefined;
    }
}
command({ pattern: 'menu(?: (owner|admin|sudo|hidden|dev))?', desc: 'Show the command menu (.menu owner for owner-only)', category: 'system' }, async (m, match) => {
    const arg = (match?.[1] ?? '').trim().toLowerCase();
    const wantsOwner = /^(owner|admin|sudo|hidden|dev)$/.test(arg);
    if (wantsOwner) {
        if (!m.isOwner)
            return m.reply('👑 The owner-only command list is for the owner. The public menu is just .menu.');
        return m.reply(buildMenu(m.pushName || 'boss', nowFor(m.senderNumber).text, true));
    }
    const caption = buildMenu(m.pushName || 'there', nowFor(m.senderNumber).text);
    try {
        const custom = customMenuMedia();
        if (custom) {
            if (custom.kind === 'video')
                await m.send({ video: custom.buffer, caption, gifPlayback: true }, { quoted: m.raw });
            else
                await m.send({ image: custom.buffer, caption }, { quoted: m.raw });
            return;
        }
        const banner = await defaultBanner();
        if (banner) {
            await m.send({ image: banner, caption }, { quoted: m.raw });
            return;
        }
    }
    catch (err) {
        logger.warn({ err }, 'menu: media send failed. Falling back to text');
    }
    await m.reply(caption);
});
command({ pattern: 'setmenu', desc: 'Set the menu image/video', usage: '<reply to image/video>', category: 'owner', fromMe: true }, async (m) => {
    const own = m.type === 'imageMessage' || m.type === 'videoMessage';
    const q = unwrapContent(m.quoted?.raw);
    const isVideo = m.type === 'videoMessage' || Boolean(q?.videoMessage);
    const isImage = m.type === 'imageMessage' || Boolean(q?.imageMessage);
    if (!isImage && !isVideo)
        return m.usage();
    const buffer = await m.downloadMedia(!own);
    if (!buffer)
        return m.reply('Could not download that media.');
    const ext = isVideo ? 'mp4' : 'jpg';
    try {
        const dir = dataDir();
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        writeFileSync(menuFile(ext), buffer);
        setSetting('menu.type', isVideo ? 'video' : 'image');
        setSetting('menu.ext', ext);
        await m.reply('✅ Menu media set. Try .menu');
    }
    catch (err) {
        logger.error({ err }, 'setmenu: failed to save');
        await m.reply('❌ Could not save the menu media.');
    }
});
