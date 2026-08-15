import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  transport: {
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  },
  base: undefined,
});

/** A child logger scoped to Baileys internals, kept quieter than the app log. */
export const waLogger = logger.child({ mod: 'baileys' });
waLogger.level = 'warn';
