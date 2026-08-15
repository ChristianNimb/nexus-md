/**
 * Entry point. Boots the bot in a deliberate order:
 *   lock (only one instance may hold the WhatsApp session) → saved prefix →
 *   plugins (each registers its commands on import) → connect to WhatsApp.
 *
 * The prefix must be applied BEFORE plugins load, because every command bakes
 * the prefix into its compiled regex at registration time.
 */
import { config, setPrefixes } from './config.js';
import { logger } from './logger.js';
import { acquireLock } from './core/lock.js';
import { loadPlugins } from './core/loader.js';
import { startBot } from './client/connection.js';
import { getSetting } from './db/index.js'; // initialises the database early too
import { startWebServer } from './web/server.js';

async function main(): Promise<void> {
  if (!acquireLock()) {
    // Another instance owns the session. Exiting protects the encryption keys.
    process.exit(1);
  }
  // Apply a saved custom prefix (set via .setprefix) BEFORE plugins compile their
  // command regexes, so the chosen prefix takes effect on startup.
  const savedPrefix = getSetting('prefix');
  if (savedPrefix !== undefined) setPrefixes(savedPrefix === '' ? [] : savedPrefix.split(''));

  logger.info(`starting ${config.botName} (mode: ${config.mode}, prefix: "${config.prefixes.join('')}")`);
  await loadPlugins();
  // Website + browser linking panel. Started BEFORE the WhatsApp connection so
  // the panel is already serving when the first QR arrives — otherwise you'd
  // miss the first rotation while the page was still loading.
  startWebServer();
  await startBot();
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error during startup');
  process.exit(1);
});

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'));
