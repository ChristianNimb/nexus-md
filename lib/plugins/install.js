import { command } from '../core/registry.js';
import { install, uninstall, listExternal, sourceOf } from '../core/external.js';
import { config } from '../config.js';
import { disable, enable, disabledCommands } from '../core/disabled.js';
const firstUrl = (s) => s.match(/https?:\/\/\S+/i)?.[0];
command({
    pattern: 'install(?: (.*))?',
    fromMe: true,
    desc: 'Install a plugin from a link',
    usage: '<url>',
    category: 'owner',
}, async (m, match) => {
    const url = firstUrl((match?.[1] ?? '').trim() || m.quoted?.text || '');
    if (!url)
        return m.usage();
    await m.react('⏳');
    const res = await install(url);
    if (!res.ok) {
        await m.react('❌');
        return m.reply(`❌ Not installed: ${res.reason}.`);
    }
    await m.react('✅');
    const prefix = config.prefixes[0] ?? '';
    const list = res.added.map((c) => `${prefix}${c}`).join(', ');
    return m.reply(`✅ Installed ${res.name}.\n\nIt added: ${list || '(no commands)'}`);
});
command({
    pattern: '(?:uninstall|remove)(?: (.*))?',
    fromMe: true,
    desc: 'Remove a plugin, or turn off a built-in command',
    usage: '<name>',
    category: 'owner',
}, async (m, match) => {
    const name = (match?.[1] ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!name)
        return m.usage();
    const prefix = config.prefixes[0] ?? '';
    if (uninstall(name))
        return m.reply(`🗑️ Removed ${name}.`);
    if (disable(name)) {
        return m.reply(`🚫 Turned off ${prefix}${name}.\n\nhint: ${prefix}enable ${name}`);
    }
    return m.reply(`I don't have a plugin or command called ${name}. Use ${prefix}plugins to see them.`);
});
command({
    pattern: 'plugins(?: (.*))?',
    fromMe: true,
    desc: 'List installed plugins, or show one',
    usage: '[name]',
    category: 'owner',
}, async (m, match) => {
    const idx = listExternal();
    const names = Object.keys(idx).sort();
    const prefix = config.prefixes[0] ?? '';
    const wanted = (match?.[1] ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (wanted) {
        const entry = idx[wanted];
        if (!entry)
            return m.reply(`I don't have a plugin called ${wanted}.`);
        const src = sourceOf(wanted);
        return m.reply(`📦 ${entry.name}\n` +
            `from: ${entry.url}\n` +
            `added: ${new Date(entry.at).toISOString().slice(0, 10)}\n` +
            `commands: ${entry.registered ?? 0}\n` +
            `size: ${src ? `${(src.length / 1024).toFixed(1)} KB` : 'missing from disk'}`);
    }
    const off = disabledCommands().sort();
    const offText = off.length
        ? `\n\n🚫 Turned off (${off.length})\n` +
            off.map((n) => `• ${prefix}${n}`).join('\n') +
            `\n\nhint: ${prefix}enable <name>`
        : '';
    if (!names.length) {
        return m.reply(`No plugins installed. Add one with ${prefix}install <url>.${offText}`);
    }
    return m.reply(`📦 Installed (${names.length})\n` +
        names.map((n) => `• ${n} — ${idx[n].registered ?? 0} command(s)`).join('\n') +
        `\n\n${prefix}plugins <name> for details.${offText}`);
});
command({
    pattern: 'enable(?: (.*))?',
    fromMe: true,
    desc: 'Turn a disabled command back on',
    usage: '<name>',
    category: 'owner',
}, async (m, match) => {
    const name = (match?.[1] ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const prefix = config.prefixes[0] ?? '';
    if (!name) {
        const off = disabledCommands().sort();
        return off.length
            ? m.reply(`Turned off: ${off.join(', ')}

hint: ${prefix}enable <name>`)
            : m.reply('Nothing is turned off.');
    }
    return enable(name)
        ? m.reply(`✅ ${prefix}${name} is back on. Restart to finish.`)
        : m.reply(`${prefix}${name} is not turned off.`);
});
