import { command } from '../core/registry.js';
import { bumpStat } from '../db/index.js';

/** Passive counter: increment a per-sender message tally for every message seen. */
command({ on: 'message' }, async (m) => {
  if (m.fromMe || !m.sender) return;
  bumpStat(m.sender);
});
