import { command } from '../core/registry.js';
import { quickGen } from './chatbot.js';
import { resolveJid } from '../core/lid.js';
import { listContacts } from '../db/index.js';
function nameFor(jid) {
    const num = jid.split('@')[0].split(':')[0];
    const c = listContacts().find((x) => x.jid.split('@')[0].split(':')[0] === num);
    return c?.name || c?.notify || num;
}
command({ pattern: 'roast ?(.*)', desc: 'A playful AI roast', usage: '[name] (or reply)', category: 'fun' }, async (m, match) => {
    const target = (match?.[1] ?? '').trim() || (m.quoted?.text ? 'that message' : 'the person who asked (me)');
    await m.react('🔥');
    const out = await quickGen(`Write a SHORT, playful, funny roast of "${target}". Rules: clever and teasing with a bit of attitude, 1-2 punchy lines, ` +
        `light-hearted banter only. Never cruel, no insults about appearance/race/religion/gender or anything sensitive. Make people laugh WITH them, not at them.`);
    await m.reply(out ? `🔥 ${out}` : '😅 my roast circuits are cold right now, try again.');
});
function shipScore(a, b) {
    const s = (a + b).toLowerCase().replace(/\s+/g, '');
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) % 101;
    return h;
}
function bar(pct) {
    const f = Math.round(pct / 10);
    return '█'.repeat(f) + '░'.repeat(10 - f);
}
command({ pattern: 'ship(?: (.+))?', desc: 'Ship two people. Compatibility % + verdict', usage: '<A> and <B>, or reply to someone', category: 'fun' }, async (m, match) => {
    const raw = (match?.[1] ?? '').trim();
    let aLabel, bLabel, aName, bName;
    const mentions = [];
    if (m.quoted?.sender) {
        const other = await resolveJid(m.client, m.quoted.sender, m.isGroup ? m.chat : undefined);
        const otherNum = other.split('@')[0].split(':')[0];
        aName = m.pushName || 'You';
        bName = nameFor(other);
        aLabel = aName;
        bLabel = `@${otherNum}`;
        mentions.push(other);
    }
    else {
        const pair = raw.split(/\s+(?:and|&|\+|x|,)\s+|\s{2,}/i).map((s) => s.trim()).filter(Boolean);
        if (pair.length < 2)
            return m.reply('💘 Usage: .ship Sara and Deng. Or reply to someone with .ship to ship them with you.');
        aName = aLabel = pair[0];
        bName = bLabel = pair[1];
    }
    const pct = shipScore(aName, bName);
    await m.react('💘');
    const verdict = await quickGen(`${aName} and ${bName} scored ${pct}% compatible. In ONE short, witty, playful line, give the verdict on them as a couple. Fun and light.`);
    const text = `💘 ${aLabel} + ${bLabel}\n${bar(pct)}  ${pct}%\n${verdict || (pct > 60 ? 'the stars kinda approve 😌' : 'eh, keep it as friends 😅')}`;
    await m.client.sendMessage(m.chat, mentions.length ? { text, mentions } : { text }, { quoted: m.raw });
});
command({ pattern: 'decide (.+)', desc: 'Can\'t decide? Let Nexus pick', usage: '<a> or <b> [or c]', category: 'fun' }, async (m, match) => {
    const raw = (match?.[1] ?? '').trim();
    const opts = raw.split(/\s+or\s+|,\s*|\s+vs\.?\s+/i).map((s) => s.trim()).filter(Boolean);
    if (opts.length < 2)
        return m.reply('🤔 Give me options: .decide pizza or burger or sushi.');
    await m.react('🎲');
    const out = await quickGen(`The user can't decide between: ${opts.join(', ')}. Pick exactly ONE for them and give a short, confident, witty reason (1-2 lines). Be playful and decisive.`);
    const fallback = opts[Math.floor(Math.random() * opts.length)];
    await m.reply(out ? `🎲 ${out}` : `🎲 Go with ${fallback}. Trust me on this one 😌`);
});
