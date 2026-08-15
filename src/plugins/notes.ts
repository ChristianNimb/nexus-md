import { command } from '../core/registry.js';
import { getSetting, setSetting } from '../db/index.js';
import type { Message } from '../core/message.js';

/**
 * A private notepad, per person. Jot things down in chat and pull them back up
 * anytime — no app-switching. Stored per sender so everyone gets their own.
 *
 *   .note buy milk        save a note
 *   .notes                list them
 *   .note del 2           delete #2
 *   .note clear           wipe all
 */

const keyFor = (m: Message) => `notes:${m.sender}`;

function load(m: Message): string[] {
  try {
    const v = JSON.parse(getSetting(keyFor(m)) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function store(m: Message, notes: string[]): void {
  setSetting(keyFor(m), JSON.stringify(notes.slice(0, 200)));
}
function render(notes: string[]): string {
  return (
    `📝 *Your notes* (${notes.length}):\n` +
    notes.map((n, i) => `${i + 1}. ${n}`).join('\n') +
    `\n\n_.note del <n> to remove  ·  .note clear to wipe_`
  );
}

// pattern uses (?: (.+))? so ".notes" only hits the list command, not this one.
command({ pattern: 'note(?: (.+))?', desc: 'Save a quick note', usage: '<text | del N | clear>', category: 'tools' }, async (m, match) => {
  const arg = (match?.[1] ?? '').trim();
  const notes = load(m);

  if (!arg) return m.reply(notes.length ? render(notes) : '📝 No notes yet. Save one with *.note buy milk*.');

  const del = arg.match(/^del(?:ete)?\s+(\d+)$/i);
  if (del) {
    const i = Number(del[1]) - 1;
    if (i < 0 || i >= notes.length) return m.reply(`There's no note #${del[1]}. You have ${notes.length}.`);
    const [removed] = notes.splice(i, 1);
    store(m, notes);
    return m.reply(`🗑️ Deleted: _${removed}_`);
  }
  if (/^clear$/i.test(arg)) {
    store(m, []);
    return m.reply('🧹 All notes cleared.');
  }

  notes.push(arg);
  store(m, notes);
  await m.reply(`📝 Saved as note *#${notes.length}*.`);
});

command({ pattern: 'notes', desc: 'Show your saved notes', category: 'tools' }, async (m) => {
  const notes = load(m);
  await m.reply(notes.length ? render(notes) : '📝 No notes yet. Save one with *.note <text>*.');
});
