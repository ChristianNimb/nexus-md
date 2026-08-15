import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../logger.js';
import { commands } from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, '..', 'plugins');

/**
 * Dynamically import every module in src/plugins. Each plugin registers its
 * commands as a side effect of being imported (by calling `command(...)`),
 * so a bare import is all that's needed.
 */
export async function loadPlugins(): Promise<number> {
  let files: string[];
  try {
    files = await readdir(PLUGIN_DIR);
  } catch (err) {
    logger.warn({ err }, 'no plugins directory found');
    return 0;
  }

  const before = commands.length;
  for (const file of files) {
    if (!/\.(ts|js)$/.test(file)) continue;
    const url = pathToFileURL(join(PLUGIN_DIR, file)).href;
    try {
      await import(url);
      logger.debug({ file }, 'plugin loaded');
    } catch (err) {
      logger.error({ err, file }, 'failed to load plugin');
    }
  }

  const added = commands.length - before;
  logger.info({ plugins: files.length, commands: added }, 'plugins loaded');
  return added;
}
