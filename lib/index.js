import { config, setPrefixes } from './config.js';
import { logger } from './logger.js';
import { acquireLock } from './core/lock.js';
import { loadPlugins, pluginCount } from './core/loader.js';
import { loadExternal, installConfigured, exposePluginApi, fetchManifest, REGISTRY_URL } from './core/external.js';
import { applyDisabled } from './core/disabled.js';
import { startBot } from './client/connection.js';
import { getSetting } from './db/index.js';
import { redeemSession, hasLocalSession, markBootState, shortId } from './core/session-id.js';
import { fetchRemote } from './core/session-remote.js';
import { registerStubs } from './core/catalogue.js';
import { commands } from './core/registry.js';
async function main() {
    if (!acquireLock()) {
        process.exit(1);
    }
    const savedPrefix = getSetting('prefix');
    if (savedPrefix !== undefined)
        setPrefixes(savedPrefix === '' ? [] : savedPrefix.split(''));
    markBootState();
    if (hasLocalSession() || config.sessionId)
        logger.info('verifying session...');
    if (!hasLocalSession() && config.sessionId) {
        const short = shortId(config.sessionId);
        const payload = short ? await fetchRemote(short) : config.sessionId;
        const res = payload ? redeemSession(payload) : { ok: false, reason: 'unresolved' };
        if (res.ok) {
            logger.info(short ? 'session restored from the session service' : 'session restored from SESSION_ID');
        }
        else {
            const why = {
                malformed: 'that does not look like a Nexus session (expected NEXUS~a7Kq2p or NEXUS~1~...)',
                'wrong-key': res.detail ?? 'wrong NEXUS_SESSION_KEY for this session',
                corrupt: 'the session is damaged. Copy it again, complete and unbroken',
                unsupported: `unsupported session format (${res.detail ?? 'unknown'})`,
                unresolved: 'the session service could not return it. See the error above',
            }[res.reason];
            logger.error(`SESSION_ID could not be used: ${why}`);
            if (config.requireSession) {
                logger.fatal('NEXUS_REQUIRE_SESSION is on, so refusing to start without a usable session');
                process.exit(1);
            }
            logger.error('falling back to QR linking. Open /link or watch the logs');
        }
    }
    if (!hasLocalSession() && !config.sessionId) {
        if (config.requireSession) {
            logger.fatal('NEXUS_REQUIRE_SESSION is on but SESSION_ID is empty. Set it and start again');
            process.exit(1);
        }
        logger.warn('no session detected. Get a session id and redeploy');
    }
    logger.info(`starting ${config.botName} (mode: ${config.mode}, prefix: "${config.prefixes.join('')}")`);
    await loadPlugins();
    const off = applyDisabled();
    if (off)
        logger.info({ commands: off }, 'disabled commands applied');
    exposePluginApi();
    const external = await loadExternal();
    if (external)
        logger.info({ external }, 'loaded installed plugins');
    logger.info('installing plugins...');
    const listed = await fetchManifest(REGISTRY_URL);
    const fresh = await installConfigured(listed);
    if (fresh.installed)
        logger.info(`${fresh.installed} plugin(s) installed successfully`);
    if (fresh.failed)
        logger.error(`${fresh.failed} plugin(s) could not be installed. See the errors above`);
    if (!fresh.installed && !fresh.failed) {
        logger.info(listed.length ? 'plugins already up to date' : 'no plugins to install');
    }
    const stubs = registerStubs();
    if (stubs)
        logger.info({ stubs }, 'catalogued commands available to install');
    const ready = commands.filter((c) => c.pattern && !c.stub).length;
    const listeners = commands.filter((c) => c.on).length;
    logger.info({ plugins: pluginCount() + external, commands: ready, listeners }, `${pluginCount() + external} plugins ready, ${ready} commands`);
    await startBot();
}
main().catch((err) => {
    logger.fatal({ err }, 'fatal error during startup');
    process.exit(1);
});
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'));
