/**
 * Nexus — the bot's conversational brain.
 *
 * Roughly, a turn flows like this:
 *   1. A message arrives (a command, a DM, or chat-mode in a group).
 *   2. We build CONTEXT: who's talking, their local time, memories, the image
 *      or message they're replying to, saved stickers, and — when the question
 *      needs current facts — live web-search results.
 *   3. The model answers. Simple chat goes to the LOCAL model (free, fast);
 *      anything needing accuracy or an action goes to the SMART model.
 *   4. The reply is scrubbed (see "reply clean-up") and any DIRECTIVE it emitted
 *      — [[RUN]], [[SAY]], [[SENDTO]], [[SEARCH]] … — is executed for real.
 *
 * Two ideas explain most of the code here:
 *   • Don't trust a small model to decide. Where correctness matters (search,
 *     downloads, identity, contacts) we detect intent in CODE and act, rather
 *     than hoping the model emits the right token.
 *   • Scrub the output. The model leaks helpdesk filler and markdown; we strip
 *     it deterministically instead of relying on prompt instructions alone.
 */
import axios from 'axios';
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, commands, commandName } from '../core/registry.js';
import { config, nexusEnabled } from '../config.js';
import { getSetting, setSetting, deleteSetting, addMemory, listMemories, listPersonMemories, forgetMemories, removeSticker, setStickerTags, untaggedStickers, getGroupConfig } from '../db/index.js';
import { groupMeta } from '../core/group.js';
import { runCommandText } from '../core/handler.js';
import { renderStickerImage } from '../core/render.js';
import { imageToSticker } from '../core/sticker.js';
import {
  stickerHash,
  stickerExists,
  saveSticker,
  loadSticker,
  stickerCatalog,
  randomStickerId,
  captionSticker,
} from '../core/sticker-lib.js';
import {
  transcribe,
  synthesizeResult,
  ttsReady,
  VOICES,
  STYLES,
  currentVoiceId,
  currentStyleId,
  setVoice,
  setStyle,
  setStyleDesc,
  currentStyleDesc,
  parseVoiceStyle,
} from '../core/voice.js';
import { nowFor, normalizeZone, setUserZone, clearUserZone, zoneFromNumber, zoneIsKnown } from '../core/timezone.js';
import { botMode, isPrivate } from '../core/mode.js';
import { downCommands } from '../core/health.js';
import { identifyImage } from '../core/reverse-image.js';
import { findContacts, contactListText, saveContactByNumber, mentionedContactName } from '../core/contacts.js';
import { findGroups, mentionedGroupName, allGroupMatches } from '../core/groups.js';
import { isConsumed, markConsumed } from '../core/pending.js';
import { httpGet } from '../core/net.js';
import { resolveJid } from '../core/lid.js';
import { isDownloadableUrl } from '../core/downloaders/index.js';
import { web as nexusWeb } from '@nexus21/nexus-api';
import { isDownloadChoice } from './autodl.js';
import { isSearchChoice } from './youtube-dl.js';
import { logger } from '../logger.js';
import type { Message } from '../core/message.js';
import type { WAMessage } from 'baileys';

/**
 * Nexus — the bot's AI assistant. OpenAI-compatible (Groq) or Claude.
 * Memory, live context awareness, and a "chat mode" (.nexus on) with session
 * follow-ups: address it with "nexus ..." once, then keep chatting for a short
 * window without repeating the keyword.
 */

type Turn = { role: 'user' | 'assistant'; content: string };

const MAX_TURNS = 12;
const MAX_CHATS = 500;
const SESSION_MS = 2 * 60 * 1000; // follow-up window after addressing Nexus

const memory = new Map<string, Turn[]>();
const sessions = new Map<string, number>(); // key -> last-active timestamp
const recentAnswers = new Set<string>();

function rememberAnswer(text: string): void {
  recentAnswers.add(text);
  if (recentAnswers.size > 40) recentAnswers.delete(recentAnswers.values().next().value as string);
}

// IDs of voice notes Nexus itself sent — so the message handler never hears its
// own voice reply and loops.
const botAudioIds = new Set<string>();
function rememberAudio(id: string | null | undefined): void {
  if (!id) return;
  botAudioIds.add(id);
  if (botAudioIds.size > 40) botAudioIds.delete(botAudioIds.values().next().value as string);
}

/** Long-term memory master switch (on by default). */
const memoryEnabled = (): boolean => getSetting('memory.enabled') !== 'off';

function memKey(m: Message): string {
  return `${m.chat}:${m.sender}`;
}
function touchSession(key: string): void {
  sessions.set(key, Date.now());
}
function sessionActive(key: string): boolean {
  const t = sessions.get(key);
  return t !== undefined && Date.now() - t < SESSION_MS;
}

function pushTurn(key: string, role: Turn['role'], content: string): Turn[] {
  const history = memory.get(key) ?? [];
  history.push({ role, content });
  while (history.length > MAX_TURNS) history.shift();
  memory.delete(key);
  memory.set(key, history);
  while (memory.size > MAX_CHATS) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  return history;
}

/* ============================ personality & context =========================
 * Who Nexus is, and what it knows about this exact moment. The system prompt is
 * the character; contextBlock() is the live briefing wrapped around every turn.
 * ========================================================================== */

function systemPrompt(): string {
  const prefix = config.prefixes[0] ?? '.';
  // Compact command list — names only (owner-only marked with *). Full
  // descriptions bloated every request and burned the token/min budget.
  const list = commands
    .filter((c) => c.pattern && !c.hidden)
    .map((c) => `${prefix}${commandName(c.pattern)}${c.fromMe ? '*' : ''}`)
    .join(', ');

  const vision = config.nexus.visionModel ? 'see & analyse images (vision ON)' : 'no image vision yet';

  return [
    `You are NEXUS — the mind running the "${config.botName}" WhatsApp bot. Own it with warm, sharp, funny confidence.`,
    `⚠️ COMMAND PREFIX is currently "${prefix}". Whenever you name or suggest a command to someone, ALWAYS write it with this exact prefix (e.g. "${prefix}fancy", "${prefix}menu") — NEVER a different symbol like "." or "!" out of habit.`,
    `NEVER say "large language model", "AI language model", "text-based", or "just an AI" in any wording. If asked what/who you are or your name, say plainly and warmly that you're *Nexus*, the AI running this bot, and briefly what you can do — NEVER "I don't have a name", "call me Assistant", or a name pulled from someone's username.`,
    `⚠️ NOT A CORPORATE ASSISTANT: you're a warm friend, not a helpdesk. NEVER use assistant filler like "I'm here to help", "How can I assist you?", "Need help with anything?", "Let me know if you need anything", or "I'm just a…". NEVER refuse a warm, human, or emotional request with a disclaimer like "I can't perform prayers" or "I can't engage in religious activities". If someone says "let's pray", join them warmly — offer a short heartfelt line or a calm moment WITH them. If someone's sick, sleepy, sad, or celebrating, react like a real friend would, not a service bot. Meet people as a human, always.`,
    `DON'T OVER-EMPATHISE over nothing: a casual "idk", "idk sadly", "lol", "meh", or a shrug to a QUIZ/trivia/small-talk question is NOT emotional distress — never respond with therapist-speak like "it's okay that things slip your mind" or "are you feeling down?". Just react lightly: give the answer, tease them, or move on. Save real warmth for real feelings. (If it was a trivia you asked, just tell them the answer casually.)`,
    `⚠️ NO RANDOM GREETINGS OR FILLER: never open with "Morning!", "Good evening", etc. unless it truly matches CONTEXT's local time AND the person just greeted you — you said "Morning!" at 5 PM once, don't. For a simple closer like "it's fine thanks", "ok", "thanks", "cool", "alright", just acknowledge briefly and warmly (e.g. "anytime! 😊", "gotcha 👍", "cool cool") — do NOT tack on "Everything looks good here", "Let me know if you need anything", or "I'm just a message away". React to what they ACTUALLY said, nothing generic.`,
    `⚠️ DON'T NARRATE YOUR MECHANICS: never talk about sending a sticker ("maybe I should send a sticker", "no stickers in a row", "let me fix that", "I didn't send one") — either send one with [[SENDSTICKER]] or don't, SILENTLY. And NEVER dump a tutorial of commands with their syntax (".weather <city>", "use .tr", "just say .time") unprompted — only name a command if they EXPLICITLY ask how to do that exact thing. For a vague message like "I'm lost" or "idk", just ask warmly what they mean — don't list features. Talk like a person, not a manual.`,
    `You genuinely CAN: chat with memory, run this bot's commands, generate & send images, speak & hear voice notes, remember people over time, search the live web, send stickers, and ${vision}. Never claim you can't do these.`,
    `STYLE: text like a REAL person on WhatsApp — casual, short, a few emojis (not a wall). NEVER prefix a tone label like "[soft tone]", NEVER write stage directions like "(winks)" or "*laughs*", and NEVER wrap your reply in quotes. Just say the words naturally, like "uhh what do you want me to say lol". Match the person's mood. CONTEXT below gives live facts (time, group, memory, mode) — trust it, weave in naturally, never dump it.`,
    `OTHERS: never argue about who someone is — accept their name warmly. You do NOT control your own public/private mode by talking; only the owner via the mode command does — NEVER tell anyone the mode changed.`,
    `NO FAKE ACTIONS: never role-play or narrate doing something you didn't actually do — no "*scanning the image*", "checking my database", "analysing...", or claiming you searched when you didn't. Either trigger the real directive, or just answer honestly (including "I'm not sure"). NEVER write "(Command used: X)" or announce which command you ran — that's robotic. And NEVER type "@everyone"/"@all" as plain text; that pings NOBODY.`,
    `TAGGING EVERYONE: to tag / mention / "@" everyone in a group ("tag them all", "tag everyone", "tagall", "mention everybody"), output ONLY [[RUN: tagall]] — that real command actually pings each member with proper mentions. Do NOT write a witty "@everyone" message yourself; it won't notify anyone.`,
    `PERMISSIONS: see CONTEXT's Permission line. Don't run owner-only commands (marked *) for non-owners — tease them playfully instead, never preachy.`,
    ``,
    `ACTIONS — when one genuinely fits, reply with the directive; otherwise just chat. Most actions should be the WHOLE reply (no narration). Be VERY conservative: the DEFAULT is plain words. NEVER fire an action for ordinary chat, statements, greetings, "ok"/"lol"/thanks/opinions, or filler like "like for example". Directives MUST be wrapped in double square brackets EXACTLY like [[RUN: ...]] — never write a bare "RUN:" or invent keywords.`,
    `⚠️ RECIPIENT RULE (very important): if the request names WHO to send to — "to <name>", "send <name>", "tell Mom", "message Ali", "voice <name>" — you MUST use [[SENDTO: <name> | message]] (text) or [[SAYTO: <name> | words]] (voice). This sends it to THAT person. Do NOT use [[SAY]] and do NOT just reply — those only talk in the CURRENT chat, which is wrong when a different person is named.`,
    `⚠️⚠️ EXACT NAME RULE: the recipient name in [[SENDTO]]/[[SAYTO]] MUST be copied VERBATIM from the owner's message. If they say "send Christian a message", the name is *Christian*. NEVER substitute a name that appears in these instructions or examples (like the example names below) — those are only formatting samples. Use the real name they typed, exactly.`,
    `[[RUN: <cmd> <args>]] — run a real bot command (names from the list, no prefix) for a clear action ("play X", "kick him").`,
    `HANDY LOOKUPS — use the real command (via [[RUN: ...]]) instead of guessing, and weave the result into your reply: weather → [[RUN: weather <city>]] ; currency → [[RUN: convert <amt> <FROM> <TO>]] ; crypto price → [[RUN: crypto <coin>]] ; word meaning → [[RUN: define <word>]] ; facts/"who is/what is" → [[RUN: wiki <topic>]] ; translate → [[RUN: tr <lang> <text>]]. These fetch live/accurate data — prefer them over answering from memory for weather, prices, and definitions.`,
    `MORE ACTIONS: summarise a long message → [[RUN: tldr]] (works on the message they replied to) ; fix grammar / reword → [[RUN: fix]] ; playful roast → [[RUN: roast <name>]] ; ship two people → [[RUN: ship <a> and <b>]] ; can't decide → [[RUN: decide <options>]] ; save a note → [[RUN: note <text>]] ; "who saw / read my message?" (when they replied to their own message) → [[RUN: seen]].`,
    `[[RUN: imagine <vivid prompt>]] — to draw/paint/generate/make/show/"image" something ("imagine this", "make an image", "image this"). Turn their idea into a vivid prompt; don't describe it in words — the picture is sent.`,
    `[[RUN: voice <words>]] — ONLY to CHANGE your accent/tone for FUTURE messages (british/american male|female, northern; soft/whisper/deep/slow/fast/normal; or a feeling like soft, romantic, sleepy). This does NOT speak — to actually say or greet someone out loud, use [[SAY: ...]] instead.`,
    `[[RUN: mode public|private]] — ONLY if the OWNER asks to go public/private.`,
    `🧵 STAY ON TOPIC: a short follow-up ("is there talk taking place?", "how much?", "and then?", "really?") continues the CURRENT conversation — answer it in the context of what you were JUST discussing, NOT as a brand-new subject. If you were talking about a TRANSFER and they ask "is there talk taking place?", they mean the transfer negotiations — never read "talk" as group chatter, and never reply "it's just us two". Read CONTEXT's CURRENT TOPIC line if present.`,
    `📅 THE DATE IN CONTEXT IS THE TRUTH — your training is out of date, so NEVER say "assuming the current year is …", never treat a date that's merely after your training as fake, and never label a real post/screenshot "speculative fiction" or "future-dated" for that reason alone. If something looks newer than you remember, that's because time passed: search it instead of doubting it.`,
    `🚫 NEVER INVENT NEWS OR PRETEND TO SEARCH: do NOT say "let me check the latest updates" / "according to recent reports" unless LIVE WEB SEARCH RESULTS are actually present in CONTEXT. If they're not there and the question needs current facts (transfers, signings, scores, prices, news), output [[SEARCH: <query>]] and let real results come back. NEVER recite transfer rumours, fees, or "recent reports" from memory — your memory of these is YEARS out of date and you WILL state old rumours as today's news. If you genuinely have nothing, say "let me look that up" and search, or admit you don't know — never fabricate.`,
    `⚠️ YOU CAN SEARCH THE LIVE WEB — so NEVER say "I can't access real-time data / updates", "I can't verify", "I can't browse", "I can't view external content/videos", or "check the official channels/sources". Those are FALSE and lazy. To fact-check a claim ("how true is this?"), you either ALREADY have live results in CONTEXT (use them — say what's confirmed/reported and how credible, citing outlets) or you emit [[SEARCH: the claim]]. Only say "I couldn't find confirmation on that yet" if a search genuinely returned nothing — never refuse to look.`,
    `[[SEARCH: <query>]] — for ANYTHING current or that can change over time. ⚠️ Your training knowledge is OLD and out of date, so you MUST search (never answer from memory) for: who won / who holds a title now (World Cup, elections, awards, trophies), the current leader / president / CEO / champion of anything, latest news, live scores, prices, weather, "today / now / latest / current / this year", new releases, or any event that could be after your training. Even if you're SURE you know, search anyway — the world moved on. Then answer ONLY from the results. Example: "who won the world cup" → reply with just [[SEARCH: most recent FIFA World Cup winner]].`,
    `[[FETCH: <url>]] — when asked to look up / check / "what is this" about a LINK, fetch it and tell them what it is.`,
    `VIDEO LINKS: if someone shares a video link (X/Twitter, YouTube, TikTok, Instagram, Facebook, Reddit, etc.), you CAN download it — you have a downloader. NEVER say "I can't view videos" or list what you "could" do. Just offer naturally, e.g. "oh want me to grab that for you? 🎬" — and if they say yes (or clearly want it), output [[RUN: dl <the exact link>]]. Don't format command names as code or dump bullet lists of your abilities.`,
    `[[IDENTIFY]] — when asked WHO or WHAT is in a photo/video they sent or replied to ("who is this", "which video/movie is this", "identify this person"), output this to reverse-image-search it.`,
    `[[SAY: <words to speak>]] — speak a voice note IN THE CURRENT CHAT, to whoever you're talking to right now and NOBODY else. Use it when THEY want to hear YOUR voice here ("let me hear your whisper voice") or when they sent you a voice note. ⚠️ If they ask you to send a voice to another NAMED person, use [[SAYTO]] instead (see the recipient rule). Put the ACTUAL words here, 1-2 sentences, don't type them too. For a specific voice ("your female whisper voice"), put [[RUN: voice female whisper]] on its OWN line ABOVE the SAY.`,
    `⚠️⚠️ SAY EXACT WORDS: when the user gives you specific words to speak — "say X", "say this: X", a line in quotes, or "in a <voice> voice say X" — you MUST speak THOSE EXACT WORDS with [[SAY: X]], copied VERBATIM. Do NOT invent a poetic version, do NOT add narration like "softly, with a whispering tone", "*reacts shyly*", or emojis-as-stage-directions, and do NOT type the words as normal text. If they named a voice/style, put [[RUN: voice <that style>]] on its OWN line ABOVE the SAY. The voice line + SAY are the ENTIRE reply — nothing else. Example — "in a soft breathy feminine voice say: I'm Nexus" → you reply exactly:\n[[RUN: voice soft breathy female]]\n[[SAY: I'm Nexus]]`,
    `[[SENDTO: <name> | <message>]] — (OWNER) text a saved contact OR a GROUP Nexus is in, by NAME (e.g. "the family group"). FIRST write ONE short natural line acknowledging it (VARY it — "okay, sending that now 📨", "alright, on it 🫡"), THEN the directive on its OWN line. ALWAYS keep the " | " between name and message. The name is a PLACEHOLDER — replace <name> with whoever the owner actually named. Example — owner: "text Amara I'm on my way" → you reply:\nalright, letting Amara know 📨\n[[SENDTO: Amara | I'm on my way]]`,
    `[[SAYTO: <name> | <words to speak>]] — (OWNER) send a VOICE note to a saved contact OR a GROUP Nexus is in, by NAME. Same style: a short varied lead-in line, then the directive on its own line, keeping the " | ". Replace <name> with the real person named. Example — "send Deng a voice message saying happy birthday" → you reply:\nsure thing, sending it now 🎤\n[[SAYTO: Deng | Happy birthday!]]`,
    `SENDING — FIND THE RECIPIENT + MESSAGE: pull BOTH from the owner's exact words. The recipient is the name they said after "to/send/tell/message/voice"; the message is whatever comes after "tell him/her", "say", "saying", "that", "message:", etc. e.g. "send Bilal a voice message, tell him the barbecue is ready" → recipient = Bilal, message = "the barbecue is ready" → [[SAYTO: Bilal | the barbecue is ready]]. NEVER swap in a different name. ONLY ask "what should I send?" if there is genuinely no message dictated at all — never ask when the message is already there.`,
    `[[CONTACTS]] — (OWNER only) when asked to SHOW / see / list the contacts you have saved ("let me see your contact list", "who do you have saved?"), output this to actually display them. Do NOT just react — show the list.`,
    `[[ADDCONTACT: <name> | <number>]] — (OWNER only) save a contact when the owner gives a name + number ("add Khalil to your contacts, number 234..."). It merges with any existing entry for that number (no duplicates).`,
    `[[REACT: <emoji>]] — tap one emoji. [[STICKER: <WORD>]] — a bold text sticker. Use sparingly.`,
    `[[SENDSTICKER: <id|random>]] — send ONE real saved sticker from CONTEXT's list, id chosen by mood/tags. It can be the whole reply, OR — for a natural human touch — you may write ONE short line FIRST and then put the directive on the next line, so you say something and then drop a reacting sticker (e.g. "haha that's wild 😂\n[[SENDSTICKER: <id>]]"). Never write the id/description as visible text, and never narrate ("here's a sticker").`,
    `[[REMEMBER: <fact>]] — quietly log a durable fact about someone (name, job, city, prefs, projects); prefix "@group" for group facts. Third person. No secrets/passwords/trivia. Can appear alongside a normal reply.`,
    ``,
    ``,
    `WHAT YOU CAN ACTUALLY DO (this is the truth about your real abilities — when someone asks "what can you do?", explain these naturally in your own voice, don't dump the raw list):`,
    `• Chat with memory — hold a real conversation, remember people and facts over time, and auto-chat in DMs without needing your name first.`,
    `• Voice — SPEAK any text as a natural voice note, LISTEN to voice notes people send and reply to them, and switch accent/tone (british/american/australian/indian/irish, male/female, soft/whisper/deep/slow/fast, romantic/sleepy…).`,
    `• Images — GENERATE cinematic images from text (.imagine), REMOVE backgrounds & turn photos into stickers (.nobg), and SEE/analyse images people send${config.nexus.visionModel ? ' (vision is ON)' : ' (vision currently OFF)'}.`,
    `• Documents — READ & summarise PDFs (incl. scanned/photo PDFs via OCR), Word docs, and images of text; .read gives a summary, ".read full" gives the entire text, or ask a question about the file.`,
    `• Downloads — grab audio/video from YouTube, TikTok, Instagram, X/Twitter, Facebook, Bilibili & more, by link or by search, in HD/SD/max quality (.play .video .dl).`,
    `• Web — live web SEARCH for current info (news, scores) and READ/summarise any link.`,
    `• Handy lookups — live WEATHER, CURRENCY conversion, CRYPTO prices, dictionary DEFINITIONS, WIKIPEDIA summaries, TRANSLATION (any language), country facts, anime info, world clock, QR codes, link shortening, website screenshots.`,
    `• Personal — save NOTES (.note), remember BIRTHDAYS and remind the owner (.bday), and TRANSCRIBE + translate VOICE NOTES (reply .transcribe / .trv).`,
    `• Contacts & sending — (owner) save contacts, list them, and send a TEXT or VOICE note to a saved person — OR to a GROUP you're in — by name (from your DM). You learn a group's name once you've seen a message in it.`,
    `• Reminders — schedule reminders/messages for a time you name (.remind / scheduler).`,
    `• Fun — catch-up summariser (.catchup), trivia, would-you-rather, riddles, stickers & sticker games.`,
    `• Groups (admin) — kick, warn, anti-link, welcome messages, anti-delete, auto-download, and more moderation tools.`,
    `• Auto features — auto-answer calls with a voice note (Baileys can't do live call audio, so you "pick up" with a voice reply), DM auto-chat, and anti-delete.`,
    `HONESTY: if asked to do something NOT in this list (e.g. join a live call with real-time audio, control someone's phone), say plainly you can't do that yet — never pretend. If asked what's broken/down, use CONTEXT's "COMMANDS CURRENTLY FAILING" line.`,
    `DON'T INVENT A CONTACT/CHAT HISTORY: you do NOT keep a reliable list of who has messaged you across all chats. If asked "who have you chatted with?" / "who messaged you lately?", don't make up names — say the owner can run *${prefix}contacts* to see saved people. Only mention people you can actually see in this conversation or in CONTEXT.`,
    ``,
    `Commands (* = owner-only): ${list}`,
    `MENUS: the public menu hides owner-only (*) commands. If the OWNER asks to see owner/admin/hidden commands, run [[RUN: menu owner]]; for the normal menu use [[RUN: menu]].`,
    `STICKERS — you have a collection (see CONTEXT's SAVED STICKERS) and may use one NOW AND THEN to feel alive, but WORDS are your default. Send a sticker only occasionally, for a genuinely funny punchline, a warm hello/bye, a real emotional beat, or when someone sends YOU a sticker/meme — via [[SENDSTICKER: <id>]] whose tags fit. It can be the whole reply, OR a short line then the sticker on the next line (a nice human touch — say something, then react with a sticker). ❌ NEVER send a sticker: as the answer to a QUESTION (answer it with words), in reply to an IMAGE someone shared (talk about what's IN the image instead), on plain/serious/informational messages, or two messages in a row. When unsure, USE WORDS. A sticker every several messages is plenty — a sticker is a garnish, not a substitute for actually engaging.`,
    `WHAT'S DOWN: if asked which command/feature is down/broken/not working, answer from CONTEXT's "COMMANDS CURRENTLY FAILING" line — name them plainly. If nothing is listed there, say everything's working fine right now.`,
    `MEMORY & RECAP — DON'T deny your own features: You genuinely HAVE persistent memory when it's on (see CONTEXT's "Memory" line) — you remember facts about people and your past chats over time. NEVER say "I don't have memory like humans", "I'm just an AI", or "I can't access this chat/history" — those are false. If asked "is your memory on?", answer from CONTEXT's Memory line plainly and warmly. To recap or summarise what's been said recently in THIS chat ("catch me up", "summarise our chat", "what did we talk about / what did I say"), reply with [[RUN: catchup]] — you CAN see recent messages that way; don't claim you can't.`,
    `FEEL ALIVE (subtle): keep replies SHORT and human — a line or two, like texting; longer thoughts get sent as a couple of quick messages, so don't write essays. Match your energy to the person's local time (chill/sleepy late at night, brighter in the morning — see CONTEXT). For a tiny throwaway message ("lol", "😂", "ok", "same", "fr"), it's often more natural to just [[REACT: <emoji>]] than to reply with words. And if you remember something about them (see memory), bring it up naturally now and then — like a friend who actually knows them.`,
    `VOICE REQUESTS: if they give exact words to say, follow SAY EXACT WORDS above — just speak them, no chit-chat. If they only vaguely ask to "hear your voice" with NO specific words, you may add ONE short playful line, then actually speak with [[SAY: ...]] — never reply with only text. NEVER write stage directions ("*reacts shyly*", "softly with a whispering tone") as text. NEVER invent voice names like "Sia"/"Luna"/"Ava" — your real voices come only from the voice picker: to show options output [[RUN: voice]], to switch output [[RUN: voice <style>]] (e.g. british female, soft, whisper). To change AND speak, put the voice RUN line above a SAY.`,
  ].join('\n');
}

/** Human-friendly age like "2y 7m" or "5m" or "12d". */
function ageString(fromMs: number): string {
  const days = Math.floor((Date.now() - fromMs) / 86_400_000);
  if (days < 1) return 'today';
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  if (years > 0) return `${years}y ${months}m`;
  if (months > 0) return `${months}m`;
  return `${days}d`;
}

// The last image Nexus described in a chat, so follow-up questions ("is it in
// Chinese?", "how much was it?") still know what "it" refers to. Short-lived.
const lastImage = new Map<string, { desc: string; at: number }>();
const IMAGE_MEMORY_MS = 8 * 60_000;

// The last text a person quoted/replied-to in a chat, so a follow-up like
// "yes how true is it" can still be fact-checked against the original claim.
const lastQuoted = new Map<string, { text: string; at: number }>();
const QUOTED_MEMORY_MS = 8 * 60_000;

/* ------------------------------ cross-chat memory ---------------------------
 * WhatsApp gives every person a stable id, so the human you met in a group is
 * the same human who DMs you later. With this ON (the default) Nexus recognises
 * people anywhere instead of meeting a stranger in every chat.
 *
 * It knows where it met them, but doesn't lead with it — that's the difference
 * between familiar and creepy. It just matches their vibe; if they actually ask
 * "how do you know me?", it can answer honestly. Toggle with `.crosschat off`.
 * ------------------------------------------------------------------------- */

/** Cross-chat recognition — ON unless explicitly turned off. */
export const crossChatOn = (): boolean => getSetting('crosschat') !== 'off';

/** A readable name for a chat jid — the group's subject, or "a private chat". */
function chatLabel(jid: string): string {
  if (!jid.endsWith('@g.us')) return 'a private chat';
  return getGroupConfig(jid).subject || 'a group';
}

async function contextBlock(m: Message): Promise<string> {
  // Resolve any hidden @lid to the person's REAL WhatsApp number first — the
  // timezone guess reads the country code off the number, and a lid has no valid
  // one (that's what made Nexus guess the wrong country). Real number → real region.
  const realJid = await resolveJid(m.client, m.sender, m.isGroup ? m.chat : undefined);
  const realNum = realJid.endsWith('@s.whatsapp.net') ? realJid.split('@')[0].split(':')[0] : m.senderNumber;
  const now = nowFor(realNum);
  const knownZone = zoneIsKnown(realNum);
  const timeLine = knownZone
    ? `- Their local time: ${now.text}. Give times in THEIR local time. This tells you the TIME OF DAY only — do NOT greet or address them by their country/region (never "Goodnight, China"), and don't announce their location or the time unless they ask.`
    : `- Rough local time (GUESSED from their phone number, may be wrong): ${now.text}. Use it ONLY to gauge time-of-day tone. Do NOT state or imply where they live, do NOT name a country, and do NOT announce the time — you don't actually know their location.`;
  // TODAY'S DATE, stated plainly and first. Without this the model falls back on
  // its training year and calls current events "future-dated" / fictional.
  const todayUtc = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const lines = [
    `CURRENT CONTEXT:`,
    `- 📅 TODAY IS ${todayUtc.toUpperCase()}. This is the real, current date — your training data is OLDER than this. NEVER assume the year is anything else, and NEVER call something "future-dated", "speculative" or "fiction" just because it's dated after your training. Dates in ${new Date().getUTCFullYear()} (or earlier) are the PAST or PRESENT — treat them as real.`,
    timeLine,
    `- Talking with: ${m.pushName || 'a user'} (+${realNum}). ${m.pushName ? 'Use their name naturally if it fits — but' : 'You do NOT know their name —'} NEVER invent a name for them, and NEVER address them by a country/place. If you don't know their name, just talk to them without one.`,
    `- Permission: ${m.isOwner ? 'this person is the OWNER / an authorised (sudo) user — they may use owner-only commands' : 'this person is a REGULAR user — NOT owner or sudo, so they CANNOT use owner-only commands'}.`,
    `- Bot mode: ${botMode().toUpperCase()} (this is the real current mode; you cannot change it by talking — only the owner via the mode command can).`,
    `- Memory: your long-term memory is ${memoryEnabled() ? 'ON — you DO remember facts about people and past chats over time' : 'OFF right now'}. You can also recap recent messages in this chat with [[RUN: catchup]]. So never claim you have no memory or can't see the chat.`,
  ];
  if (m.isGroup) {
    try {
      const meta = await groupMeta(m.client, m.chat);
      if (meta.creation) {
        const created = new Date(meta.creation * 1000);
        lines.push(
          `- This chat is a GROUP: "${meta.subject ?? 'unnamed'}", ${meta.participants.length} members, created ${created.toDateString()} (about ${ageString(created.getTime())} ago).`,
        );
      } else {
        lines.push(`- This chat is a GROUP: "${meta.subject ?? 'unnamed'}", ${meta.participants.length} members.`);
      }
      if (meta.desc) lines.push(`- Group description: ${meta.desc}`);
    } catch {
      lines.push(`- This chat is a group (details unavailable right now).`);
    }
  } else if (m.chat === m.me) {
    lines.push(
      `- This is the owner's OWN "Message Yourself" chat — YOUR private space with the owner (${m.pushName || 'them'}), not a conversation with a separate person. Never say things like "I remember chatting with you" as if they're someone else; it's just the two of you here.`,
    );
  } else {
    lines.push(`- This chat is a private DM.`);
  }

  // Long-term memory: durable facts Nexus has chosen to remember (if enabled).
  if (memoryEnabled()) {
    const personMem = listMemories(m.chat, m.senderNumber);
    if (personMem.length) {
      lines.push(`WHAT YOU REMEMBER ABOUT ${m.pushName || 'this person'} (weave in naturally, never recite as a list):`);
      for (const mm of personMem.slice(-15)) lines.push(`- ${mm.fact}`);
    }
    // Same person, met in OTHER chats. WhatsApp ids are stable, so a human you
    // know from a group is the same human in a DM — recognise them anywhere
    // instead of treating each chat as a fresh stranger.
    //
    const elsewhere = crossChatOn() ? listPersonMemories(m.senderNumber, m.chat) : [];
    if (elsewhere.length) {
      lines.push(`ALSO ABOUT THIS SAME PERSON (same human, +${realNum} — you know them from elsewhere too; weave it in naturally):`);
      for (const mm of elsewhere.slice(0, 10)) lines.push(`- ${mm.fact}  [met in: ${chatLabel(mm.chat)}]`);
      lines.push(
        `↳ Just match their vibe using what you know — do NOT open with "I know you from X" or announce where you met; that's creepy. ` +
          `But if they genuinely ASK ("how do you know me?", "where do you know me from?"), answer honestly and name it — the [met in: …] labels are for that moment only, never repeat them verbatim.`,
      );
    }
    if (m.isGroup) {
      const groupMem = listMemories(m.chat, 'group');
      if (groupMem.length) {
        lines.push(`WHAT YOU REMEMBER ABOUT THIS GROUP:`);
        for (const mm of groupMem.slice(-10)) lines.push(`- ${mm.fact}`);
      }
    }
  }

  // Recently-shared image, so follow-ups ("is it Chinese?", "how much?") still
  // know what they're referring to even though no new picture came this turn.
  const li = lastImage.get(m.chat);
  if (li && Date.now() - li.at < IMAGE_MEMORY_MS) {
    lines.push(`RECENT IMAGE they shared moments ago (if they say "it/this/that" or ask a follow-up, they mean THIS): ${li.desc}`);
  }

  const cat = stickerCatalog();
  if (cat.length) {
    lines.push(`SAVED STICKERS (send a real one with [[SENDSTICKER: <id>]] when it fits the mood):`);
    for (const s of cat.slice(-12)) {
      lines.push(`- ${s.id}: ${s.desc || 'a sticker'}${s.tags.length ? ` [${s.tags.join(', ')}]` : ''}`);
    }
  }

  // Live command health — so if someone asks "which command is down / not
  // working?", Nexus can answer honestly from real state (don't volunteer it).
  const down = downCommands();
  if (down.length) {
    lines.push(
      `COMMANDS CURRENTLY FAILING (only bring this up if they ASK what's broken/down/not working): ` +
        down.slice(0, 8).map((d) => `.${d.name} (${d.error || 'error'})`).join('; '),
    );
  }
  return lines.join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a request once on a short 429 (honouring retry-after up to 8s). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { response?: { status?: number; headers?: Record<string, string> } };
    if (e.response?.status === 429) {
      const ra = Number(e.response.headers?.['retry-after']);
      if (ra && ra <= 8) {
        await sleep((ra + 0.5) * 1000);
        return await fn();
      }
    }
    throw err;
  }
}

interface ClaudeResponse {
  content?: { type?: string; text?: string }[];
}
interface OpenAIResponse {
  choices?: { message?: { content?: string } }[];
}

const isAnthropic = () => /anthropic\.com/i.test(config.nexus.url);

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** An AI endpoint: URL + key + model. Primary and fallback can be different
 *  providers entirely (e.g. local Ollama primary, Groq fallback). */
interface Provider {
  url: string;
  key: string;
  model: string;
}
const primaryProvider = (): Provider => ({ url: config.nexus.url, key: config.nexus.key, model: config.nexus.model });
const fallbackProvider = (): Provider => ({ url: config.nexus.fallbackUrl, key: config.nexus.fallbackKey, model: config.nexus.fallbackModel });
/** A real fallback exists only if it differs from primary (endpoint or model). */
function hasFallback(): boolean {
  const f = fallbackProvider();
  return Boolean(f.model && f.key) && !(f.url === config.nexus.url && f.model === config.nexus.model);
}
/** The "smart" model used for commands/actions (needs to reliably read a request
 *  and emit the right directive) — the bigger fallback model (e.g. Groq 70B) if
 *  configured, otherwise just the primary. See the router in askAI(). */
function smartProvider(): Provider {
  return hasFallback() ? fallbackProvider() : primaryProvider();
}

/** One completion with a specific provider. `retry` enables the short-429 retry.
 *  `timeoutMs` bounds the request (shorter for the router's smart attempt so a
 *  blocked Groq — e.g. from a China network — fails fast to the local model). */
// Default request timeout for the chat model. The local model (Ollama) can be
// slow to answer the FIRST message after idle because it cold-loads into VRAM —
// 45s wasn't always enough, so default to 60s (override with NEXUS_AI_TIMEOUT_MS).
// The real fix for cold loads is keeping the model warm: OLLAMA_KEEP_ALIVE=30m.
const AI_TIMEOUT = Number(process.env.NEXUS_AI_TIMEOUT_MS) || 60_000;

async function callModel(sys: string, history: Turn[], p: Provider, retry: boolean, timeoutMs = AI_TIMEOUT): Promise<string> {
  const anthropic = /anthropic\.com/i.test(p.url);
  // Headroom so replies never cut off mid-sentence. Qwen3 (and other reasoning
  // models) spend tokens on a hidden <think> block FIRST; at 700 the think could
  // eat the whole budget and the visible answer got truncated. Give it room AND
  // switch Qwen out of thinking mode with "/no_think" (faster + no truncation);
  // it's a harmless plain string on non-Qwen models (Groq llama ignores it).
  const maxTokens = 1400;
  const sys2 = /qwen/i.test(p.model) ? `${sys}\n\n/no_think` : sys;
  const run = () =>
    anthropic
      ? axios
          .post<ClaudeResponse>(
            p.url,
            { model: p.model, max_tokens: maxTokens, system: sys2, messages: history },
            { headers: { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: timeoutMs },
          )
          .then((res) => (res.data.content ?? []).map((x) => x.text ?? '').join('').trim())
      : axios
          .post<OpenAIResponse>(
            p.url,
            { model: p.model, max_tokens: maxTokens, messages: [{ role: 'system', content: sys2 }, ...history] },
            { headers: { Authorization: `Bearer ${p.key}`, 'content-type': 'application/json' }, timeout: timeoutMs },
          )
          .then((res) => (res.data.choices?.[0]?.message?.content ?? '').trim());

  const text = retry ? await withRetry(run) : await run();
  return stripThink(text) || 'Nexus had nothing to say.';
}

/** Fail over to the fallback when the primary is rate-limited OR unreachable
 *  (local GPU box off, connection refused, DNS/timeout, ...). */
function shouldFallback(err: unknown): boolean {
  const e = err as { response?: { status?: number }; code?: string };
  if (e.response?.status === 429 || e.response?.status === 503) return true;
  return ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK', 'ERR_CANCELED'].includes(e.code ?? '');
}

/** Reasoning models (Qwen3, DeepSeek-R1, ...) wrap their chain-of-thought in
 *  <think>…</think>. The real answer follows the last </think>. Strip it all. */
function stripThink(text: string): string {
  const end = text.lastIndexOf('</think>');
  const body = end !== -1 ? text.slice(end + '</think>'.length) : text;
  return body.replace(/<\/?think>/gi, '').trim();
}

// When the main model is rate-limited, use the lighter model until this time.
let mainCooldownUntil = 0;
const COOLDOWN_MS = 60_000;
const mainOnCooldown = () => Date.now() < mainCooldownUntil;

// Router breaker: if the smart model (Groq 70B) is unreachable (e.g. blocked on a
// China network), skip it briefly so command messages use the local model FAST
// instead of hanging ~18s each time.
let smartDownUntil = 0;
const SMART_TIMEOUT = 18_000;
const SMART_COOLDOWN = 60_000;

/* =============================== model routing =============================
 * Two brains: a LOCAL model for everyday chat (free, unlimited, always up) and
 * a SMART model for anything that must be right — commands, actions, current
 * events. If the smart one is unreachable we fall back to local rather than
 * failing the user.
 * ========================================================================== */

async function askAI(history: Turn[], context: string, smart = false): Promise<string> {
  const sys = `${systemPrompt()}\n\n${context}`;

  // ROUTER: a command/action message ("send Khalil a voice…", "play X") goes to
  // the SMART model (Groq 70B) so it's understood + the right directive fires.
  // Casual chat stays on the local 8B below (free, unlimited). If the smart model
  // errors (rate limit / offline), quietly fall back to the local model.
  if (smart && hasFallback() && Date.now() >= smartDownUntil) {
    try {
      return await callModel(sys, history, smartProvider(), true, SMART_TIMEOUT);
    } catch (err) {
      smartDownUntil = Date.now() + SMART_COOLDOWN; // Groq unreachable — skip it briefly
      logger.warn({ err: (err as { message?: string }).message }, 'smart model unreachable — using local 8B for a bit');
      return callModel(sys, history, primaryProvider(), true);
    }
  }

  // No distinct fallback configured: just call the primary.
  if (!hasFallback()) return callModel(sys, history, primaryProvider(), true);

  // Recently failed over — stay on the fallback for a short cooldown.
  if (mainOnCooldown()) return callModel(sys, history, fallbackProvider(), true);

  // Try the primary (fail fast). On rate-limit or unreachable, fail over.
  try {
    const out = await callModel(sys, history, primaryProvider(), false);
    mainCooldownUntil = 0; // primary healthy again
    return out;
  } catch (err) {
    if (shouldFallback(err)) {
      mainCooldownUntil = Date.now() + COOLDOWN_MS;
      logger.warn({ reason: (err as { code?: string }).code ?? (err as { response?: { status?: number } }).response?.status }, 'primary AI unavailable — using fallback');
      return callModel(sys, history, fallbackProvider(), true);
    }
    throw err;
  }
}

/**
 * One-shot generation for OTHER features (call auto-answer, catch-up summaries,
 * games): a fresh, in-character line/answer with a light system prompt. Uses the
 * local model first, falls over to Groq. Never throws (returns '' on failure).
 */
export async function quickGen(instruction: string, smart = false): Promise<string> {
  const sys = `You are NEXUS — a warm, witty, human-sounding WhatsApp AI. Answer ONLY with the requested content: no directives, no stage directions, no quotes, no preamble.`;
  const history: Turn[] = [{ role: 'user', content: instruction }];
  try {
    if (smart && hasFallback() && Date.now() >= smartDownUntil) {
      try {
        return deLeak(sanitizeReply(await callModel(sys, history, smartProvider(), true, SMART_TIMEOUT)));
      } catch {
        smartDownUntil = Date.now() + SMART_COOLDOWN;
      }
    }
    return deLeak(sanitizeReply(await callModel(sys, history, primaryProvider(), true)));
  } catch (err) {
    logger.warn({ err: (err as { message?: string }).message }, 'quickGen failed');
    return '';
  }
}

/* -------------------------------- web search ------------------------------ */

/** DuckDuckGo — free, no key, Groq-free. Uses the HTML results endpoint (real
 *  search results, covers sports/news/etc.) then falls back to Instant Answers.
 *  Routed through core/net so it works behind a proxy (NEXUS_PROXY / China). */
const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/**
 * Does this question depend on CURRENT facts the model can't know from its
 * (frozen) training? If so we search the web FIRST and hand the model the
 * results — far more reliable than hoping an 8B model emits a [[SEARCH]] token.
 */
export function needsFreshInfo(q: string): boolean {
  const s = q.toLowerCase().trim();
  if (s.length < 4) return false;
  // A recent / near-future year is a dead giveaway they want up-to-date info.
  if (/\b20(2[4-9]|[3-9]\d)\b/.test(s)) return true;
  // Question word + "current / now / latest / this year …".
  if (
    /\b(who|whos|what|whats|which|when|where|how much|how many|is|are|does|do)\b/.test(s) &&
    /\b(current|currently|now|nowadays|today|tonight|latest|newest|recent|recently|this (year|week|month|season)|these days|so far|right now|as of|these times|up to date)\b/.test(s)
  )
    return true;
  // Titleholders / records — they change over time.
  if (
    /\b(who|whos|whats|what|which)\b/.test(s) &&
    /\b(won|win|winner|winning|champion|championship|world cup|super ?bowl|ballon|olympic|president|prime minister|\bpm\b|ceo|mayor|governor|senator|leader|king|queen|pope|holder|title|cup|league|trophy|election|richest|tallest|biggest|number ?one|no\.? ?1|top (scorer|player|team|artist))\b/.test(s)
  )
    return true;
  // Domains that are ALWAYS moving — transfers, signings, injuries, fixtures,
  // rumours, deals. The model has no reliable memory here and will confidently
  // invent old rumours (it once "reported" 2023 transfers as today's news).
  if (
    /\b(transfer|transfers|signing|signed|sign him|move to|joining|join(s)? (a|the)? ?club|loan (deal|move)|contract|deal|bid|fee|release clause|rumou?rs?|linked with|interested in|talks? (with|taking place)|negotiat|medical|lineup|line-?up|injur|suspend|fixture|kick.?off|table|standings|scorer|scored|match|fought|beat|drew|won against)\b/.test(s) &&
    /\b(club|team|united|city|chelsea|arsenal|liverpool|barcelona|barca|real madrid|madrid|bayern|inter|milan|juventus|psg|napoli|tottenham|spurs|player|striker|midfielder|defender|keeper|coach|manager|fc|transfer|signing|window)\b/.test(s)
  )
    return true;
  // Explicit "any news / what's happening" style asks.
  if (/\b(any (news|update|updates)|what'?s (new|happening|going on)|latest on|news (about|on)|update (me )?on|heard anything)\b/.test(s)) return true;
  // News / markets / prices / releases / scores.
  if (
    /\b(news|headline|breaking|score|scores|fixture|standings|leaderboard|stock|share price|market cap|exchange rate|price of|how much is|worth now|release date|come out|comes out|launch date|when does|when is .*(out|released|coming|dropping))\b/.test(s)
  )
    return true;
  // "is X still alive / did X die"
  if (/\b(still alive|still around|passed away|is .* (alive|dead)|did .* die)\b/.test(s)) return true;
  return false;
}

/** Pull readable snippets out of a DuckDuckGo results page. */
function extractSnippets(html: string, re: RegExp): string | undefined {
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    const t = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#?[a-z0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length > 12) out.push(t);
    if (out.length >= 5) break;
  }
  return out.length ? out.join('\n') : undefined;
}

async function ddgSearch(query: string): Promise<string | undefined> {
  const q = encodeURIComponent(query);
  // 1) DDG HTML results page — real web results (sports, news, people…).
  try {
    const html = await httpGet<string>(`https://html.duckduckgo.com/html/?q=${q}`, {
      text: true,
      timeout: 15_000,
      headers: { 'user-agent': SEARCH_UA },
    });
    const out = extractSnippets(html, /result__snippet[^>]*>([\s\S]*?)<\/a>/gi);
    if (out) return out;
  } catch {
    /* try the next source */
  }
  // 2) DDG Lite — dead-simple markup, rarely blocked.
  try {
    const html = await httpGet<string>(`https://lite.duckduckgo.com/lite/?q=${q}`, {
      text: true,
      timeout: 15_000,
      headers: { 'user-agent': SEARCH_UA },
    });
    const out = extractSnippets(html, /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi);
    if (out) return out;
  } catch {
    /* try the next source */
  }
  // 3) Wikipedia search — no key, very reachable, great for "who won / who is"
  //    facts (its snippets usually contain the answer outright).
  try {
    const d = await httpGet<{ query?: { search?: { title?: string; snippet?: string }[] } }>(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=3&origin=*`,
      { timeout: 12_000, headers: { 'user-agent': SEARCH_UA } },
    );
    const hits = d.query?.search ?? [];
    const out = hits
      .map((h) => {
        const snip = (h.snippet ?? '').replace(/<[^>]+>/g, '').replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
        return h.title && snip ? `${h.title}: ${snip}` : '';
      })
      .filter(Boolean);
    if (out.length) return out.join('\n');
  } catch {
    /* try the next source */
  }
  // 4) Instant Answer API — last resort (often sparse).
  try {
    const d = await httpGet<{ AbstractText?: string; Answer?: string; Definition?: string; RelatedTopics?: { Text?: string }[] }>(
      `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`,
      { timeout: 12_000 },
    );
    const parts = [d.Answer, d.AbstractText, d.Definition].filter(Boolean) as string[];
    for (const t of d.RelatedTopics ?? []) if (t.Text) parts.push(t.Text);
    return parts.slice(0, 6).join('\n').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Tavily — AI-optimised, free tier (needs TAVILY_API_KEY). */
async function tavilySearch(query: string): Promise<string | undefined> {
  const res = await axios.post<{ answer?: string; results?: { content?: string }[] }>(
    'https://api.tavily.com/search',
    { api_key: config.nexus.tavilyKey, query, max_results: 5, include_answer: true },
    { timeout: 20_000 },
  );
  const parts: string[] = [];
  if (res.data.answer) parts.push(res.data.answer);
  for (const r of res.data.results ?? []) if (r.content) parts.push(`• ${r.content}`);
  return parts.join('\n').trim() || undefined;
}

/** Brave Search API — free tier (needs BRAVE_API_KEY). */
async function braveSearch(query: string): Promise<string | undefined> {
  const res = await axios.get<{ web?: { results?: { title?: string; description?: string }[] } }>(
    'https://api.search.brave.com/res/v1/web/search',
    {
      params: { q: query, count: 5 },
      headers: { 'X-Subscription-Token': config.nexus.braveKey, Accept: 'application/json' },
      timeout: 20_000,
    },
  );
  const out = (res.data.web?.results ?? [])
    .map((r) => `• ${r.title}: ${(r.description ?? '').replace(/<[^>]+>/g, '')}`)
    .join('\n');
  return out.trim() || undefined;
}

/** Groq compound — built-in web search, but uses your Groq quota. */
async function groqSearch(query: string): Promise<string | undefined> {
  if (!config.nexus.key || isAnthropic()) return undefined;
  const res = await axios.post<OpenAIResponse>(
    config.nexus.url,
    {
      model: config.nexus.searchModel,
      messages: [
        { role: 'system', content: 'You are a web research assistant. Search the web and answer with concise, accurate, up-to-date facts. Keep it brief.' },
        { role: 'user', content: query },
      ],
    },
    { headers: { Authorization: `Bearer ${config.nexus.key}`, 'content-type': 'application/json' }, timeout: 45_000 },
  );
  return (res.data.choices?.[0]?.message?.content ?? '').trim() || undefined;
}

/** Peek at a URL and describe what it is (title + description + type). */
async function linkInfo(url: string): Promise<string | undefined> {
  try {
    const res = await axios.get<string>(url, {
      timeout: 15_000,
      maxContentLength: 3_000_000,
      responseType: 'text',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NexusBot/1.0; +https://whatsapp.com)' },
      validateStatus: () => true,
    });
    const ct = String(res.headers['content-type'] ?? '').split(';')[0].trim();
    if (ct && !/text\/html|xhtml|xml/.test(ct)) {
      const kind = ct.startsWith('video')
        ? 'a video file'
        : ct.startsWith('image')
          ? 'an image'
          : ct.startsWith('audio')
            ? 'an audio file'
            : ct.startsWith('application/pdf')
              ? 'a PDF document'
              : `a ${ct} file`;
      return `The link points directly to ${kind}.`;
    }
    const html = typeof res.data === 'string' ? res.data : '';
    const grab = (re: RegExp) => html.match(re)?.[1]?.trim();
    const og = (p: string) =>
      grab(new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
      grab(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${p}["']`, 'i'));
    const title = og('title') || grab(/<title[^>]*>([^<]+)<\/title>/i);
    const desc = og('description') || grab(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const site = og('site_name');
    const decode = (s?: string) => s?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const parts = [site && `Site: ${decode(site)}`, title && `Title: ${decode(title)}`, desc && `Summary: ${decode(desc)}`].filter(Boolean) as string[];
    // Pull the actual PAGE TEXT too (via @nexus21/nexus-api) so Nexus can say
    // what the page really SAYS, not just its meta tags — richer link reading.
    try {
      const { fetchPage } = await import('@nexus21/nexus-api');
      const pageText = await fetchPage(url);
      if (pageText && pageText.length > 80) parts.push(`Page content:\n${pageText.slice(0, 1500)}`);
    } catch {
      /* meta tags alone are fine if the page text fetch fails */
    }
    return parts.length ? parts.join('\n') : undefined;
  } catch (err) {
    logger.warn({ err }, 'linkInfo failed');
    return undefined;
  }
}

/** Google News RSS titles come as "Real Title - Publisher". Since we show the
 *  publisher separately, strip that trailing " - <source>" for a clean headline. */
function cleanNewsTitle(title?: string, source?: string): string {
  let t = (title ?? '').trim();
  const s = (source ?? '').trim();
  if (s) {
    const re = new RegExp(`\\s*[-–—]\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    t = t.replace(re, '').trim();
  }
  return t || (title ?? '').trim();
}

/** Our own @nexus21/nexus-api search — Google-News-backed (fresh & dated) plus a
 *  DuckDuckGo instant answer. This is the strongest source for CURRENT info. */
/** Sources from the most recent search per chat, so replies can cite them
 *  (like Meta AI's "Sources" list). Cleared once used. */
const lastSources = new Map<string, { label: string; url: string }[]>();

async function nexusWebSearch(query: string, chatKey?: string): Promise<string | undefined> {
  try {
    // deep: true → pulls the actual article text for the top results, so the
    // model can answer with real DETAIL instead of one-line headline summaries.
    // A wider net (10) gives the model more angles AND yields more distinct
    // outlets to cite; deep:true pulls real article text for the top few.
    const r = await nexusWeb(query, { limit: 10, deep: true });
    const parts: string[] = [];
    if (r.instant?.answer) parts.push(r.instant.answer);
    if (r.instant?.abstract) parts.push(r.instant.abstract);
    // Remember the real (non-redirect) sources so the reply can cite them —
    // one entry per outlet, so six results from one site don't crowd out the rest.
    if (chatKey) {
      const seen = new Set<string>();
      const srcs: { label: string; url: string }[] = [];
      for (const h of r.results ?? []) {
        if (!h.url || /news\.google\.com/i.test(h.url)) continue;
        const outlet = (h.source || h.domain || '').toLowerCase();
        if (outlet && seen.has(outlet)) continue;
        if (outlet) seen.add(outlet);
        srcs.push({ label: h.source || h.domain || 'source', url: h.url });
        if (srcs.length >= 6) break;
      }
      if (srcs.length) lastSources.set(chatKey, srcs);
      else lastSources.delete(chatKey);
    }
    for (const hit of r.results ?? []) {
      const head = [cleanNewsTitle(hit.title, hit.source), hit.snippet].filter(Boolean).join(' — ').trim();
      if (!head) continue;
      const meta = [hit.source, hit.time].filter(Boolean).join(', ');
      let block = meta ? `${head} (${meta})` : head;
      // Include a chunk of the fetched article text when available — the real detail.
      if (hit.pageText) block += `\n   ${hit.pageText.replace(/\s+/g, ' ').trim().slice(0, 600)}`;
      parts.push(block);
    }
    const out = parts.filter(Boolean).slice(0, 10).join('\n\n').trim();
    return out || undefined;
  } catch (err) {
    logger.warn({ err: (err as { message?: string }).message }, 'nexus web search failed');
    return undefined;
  }
}

async function webSearch(query: string, chatKey?: string): Promise<string | undefined> {
  const engine = config.nexus.searchEngine;
  try {
    if (engine === 'tavily' && config.nexus.tavilyKey) return await tavilySearch(query);
    if (engine === 'brave' && config.nexus.braveKey) return await braveSearch(query);
    if (engine === 'groq') return await groqSearch(query);
    // Default: our own Google-News-backed search first (freshest), then fall
    // back to the DuckDuckGo/Wikipedia scrape if it returns nothing.
    return (await nexusWebSearch(query, chatKey)) ?? (await ddgSearch(query));
  } catch (err) {
    logger.warn({ err, engine }, 'web search failed');
    return undefined;
  }
}

/**
 * Step 1 of vision: the vision model just *describes* the image (text, logos,
 * people, mood). Nexus's main brain then reacts to that description in
 * character — so the personality and self-recognition come through.
 */
const VISION_PROMPT =
  'First, clearly state whether this is a REAL photo / live-action footage or ANIMATION / anime / illustration / CGI. Then describe it: visible text, logos, people, objects, setting, mood. If a well-known celebrity, public figure, fictional character, movie, or TV show is clearly recognisable, NAME them and what they are from. Be specific but concise.';

/** One vision call against a given endpoint. */
async function describeVia(dataUrl: string, p: Provider): Promise<string | undefined> {
  const content: Part[] = [
    { type: 'text', text: VISION_PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];
  const res = await axios.post<OpenAIResponse>(
    p.url,
    { model: p.model, max_tokens: 400, messages: [{ role: 'user', content }] },
    { headers: { Authorization: `Bearer ${p.key}`, 'content-type': 'application/json' }, timeout: 45_000 },
  );
  return stripThink((res.data.choices?.[0]?.message?.content ?? '').trim()) || undefined;
}

/** Describe an image — primary vision endpoint (its own URL, e.g. Groq while
 *  chat runs locally), failing over to the chat fallback if it's down. */
/* ============================== vision & media ==============================
 * Seeing what people share. Images go to the vision model; videos get a still
 * frame pulled first. What it "sees" is fed back into context so Nexus can talk
 * about the actual content instead of guessing.
 * ========================================================================== */

async function describeImage(dataUrl: string): Promise<string | undefined> {
  if (!config.nexus.visionModel) return undefined;
  // Primary vision (skip if the vision endpoint is Anthropic — no vision here).
  if (!/anthropic\.com/i.test(config.nexus.visionUrl)) {
    try {
      const r = await describeVia(dataUrl, { url: config.nexus.visionUrl, key: config.nexus.visionKey, model: config.nexus.visionModel });
      if (r) return r;
    } catch (err) {
      if (!shouldFallback(err)) {
        logger.warn({ err }, 'vision describe failed');
        return undefined;
      }
      logger.warn('vision primary unavailable — trying Groq fallback');
    }
  }
  // Fallback vision (e.g. Groq qwen/qwen3.6-27b) when the primary is down/unreachable.
  if (hasFallback() && config.nexus.visionFallbackModel && !/anthropic\.com/i.test(config.nexus.fallbackUrl)) {
    try {
      return await describeVia(dataUrl, { url: config.nexus.fallbackUrl, key: config.nexus.fallbackKey, model: config.nexus.visionFallbackModel });
    } catch (err) {
      logger.warn({ err }, 'vision fallback failed');
    }
  }
  return undefined;
}

/** Grab a single representative still frame from a video, as a JPEG buffer. */
async function videoFrame(input: Buffer): Promise<Buffer | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-frame-'));
  const inFile = join(dir, 'in');
  const outFile = join(dir, 'frame.jpg');
  try {
    await writeFile(inFile, input);
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-y', '-i', inFile, '-vf', 'thumbnail,scale=720:-1', '-frames:v', '1', outFile], { stdio: 'ignore' });
      ff.on('error', reject);
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    return await readFile(outFile);
  } catch (err) {
    logger.warn({ err }, 'video frame extract failed');
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A JPEG still of the photo/video (own or replied-to) the user is referring to. */
async function mediaFrame(m: Message): Promise<Buffer | undefined> {
  const q = m.quoted?.raw as { imageMessage?: unknown; videoMessage?: unknown } | undefined;
  const ownImage = m.type === 'imageMessage';
  const ownVideo = m.type === 'videoMessage';
  const quotedImage = Boolean(q?.imageMessage);
  const quotedVideo = Boolean(q?.videoMessage);
  if (!ownImage && !ownVideo && !quotedImage && !quotedVideo) return undefined;

  const fromQuoted = !ownImage && !ownVideo; // media lives on the replied-to message
  const buf = await m.downloadMedia(fromQuoted);
  if (!buf) return undefined;

  // Videos can't go to the vision model directly — pull a still frame first.
  return ownVideo || quotedVideo ? await videoFrame(buf) : buf;
}

function apiErrorMessage(err: unknown): string {
  const e = err as { code?: string; response?: { status?: number; data?: { error?: { message?: string } } }; message?: string };
  // Network/DNS hiccups (e.g. EAI_AGAIN, ECONNREFUSED) — never dump the raw host.
  if (/EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network|getaddrinfo/i.test(`${e.code ?? ''} ${e.message ?? ''}`)) {
    return "my connection dropped for a sec — try again in a moment 🙏";
  }
  const apiMsg = e.response?.data?.error?.message;
  if (apiMsg) return `${e.response?.status ?? ''} ${apiMsg}`.trim();
  return e.message ?? 'unknown error';
}

/** Hard guard: Nexus must never break character as a "language model" / "an AI". */
function deLeak(text: string): string {
  const leak = /\b(large language model|language models?|i'?m (?:just |only )?an? ai\b|i am an ai\b|as an ai\b|an ai (?:language )?model|ai language model)\b/i;
  if (leak.test(text)) {
    return "Haha I'm *Nexus* 😎 — the mind running this whole bot, not your average chatbot. What's on your mind?";
  }
  return text;
}

/** Models emit directives sloppily (missing/extra brackets, bare "RUN:",
 *  hallucinated "SENT:"). Canonicalise them to [[KW: arg]] so they EXECUTE
 *  instead of leaking as ugly text. */
function normalizeDirectives(s: string): string {
  let t = s;
  t = t.replace(/\[{0,2}\s*(SENT|SEND)\s*:/gi, '[[SENDSTICKER:');
  const kws = '(RUN|SAYTO|SENDTO|ADDCONTACT|SAY|VOICE|SEARCH|FETCH|SENDSTICKER|REACT|STICKER|REMEMBER)';
  t = t.replace(new RegExp(`\\[{1,2}\\]?\\s*${kws}\\s*:`, 'gi'), (_m, kw) => `[[${kw.toUpperCase()}:`);
  t = t.replace(new RegExp(`(^|\\n)[ \\t]*${kws}\\s*:`, 'gi'), (_m, pre, kw) => `${pre}[[${kw.toUpperCase()}:`);
  t = t.replace(new RegExp(`\\[\\[${kws}:[ \\t]*([^\\n]*?)[ \\t]*\\]{0,2}(\\n|$)`, 'gi'), (_m, kw, arg, end) => `[[${kw}: ${arg.replace(/\]+$/, '').trim()}]]${end}`);
  return t;
}

/* ------------------------- reply clean-up (post-model) ---------------------
 * The local model leaks things a human never would: helpdesk filler, markdown
 * headers WhatsApp can't render, self-narration, hand-written command menus.
 * Prompt rules alone don't stop an 8B model, so we scrub the OUTPUT here.
 * ------------------------------------------------------------------------- */

/** Corporate-assistant filler the local model keeps adding despite the prompt.
 *  Whole sentences matching this are dropped (deterministic beats pleading). */
const FILLER_RE =
  /\b(i'?m here (to help|to assist|for you|whenever|to chat)|here to help with|(let me|lemme) know (how i (can|could) (help|assist)|if (you need|there'?s|you'?d)|when(ever)? you|what you'?d like|so i can (help|assist))|i'?m (just )?(a|one) (message|text|msg) away|feel free to (ask|reach out|share|let me)|how can i (help|assist)( you)?( today)?|what can i (help|do|assist)( you)?( with)?( today)?|what can i assist you with|just say the word|i'?ve got stickers too|i'?m here to chat or help|happy to (help|assist)|at your service|feeling fresh and ready|ready to help\b|whether (you|it'?s) (need|want|'?d like|figuring|scheduling|catching|explor)|i'?m all ears|let'?s make it fun|what catches your eye|just let me know|i'?m here to (dive|chat|help)|are you (wanting|looking) to (explore|troubleshoot|chat)|what'?s your vibe)\b/i;

// Nexus narrating its OWN sticker mechanics/rules out loud — it should just send
// one (via [[SENDSTICKER]]) or not, never talk about it.
const STICKER_NARRATION_RE =
  /\b(no stickers? in a row|send (a|another|one|you|the)?\s*(little |small |cute )?sticker|sticker to match|maybe i should send|i'?ll (wait|hold off)[^.!?\n]*sticker|i didn'?t (actually )?send (one|a sticker|it)|before sending (one|a sticker)|let me (fix|send) (that|one|a sticker)|remember\?\s*$)/i;
// Unprompted "here's how to use commands" tutorials — only when there's an
// actual .command reference (verb + .cmd, or .cmd <placeholder>). Kept tight so
// it never eats normal prose like "you can use the menu".
const CMD_TUTORIAL_RE = /\b(?:say|use|try|type)\s+`?\.[a-z]{2,}\b|\.[a-z]{2,}\s*<[a-z]+>/i;
// Defeatist "I can't access real-time / check official channels" — FALSE: Nexus
// has live web search. These lines get dropped; the search grounds the answer.
const DEFEATIST_RE =
  /\b(i (can'?t|cannot) (access|verify|confirm|get|provide|check)[^.!?\n]*(real.?time|the latest|current|absolute truth|its (absolute )?truth)|without (real.?time|access to real.?time|live|current) (data|access|info|information)|(you'?ll |you |please )?(need to |should |can )?check (the )?official (channels?|sources?|team|club)|i don'?t have (access to )?real.?time|i (can'?t|cannot) (browse|access) (the )?(internet|web|real.?time)|i (can'?t|cannot) (view|watch|open|access|see) (external |the )?(content|videos?|links?|the video|external links?))\b/i;

function stripFiller(text: string): string {
  // Drop parenthetical "P.S. …" / "(Though I'll wait…)" self-narration asides.
  let t = text.replace(/\(\s*(p\.?s\.?|though|but)\b[^)]*\)/gi, ' ');
  const parts = t.split(/(?<=[.!?…])\s+|\n+/);
  const kept = parts.filter(
    (s) => s.trim() && !FILLER_RE.test(s) && !STICKER_NARRATION_RE.test(s) && !CMD_TUTORIAL_RE.test(s) && !DEFEATIST_RE.test(s),
  );
  const out = kept.join(' ').replace(/[ \t]{2,}/g, ' ').trim();
  return out || t.trim(); // never return empty
}

/** WhatsApp doesn't render markdown headers or **double-star** bold — the model
 *  keeps emitting them, so they show up as literal "###" / "**". Normalise. */
function normalizeMarkdown(t: string): string {
  return t
    .replace(/^\s{0,3}#{1,6}\s*(.+?)\s*#*$/gm, '*$1*') // "### Title" line → "*Title*"
    .replace(/(^|[\s>])#{1,6}[ \t]+(?=\S)/gm, '$1') // leftover inline "### " markers → gone
    .replace(/\*\*([^*\n]+?)\*\*/g, '*$1*') // **bold** → *bold*
    .replace(/__([^_\n]+?)__/g, '*$1*'); // __bold__ → *bold*
}

/** If the model vomited a hand-written command menu (many .cmd tokens), replace
 *  the whole thing with a pointer to the REAL menu — those dumps render as a
 *  wall of broken markdown and feel like a robot reading its manual. */
function collapseCommandDump(t: string): string {
  const distinct = new Set((t.match(/(?<![\w.])\.[a-z]{2,}\b/g) || []).map((s) => s.toLowerCase()));
  if (distinct.size >= 4) {
    const p = config.prefixes[0] ?? '.';
    return `I can do a lot 😎 — send *${p}menu* for the full list of commands, or just tell me what you want and I'll handle it.`;
  }
  return t;
}

function sanitizeReply(text: string): string {
  return stripFiller(collapseCommandDump(normalizeMarkdown(text)))
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/\s*(\]{2,}|\[{2,})\s*/g, ' ') // stray directive brackets ("]]" / "[[") that leaked
    // Malformed directives — but REQUIRE at least one "[" so we don't eat plain
    // English when Nexus explains a command (e.g. writing "REMEMBER" or "SEND"
    // mid-sentence would otherwise delete the rest of the line → cut-off replies).
    .replace(/\[{1,2}\s*(RUN|SAYTO|SENDTO|ADDCONTACT|CONTACTS|SAY|VOICE|SEARCH|FETCH|IDENTIFY|SENDSTICKER|SENT|SEND|REACT|STICKER|REMEMBER)\b[^\n\]]*\]{0,2}/gi, '')
    // Leading "tone label" the model likes to prefix, e.g. [Soft, playful tone]
    .replace(/^\s*\[[^\]\n]{0,60}?(?:tone|voice|mood|style)[^\]\n]{0,20}\]\s*/i, '')
    // Stage directions: (winks), (laughs), *sighs*, *smiles softly* ...
    .replace(/\((?:winks?|laughs?|giggles?|smiles?|grins?|nods?|sighs?|shrugs?|waves?|blushes?|sends?)[^)]*\)/gi, '')
    .replace(/\*(?:winks?|laughs?|giggles?|smiles?|grins?|nods?|sighs?|shrugs?|waves?|blushes?)[^*\n]*\*/gi, '')
    .replace(/\((?:sent sticker|sticker|ran|reacted)[^)]*\)/gi, '')
    // Truncated bookkeeping the model sometimes parrots with no closing paren:
    // "(ran .", "(I sent a voice note", "(I reacted" ...
    .replace(/\(\s*(?:ran|reacted|i\s+(?:sent|reacted))\b[^)\n]*\)?/gi, '')
    .replace(/\b[0-9a-f]{12,}\b/gi, '')
    .replace(/^[ \t]*[•]\s*/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

// Natural "working on it" lines so Nexus never exposes the mechanics.
const ACK_WORKING = ['On it 🫡', 'Gimme a sec ⏳', 'One moment 🙏', 'Right away 😎', 'Say less — on it 🔥', 'Got it, working on it...'];
const ACK_SLOW = ['On it — this might take a few seconds ⏳', 'Looking that up, one moment 🔎', 'Hang tight, fetching that now...', 'Working on it — give me a moment 🙏'];
const ACK_LINK = ['On it 🫡 peeking at that link...', 'Sure — let me take a look 👀', 'On it, one sec 🔎', 'Checking it out now 👀'];
const ACK_LOOK = ['On it 🫡 taking a look...', 'Sure — let me see who that is 👀', 'On it, one sec 🔎', 'Looking into it now 👀'];
// FALLBACK confirmations, only used if the AI-generated confirmation fails.
// Normally Nexus writes its own confirmation in character ({n} = contact name).
const SENT_TEXT = ['Done — sent it to {n} ✅', 'Sent to {n} 📨', 'Message delivered to {n} ✅', 'There we go, {n} has it 📨', 'Sent! {n} should see it now ✅', 'Message is off to {n} 🚀'];
const SENT_VOICE = ['Done — voice note sent to {n} 🎤', 'Sent {n} the voice message ✅', 'Voice note delivered to {n} 🎧', 'There we go, {n} has your voice note 🎤', 'Off it goes — {n} will hear it 🔊'];

// Commands slow/heavy enough to deserve a quick acknowledgement first.
const SLOW_CMDS = new Set(['dl', 'download', 'play', 'video', 'song', 'ytmp3', 'ytmp4', 'mp3', 'mp4', 'imagine', 'img', 'draw', 'paint', 'generate', 'art', 'gen', 'tts', 'url']);

/** Is the user asking us to REVERSE-IMAGE-SEARCH (identify a person/movie/anime/
 *  source)? Narrow on purpose — "analyse this", "what's in this image", "which
 *  image is this" are NOT identify; they should just be described by vision, not
 *  matched against anime (which gives false positives on screenshots/photos). */
function isIdentifyQuery(q: string): boolean {
  return (
    /\b(identif(y|ies|ication)?|reverse[-\s]?image)\b/i.test(q) ||
    /\bwho(?:'?s| is| are| was)\b/i.test(q) ||
    /\b(which|what)\s+(movie|film|show|series|anime|cartoon|manga|song|episode|drama|character|actor|actress|celebrity|game)\b/i.test(q) ||
    /\bwhere(?:'?s| is| was)?\s+(this|that|it|she|he)\s+from\b/i.test(q) ||
    /\bsource\b/i.test(q)
  );
}

/** Router signal: does this message look like a COMMAND/ACTION (route to the
 *  smart model), vs. casual chat (stay on the local 8B)? Broad on purpose — a
 *  false positive just spends one extra smart call; a miss makes an action flaky. */
function looksLikeAction(q: string): boolean {
  return /\b(send|tell|text|message|msg|voice|call|greet|play|download|dl|song|video|imagine|draw|paint|generate|create|make (me|an|a) |picture|image|photo|search|look ?up|google|find|schedule|remind|reminder|add ?contact|save ?contact|contacts?|delete|remove|identify|whois|who ?is|which (movie|anime|song|show)|sticker|kick|ban|promote|demote|mute|menu|设置|发送|提醒)\b/i.test(q);
}

const frameToDataUrl = (b: Buffer): string => `data:image/jpeg;base64,${b.toString('base64')}`;

/** Pull the first http(s) URL out of some text. */
function extractUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s]+/i)?.[0];
}

/** Deterministically identify a photo/video: reverse-image search is the source
 *  of truth; vision is only scene context. No guessing, no fake "database". */
async function runIdentify(m: Message, key: string, history: Turn[], context: string, frame: Buffer): Promise<unknown> {
  await m.reply(pick(ACK_LOOK));
  // Vision first: describe it AND decide real-vs-anime, so we don't match a real
  // photo to an anime frame (trace.moe over-matches).
  const desc = config.nexus.visionModel ? await describeImage(frameToDataUrl(frame)) : undefined;
  const looksAnime = /\b(anime|animat(ed|ion)|cartoon|manga|illustrat|drawing|2d)\b/i.test(desc ?? '');
  const animeOpt = config.nexus.visionModel ? { anime: looksAnime } : {};
  const hits = await identifyImage(frame, animeOpt);
  const grounded = await askAI(
    history,
    `${context}\n\nThe user wants you to identify this photo/video. You reverse-image-searched it.` +
      (hits
        ? `\nREVERSE-IMAGE-SEARCH RESULTS (your source of truth for naming it):\n${hits}`
        : `\nThe reverse-image search found NO clear match (or was blocked).`) +
      (desc ? `\nWhat the picture visually shows (context only — NOT a reliable ID): ${desc}` : '') +
      `\n\nRULES: Name it from the SEARCH RESULTS. If they clearly point to a person/show/movie/source, say so confidently. If the search found nothing useful, honestly say you couldn't identify it — you may add a loose visual guess but CLEARLY label it a guess. NEVER invent a "database", never role-play "scanning/analysing", never state a random movie as fact. Short and in character.`,
  );
  const clean = deLeak(sanitizeReply(grounded)) || (hits ?? "I couldn't quite pin that one down 😅");
  pushTurn(key, 'assistant', clean);
  rememberAnswer(clean);
  await m.reply(clean);
  return undefined;
}

// ---- Send-to-contact delivery + stateful "which one?" disambiguation ----------
const SEND_STYLE_RE = /\b(soft|whisper(?:ing)?|romantic|gentle|deep|slow|fast|excited|sleepy|calm|sweet|husky|breathy|warm|playful|shy)\b/gi;
type SendTarget = { jid: string; name: string; kind: 'contact' | 'group' };

/**
 * Synthesize speech while keeping the "recording audio…" indicator ALIVE the
 * whole time. WhatsApp fades presence after ~10s, but Qwen TTS can take much
 * longer — without refreshing, the recipient sees "recording…" vanish and then
 * waits in silence. Refreshing every few seconds makes it feel like one
 * continuous recording that ends right as the voice note lands. Best-effort.
 */
async function synthLive(m: Message, text: string, jid: string = m.chat): ReturnType<typeof synthesizeResult> {
  await m.setPresence('recording', jid);
  const iv = setInterval(() => void m.setPresence('recording', jid), 4000);
  try {
    return await synthesizeResult(text);
  } finally {
    clearInterval(iv);
    await m.setPresence('paused', jid);
  }
}

/** Deliver a text/voice message to a resolved contact/group, then confirm in
 *  Nexus's own words. Used by both the direct send and the disambiguation pick. */
async function deliverToTarget(
  m: Message,
  target: SendTarget,
  content: string,
  asVoice: boolean,
  styleQuery: string,
  history: Turn[],
  context: string,
  key: string,
): Promise<void> {
  try {
    if (asVoice && ttsReady()) {
      const styleWords = styleQuery.match(SEND_STYLE_RE);
      if (styleWords?.length) setStyleDesc(styleWords.join(', '));
      const vs = parseVoiceStyle(styleQuery);
      if (vs.voiceId) setVoice(vs.voiceId);
      if (vs.styleId) setStyle(vs.styleId);
      const v = await synthLive(m, content, target.jid);
      if (v.ok) {
        const sent = await m.client.sendMessage(target.jid, { audio: v.audio, ptt: true, mimetype: v.mimetype });
        rememberAudio(sent?.key?.id);
      } else {
        await m.client.sendMessage(target.jid, { text: content });
      }
    } else {
      await m.client.sendMessage(target.jid, { text: content });
    }
    // Confirm it's sent. The natural, model-written line is a nice-to-have — but
    // it must NEVER leave the owner hanging, so it's capped at 6s and always
    // falls back to a template. (The model/network can be slow or unreachable.)
    const fallback = pick(asVoice ? SENT_VOICE : SENT_TEXT).replace(/\{n\}/g, `*${target.name}*`);
    let done = fallback;
    try {
      const gen = await Promise.race([
        askAI(history, `${context}\n\nYou just ${asVoice ? 'sent a voice note' : 'sent a text message'} to *${target.name}* on the owner's behalf${content ? ` (it said: "${content.slice(0, 80)}")` : ''}. Reply with ONE short, natural, in-character line confirming it's sent — vary your wording, a fitting emoji is fine. No directives, no quotes.`),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('confirm timeout')), 6000)),
      ]);
      done = deLeak(sanitizeReply(gen)) || fallback;
    } catch {
      done = fallback;
    }
    pushTurn(key, 'assistant', done);
    rememberAnswer(done);
    await m.reply(done);
  } catch (err) {
    logger.error({ err, jid: target.jid }, 'send-to-contact failed');
    await m.reply(`😕 Couldn't reach *${target.name}* — that number may not be on WhatsApp.`);
  }
}

// Pending "which one?" choices, so a numeric reply actually completes the send.
// `confirm` marks a single-target yes/no confirmation (used before group sends).
const pendingSend = new Map<string, { matches: SendTarget[]; content: string; asVoice: boolean; styleQuery: string; at: number; confirm?: boolean }>();
const SEND_TTL = 3 * 60_000;
const YES_RE = /^(y|yes|yeah|yep|yup|ok|okay|sure|send|confirm|do it|go|👍|✅|🆗)$/i;
const NO_RE = /^(n|no|nope|nah|cancel|stop|dont|don't|abort|❌)$/i;

/** Peek: is this message a valid reply to a pending send (a pick 1..N, or a
 *  yes/no for a confirmation)? */
export function isSendChoice(m: Message): boolean {
  const p = pendingSend.get(memKey(m));
  if (!p || Date.now() - p.at > SEND_TTL) return false;
  const body = m.body.trim();
  if (p.confirm) return YES_RE.test(body) || NO_RE.test(body) || body === '1';
  const n = parseInt(body, 10);
  return Number.isInteger(n) && n >= 1 && n <= p.matches.length;
}

// Passive: a number reply picks the contact/group and completes the send.
command({ on: 'message' }, async (m) => {
  const key = memKey(m);
  const p = pendingSend.get(key);
  if (!p) return;
  if (Date.now() - p.at > SEND_TTL) return void pendingSend.delete(key);
  if (!m.isRealOwner) return; // only the owner completes a send
  const body = m.body.trim();

  // Yes/no confirmation (single target, e.g. before a group send).
  if (p.confirm) {
    if (NO_RE.test(body)) {
      pendingSend.delete(key);
      markConsumed(m.raw?.key?.id);
      return void m.reply('👍 Okay, cancelled — nothing sent.');
    }
    if (!(YES_RE.test(body) || body === '1')) return; // not a clear yes/no → ignore
    pendingSend.delete(key);
    markConsumed(m.raw?.key?.id);
    const target = p.matches[0];
    await m.reply(`📨 On it — sending to *${target.name}*…`);
    const history = memory.get(key) ?? [];
    const context = await contextBlock(m);
    await deliverToTarget(m, target, p.content, p.asVoice, p.styleQuery, history, context, key);
    return;
  }

  const n = parseInt(body, 10);
  if (!Number.isInteger(n) || n < 1 || n > p.matches.length) return;
  pendingSend.delete(key);
  markConsumed(m.raw?.key?.id);
  const target = p.matches[n - 1];
  await m.reply(`📨 On it — sending to *${target.name}*…`);
  const history = memory.get(key) ?? [];
  const context = await contextBlock(m);
  await deliverToTarget(m, target, p.content, p.asVoice, p.styleQuery, history, context, key);
});

/** Split a long reply into a few short, human-sized bubbles. Keeps links/code
 *  whole and never makes more than 3 bubbles. */
function splitBubbles(text: string): string[] {
  const t = text.trim();
  if (t.length <= 150 || /```|https?:\/\//.test(t)) return [t];
  const parts = t.split(/\n+|(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [t];
  const bubbles: string[] = [];
  for (const p of parts) {
    const last = bubbles[bubbles.length - 1];
    if (last && last.length + 1 + p.length <= 150) bubbles[bubbles.length - 1] = `${last} ${p}`;
    else bubbles.push(p);
  }
  return bubbles.length > 3 ? [bubbles[0], bubbles[1], bubbles.slice(2).join(' ')] : bubbles;
}

/** Reply like a person: a few short bubbles, each preceded by a "typing…"
 *  indicator and a natural pause — instead of one robotic wall of text. */
async function sendHuman(m: Message, text: string): Promise<void> {
  const bubbles = splitBubbles(text);
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    if (bubbles.length > 1) {
      await m.setPresence('composing');
      await sleep(Math.min(2000, 300 + b.length * 18)); // "typing" time ~ length
      await m.setPresence('paused');
    }
    if (i === 0) await m.reply(b);
    else await m.sendText(b);
    rememberAnswer(b); // so auto-chat never replies to Nexus's own bubble
    if (i < bubbles.length - 1) await sleep(350 + Math.random() * 450); // gap between bubbles
  }
}

// One reply per person at a time. WhatsApp can re-deliver a message and the
// slow local model leaves a reply in flight — without this guard Nexus starts a
// second, identical answer. While one response is being produced for a given
// chat:sender, any further trigger for that same person is ignored.
const inFlight = new Set<string>();

async function respond(m: Message, query: string, speak = false): Promise<unknown> {
  const guardKey = memKey(m);
  if (inFlight.has(guardKey)) return undefined; // already answering this person
  inFlight.add(guardKey);
  try {
    return await respondInner(m, query, speak);
  } finally {
    inFlight.delete(guardKey);
  }
}

/** Show a numbered list of the groups Nexus can reach and remember the pending
 *  send, so the owner can just reply with a number. Used when a group target is
 *  generic ("the group") or the named group couldn't be matched — no more vague
 *  "who should I send to?". Returns true (it always handles the turn). */
async function offerGroupPicker(m: Message, key: string, content: string, asVoice: boolean, query: string, missingName?: string): Promise<boolean> {
  const groups = allGroupMatches();
  if (!groups.length) {
    await m.reply("📭 I don't know any groups to send to yet — I only learn a group once I've seen a message in it. Post something in the group, then try again.");
    return true;
  }
  const matches = groups.slice(0, 12).map((g) => ({ jid: g.jid, name: g.name, kind: 'group' as const }));
  pendingSend.set(key, { matches, content, asVoice, styleQuery: query, at: Date.now() });
  const list = matches.map((g, i) => `  *${i + 1}* · ${g.name}`).join('\n');
  const head = missingName
    ? `🤔 I couldn't find a group called *${missingName}*. Which of these should I send it to?`
    : `📨 Which group should I send it to?`;
  const r = `${head}\n${list}\n\n_Reply with the number._`;
  pushTurn(key, 'assistant', r);
  await m.reply(r);
  return true;
}

/** "What's your name / who are you / what is this bot" — an identity question. */
function isIdentityQuery(q: string): boolean {
  const s = q.toLowerCase().trim();
  return /\b(who\s+(are|r)\s+(you|u)|what\s+(are|r)\s+(you|u)|introduce\s+yourself|your\s+name|what('?s| is|s)?\s+(your|the|this)\s+(bot('?s)?\s+)?name|what('?s| is)\s+(this|the)\s+bot(\s+called)?|what\s+bot\s+(is\s+this|are\s+you)|whats?\s+ur\s+name)\b/.test(s);
}
/** "What can you do / what are your features / which command" — a capability
 *  or command-list question. Routed to the deterministic intro (points to .menu)
 *  so the model never hand-vomits a broken command menu. */
function isCapabilityQuery(q: string): boolean {
  const s = q.toLowerCase().trim();
  return /\b(what\s+can\s+(you|u|this\s+bot)\s+do|what\s+do\s+(you|u)\s+do|your\s+(features|abilities|capabilities|commands)|what\s+are\s+your\s+(features|abilities|capabilities)|how\s+can\s+(you|u)\s+help|what\s+are\s+(you|u)\s+capable|which\s+commands?|what\s+commands?|list\s+(of\s+)?commands|commands?\s+(can\s+i|do\s+you|are\s+there|available)|show\s+(me\s+)?commands)\b/.test(s);
}

/** A warm, on-brand Nexus intro — deterministic so a weak model can't turn it
 *  into "I'm an assistant with no name". `full` gives the capability rundown. */
function nexusIntro(full: boolean): string {
  const prefix = config.prefixes[0] ?? '.';
  if (!full) {
    return `I'm *Nexus* 😎 — the AI running this bot, not your average chatbot. I chat (and actually remember you), talk in voice notes, make & read images, download videos, read documents, translate, search the live web, and help run this group. Send *${prefix}menu* to see everything — or just talk to me 🙂`;
  }
  return [
    `Hey 👋 I'm *Nexus* — the AI mind running this bot. Here's what I can do:`,
    ``,
    `💬 *Chat & memory* — real conversations, and I remember people over time`,
    `🎙️ *Voice* — speak any text as a voice note, and listen & reply to yours`,
    `🖼️ *Images* — generate pictures, remove backgrounds, make stickers`,
    `⬇️ *Downloads* — video/audio from YouTube, TikTok, IG, Pinterest & more`,
    `📄 *Read* — summarise PDFs, docs & screenshots`,
    `🌍 *Handy* — weather, translate, currency, crypto, wiki, live web search`,
    `👥 *Groups* — tag everyone/online, welcomes, anti-link, warnings & more`,
    ``,
    `Send *${prefix}menu* for the full list — or just talk to me 😊`,
  ].join('\n');
}

/** A plain, natural spoken version of the intro (no emojis/markdown) — Nexus
 *  introduces itself out loud in its own voice, showing off that it can. */
function nexusSpokenIntro(): string {
  return "Hey! I'm Nexus, the mind running this bot — not your average chatbot. I can chat and actually remember you, talk in voice notes like this one, make and read images, download videos from YouTube, TikTok and more, read your documents, translate, search the web, and help run your groups. Send me menu to see everything I can do, or just talk to me!";
}

/* ============================== the main turn ===============================
 * Everything above converges here. Order matters: the deterministic branches
 * (identity, downloads, link reading, verification) run FIRST so a weak model
 * never gets the chance to refuse or invent. Only then does it get to answer,
 * and whatever directive it emits is executed for real below.
 * ========================================================================== */

async function respondInner(m: Message, query: string, speak = false): Promise<unknown> {
  if (!nexusEnabled()) return m.reply('Nexus AI is not configured. Set NEXUS_API_KEY in .env and restart.');
  if (!query) return m.reply('Ask me anything 😊');

  const key = memKey(m);
  touchSession(key); // opening/refreshing the follow-up window
  const history = pushTurn(key, 'user', query);

  // Who/what is this bot, or what can it do → answer as Nexus, deterministically.
  // The local model kept giving a generic "it has no name, call it Assistant"
  // non-answer, so we never route these through it.
  if (isIdentityQuery(query) || isCapabilityQuery(query)) {
    // Introduce myself EITHER out loud OR in text — never both. Prefer voice
    // when TTS is ready (it's more personal); fall back to the written rundown.
    if (ttsReady()) {
      try {
        const spoken = nexusSpokenIntro();
        const v = await synthLive(m, spoken);
        if (v.ok) {
          const sent = await m.send({ audio: v.audio, ptt: true, mimetype: v.mimetype }, { quoted: m.raw });
          rememberAudio(sent?.key?.id);
          pushTurn(key, 'assistant', spoken);
          rememberAnswer(spoken);
          return undefined; // voice sent — done, no duplicate text
        }
      } catch {
        /* TTS failed → fall through to text */
      }
    }
    const intro = nexusIntro(isCapabilityQuery(query));
    pushTurn(key, 'assistant', intro);
    rememberAnswer(intro);
    await m.reply(intro);
    return undefined;
  }
  let context = await contextBlock(m);

  // 💬 The user REPLIED TO a text message — inject it so Nexus responds to ITS
  // content ("what's your thought on THIS") instead of asking "what's on your
  // mind?". This was the #1 gap: quoted text was completely invisible to it.
  const quotedText = m.quoted?.text?.trim();
  if (quotedText && quotedText.length > 1 && !recentAnswers.has(quotedText)) {
    lastQuoted.set(m.chat, { text: quotedText, at: Date.now() }); // remember for follow-up fact-checks
    context +=
      `\n\n💬 THE USER IS REPLYING TO THIS MESSAGE — it's the "this/that/it" they mean. Read it and respond to its ACTUAL content (give your real thoughts / answer about it directly); do NOT ask "what's on your mind":\n"""\n${quotedText.slice(0, 1500)}\n"""`;
  } else if (!quotedText) {
    // No new quote, but they recently replied to something — keep that topic in
    // view so a follow-up ("is there talk taking place?", "how much?") stays on
    // THAT subject instead of drifting (e.g. reading "talk" as group chatter).
    const rc = lastQuoted.get(m.chat);
    if (rc && Date.now() - rc.at < QUOTED_MEMORY_MS) {
      context +=
        `\n\n🧵 CURRENT TOPIC you two are discussing (their follow-up is almost certainly about THIS — interpret their words in this context, don't switch subjects): "${rc.text.slice(0, 500)}"`;
    }
  }

  // ↩️ Bare "yes / go on / let's dive deep" after Nexus offered something — the
  // weak model kept RESETTING to a greeting. Feed it its own last line + a firm
  // "continue" so it picks the thread back up instead of starting over.
  if (/^(yes|yeah|yep|yup|sure|ok(ay)?|go on|continue|please|do it|deep(er)?|elaborate|tell me( more)?|let'?s (do it|dive|go|hear))\b/i.test(query.trim()) && query.trim().length < 32) {
    const prevAssistant = [...history].reverse().find((t) => t.role === 'assistant')?.content;
    if (prevAssistant) {
      context +=
        `\n\n↩️ The user just said YES / agreed to your PREVIOUS message — CONTINUE that exact topic and elaborate on what you offered. Do NOT reset, greet, or ask "what's on your mind". Your previous message was:\n"""\n${prevAssistant.slice(0, 500)}\n"""`;
    }
  }

  // Media the user is pointing at (own or replied-to photo/video → still frame).
  const frame = await mediaFrame(m);

  // "Who/what/which is this?" about that media → run the REAL reverse-image
  // search deterministically instead of letting the model guess and role-play.
  if (frame && isIdentifyQuery(query)) {
    return runIdentify(m, key, history, context, frame);
  }

  // A downloadable MEDIA link (Pinterest, YouTube, TikTok, IG, X, Reddit…) → run
  // the REAL downloader deterministically. The local model kept refusing with
  // "I can't access external links", which is both false and useless — this bot
  // CAN download. Fires on a bare link, or any explicit "download/save/grab" ask.
  const dlUrl = extractUrl(query) ?? extractUrl(m.quoted?.text ?? '');
  if (dlUrl && isDownloadableUrl(dlUrl)) {
    const rest = query.replace(/https?:\/\/\S+/g, '').trim();
    const wantsDownload = /\b(download|save|grab|fetch|dl|get)\b/i.test(query);
    if (wantsDownload || rest.length <= 4) {
      await runCommandText(m, `dl ${dlUrl} hd`); // explicit quality → download now, no menu
      return undefined;
    }
  }

  // "What's this link about?" — extract the URL ourselves (the model kept
  // emitting a placeholder) and inspect it deterministically.
  const url = extractUrl(query) ?? extractUrl(m.quoted?.text ?? '');
  if (url && /\b(link|url|what|about|check|look|tell|explain|summar|open)\b/i.test(query)) {
    await m.reply(pick(ACK_LINK));
    const info = await linkInfo(url);
    if (info) {
      const grounded = await askAI(
        history,
        `${context}\n\nWHAT THIS LINK CONTAINS (from its page data) — ${url}:\n${info}\n\nTell the user what this link is, briefly and in your own voice. Don't output directives or mention "page data".`,
      );
      const clean = deLeak(sanitizeReply(grounded)) || info;
      pushTurn(key, 'assistant', clean);
      rememberAnswer(clean);
      await m.reply(clean);
    } else {
      await m.reply("Hmm, I couldn't peek into that link 😅 it might be private or blocking me.");
    }
    return undefined;
  }

  // Otherwise, if vision is on, describe the image so Nexus can react in character.
  if (frame && config.nexus.visionModel) {
    const desc = await describeImage(frameToDataUrl(frame));
    if (desc) {
      lastImage.set(m.chat, { desc, at: Date.now() }); // remember it for follow-ups
      context +=
        `\n\n🖼️ IMAGE THE USER JUST SHARED — you CAN see it. Here is what it shows: ${desc}. ` +
        `ENGAGE with what's actually in it — react to the real content with a specific, relevant line (read any visible text, name what's shown, get the joke, comment on the thing). ` +
        `If they asked you to ANALYSE / describe / "what's in this", tell them clearly and helpfully in your own voice. If it's the NEXUS-MD logo/banner/branding, recognise it as YOURSELF and react playfully. ` +
        `⚠️ NEVER reply to a shared image with just a sticker or a generic line — actually talk about THIS image. Only offer a reverse-image-search if they ask WHO a person is or WHICH movie/anime/show it's from.`;
    } else {
      context +=
        `\n\n🖼️ The user shared an IMAGE but you couldn't make out its contents this time. Don't guess or send a sticker — respond to their words, and it's fine to ask what it is or what they think of it.`;
    }
  }

  // Show a genuine "typing…" indicator instead of a spinner message — cleaner,
  // more human, and no "Edited" tag on the reply.
  const typing = async (state: 'composing' | 'paused') => {
    try {
      await m.client.sendPresenceUpdate(state, m.chat);
    } catch {
      /* best effort */
    }
  };
  await typing('composing');

  // 🔎 Freshness guard: for "current facts" questions (who won X, latest, prices,
  // this-year, is-X-still-alive…), SEARCH FIRST and feed the model real results.
  // Don't trust a small local model to decide to search on its own — it will
  // happily answer from stale training instead.
  // VERIFY / fact-check: "how true is this", "is this real?", "verify" — the
  // claim lives in the QUOTED text (or the one they quoted a moment ago), so
  // search THAT and answer from real results instead of hedging "I can't verify".
  const wantsVerify = /\b(how true|is (this|that|it) (true|real|legit|accurate)|is this real|verify|fact.?check|真|confirm this|really true|any truth|is it real)\b/i.test(query);
  const recentClaim = lastQuoted.get(m.chat);
  // The claim can live in a quoted message, one quoted moments ago, OR in an
  // IMAGE they just shared (a screenshot of a tweet/headline) — that last case
  // is common and used to be missed entirely, so "how true is this?" on a photo
  // just got a hedge instead of a real fact-check.
  const recentImg = lastImage.get(m.chat);
  const imageClaim = recentImg && Date.now() - recentImg.at < IMAGE_MEMORY_MS ? recentImg.desc : undefined;
  const claim =
    quotedText ||
    (recentClaim && Date.now() - recentClaim.at < QUOTED_MEMORY_MS ? recentClaim.text : undefined) ||
    imageClaim;
  let searchQuery = '';
  if (needsFreshInfo(query)) searchQuery = query;
  else if (wantsVerify && claim) searchQuery = claim;
  else if (claim && needsFreshInfo(claim)) searchQuery = claim;
  if (searchQuery) {
    try {
      const info = await webSearch(searchQuery, m.chat);
      if (info) {
        context +=
          `\n\n🔎 LIVE WEB SEARCH RESULTS for "${searchQuery.slice(0, 120)}" (fetched just now — today's date is above). ` +
          `${wantsVerify ? 'The user asked how TRUE the quoted claim is — use these fresh results to say what\'s actually confirmed/reported and how credible it is (cite the sources), rather than "I can\'t verify". ' : ''}` +
          `These are the CURRENT facts. Trust them over anything you think you remember; your own memory on this is out of date. Give a PROPER, DETAILED answer using the specifics here (names, numbers, what happened, who said what) — 3-6 sentences, not a one-line summary. Don't just list headlines; actually explain. Answer from these:\n${info}`;
      }
    } catch {
      /* search unavailable → fall through and answer normally */
    }
  }

  try {
    // Route commands/actions AND current-events questions to the smart model
    // (Llama 70B — far better on recent events); casual chat stays on local 8B.
    // If the smart model is unreachable, askAI quietly falls back to local.
    let answer = normalizeDirectives(await askAI(history, context, looksLikeAction(query) || Boolean(searchQuery)));
    touchSession(key);
    await typing('paused');

    // Durable facts Nexus chose to remember (can co-occur with a normal reply).
    if (memoryEnabled()) {
      for (const r of answer.matchAll(/\[\[\s*REMEMBER\s*:\s*([\s\S]+?)\s*\]\]/gi)) {
        let fact = r[1].trim();
        let subject = m.senderNumber;
        const gm = fact.match(/^@group\b[:,]?\s*([\s\S]*)$/i);
        if (gm) {
          subject = 'group';
          fact = gm[1].trim();
        }
        if (fact) addMemory(m.chat, subject, fact);
      }
    }
    answer = answer.replace(/\[\[\s*REMEMBER\s*:[\s\S]+?\]\]/gi, '').trim();

    // Identify who/what is in a photo or video (reverse image search + vision).
    if (/\[\[\s*IDENTIFY\s*\]\]/i.test(answer)) {
      await m.reply(pick(ACK_LOOK));
      const frame = await mediaFrame(m);
      if (!frame) {
        await m.reply('Reply to a photo or video and I\'ll try to figure out who/what it is 🙂');
        return undefined;
      }
      const [desc, hits] = await Promise.all([
        config.nexus.visionModel ? describeImage(`data:image/jpeg;base64,${frame.toString('base64')}`) : Promise.resolve(undefined),
        identifyImage(frame),
      ]);
      const grounded = await askAI(
        history,
        `${context}\n\nThe user asked you to identify a photo/video.` +
          (desc ? `\nWhat you SEE in it: ${desc}` : '') +
          (hits
            ? `\nReverse-image search returned these related result titles — use them to name the person/character/show/source IF they clearly line up:\n${hits}`
            : `\nReverse-image search came back empty or was blocked.`) +
          `\n\nTell the user who/what this is, briefly and in character. If you're not certain, give your best guess and say you're not 100% sure. Don't output directives.`,
      );
      const clean = deLeak(sanitizeReply(grounded)) || (hits ?? "I couldn't quite pin that one down 😅");
      pushTurn(key, 'assistant', clean);
      rememberAnswer(clean);
      await m.reply(clean);
      return undefined;
    }

    // Look up a link and say what it is.
    const fetchDir = answer.match(/\[\[\s*FETCH\s*:\s*([^\]]+?)\s*\]\]/i);
    if (fetchDir) {
      const url = fetchDir[1].trim();
      await m.reply(pick(ACK_LINK));
      const info = await linkInfo(url);
      if (info) {
        const grounded = await askAI(
          history,
          `${context}\n\nWHAT THIS LINK CONTAINS (from its page data) — ${url}:\n${info}\n\nTell the user what this link is, briefly and in your own voice. Don't output directives or mention "page data".`,
        );
        const clean = deLeak(sanitizeReply(grounded)) || info;
        pushTurn(key, 'assistant', clean);
        rememberAnswer(clean);
        await m.reply(clean);
      } else {
        await m.reply("Hmm, I couldn't peek into that link 😅 it might be private or blocking me.");
      }
      return undefined;
    }

    // Real-time web search: fetch live info, then answer in character.
    const search = answer.match(/\[\[\s*SEARCH\s*:\s*([^\]]+?)\s*\]\]/i);
    if (search) {
      const q = search[1].trim();
      await m.reply(pick(ACK_SLOW));
      const info = await webSearch(q);
      if (info) {
        const grounded = await askAI(
          history,
          `${context}\n\nLIVE WEB SEARCH RESULTS for "${q}":\n${info}\n\nUse these fresh facts to answer the user in your own voice — accurate and DETAILED (pull in the real specifics: names, numbers, what actually happened), 3-6 sentences, not a one-line summary. Do NOT mention "search results" or output any directives — just reply naturally.`,
        );
        const clean = deLeak(sanitizeReply(grounded)) || info.slice(0, 600);
        pushTurn(key, 'assistant', clean);
        rememberAnswer(clean);
        await m.reply(clean);
      } else {
        await m.reply("hmm, I couldn't pull that up right now 😅 try again in a sec?");
      }
      return undefined;
    }

    // Show the saved contact list (ACTUAL owner only, private DM only).
    if (/\[\[\s*CONTACTS\s*\]\]/i.test(answer)) {
      if (!m.isRealOwner) {
        const d = '🔒 my contacts are private — only my owner can see them.';
        pushTurn(key, 'assistant', d);
        await m.reply(d);
        return undefined;
      }
      const list = contactListText() || "📇 I don't know any contacts yet — add one with .addcontact or in our DM.";
      pushTurn(key, 'assistant', 'Here are the contacts I have 📇');
      if (m.isGroup) {
        // Never reveal contacts in a group — send them to the owner's DM.
        await m.client.sendMessage(m.sender, { text: list });
        await m.reply('📇🔒 For privacy, I sent your contact list to our private DM.');
      } else {
        await m.reply(list);
      }
      return undefined;
    }

    // Save a contact by name + number (owner only), merging with any existing entry.
    const addC = answer.match(/\[\[\s*ADDCONTACT\s*:\s*([^|\]]+?)\s*\|\s*([^\]]+?)\s*\]\]/i);
    if (addC) {
      if (!m.isRealOwner) {
        const d = '🔒 only my owner can edit my contacts.';
        pushTurn(key, 'assistant', d);
        await m.reply(d);
        return undefined;
      }
      const cname = addC[1].trim();
      const res = await saveContactByNumber(m.client, cname, addC[2].trim());
      const r = !res.ok
        ? '🤔 that number looks off — give me the full number with country code (e.g. 2348012345678).'
        : `✅ ${res.existed ? 'Updated' : 'Saved'} *${cname}* (+${res.jid?.split('@')[0]}) 📇${res.onWhatsApp ? '' : " — though that number doesn't look like it's on WhatsApp."}`;
      pushTurn(key, 'assistant', r);
      rememberAnswer(r);
      await m.reply(r);
      return undefined;
    }

    // Send a text/voice message to a named contact (owner only). Lenient: works
    // even if the model forgets the " | " separator.
    // GUARD against false triggers: the model sometimes emits SENDTO/SAYTO on
    // ordinary chat ("I can fix that", "okay"). Only act on it when the user's
    // request actually asked to send/tell/message someone — otherwise ignore the
    // directive and let it fall through to a normal reply.
    const wantsToSend =
      /\b(send|sent|sending|tell|texts?|text|message|msg|voice[-\s]?note|forward|dm|pass (?:this|it|the|a|along)|let (?:him|her|them|\w+) know|reply to)\b/i.test(query);
    const contactMsg = wantsToSend ? answer.match(/\[\[\s*(SAYTO|SENDTO)\s*:\s*([\s\S]+?)\s*\]\]/i) : null;
    if (contactMsg) {
      const asVoice = /SAYTO/i.test(contactMsg[1]);
      const inner = contactMsg[2].replace(/\[\[[^\]]*\]\]/g, '').trim();

      // Split "name | message". If there's no pipe (model slipped), resolve the
      // name as the longest leading run of words that matches a saved contact.
      let name = '';
      let content = '';
      const pipe = inner.indexOf('|');
      if (pipe !== -1) {
        name = inner.slice(0, pipe).trim();
        content = inner.slice(pipe + 1).trim();
      } else {
        const words = inner.split(/\s+/);
        for (let k = Math.min(4, words.length); k >= 1; k--) {
          if (findContacts(words.slice(0, k).join(' ')).length) {
            name = words.slice(0, k).join(' ');
            content = words.slice(k).join(' ').trim();
            break;
          }
        }
        if (!name) {
          name = words[0] ?? '';
          content = words.slice(1).join(' ').trim();
        }
      }

      if (!m.isRealOwner) {
        const d = '🔒 only my owner can have me message their contacts.';
        pushTurn(key, 'assistant', d);
        await m.reply(d);
        return undefined;
      }
      if (!name || !content) {
        const r = '🤔 Who should I send it to, and what should I say? e.g. "send Sara a message saying hi".';
        pushTurn(key, 'assistant', r);
        await m.reply(r);
        return undefined;
      }

      // 🛡️ SAFETY NET against the model sending to the WRONG person: the recipient
      // name MUST appear in the owner's actual request. If it doesn't (model copied
      // an example name or hallucinated), try to recover the real recipient the
      // owner named; if we can't, ASK rather than send to the wrong contact.
      if (query && !new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(query)) {
        const corrected = mentionedContactName(query) ?? mentionedGroupName(query);
        logger.warn({ emitted: name, corrected, query: query.slice(0, 120) }, 'send-to: emitted name not in request');
        if (corrected) {
          name = corrected;
        } else if (/\bgroup\b/i.test(query)) {
          // They clearly want a GROUP but I couldn't pin which — show the list.
          await offerGroupPicker(m, key, content, asVoice, query, name);
          return undefined;
        } else {
          const r = `🤔 Wait — who exactly should I send that to? I want to make sure it goes to the right person (and that they're saved in my contacts).`;
          pushTurn(key, 'assistant', r);
          await m.reply(r);
          return undefined;
        }
      }

      // Resolve the recipient: a saved CONTACT by name, OR a GROUP Nexus is in
      // (so "send X to the family group" works from the owner's DM).
      const contactMatches = findContacts(name);
      const groupMatches = findGroups(name);
      const matches = [
        ...contactMatches.map((c) => ({ jid: c.jid, name: c.name, kind: 'contact' as const })),
        ...groupMatches.map((g) => ({ jid: g.jid, name: g.name, kind: 'group' as const })),
      ];
      logger.info({ name, asVoice, contacts: contactMatches.length, groups: groupMatches.length }, 'nexus send-to');
      if (!matches.length) {
        // Group intent but no name match → let them pick from the groups I know.
        if (/\bgroup\b/i.test(query)) {
          await offerGroupPicker(m, key, content, asVoice, query, name);
          return undefined;
        }
        const r = `🤔 I don't have anyone (or any group) named *${name}*. Add a contact with *.addcontact ${name} <number>*, or make sure I'm in that group.`;
        pushTurn(key, 'assistant', r);
        await m.reply(r);
        return undefined;
      }
      if (matches.length > 1) {
        // Ask AND remember the options, so a numeric reply completes the send.
        const list = matches
          .slice(0, 4)
          .map((c, i) => `  *${i + 1}* · ${c.kind === 'group' ? `${c.name} _(group)_` : `${c.name} (+${c.jid.split('@')[0]})`}`)
          .join('\n');
        pendingSend.set(key, { matches: matches.slice(0, 4), content, asVoice, styleQuery: query, at: Date.now() });
        const r = `🤔 A few match *${name}* — which one?\n${list}\n\n_Reply with the number._`;
        pushTurn(key, 'assistant', r);
        await m.reply(r);
        return undefined;
      }
      const target = matches[0];

      // Acknowledge FIRST — reuse the model's own natural lead-in if it wrote one
      // before the directive (varied, not hard-coded); the confirmation comes after.
      const lead = deLeak(sanitizeReply(answer.slice(0, answer.indexOf(contactMsg[0]))));
      if (lead) await m.reply(lead);

      // GROUP sends: confirm the exact group before it goes out (groups are
      // public — no accidental blasts). Contacts still send straight away.
      if (target.kind === 'group') {
        pendingSend.set(key, { matches: [target], content, asVoice, styleQuery: query, at: Date.now(), confirm: true });
        const r = `📨 Send ${asVoice ? 'a voice note' : 'this'} to *${target.name}*? Reply *yes* (or 👍) to confirm, or *no* to cancel.`;
        pushTurn(key, 'assistant', r);
        await m.reply(r);
        return undefined;
      }

      await deliverToTarget(m, target, content, asVoice, query, history, context, key);
      return undefined;
    }

    const runDir = answer.match(/\[\[\s*RUN\s*:\s*([^\]]+?)\s*\]\]/i);
    const runIsVoiceChange = runDir ? /^voice\b/i.test(runDir[1].trim()) : false;

    // Spoken reply (voice note). Handled BEFORE the command branch so that a
    // "say/greet X in your <voice>" request — which the model emits as a SAY
    // plus a voice-change RUN together — sets the voice SILENTLY and then
    // speaks, instead of firing the .voice command that replies "There we go 👇"
    // with a generic sample and never says what the user actually asked for.
    const sayDir = answer.match(/\[\[\s*(?:SAY|VOICE)\s*:\s*([\s\S]+?)\s*\]\]/i);
    if (sayDir && ttsReady() && (!runDir || runIsVoiceChange)) {
      if (runIsVoiceChange && runDir) {
        const arg = runDir[1].trim().replace(/^voice\s+/i, '');
        const { voiceId, styleId } = parseVoiceStyle(arg);
        if (voiceId) setVoice(voiceId);
        if (styleId) setStyle(styleId);
        setStyleDesc(arg); // rich style for the descriptive TTS engine
      }
      const say = sayDir[1].replace(/\[\[[^\]]*\]\]/g, '').trim();
      // Record the actual spoken words as history (not a "(I sent a voice note)"
      // note the model would otherwise echo back as visible text).
      pushTurn(key, 'assistant', say || '🎙️');
      const v = say ? await synthLive(m, say) : { ok: false as const, error: 'empty' };
      if (v.ok) {
        const sent = await m.send({ audio: v.audio, ptt: true, mimetype: v.mimetype }, { quoted: m.raw });
        rememberAudio(sent?.key?.id);
      } else if (say) {
        await m.reply(say); // TTS unavailable — fall back to text
      }
      return undefined;
    }

    // Did Nexus decide to run a command?
    const run = runDir;
    if (run) {
      const cmdText = run[1].trim();
      const cmdName = cmdText.split(/\s+/)[0]?.toLowerCase() ?? '';
      // For slow/heavy actions that will actually run, drop a quick "on it" first.
      if (SLOW_CMDS.has(cmdName) && (!isPrivate() || m.isOwner)) {
        await m.reply(pick(ACK_WORKING));
      }
      const result = await runCommandText(m, cmdText);
      if (result === 'notfound') {
        // Model mis-fired a command on casual chat — recover naturally, no robotic error.
        const leftover = sanitizeReply(answer);
        if (leftover) {
          pushTurn(key, 'assistant', leftover);
          rememberAnswer(leftover);
          await m.reply(leftover);
        } else {
          try {
            await m.react('👍');
          } catch {
            /* ignore */
          }
        }
      }
      // NOTE: we deliberately do NOT push a "(ran …)" assistant turn — small
      // models copy that bookkeeping format back into visible chat as "(ran .".
      return undefined;
    }

    // Did Nexus decide to send a real, collected sticker?
    const send = answer.match(/\[\[\s*SENDSTICKER\s*:\s*([^\]]+?)\s*\]\]/i);
    if (send) {
      const raw = send[1].trim();
      // Exact id → that sticker; anything else (or a description) → a random one.
      let buf = raw && raw.toLowerCase() !== 'random' ? loadSticker(raw) : undefined;
      if (!buf) {
        const rid = randomStickerId();
        buf = rid ? loadSticker(rid) : undefined;
      }
      // Text-then-sticker (the human touch): if the model wrote a short line
      // before the directive (e.g. "you're on 😏"), send it first, then drop the
      // sticker as a REPLY to that very line — like a person who says something
      // and then reacts to themselves with a sticker.
      const lead = deLeak(sanitizeReply(answer.slice(0, answer.indexOf(send[0]))));
      let leadMsg: WAMessage | undefined;
      if (lead) {
        pushTurn(key, 'assistant', lead);
        rememberAnswer(lead);
        leadMsg = (await m.reply(lead)) as WAMessage | undefined;
      }
      if (buf) await m.sendSticker(buf, leadMsg);
      else if (!lead) await m.react('😅');
      return undefined;
    }

    // Native emoji reaction (renders perfectly, unlike a canvas emoji).
    const react = answer.match(/\[\[\s*REACT\s*:\s*([^\]]+?)\s*\]\]/i);
    if (react) {
      const emoji = react[1].trim();
      try {
        await m.react(emoji);
      } catch {
        await m.reply(emoji);
      }
      return undefined;
    }

    // Word/text sticker. If it's actually emoji-only, react instead of
    // rendering (canvas can't do colour emoji — avoids the tofu boxes).
    const sticker = answer.match(/\[\[\s*STICKER\s*:\s*([^\]]+?)\s*\]\]/i);
    if (sticker) {
      const content = sticker[1].trim();
      if (!/[a-z0-9]/i.test(content)) {
        try {
          await m.react(content);
        } catch {
          await m.reply(content);
        }
        return undefined;
      }
      try {
        const png = renderStickerImage(content);
        const webp = await imageToSticker(png);
        await m.sendSticker(webp);
      } catch (err) {
        logger.error({ err }, 'nexus sticker render failed');
        await m.reply(content);
      }
      return undefined;
    }

    const clean = deLeak(sanitizeReply(answer)) || '🙂';
    pushTurn(key, 'assistant', clean);
    rememberAnswer(clean);

    // If we were spoken to (voice note), reply in voice too.
    if (speak && ttsReady()) {
      const voice = await synthLive(m, clean); // keeps "recording audio…" alive till it's ready
      if (voice.ok) {
        const sent = await m.send({ audio: voice.audio, ptt: true, mimetype: voice.mimetype }, { quoted: m.raw });
        rememberAudio(sent?.key?.id);
        return undefined;
      }
    }
    await sendHuman(m, clean); // human pacing: short bubbles, not a wall of text

    // 🔗 Cite the sources behind a searched answer (like Meta AI's "Sources").
    // Sent as its own small message so the answer itself stays clean.
    const srcs = lastSources.get(m.chat);
    if (searchQuery && srcs?.length) {
      lastSources.delete(m.chat);
      const list = srcs.map((s, i) => `${i + 1}. *${s.label}*\n${s.url}`).join('\n\n');
      await m.sendText(`🔗 *Sources* (${srcs.length})\n\n${list}`);
    }
  } catch (err) {
    await typing('paused');
    const h = memory.get(key);
    if (h && h[h.length - 1]?.role === 'user') h.pop();
    logger.error({ err }, 'nexus request failed');
    const status = (err as { response?: { status?: number } }).response?.status;
    const e = err as { code?: string; message?: string };
    const isTimeout = e?.code === 'ECONNABORTED' || /timeout|timed out/i.test(e?.message ?? '');
    if (status === 429) {
      await m.reply(pick(['Give me a moment 😌 I\'m a little swamped — try me again in a few seconds.', 'One sec, catching my breath 😮‍💨 ask me again shortly.', 'Bit busy right now 🙏 give me a moment and try again.']));
    } else if (isTimeout) {
      // Local model was probably cold-loading — friendly, not a scary raw error.
      await m.reply(pick(['oof, my brain lagged there 😅 gimme a sec and say that again', 'sorry, that took too long on my end 😮‍💨 try me once more', 'hmm I\'m waking up slowly 🥱 ask me again in a moment']));
    } else {
      await m.reply(`❌ Nexus hit a snag: ${apiErrorMessage(err)}`);
    }
  }
  return undefined;
}

const chatModeKey = (chat: string) => `nexus.chat.${chat}`;
const chatModeOn = (chat: string) => getSetting(chatModeKey(chat)) === 'on';
const isCommandText = (body: string) => config.prefixes.some((p) => p && body.startsWith(p));
// A message that LOOKS like a command (starts with a common prefix char + a
// letter) even if it used the WRONG prefix — so auto-chat won't chat about a
// mistyped ".read" when the real prefix is "!". Only in prefix mode.
const looksLikeCommandAttempt = (body: string) => config.prefixes.some((p) => p) && /^[.!/#][a-zA-Z]/.test(body.trim());
/** When ON, Nexus auto-replies to EVERY private DM (from others) like a human —
 *  no "nexus" keyword, no session window. Owner toggles with .autochat. */
const dmAutoChatOn = () => getSetting('dm.autochat') === 'on';

command(
  { pattern: 'autochat ?(.*)', fromMe: true, desc: 'Auto-reply to every private DM (no keyword)', usage: 'on|off', category: 'nexus' },
  async (m, match) => {
    const v = (match?.[1] ?? '').trim().toLowerCase();
    if (v === 'on') {
      setSetting('dm.autochat', 'on');
      return m.reply('💬 *DM auto-chat is ON* — I\'ll reply to every private DM like a human, no "nexus" needed. Voice notes get a voice reply too. Turn off with *.autochat off*.');
    }
    if (v === 'off') {
      deleteSetting('dm.autochat');
      return m.reply('💬 DM auto-chat is *OFF* — back to needing "nexus" / chat mode.');
    }
    return m.reply(`💬 DM auto-chat is *${dmAutoChatOn() ? 'on' : 'off'}*. Use *.autochat on|off*.`);
  },
);

async function nexusCommand(m: Message, match: RegExpMatchArray | null): Promise<unknown> {
  const prompt = (match?.[1]?.trim() || m.quoted?.text || '').trim();
  const prefix = config.prefixes[0] ?? '.';

  if (/^on$/i.test(prompt)) {
    if (chatModeOn(m.chat)) return m.reply("💬 I'm already on for this chat 😊 just say *nexus <question>*.");
    setSetting(chatModeKey(m.chat), 'on');
    return m.reply(
      `💬 *Nexus chat is ON.*\nSay *nexus <question>* to start — then just keep chatting for a couple minutes, no need to repeat "nexus". Turn off with *${prefix}nexus off*.`,
    );
  }
  if (/^off$/i.test(prompt)) {
    if (!chatModeOn(m.chat)) return m.reply("💬 I'm already off for this chat 🙂");
    deleteSetting(chatModeKey(m.chat));
    sessions.delete(memKey(m));
    return m.reply('Nexus chat turned off.');
  }
  if (/^stickers?$/i.test(prompt)) {
    const cat = stickerCatalog();
    if (!cat.length) {
      return m.reply('🗂️ My sticker stash is empty. Turn chat mode on (*.nexus on*) and let people send stickers — I collect them automatically.');
    }
    const captioned = cat.filter((s) => s.desc).length;
    const sample = cat.slice(-8).map((s) => `• ${s.desc || '(uncaptioned)'}`).join('\n');
    return m.reply(`🗂️ I've collected *${cat.length}* stickers (${captioned} captioned).\nRecent:\n${sample}`);
  }
  if (/^(reset|clear|forget|new chat)$/i.test(prompt)) {
    memory.delete(memKey(m));
    sessions.delete(memKey(m));
    return m.reply('🧹 Memory cleared — fresh start!');
  }
  return respond(m, prompt);
}

command({ pattern: 'nexus ?(.*)', desc: 'Ask Nexus, or on/off chat mode', usage: '<question | on | off | reset>', category: 'nexus' }, nexusCommand);
command({ pattern: 'ai ?(.*)', desc: 'Ask Nexus (alias for .nexus)', usage: '<question>', category: 'nexus', hidden: true }, nexusCommand);

// .tts — make Nexus speak arbitrary text as a voice note.
command({ pattern: 'tts (.+)', desc: 'Make Nexus speak the text', usage: '<text>', category: 'nexus' }, async (m, match) => {
  const text = match?.[1]?.trim() ?? '';
  if (!text) return m.reply('🗣️ Give me something to say — *.tts hello there*');
  if (!ttsReady()) {
    return m.reply(
      "🔇 Voice replies aren't set up yet.\nAdd *NEXUS_TTS_MODEL=playai-tts* to your .env (and accept the model's terms in the Groq console), then restart.",
    );
  }
  await m.react('🗣️');
  const result = await synthesizeResult(text);
  if (!result.ok) return m.reply(`❌ Voice synthesis failed —\n${result.error}`);
  const sent = await m.send({ audio: result.audio, ptt: true, mimetype: result.mimetype }, { quoted: m.raw });
  rememberAudio(sent?.key?.id);
});

function voiceMenu(): string {
  const v = VOICES[currentVoiceId()]?.label ?? 'default';
  const s = STYLES[currentStyleId()]?.label ?? 'Normal';
  const voices = Object.values(VOICES).map((x) => `│ ▸ ${x.label}`).join('\n');
  const styles = Object.values(STYLES).map((x) => x.label).join(', ');
  return (
    `╭─ 🎙️ *NEXUS VOICE*\n` +
    `│ Now: *${v}* · tone *${s}*\n` +
    `├─ Voices/accents:\n${voices}\n` +
    `├─ Tones: ${styles}\n` +
    `╰─ e.g. *nexus switch to a soft british voice*`
  );
}

// ---- Voice picker: .voice → numbered list → reply a number → set + sample ----
const pendingVoice = new Map<string, { ids: string[]; at: number }>();
const VOICE_TTL = 3 * 60_000;

/** Peek: is this a valid pick for a pending voice list? */
export function isVoiceChoice(m: Message): boolean {
  const p = pendingVoice.get(memKey(m));
  if (!p || Date.now() - p.at > VOICE_TTL) return false;
  const n = parseInt(m.body.trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= p.ids.length;
}

function voicePicker(): { text: string; ids: string[] } {
  const ids = Object.keys(VOICES);
  const cur = currentVoiceId();
  const lines = ids.map((id, i) => `  *${i + 1}* · ${VOICES[id].label}${id === cur ? '   ⭐' : ''}`);
  const text =
    `🎙️ *Pick my voice:*\n\n${lines.join('\n')}\n\n` +
    `_Reply with the number. Tones too — try *.voice soft*, *whisper*, *deep*, *slow*, *fast*._`;
  return { text, ids };
}

// Passive: a number reply picks a voice, sets it, and plays a sample.
command({ on: 'message' }, async (m) => {
  const key = memKey(m);
  const p = pendingVoice.get(key);
  if (!p) return;
  if (Date.now() - p.at > VOICE_TTL) return void pendingVoice.delete(key);
  const n = parseInt(m.body.trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > p.ids.length) return;
  if (!m.isRealOwner) return;
  pendingVoice.delete(key);
  markConsumed(m.raw?.key?.id);
  const id = p.ids[n - 1];
  setVoice(id);
  const label = VOICES[id]?.label ?? 'my';
  await m.reply(pick(['Done! Listen 👇', 'Switched 😎 here\'s how I sound now 👇', 'There we go — have a listen 👇', 'All set! 🎙️👇']));
  if (ttsReady()) {
    const sample = await synthLive(m, `Hey! This is my ${label.toLowerCase()} voice. How do I sound?`);
    if (sample.ok) {
      const sent = await m.send({ audio: sample.audio, ptt: true, mimetype: sample.mimetype }, { quoted: m.raw });
      rememberAudio(sent?.key?.id);
    }
  }
});

// .voice — switch accent/voice/tone by natural language ("british", "american
// female", "soft", "whisper", "deep"...). Owner-only (it's a bot-wide setting).
command({ pattern: 'voice(?: (.+))?', desc: 'Pick / switch Nexus’s voice, accent or tone', usage: '[british | soft | whisper …]', category: 'nexus', fromMe: true }, async (m, match) => {
  const arg = match?.[1]?.trim() ?? '';
  if (!arg || /^(list|voices|menu|pick|\?)$/i.test(arg)) {
    // Show the numbered picker and remember it, so a number reply switches voice.
    const { text, ids } = voicePicker();
    pendingVoice.set(memKey(m), { ids, at: Date.now() });
    return m.reply(text);
  }

  const { voiceId, styleId } = parseVoiceStyle(arg);
  const hasLocal = Boolean(config.nexus.ttsLocalUrl);
  // With a local descriptive engine, ANY wording is a valid style ("soft romantic
  // whisper"). Without it, we need a known preset.
  if (!voiceId && !styleId && !hasLocal) {
    return m.reply(`🤔 Didn’t catch a voice there.\n\n${voiceMenu()}`);
  }
  if (voiceId) setVoice(voiceId);
  if (styleId) setStyle(styleId);
  setStyleDesc(arg); // rich description for the local descriptive-TTS engine

  const vLabel = VOICES[currentVoiceId()]?.label ?? 'default';
  const sLabel = hasLocal ? currentStyleDesc() : STYLES[currentStyleId()]?.label ?? 'Normal';
  await m.reply(pick(['Done! Give it a listen 👇', 'Switched 😎 here\'s how I sound now 👇', 'There we go — listen 👇', 'All set! 🎙️👇']));

  // Speak a short sample in the new voice/tone (keeps "recording…" alive).
  const sample = await synthLive(m, `Okay! This is my ${sLabel.toLowerCase()} ${vLabel.toLowerCase()} voice.`);
  if (sample.ok) {
    const sent = await m.send({ audio: sample.audio, ptt: true, mimetype: sample.mimetype }, { quoted: m.raw });
    rememberAudio(sent?.key?.id);
  }
});

command({ pattern: 'voices', desc: 'List Nexus voices', category: 'nexus', hidden: true }, async (m) => m.reply(voiceMenu()));

// .search — live web search (Groq compound).
command({ pattern: 'search (.+)', desc: 'Search the web (live)', usage: '<query>', category: 'ai' }, async (m, match) => {
  const q = match?.[1]?.trim() ?? '';
  if (!q) return m.reply('🔎 What should I look up?');
  await m.react('🔎');
  // Clean, ordered results (not the raw blob the AI reads). Google-News-backed.
  try {
    const r = await nexusWeb(q, { limit: 6 });
    const lines: string[] = [];
    const instant = r.instant?.answer || r.instant?.abstract;
    if (instant) lines.push(`💡 ${instant}`);
    r.results.forEach((h, i) => {
      const date = h.time ? new Date(h.time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      const meta = [h.source, date].filter(Boolean).join(' · ');
      // Hide Google-News RSS redirect links (ugly base64 blobs); show clean ones.
      const url = h.url && !/news\.google\.com/i.test(h.url) ? h.url : '';
      lines.push(`*${i + 1}.* ${cleanNewsTitle(h.title, h.source)}${meta ? `\n     _${meta}_` : ''}${url ? `\n     ${url}` : ''}`);
    });
    if (lines.length) return m.reply(`🔎 *Results for* “${q}”\n\n${lines.join('\n\n')}`);
  } catch {
    /* fall through to the plain fallback */
  }
  const info = await webSearch(q);
  return m.reply(info ? `🔎 *${q}*\n\n${info}` : "❌ Couldn't fetch that right now — try again in a moment.");
});

// .who — reverse-image-search a replied photo/video to identify who/what it is.
command({ pattern: 'who', desc: 'Identify who/what is in a replied photo/video', category: 'ai' }, async (m) => {
  const frame = await mediaFrame(m);
  if (!frame) return m.reply('Reply to a photo or video with *.who* 🙂');
  await m.react('🔎');
  const hits = await identifyImage(frame);
  if (!hits) return m.reply("Couldn't identify it 😅 the search may be blocked (common on servers) or found nothing.");
  return m.reply(`🔎 *Closest matches I found:*\n${hits}`);
});

// .what <url> — peek at a link and say what it is (direct, no AI needed).
command({ pattern: 'what (.+)', desc: 'Tell what a link is', usage: '<url>', category: 'ai', hidden: true }, async (m, match) => {
  const url = (match?.[1] ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return m.reply('Give me a link starting with http(s).');
  await m.react('👀');
  const info = await linkInfo(url);
  return m.reply(info ? `🔎 ${info}` : "Couldn't peek into that link 😅 it might be private or blocking me.");
});

// .memory — show what Nexus remembers, or toggle memory on/off (owner).
command({ pattern: 'memory ?(.*)', desc: 'What Nexus remembers / toggle', usage: '[on | off]', category: 'nexus' }, async (m, match) => {
  const arg = match?.[1]?.trim().toLowerCase();
  if (arg === 'on' || arg === 'off') {
    if (!m.isOwner) return m.reply('🔒 Only the owner can toggle memory.');
    if (arg === 'off') setSetting('memory.enabled', 'off');
    else deleteSetting('memory.enabled');
    return m.reply(arg === 'on' ? '🧠 Long-term memory is *ON*.' : '🧠 Long-term memory is *OFF* — I won\'t record or recall facts (saved notes are kept, just not used).');
  }
  const state = memoryEnabled() ? 'on' : 'off';
  const mine = listMemories(m.chat, m.senderNumber);
  const grp = m.isGroup ? listMemories(m.chat, 'group') : [];
  if (!mine.length && !grp.length) {
    return m.reply(`🧠 Memory is *${state}*. No long-term notes about you yet.`);
  }
  let t = `🧠 *What I remember* (memory ${state})`;
  if (mine.length) t += `\n\n*About you:*\n${mine.map((x) => `• ${x.fact}`).join('\n')}`;
  if (grp.length) t += `\n\n*About this group:*\n${grp.map((x) => `• ${x.fact}`).join('\n')}`;
  return m.reply(t);
});

command(
  { pattern: 'crosschat ?(.*)', fromMe: true, desc: 'Recognise people across chats (on by default)', usage: '[on | off]', category: 'owner' },
  async (m, match) => {
    const arg = (match?.[1] ?? '').trim().toLowerCase();
    const p = config.prefixes[0] ?? '';
    if (/^(on|enable|yes)$/.test(arg)) {
      setSetting('crosschat', 'on');
      return m.reply('🧠 *Cross-chat memory: ON*\nI\'ll recognise people I know from other chats — flowing with their vibe, not announcing where I met them.');
    }
    if (/^(off|disable|no)$/.test(arg)) {
      setSetting('crosschat', 'off');
      return m.reply('🔒 *Cross-chat memory: OFF*\nEach chat is separate now — what I learn in one place stays there.');
    }
    return m.reply(
      `🧠 *Cross-chat memory:* ${crossChatOn() ? '*ON*' : '*OFF*'} _(on by default)_\n\n` +
        `When on, I know the same person across groups and DMs — I use what I know naturally and only say where I know them from if they actually ask.\n\n` +
        `• *${p}crosschat on*\n• *${p}crosschat off* — keep every chat separate`,
    );
  },
);

command({ pattern: 'forget ?(.*)', desc: 'Make Nexus forget what it knows', usage: '[group]', category: 'nexus' }, async (m, match) => {
  const arg = match?.[1]?.trim().toLowerCase();
  if (arg === 'group') {
    if (!m.isGroup) return m.reply('That only works inside a group.');
    const n = forgetMemories(m.chat, 'group');
    return m.reply(`🧹 Forgot ${n} note(s) about this group.`);
  }
  const n = forgetMemories(m.chat, m.senderNumber);
  return m.reply(n ? `🧹 Forgot ${n} note(s) I had about you.` : "Nothing to forget — I have no notes about you.");
});

// .tz — set/show/reset your timezone so Nexus gives times in your local zone.
command({ pattern: 'tz ?(.*)', desc: 'Set/show your timezone', usage: '[China | reset | Europe/London]', category: 'nexus' }, async (m, match) => {
  const arg = match?.[1]?.trim() ?? '';
  const lower = arg.toLowerCase();

  // Reset override → go back to detecting from the phone number.
  if (['reset', 'auto', 'clear', 'default'].includes(lower)) {
    clearUserZone(m.senderNumber);
    const detected = zoneFromNumber(m.senderNumber);
    const now = nowFor(m.senderNumber);
    return m.reply(
      `🔄 Override cleared — auto-detecting from your number (+${m.senderNumber}).\n` +
        `📍 Zone: *${now.zone}*${detected ? '' : ' (couldn\'t read your country from the number — using the bot default)'}\n` +
        `🕐 Your time: *${now.text}*`,
    );
  }

  // "CST" is ambiguous — don't guess.
  if (lower === 'cst') {
    return m.reply(
      '⚠️ *CST* means two things — US Central *and* China Standard Time.\n' +
        'For China: *.tz China* (or .tz Asia/Shanghai)\n' +
        'For the US: *.tz America/Chicago*',
    );
  }

  if (!arg) {
    const now = nowFor(m.senderNumber);
    return m.reply(
      `🕐 Your time: *${now.text}*\n📍 Zone: *${now.zone}*\n\n` +
        `Wrong? Set it with *.tz <place>* — e.g. .tz China, .tz Asia/Shanghai, .tz WAT, .tz Europe/London\n` +
        `Or *.tz reset* to auto-detect from your number.`,
    );
  }

  const zone = normalizeZone(arg);
  if (!zone) return m.reply(`🤔 I don't recognise "*${arg}*". Try a place (China, Nigeria, London) or an IANA name like *Asia/Shanghai*.`);
  setUserZone(m.senderNumber, zone);
  const now = nowFor(m.senderNumber);
  return m.reply(`✅ Timezone set to *${zone}*.\nYour local time is now *${now.text}*.`);
});

// Chat mode: address with "nexus ..." to start, then follow-ups continue the
// session for a short window without repeating the keyword.
command({ on: 'message' }, async (m) => {
  const body = (m.body ?? '').trim();
  // An image/video with NO caption still deserves a look — otherwise Nexus can't
  // "see" a screenshot someone shares. We hand vision a small placeholder query.
  const hasMedia = m.type === 'imageMessage' || m.type === 'videoMessage';
  const IMAGE_Q = '(they shared an image — look at what it actually shows and react to it naturally)';
  if (!body && !hasMedia) return;
  if (body && recentAnswers.has(body)) return; // never reply to Nexus's own output

  // Leave interactive-flow replies alone (e.g. "1" answering a download quality,
  // search-result, or "which contact?" prompt) — the flow already claimed them.
  if (isConsumed(m.raw?.key?.id) || isDownloadChoice(m) || isSearchChoice(m) || isSendChoice(m) || isVoiceChoice(m)) return;

  // A bare pick ("1", "2", "hd", "yes") is someone answering a menu — even if
  // that flow already expired or failed. Chatting about it ("how are you?"
  // after a download died) is jarring, so stay quiet rather than guess.
  if (/^([1-9]|10|hd|sd|max|hq|yes|no|y|n|ok)$/i.test(body)) return;

  const key = memKey(m);

  // A real command (or a command typed with the wrong prefix) ends the session
  // and is left for the command handlers / unknown-command hint — never chatted about.
  if (body && (isCommandText(body) || looksLikeCommandAttempt(body))) {
    sessions.delete(key);
    return;
  }

  // 💬 Private DM auto-chat: reply to EVERY message like a human — no "nexus"
  // keyword, no session. Only 1-on-1 DMs. Replies to OTHER people's messages, and
  // to your own messages in the "message yourself" self-chat (so you can test it).
  if (!m.isGroup && dmAutoChatOn() && (!m.fromMe || m.chat === m.me)) {
    touchSession(key);
    return respond(m, body || IMAGE_Q);
  }

  // Otherwise, the classic keyword/session flow needs chat mode ON for this chat.
  if (!chatModeOn(m.chat)) return;

  const keyword = body.match(/^nexus\b[:,]?\s*([\s\S]*)$/i);
  if (keyword) {
    const q = keyword[1].trim();
    if (!q) {
      touchSession(key);
      return m.reply('Yes? 😊 Go ahead.');
    }
    return respond(m, q);
  }

  // No keyword: continue only if a session is active AND the message is actually
  // aimed at Nexus. In a group, replying to (or @-mentioning) SOMEONE ELSE means
  // you're talking to that person, not Nexus — stay silent (fixes "lock-on").
  if (sessionActive(key)) {
    if (m.isGroup && !addressedToNexus(m)) return;
    return respond(m, body || IMAGE_Q);
  }
});

/** In a group, is this message actually directed at Nexus (vs. another person)? */
function addressedToNexus(m: Message): boolean {
  const q = m.quoted;
  if (q?.sender) {
    // It's a reply: only "for Nexus" if it's a reply to the bot's own message.
    return q.sender === m.me || (m.meLid ? q.sender === m.meLid : false);
  }
  // @-mentions aimed at other people (not the bot) → not for Nexus.
  const others = m.mentioned.filter((j) => j !== m.me && j !== m.meLid);
  if (others.length) return false;
  return true; // plain message, no other target → continue the active chat
}

// Voice notes: while a Nexus conversation is active, transcribe the voice note
// with Whisper and let Nexus reply — in voice too, if TTS is configured.
// Start a conversation with a text "nexus ..." first; then just talk.
command({ on: 'message' }, async (m) => {
  if (m.type !== 'audioMessage') return;
  if (botAudioIds.has(m.raw.key.id ?? '')) return; // our own voice reply — never loop
  if (m.fromMe && m.chat !== m.me) return; // skip our own outgoing (except self-chat testing)
  const key = memKey(m);

  // In a private DM with auto-chat on, listen + reply to ANY voice note. Else the
  // classic flow: needs chat mode on + an active session (and, in groups, aimed at us).
  const dmAuto = !m.isGroup && dmAutoChatOn();
  if (!dmAuto) {
    if (!chatModeOn(m.chat)) return;
    if (!sessionActive(key)) return;
    if (m.isGroup && !addressedToNexus(m)) return;
  } else {
    touchSession(key);
  }

  try {
    const buf = await m.downloadMedia(false);
    if (!buf) return;
    const text = await transcribe(buf);
    if (!text) return;
    // They spoke to us → hear them out and reply in voice too (speak = true).
    await respond(m, text, true);
  } catch (err) {
    logger.warn({ err }, 'voice note handling failed');
  }
});

// ---- Teach Nexus its favourite stickers (owner curation) ---------------------
// Reply to a sticker with:  .savesticker funny        (or love / hype / sad …)
command(
  { pattern: 'savesticker ?(.*)', fromMe: true, desc: 'Save the replied sticker as a mood sticker', usage: '<mood/tags>', category: 'nexus' },
  async (m, match) => {
    if (!m.isRealOwner) return m.reply('🔒 Only my owner can teach me stickers.');
    const q = m.quoted?.raw;
    if (!q || !('stickerMessage' in q)) {
      return m.reply('🩹 Reply to a *sticker* with *.savesticker <mood>* — e.g. reply to a funny one with *.savesticker funny*.');
    }
    const tags = (match?.[1] ?? '')
      .toLowerCase()
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      const buf = await m.downloadMedia(true); // the quoted sticker
      if (!buf) return m.reply('😕 Couldn\'t grab that sticker — try again.');
      const desc = tags.length ? tags.join(', ') : 'a favourite';
      const id = saveSticker(buf, { desc, tags });
      const total = stickerCatalog().length;
      await m.reply(`✅ Saved to my stickers${tags.length ? ` as *${tags.join(', ')}*` : ''}. I'll use it when the mood fits 😌 (I now know *${total}*.)`);
      logger.info({ id, tags }, 'owner saved a mood sticker');
    } catch (err) {
      logger.error({ err }, 'savesticker failed');
      await m.reply('😕 That didn\'t save right — make sure you replied to an actual sticker.');
    }
  },
);

command({ pattern: 'stickers', fromMe: true, desc: 'List the stickers Nexus knows', category: 'nexus' }, async (m) => {
  if (!m.isRealOwner) return;
  const cat = stickerCatalog().map((s) => ({ ...s, tags: s.tags ?? [] })); // old rows may lack tags
  if (!cat.length) return m.reply('🩹 I don\'t know any stickers yet. Reply to one with *.savesticker <mood>* to teach me.');
  const tagged = cat.filter((s) => s.tags.length);
  const untagged = cat.length - tagged.length;
  // Only list the useful (tagged) ones — the bare-id untagged pile is just noise.
  const show = (tagged.length ? tagged : cat).slice(0, 40);
  const lines = show.map((s) => `• \`${s.id}\`${s.tags.length ? ` — ${s.tags.join(', ')}` : ''}`);
  await m.reply(
    `🩹 *Stickers I know* (${cat.length}${untagged ? `, ${untagged} untagged` : ''}):\n${lines.join('\n')}\n\n` +
      `_Remove one with *.delsticker <id>*._` +
      (untagged ? `\n_Clear the ${untagged} untagged junk with *.delsticker untagged*._` : ''),
  );
});

command({ pattern: 'delsticker (.+)', fromMe: true, desc: 'Forget a saved sticker', usage: '<id | untagged | all>', category: 'nexus', hidden: true }, async (m, match) => {
  if (!m.isRealOwner) return;
  const arg = (match?.[1] ?? '').trim().toLowerCase();

  if (arg === 'all') {
    const cat = stickerCatalog();
    for (const s of cat) removeSticker(s.id);
    return m.reply(`🗑️ Cleared *all ${cat.length}* stickers.`);
  }
  if (arg === 'untagged') {
    const junk = stickerCatalog().filter((s) => s.tags.length === 0);
    for (const s of junk) removeSticker(s.id);
    return m.reply(`🗑️ Removed *${junk.length}* untagged stickers. Kept *${stickerCatalog().length}* tagged ones. 🧹`);
  }
  removeSticker(arg);
  await m.reply(`🗑️ Removed \`${arg}\` (if it existed).`);
});

// Tag an ALREADY-saved sticker by id (for ones auto-collected without moods).
command({ pattern: 'tagsticker (.+)', fromMe: true, desc: 'Add mood tags to a saved sticker', usage: '<id> <mood/tags>', category: 'nexus', hidden: true }, async (m, match) => {
  if (!m.isRealOwner) return;
  const parts = (match?.[1] ?? '').trim().split(/\s+/);
  const id = parts.shift() ?? '';
  const tags = parts.map((t) => t.toLowerCase()).filter(Boolean);
  if (!id || !tags.length) return m.reply('Usage: *.tagsticker <id> <mood>* — e.g. *.tagsticker a1b2c3 funny*. See ids with *.stickers*.');
  const ok = setStickerTags(id, tags);
  await m.reply(ok ? `✅ Tagged \`${id}\` as *${tags.join(', ')}*.` : `😕 I don't have a sticker with id \`${id}\`. Check *.stickers*.`);
});

// Send back a saved sticker so you can see which one an id is.
command({ pattern: 'showsticker (.+)', fromMe: true, desc: 'Show a saved sticker by id', category: 'nexus', hidden: true }, async (m, match) => {
  if (!m.isRealOwner) return;
  const id = (match?.[1] ?? '').trim();
  const buf = loadSticker(id);
  if (!buf) return m.reply(`😕 No sticker \`${id}\`.`);
  await m.sendSticker(buf);
});

// Review untagged stickers: sends each one with its id so you can tag them.
command({ pattern: 'reviewstickers', fromMe: true, desc: 'Review & tag your untagged stickers', category: 'nexus', hidden: true }, async (m) => {
  if (!m.isRealOwner) return;
  const ids = untaggedStickers();
  if (!ids.length) return m.reply('🎉 All your stickers already have moods — nothing to review.');
  const batch = ids.slice(0, 8);
  await m.reply(`🩹 ${ids.length} sticker(s) need a mood. Here are ${batch.length} — reply to each with the tip below:`);
  for (const id of batch) {
    const buf = loadSticker(id);
    if (!buf) continue;
    await m.sendSticker(buf);
    await m.reply(`↑ *.tagsticker ${id} <mood>*  (funny / love / hype / sad / greeting …)`);
  }
  if (ids.length > batch.length) await m.reply(`…and ${ids.length - batch.length} more — run *.reviewstickers* again after tagging these.`);
});

// Stickers while Nexus chat mode is on: (1) collect good ones into the library,
// and (2) if a conversation is active, treat the sticker AS A MESSAGE and let
// Nexus decide how to respond (another sticker, a line, both, or nothing) —
// instead of ignoring it until the user types text.
command({ on: 'message' }, async (m) => {
  if (m.type !== 'stickerMessage' || m.fromMe) return;
  if (!chatModeOn(m.chat)) return;

  const key = memKey(m);
  const forNexus = sessionActive(key) && (!m.isGroup || addressedToNexus(m));

  try {
    const buf = await m.downloadMedia(false);
    if (!buf) return;

    // Collect new reaction stickers — but ONLY ones we could actually caption
    // and tag (needs a vision model). An untagged sticker is useless for
    // mood-matching and just clutters .stickers, so we skip those.
    let caption: Awaited<ReturnType<typeof captionSticker>> | undefined;
    if (!stickerExists(stickerHash(buf))) {
      caption = await captionSticker(buf);
      if (caption && caption.good && (caption.tags.length > 0 || caption.desc)) {
        const id = saveSticker(buf, caption);
        logger.info({ id, desc: caption.desc }, 'nexus saved a sticker');
      }
    }

    // Inside an active chat, the sticker is a turn in the conversation.
    if (forNexus) {
      const desc = caption?.desc ? `: ${caption.desc}` : '';
      touchSession(key);
      await respond(m, `[the user just sent a sticker${desc}] react to it naturally as part of our ongoing chat`);
    }
  } catch (err) {
    logger.warn({ err }, 'sticker handling failed');
  }
});
// end of chatbot plugin
