import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { command, recompileCommands } from '../core/registry.js';
import { config, setPrefixes } from '../config.js';
import { flush, setSetting } from '../db/index.js';
import { logger } from '../logger.js';
import { listExternal, install } from '../core/external.js';
import { version } from '../core/botinfo.js';
const run = promisify(exec);
command({ pattern: 'restart', fromMe: true, desc: 'Restart the bot', category: 'owner' }, async (m) => {
    await m.reply('Restarting...');
    flush();
    logger.info('restart requested by owner');
    setTimeout(() => process.exit(0), 500);
});
const REPO = 'ChristianNimb/nexus-md';
async function isGitCheckout() {
    try {
        const { stdout } = await run('git rev-parse --is-inside-work-tree');
        return stdout.trim() === 'true';
    }
    catch {
        return false;
    }
}
async function latestUpstream() {
    try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/commits/HEAD`, {
            headers: { accept: 'application/vnd.github+json' },
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok)
            return undefined;
        const body = (await res.json());
        if (!body.sha)
            return undefined;
        return { sha: body.sha.slice(0, 7), message: (body.commit?.message ?? '').split('\n')[0] ?? '' };
    }
    catch {
        return undefined;
    }
}
async function updatePlugins() {
    const done = [];
    const failed = [];
    for (const entry of Object.values(listExternal())) {
        const res = await install(entry.url);
        if (res.ok)
            done.push(entry.name);
        else
            failed.push(`${entry.name} (${res.reason})`);
    }
    return { done, failed };
}
command({ pattern: 'update(?: (plugins))?', fromMe: true, desc: 'Update the bot and restart', usage: '[plugins]', category: 'owner' }, async (m, match) => {
    const arg = (match?.[1] ?? '').trim().toLowerCase();
    if (arg === 'plugins') {
        const installed = Object.keys(listExternal()).length;
        if (!installed)
            return m.reply('No installed plugins to update.');
        await m.reply(`Refreshing ${installed} plugin(s)...`);
        const { done, failed } = await updatePlugins();
        const lines = [
            done.length ? `Updated: ${done.join(', ')}` : 'Nothing updated.',
            ...(failed.length ? [`Failed: ${failed.join(', ')}`] : []),
        ];
        return m.reply(lines.join('\n'));
    }
    if (await isGitCheckout()) {
        try {
            await m.reply('Pulling latest changes...');
            const { stdout } = await run('git pull --ff-only');
            if (/Already up to date/i.test(stdout))
                return m.reply('Already up to date.');
            await m.reply('Updated:\n```' + stdout.trim().slice(0, 800) + '```\nRestarting...');
            flush();
            setTimeout(() => process.exit(0), 800);
            return;
        }
        catch (err) {
            logger.error({ err }, 'update failed');
            return m.reply('Pull failed. The working tree probably has local changes. Commit or stash them, then try again.');
        }
    }
    const latest = await latestUpstream();
    const lines = [
        `Running v${version()} from an image, so there is no checkout to pull into.`,
        ...(latest ? [`Latest upstream: ${latest.sha} ${latest.message}`.trim()] : []),
        '',
        'Redeploy from the host to pick it up. Installed plugins can be refreshed here and now with .update plugins.',
    ];
    await m.reply(lines.join('\n'));
});
command({ pattern: 'setprefix ?(.*)', fromMe: true, desc: 'Change the command prefix (e.g. ! or / or none)', usage: '<char(s) | none>', category: 'owner' }, async (m, match) => {
    const raw = (match?.[1] ?? '').trim();
    if (!raw) {
        const cur = config.prefixes.length ? config.prefixes.join('') : '(none)';
        return m.reply(`Current prefix: ${cur}\nChange it with ${config.prefixes[0] ?? ''}setprefix ! (or a few like .!/, or none for no prefix).`);
    }
    const none = /^(none|blank|off|nothing)$/i.test(raw);
    const chars = none ? [] : [...new Set(raw.replace(/\s+/g, '').split(''))].slice(0, 4);
    if (!none && !chars.length)
        return m.reply('Give me a prefix character, e.g. setprefix !. Or setprefix none.');
    setPrefixes(chars);
    recompileCommands();
    setSetting('prefix', none ? '' : chars.join(''));
    const shown = none ? '(none. Just type the command name)' : chars.join(' ');
    const eg = chars[0] ?? '';
    await m.reply(`✅ Prefix updated to: ${shown}\nTry ${eg}menu now. (Saved. It'll stick after restarts.)`);
});
command({ pattern: 'shutdown', fromMe: true, desc: 'Stop the bot', category: 'owner', hidden: true }, async (m) => {
    await m.reply('Shutting down.');
    flush();
    setTimeout(() => process.exit(0), 300);
});
