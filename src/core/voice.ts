import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/index.js';
import { logger } from '../logger.js';

/* --------------------------- voices & tone styles -------------------------- */

/** Selectable voices. `edge` = Microsoft neural voice (natural, primary),
 *  `file` = Piper model name (offline fallback). */
export const VOICES: Record<string, { file: string; edge: string; label: string }> = {
  'gb-male': { file: 'en_GB-alan-medium', edge: 'en-GB-RyanNeural', label: 'British male' },
  'gb-female': { file: 'en_GB-jenny_dioco-medium', edge: 'en-GB-SoniaNeural', label: 'British female' },
  'gb-north': { file: 'en_GB-northern_english_male-medium', edge: 'en-GB-ThomasNeural', label: 'Northern British male' },
  'us-female': { file: 'en_US-amy-medium', edge: 'en-US-AriaNeural', label: 'American female' },
  'us-male': { file: 'en_US-ryan-high', edge: 'en-US-GuyNeural', label: 'American male' },
  // Extra Edge (Microsoft) voices — no download needed, work online.
  'us-female2': { file: 'en_US-amy-medium', edge: 'en-US-JennyNeural', label: 'American female (warm)' },
  'us-male2': { file: 'en_US-ryan-high', edge: 'en-US-ChristopherNeural', label: 'American male (deep)' },
  'au-female': { file: 'en_US-amy-medium', edge: 'en-AU-NatashaNeural', label: 'Australian female' },
  'au-male': { file: 'en_US-ryan-high', edge: 'en-AU-WilliamNeural', label: 'Australian male' },
  'in-female': { file: 'en_US-amy-medium', edge: 'en-IN-NeerjaNeural', label: 'Indian female' },
  'in-male': { file: 'en_US-ryan-high', edge: 'en-IN-PrabhatNeural', label: 'Indian male' },
  'ie-female': { file: 'en_GB-jenny_dioco-medium', edge: 'en-IE-EmilyNeural', label: 'Irish female' },
};

/** Tone styles — ffmpeg audio filters layered on top of any voice. */
export const STYLES: Record<string, { label: string; filter: string }> = {
  normal: { label: 'Normal', filter: '' },
  soft: { label: 'Soft', filter: 'volume=0.6,lowpass=f=3500' },
  whisper: { label: 'Whisper', filter: 'volume=0.5,highpass=f=200,lowpass=f=5000' },
  deep: { label: 'Deep', filter: 'aresample=48000,asetrate=40800,atempo=1.1765,aresample=48000' },
  slow: { label: 'Slow', filter: 'atempo=0.85' },
  fast: { label: 'Fast', filter: 'atempo=1.25' },
};

export function currentVoiceId(): string {
  const v = getSetting('tts.voice');
  return v && VOICES[v] ? v : 'gb-male';
}
export function currentStyleId(): string {
  const s = getSetting('tts.style');
  return s && STYLES[s] ? s : 'normal';
}
export function setVoice(id: string): void {
  if (VOICES[id]) setSetting('tts.voice', id);
}
export function setStyle(id: string): void {
  if (STYLES[id]) setSetting('tts.style', id);
}

/** Free-form voice style description for the local descriptive-TTS engine
 *  (e.g. "soft, romantic, whispering"). */
export function currentStyleDesc(): string {
  return getSetting('tts.desc') || 'natural, warm and friendly';
}
export function setStyleDesc(desc: string): void {
  const d = desc.trim();
  if (d) setSetting('tts.desc', d.slice(0, 200));
}

/** Directory holding the baked voice models. */
function voicesDir(): string {
  if (config.nexus.piperDir) return config.nexus.piperDir;
  return config.nexus.piperVoice ? dirname(config.nexus.piperVoice) : '/opt/piper-voices';
}

/** Resolve the .onnx model path for the currently-selected voice. */
function selectedModel(): string | undefined {
  const preset = VOICES[currentVoiceId()];
  if (preset) {
    const p = join(voicesDir(), `${preset.file}.onnx`);
    if (existsSync(p)) return p;
  }
  return config.nexus.piperVoice || undefined; // fall back to the default baked voice
}

/** Parse a free-text request like "soft british" or "american female" into ids. */
export function parseVoiceStyle(text: string): { voiceId?: string; styleId?: string } {
  const t = text.toLowerCase();
  let voiceId: string | undefined;
  let styleId: string | undefined;

  if (VOICES[t.trim()]) voiceId = t.trim();
  const female = /\b(female|woman|girl|lady|she|her)\b/.test(t) || /jenny|amy/.test(t);
  const male = /\b(male|man|guy|boy|he|him|dude)\b/.test(t) || /alan|ryan/.test(t);

  if (/brit|uk|england|english|alan|jenny/.test(t)) {
    if (/north/.test(t)) voiceId = 'gb-north';
    else voiceId = female ? 'gb-female' : 'gb-male';
  } else if (/austral|aussie/.test(t)) {
    voiceId = female ? 'au-female' : 'au-male';
  } else if (/india|indian|desi/.test(t)) {
    voiceId = female ? 'in-female' : 'in-male';
  } else if (/irish|ireland/.test(t)) {
    voiceId = 'ie-female';
  } else if (/america|american|\bus\b|\busa\b|amy|ryan|yank/.test(t)) {
    voiceId = female ? 'us-female' : 'us-male';
  } else if (/north/.test(t)) {
    voiceId = 'gb-north';
  } else if (female) {
    voiceId = 'us-female';
  } else if (male) {
    voiceId = 'gb-male';
  }

  if (/whisper/.test(t)) styleId = 'whisper';
  else if (/soft|gentle|calm|quiet|smooth|sweet/.test(t)) styleId = 'soft';
  else if (/deep|low|dark|bass|husky/.test(t)) styleId = 'deep';
  else if (/slow/.test(t)) styleId = 'slow';
  else if (/fast|quick|speed/.test(t)) styleId = 'fast';
  else if (/normal|default|clear|plain|reset|neutral/.test(t)) styleId = 'normal';

  return { voiceId, styleId };
}

/**
 * Voice for Nexus — hearing (speech-to-text via Whisper) and speaking
 * (text-to-speech).
 *
 * HEARING uses the same OpenAI-compatible provider as the chat model (Groq by
 * default) at .../v1/audio/transcriptions — free on Groq.
 *
 * SPEAKING has two providers:
 *   1. A paid provider (Groq Orpheus / any OpenAI-compatible /audio/speech) —
 *      used only if NEXUS_TTS_MODEL is set. Highest quality.
 *   2. A FREE fallback (StreamElements, no API key) — used by default, and
 *      automatically when the paid provider isn't configured or fails.
 */

/** Derive a sibling audio endpoint (/audio/transcriptions or /audio/speech)
 *  from a chat-completions base URL. */
function audioEndpoint(base: string, path: 'audio/transcriptions' | 'audio/speech'): string {
  return base.replace(/chat\/completions\/?$/, path);
}

/** A local model server (Ollama, LM Studio, ...) — it has no Whisper/audio
 *  route, so hearing/paid-speech must go to a real cloud provider instead. */
function isLocalUrl(u: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|::1|:11434|:1234|\/ollama/i.test(u);
}

/**
 * Pick the endpoint to use for Whisper transcription. Whisper needs a cloud
 * provider (Groq gives it free); if the PRIMARY chat model is local (Ollama),
 * its /v1 has no /audio/transcriptions route — so fall back to the (Groq)
 * fallback endpoint automatically. This is why voice-in→voice-out was silent on
 * a fully-local setup.
 */
function sttProvider(): { url: string; key: string } | undefined {
  const primary = { url: config.nexus.url, key: config.nexus.key };
  const fallback = { url: config.nexus.fallbackUrl, key: config.nexus.fallbackKey };
  if (primary.key && !isLocalUrl(primary.url)) return primary;
  if (fallback.key && !isLocalUrl(fallback.url)) return fallback;
  // Nothing cloud-capable — try whatever has a key (will likely fail, but honest).
  if (primary.key) return primary;
  if (fallback.key) return fallback;
  return undefined;
}

/** True when Nexus can transcribe voice notes (needs a cloud key). */
export function sttReady(): boolean {
  return Boolean(sttProvider());
}

/** True when Nexus can speak — local descriptive TTS, Edge, Piper, paid, or web. */
export function ttsReady(): boolean {
  return (
    Boolean(config.nexus.ttsLocalUrl) ||
    config.nexus.ttsEdge ||
    Boolean(config.nexus.piperBin && config.nexus.piperVoice) ||
    Boolean(config.nexus.key && config.nexus.ttsModel) ||
    config.nexus.ttsFree
  );
}

// Circuit breaker: only skip the local server when it's genuinely UNREACHABLE
// (connection refused) — NOT when it's just slow (a timeout). Qwen3-TTS can take
// a while (especially on CPU), and we don't want a slow reply to lock us onto
// Edge. A generous timeout keeps the Qwen voice; a real outage falls back fast.
let localTtsDownUntil = 0;
const LOCAL_TTS_COOLDOWN = 60_000;
// Generous, because Qwen3-TTS on CPU is slow. If you run it on the GPU
// (DEVICE=cuda:0) it's a few seconds and this never matters. Override with
// NEXUS_TTS_TIMEOUT_MS if needed.
const LOCAL_TTS_TIMEOUT = Number(process.env.NEXUS_TTS_TIMEOUT_MS) || 120_000;

/** Local descriptive-TTS server (Higgs / Qwen3-TTS / Parler behind a small
 *  wrapper). POST {text, description, voice} → audio bytes. */
async function synthesizeLocal(text: string): Promise<Buffer | undefined> {
  const url = config.nexus.ttsLocalUrl;
  if (!url) return undefined;
  if (Date.now() < localTtsDownUntil) return undefined; // known-down — skip fast
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 1000), description: currentStyleDesc(), voice: config.nexus.ttsVoice }),
      signal: AbortSignal.timeout(LOCAL_TTS_TIMEOUT),
    });
    if (!res.ok) {
      localTtsDownUntil = Date.now() + LOCAL_TTS_COOLDOWN;
      logger.warn({ status: res.status }, 'voice: local TTS returned an error — skipping ~1 min');
      return undefined;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 512 ? buf : undefined;
  } catch (err) {
    const timedOut = (err as { name?: string })?.name === 'TimeoutError';
    if (timedOut) {
      // Reachable but slow — DON'T lock onto Edge; just fall back this once and
      // try Qwen again next time (it may be a cold start / long text).
      logger.warn('voice: local TTS was slow this time — using fallback, will retry Qwen next');
    } else {
      // Genuinely unreachable (server down / wrong URL) — skip it briefly.
      localTtsDownUntil = Date.now() + LOCAL_TTS_COOLDOWN;
      logger.warn({ err }, 'voice: local TTS unreachable — skipping ~1 min (using Edge/Piper)');
    }
    return undefined;
  }
}

/* ------------------------------- audio utils ------------------------------ */

/** Run ffmpeg with temp files (avoids pipe back-pressure deadlocks). */
async function ffmpeg(input: Buffer, args: (inFile: string, outFile: string) => string[], outName: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-aud-'));
  const inFile = join(dir, 'in');
  const outFile = join(dir, outName);
  try {
    await writeFile(inFile, input);
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', args(inFile, outFile), { stdio: 'ignore' });
      ff.on('error', reject);
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    return await readFile(outFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** OGG/Opus voice-note bytes + mimetype, converted from any input audio. */
// Note: WhatsApp's voice-note waveform bars are generated by Baileys itself
// (it decodes the audio with the `audio-decode` package on upload), so we only
// need to hand it a proper OGG/Opus PTT clip here.
async function toVoiceNote(input: Buffer, filter = ''): Promise<{ buffer: Buffer; mimetype: string }> {
  const af = filter ? ['-af', filter] : [];
  try {
    const buffer = await ffmpeg(input, (i, o) => ['-y', '-i', i, ...af, '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', o], 'out.ogg');
    return { buffer, mimetype: 'audio/ogg; codecs=opus' };
  } catch (err) {
    logger.warn({ err }, 'voice: opus convert failed, sending raw');
    return { buffer: input, mimetype: 'audio/mpeg' };
  }
}

/* --------------------------------- hearing -------------------------------- */

/** Transcribe a voice note to text. Returns undefined on any failure. */
export async function transcribe(audio: Buffer): Promise<string | undefined> {
  const prov = sttProvider();
  if (!prov) return undefined;

  // Convert to a small mono mp3 for reliable transcription; fall back to raw.
  let payload = audio;
  let filename = 'audio.ogg';
  try {
    payload = await ffmpeg(audio, (i, o) => ['-y', '-i', i, '-ar', '16000', '-ac', '1', o], 'out.mp3');
    filename = 'audio.mp3';
  } catch (err) {
    logger.warn({ err }, 'voice: ffmpeg convert failed, sending raw audio');
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(payload)]), filename);
    form.append('model', config.nexus.sttModel);
    form.append('response_format', 'json');
    const res = await fetch(audioEndpoint(prov.url, 'audio/transcriptions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${prov.key}` },
      body: form,
    });
    if (!res.ok) {
      logger.warn({ status: res.status, body: await res.text().catch(() => '') }, 'voice: transcription failed');
      return undefined;
    }
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || undefined;
  } catch (err) {
    logger.warn({ err }, 'voice: transcription error');
    return undefined;
  }
}

/* --------------------------------- speaking ------------------------------- */

export type TtsResult = { ok: true; audio: Buffer; mimetype: string } | { ok: false; error: string };

/** Edge Neural TTS (Microsoft, free, no key) — the most natural free voice. */
async function synthesizeEdge(text: string): Promise<Buffer | undefined> {
  if (!config.nexus.ttsEdge) return undefined;
  const voice = VOICES[currentVoiceId()]?.edge || 'en-US-AriaNeural';
  const dir = await mkdtemp(join(tmpdir(), 'nexus-edge-'));
  const out = join(dir, 'out.mp3');
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn('edge-tts', ['--voice', voice, '--write-media', out, '--text', text.slice(0, 1500)], { stdio: 'ignore' });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`edge-tts exited ${code}`))));
    });
    const buf = await readFile(out);
    return buf.length > 1024 ? buf : undefined;
  } catch (err) {
    logger.warn({ err }, 'voice: edge tts failed');
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Paid/provider TTS (Groq Orpheus or any OpenAI-compatible /audio/speech). */
async function synthesizePaid(text: string): Promise<TtsResult> {
  const prov = sttProvider();
  if (!prov) return { ok: false, error: 'no cloud provider for paid TTS' };
  try {
    const res = await fetch(audioEndpoint(prov.url, 'audio/speech'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${prov.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.nexus.ttsModel,
        voice: config.nexus.ttsVoice,
        input: text.slice(0, 1000),
        response_format: 'mp3',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let msg = body;
      try {
        msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
      } catch {
        /* keep raw */
      }
      logger.warn({ status: res.status, body }, 'voice: paid tts failed');
      return { ok: false, error: `${res.status}: ${msg || 'request rejected'}` };
    }
    return { ok: true, audio: Buffer.from(await res.arrayBuffer()), mimetype: 'audio/mpeg' };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'network error' };
  }
}

/** Local TTS via Piper (offline, unlimited, free). Returns WAV bytes. */
async function synthesizePiper(text: string): Promise<Buffer | undefined> {
  const bin = config.nexus.piperBin;
  const model = selectedModel();
  if (!bin || !model) return undefined;
  const dir = await mkdtemp(join(tmpdir(), 'nexus-piper-'));
  const out = join(dir, 'out.wav');
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(bin, ['--model', model, '--output_file', out], { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`piper exited ${code}`))));
      p.stdin.write(text.slice(0, 1500));
      p.stdin.end();
    });
    return await readFile(out);
  } catch (err) {
    logger.warn({ err }, 'voice: piper failed');
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Split text into chunks small enough for the free TTS endpoint. */
function chunkText(text: string, size = 280): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const chunks: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > size) {
      if (cur) chunks.push(cur.trim());
      cur = w;
    } else {
      cur = `${cur} ${w}`;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [text.slice(0, size)];
}

/** Fetch all chunks from a URL builder and concatenate the audio. */
async function fetchChunks(chunks: string[], urlFor: (c: string) => string): Promise<Buffer | undefined> {
  const parts: Buffer[] = [];
  for (const c of chunks) {
    const res = await fetch(urlFor(c), { headers: { 'user-agent': 'Mozilla/5.0 (Nexus-MD)' } });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'voice: web tts chunk failed');
      return undefined;
    }
    parts.push(Buffer.from(await res.arrayBuffer()));
  }
  return parts.length ? Buffer.concat(parts) : undefined;
}

/** Free web TTS: StreamElements first, Google Translate as a backup. No key. */
async function synthesizeFree(text: string): Promise<Buffer | undefined> {
  const body = text.slice(0, 1200);
  try {
    const voice = config.nexus.ttsFreeVoice || 'Brian';
    const se = await fetchChunks(chunkText(body, 280), (c) =>
      `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(c)}`,
    );
    if (se) return se;
  } catch (err) {
    logger.warn({ err }, 'voice: streamelements error');
  }
  try {
    // Google endpoint caps ~200 chars/request, so chunk smaller.
    const g = await fetchChunks(chunkText(body, 190), (c) =>
      `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(c)}`,
    );
    if (g) return g;
  } catch (err) {
    logger.warn({ err }, 'voice: google tts error');
  }
  return undefined;
}

/**
 * Synthesize speech, preferring the paid model (if configured) and falling back
 * to free TTS. Output is converted to an OGG/Opus voice note.
 */
/**
 * Strip emojis, symbols and markdown before speaking — otherwise the TTS engine
 * reads them out loud ("smirking face", "star", "asterisk"…). Keeps normal
 * punctuation so the delivery still sounds natural.
 */
export function stripForSpeech(text: string): string {
  return text
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}\u{2122}\u{2139}\u{2300}-\u{23FF}]/gu,
      '',
    )
    .replace(/[*_~`>#|]/g, '') // markdown that TTS may vocalise oddly
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

export async function synthesizeResult(text: string): Promise<TtsResult> {
  const clean = stripForSpeech(text);
  if (!clean) return { ok: false, error: 'Nothing to say.' };
  const filter = STYLES[currentStyleId()]?.filter ?? '';
  const ok = async (audio: Buffer): Promise<TtsResult> => {
    const vn = await toVoiceNote(audio, filter);
    return { ok: true, audio: vn.buffer, mimetype: vn.mimetype };
  };

  // 1) Local descriptive TTS (Higgs / Qwen3-TTS) — expressive, style by prompt.
  const local = await synthesizeLocal(clean);
  if (local) {
    logger.info({ engine: 'local-qwen', desc: currentStyleDesc() }, 'voice: engine used');
    return ok(local);
  }

  // 2) Edge Neural TTS — most natural, free, no key (needs internet).
  const edge = await synthesizeEdge(clean);
  if (edge) {
    logger.info({ engine: 'edge', localUrlSet: Boolean(config.nexus.ttsLocalUrl) }, 'voice: engine used (Qwen unavailable — NOT the whisper voice)');
    return ok(edge);
  }

  // 2) Piper — local, offline, unlimited (works with no internet).
  const piper = await synthesizePiper(clean);
  if (piper) {
    logger.info({ engine: 'piper' }, 'voice: engine used (fallback)');
    return ok(piper);
  }

  // 3) Paid provider, if a model is explicitly configured.
  if (config.nexus.key && config.nexus.ttsModel) {
    const paid = await synthesizePaid(clean);
    if (paid.ok) return ok(paid.audio);
    if (!config.nexus.ttsFree) return paid; // no fallback → surface the real error
    logger.warn({ error: paid.error }, 'voice: paid tts failed, trying web fallback');
  }

  // 4) Free web fallback (StreamElements / Google).
  if (config.nexus.ttsFree) {
    const audio = await synthesizeFree(clean);
    if (audio) return ok(audio);
    return { ok: false, error: 'Voice service is unavailable right now — try again shortly.' };
  }

  return { ok: false, error: 'No voice engine available.' };
}
