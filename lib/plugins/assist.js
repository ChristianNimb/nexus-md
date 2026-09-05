import { command } from '../core/registry.js';
import { quickGen, requireAI } from './chatbot.js';
function subject(m, arg) {
    return arg.trim() || (m.quoted?.text ?? '').trim();
}
command({ pattern: 'tldr ?(.*)', desc: 'Summarise a long message', usage: '<text | reply>', category: 'tools' }, async (m, match) => {
    const text = subject(m, match?.[1] ?? '');
    if (text.length < 40)
        return m.reply('📝 Reply to a long message with .tldr (or paste the text after it).');
    if (!(await requireAI(m)))
        return;
    await m.react('📝');
    const out = await quickGen(`Summarise the following in 2-3 short, clear sentences. Just the gist, no preamble:\n\n${text.slice(0, 6000)}`);
    await m.reply(out ? `📝 TL;DR:\n${out}` : '😕 Couldn\'t summarise that right now. Try again.');
});
command({ pattern: 'fix ?(.*)', desc: 'Fix grammar / reword a message', usage: '<text | reply>', category: 'tools' }, async (m, match) => {
    const text = subject(m, match?.[1] ?? '');
    if (!text)
        return m.reply('✍️ Reply to a message with .fix (or type .fix <your text>) and I\'ll clean up the grammar.');
    if (!(await requireAI(m)))
        return;
    await m.react('✍️');
    const out = await quickGen(`Fix the grammar and make this clearer and more natural, keeping the original meaning and tone. Reply with ONLY the improved version, nothing else:\n\n${text.slice(0, 4000)}`);
    await m.reply(out ? `✍️ Cleaner version:\n${out}` : '😕 Couldn\'t reword that right now.');
});
command({ pattern: 'split (.+)', desc: 'Split a bill between people', usage: '<amount> <people> [tip%]', category: 'tools' }, async (m, match) => {
    const raw = (match?.[1] ?? '').trim();
    const tipM = raw.match(/(\d+(?:\.\d+)?)\s*%/);
    const tip = tipM ? parseFloat(tipM[1] ?? '0') : 0;
    const nums = raw.replace(/(\d+(?:\.\d+)?)\s*%/, '').replace(/\bby\b/gi, ' ').match(/\d+(?:\.\d+)?/g) ?? [];
    const amount = parseFloat(nums[0] ?? '');
    const people = parseInt(nums[1] ?? '', 10);
    if (!Number.isFinite(amount) || !Number.isFinite(people) || people < 1) {
        return m.reply('Usage: .split 120 4 (amount, people). Add a tip: .split 120 4 15%.');
    }
    const total = amount * (1 + tip / 100);
    const each = total / people;
    await m.reply(`🧾 Bill split\n` +
        `• Total${tip ? ` (+${tip}% tip)` : ''}: ${total.toFixed(2)}\n` +
        `• ${people} ${people === 1 ? 'person' : 'people'} → ${each.toFixed(2)} each`);
});
