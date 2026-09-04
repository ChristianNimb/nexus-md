import { command } from '../core/registry.js';
import { config } from '../config.js';
import { getSetting, setSetting, deleteSetting } from '../db/index.js';
import { recentMessages, renderTranscript, eventCounts } from '../core/chatlog.js';
import { quickGen } from './chatbot.js';
import { logger } from '../logger.js';
command({ pattern: 'catchup ?(.*)', desc: 'Summarise the recent activity you missed', usage: '[how many]', category: 'ai' }, async (m, match) => {
    const n = Math.min(120, Math.max(5, Number((match?.[1] ?? '').trim()) || 40));
    const events = recentMessages(m.chat, n);
    if (events.length < 3)
        return m.reply('🙂 Not enough recent activity to summarise yet. Check back after a bit of chatting.');
    const transcript = renderTranscript(events);
    const counts = eventCounts(events);
    logger.info({ chat: m.chat, events: events.length, counts }, 'catchup');
    await m.react('📝');
    const summary = await quickGen(`You are catching a friend up on a WhatsApp ${m.isGroup ? 'group ' : ''}chat they missed. Below is a chronological log; media appears as placeholders like [voice note 18s], [sticker], [image — "caption"]. ` +
        `Summarise what ACTUALLY happened as a few short, punchy bullets grouped by topic/event — arguments, questions, decisions, plans, announcements, and notable media (voice notes, stickers). ` +
        `Mention that someone "sent a voice note" when you see one, but NEVER invent what the voice note or an uncaptioned image said — you did not hear/see it. ` +
        `Match the tone to the content (playful if it was banter, serious if it was serious). If barely anything happened, say so briefly. No preamble, no "here is a summary".\n\n---\n${transcript}`);
    await m.reply(summary ? `📝 Here's what you missed:\n\n${summary}` : "😅 Couldn't summarise right now. Try again in a sec.");
});
const pendingTrivia = new Map();
command({ pattern: 'trivia', desc: 'Start a trivia question', category: 'fun' }, async (m) => {
    await m.react('🧠');
    const raw = await quickGen('Ask ONE fun general-knowledge trivia question (medium difficulty). Reply EXACTLY in this format and nothing else:\nQ: <the question>\nA: <the short answer>');
    const q = raw.match(/Q:\s*(.+)/i)?.[1]?.trim();
    const a = raw.match(/A:\s*(.+)/i)?.[1]?.trim();
    if (!q || !a)
        return m.reply('🤔 my brain fogged. Try .trivia again.');
    pendingTrivia.set(m.chat, { answer: a.toLowerCase(), at: Date.now() });
    await m.reply(`🧠 Trivia time!\n\n${q}\n\n_note: reply with your answer 👇_`);
});
command({ on: 'message' }, async (m) => {
    const p = pendingTrivia.get(m.chat);
    if (!p || m.fromMe || !m.body)
        return;
    if (Date.now() - p.at > 5 * 60_000)
        return void pendingTrivia.delete(m.chat);
    if (config.prefixes.some((x) => x && m.body.startsWith(x)))
        return;
    const guess = m.body.trim().toLowerCase();
    const correct = guess === p.answer || (guess.length >= 3 && (guess.includes(p.answer) || p.answer.includes(guess)));
    if (correct) {
        pendingTrivia.delete(m.chat);
        await m.reply(`✅ Correct! The answer was ${p.answer} 🎉`);
    }
});
command({ pattern: 'wyr', desc: 'Would you rather…', category: 'fun' }, async (m) => {
    await m.react('🤔');
    const wyr = await quickGen('Pose ONE fun, surprising "Would you rather" dilemma (two options). Keep it to one or two sentences, playful. No preamble.');
    await m.reply(wyr ? `🤔 Would you rather…\n${wyr}` : 'Would you rather try that again? 😅');
});
command({ pattern: 'riddle', desc: 'Get a riddle', category: 'fun' }, async (m) => {
    await m.react('🧩');
    const riddle = await quickGen('Give ONE clever riddle. Put the riddle first, then on a new line write "||Answer: <answer>" so it stays hidden until they think. One riddle only.');
    await m.reply(riddle ? `🧩 ${riddle}` : 'Hmm, no riddle came to mind. Try again 🙂');
});
command({ pattern: 'callreply(?: (on|off))?', fromMe: true, desc: 'Toggle auto voice-note reply to incoming calls', usage: 'on|off', category: 'system' }, async (m, match) => {
    const v = (match?.[1] ?? '').trim().toLowerCase();
    if (v === 'off') {
        setSetting('call.answer', 'off');
        return m.reply('📞 Call auto-answer is OFF. I\'ll ignore incoming calls now.');
    }
    if (v === 'on') {
        deleteSetting('call.answer');
        return m.reply('📞 Call auto-answer is ON. When someone calls, I decline and reply with a voice note.');
    }
    const state = getSetting('call.answer') === 'off' ? 'off' : 'on';
    await m.reply(`📞 Call auto-answer is ${state}.\nWhen ON, a call to me gets declined + an instant voice-note reply. Use *.callreply on|off*.`);
});
