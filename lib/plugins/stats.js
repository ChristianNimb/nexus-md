import { command } from '../core/registry.js';
import { bumpStat } from '../db/index.js';
command({ on: 'message' }, async (m) => {
    if (m.fromMe || !m.sender)
        return;
    bumpStat(m.sender);
});
