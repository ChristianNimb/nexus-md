import 'dotenv/config';

/**
 * Central configuration, read once from the environment.
 * Everything is typed so the rest of the codebase never touches process.env directly.
 */

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function list(key: string): string[] {
  return str(key)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export type BotMode = 'public' | 'private';

export const config = {
  /** Valid command prefixes. Each char is a prefix; empty string = no prefix required. */
  prefixes: str('PREFIX', '.').split(''),

  mode: (str('MODE', 'public') as BotMode),

  /** Owner phone numbers (digits only, with country code). */
  owners: list('OWNERS'),

  botName: str('BOT_NAME', 'Nexus-MD'),

  /** Display name shown as "Owner" in the menu. */
  ownerName: str('BOT_OWNER', ''),

  sessionDir: str('SESSION_DIR', 'session'),

  dbPath: str('DB_PATH', 'nexus.db'),

  logLevel: str('LOG_LEVEL', 'info'),

  /**
   * Nexus AI assistant (.nexus command). Works with any OpenAI-compatible
   * /chat/completions endpoint (Groq, OpenRouter, OpenAI, local, ...) or the
   * Anthropic Claude API. Defaults to Groq, which has a free tier.
   */
  nexus: {
    url: str('NEXUS_API_URL', 'https://api.groq.com/openai/v1/chat/completions'),
    key: str('NEXUS_API_KEY') || str('GROQ_API_KEY') || str('CLAUDE_API_KEY'),
    // Was llama-3.3-70b-versatile until Groq decommissioned it on 2026-08-16.
    model: str('NEXUS_MODEL', 'openai/gpt-oss-120b'),
    /** Fallback model used when the primary is rate-limited OR unreachable. */
    fallbackModel: str('NEXUS_FALLBACK_MODEL', 'llama-3.1-8b-instant'),
    /** Fallback endpoint/key — defaults to the primary provider. Point these at
     *  Groq to fail over from a local model (Ollama) when your GPU box is off. */
    fallbackUrl: str('NEXUS_FALLBACK_URL') || str('NEXUS_API_URL', 'https://api.groq.com/openai/v1/chat/completions'),
    fallbackKey: str('NEXUS_FALLBACK_KEY') || str('NEXUS_API_KEY') || str('GROQ_API_KEY') || str('CLAUDE_API_KEY'),
    /** Code-specialist model for the .code command (dev mode). */
    codeModel: str('NEXUS_CODE_MODEL', 'openai/gpt-oss-120b'),
    /** Search engine: 'ddg' (free, no key, no Groq usage), 'tavily', 'brave', or 'groq'. */
    searchEngine: str('NEXUS_SEARCH_ENGINE', 'ddg'),
    /** Web-search model when engine is 'groq' (compound has built-in live search). */
    searchModel: str('NEXUS_SEARCH_MODEL', 'groq/compound-mini'),
    /** Optional Tavily API key (free tier ~1000/mo) — better quality than DDG. */
    tavilyKey: str('TAVILY_API_KEY'),
    /** Optional Brave Search API key (free tier ~2000/mo). */
    braveKey: str('BRAVE_API_KEY'),
    /** Optional vision model (OpenAI-compatible). */
    visionModel: str('NEXUS_VISION_MODEL'),
    /** Vision endpoint/key — defaults to the primary. Point at Groq to keep chat
     *  LOCAL (Ollama) but run vision on Groq (frees GPU VRAM; vision is occasional). */
    visionUrl: str('NEXUS_VISION_URL') || str('NEXUS_API_URL', 'https://api.groq.com/openai/v1/chat/completions'),
    visionKey: str('NEXUS_VISION_KEY') || str('NEXUS_API_KEY') || str('GROQ_API_KEY') || str('CLAUDE_API_KEY'),
    /** Vision model on the FALLBACK endpoint (e.g. Groq) when the primary vision is down.
     *  qwen/qwen3.6-27b — Groq's current multimodal model (Llama 4 Scout was deprecated). */
    visionFallbackModel: str('NEXUS_VISION_FALLBACK_MODEL', 'qwen/qwen3.6-27b'),
    /** Local descriptive-TTS server (Higgs/Qwen3-TTS/Parler). POST {text,description}
     *  → audio. When set, it's the top voice engine (Edge/Piper are the fallback). */
    ttsLocalUrl: str('NEXUS_TTS_LOCAL_URL'),
    /** Speech-to-text (Whisper) model — lets Nexus "hear" voice notes. Free on Groq. */
    sttModel: str('NEXUS_STT_MODEL', 'whisper-large-v3'),
    /** Paid TTS model (Groq Orpheus etc.). Blank = use the free fallback only. */
    ttsModel: str('NEXUS_TTS_MODEL'),
    /** Voice for the paid model (Orpheus: daniel/troy/austin/autumn/diana/hannah). */
    ttsVoice: str('NEXUS_TTS_VOICE', 'daniel'),
    /** Edge Neural TTS (Microsoft, free, no key, natural). Primary voice engine. */
    ttsEdge: str('NEXUS_TTS_EDGE', 'on') !== 'off',
    /** Piper local TTS — path to the piper binary (set in the Docker image). */
    piperBin: str('PIPER_BIN'),
    /** Piper voice model (.onnx) path. Together with piperBin this enables local,
     *  offline, unlimited free voice — the primary TTS engine. */
    piperVoice: str('PIPER_VOICE'),
    /** Directory holding extra Piper voice models (for .voice switching). */
    piperDir: str('PIPER_VOICE_DIR', '/opt/piper-voices'),
    /** Web TTS fallback (StreamElements, no key). Used only if Piper is absent. */
    ttsFree: str('NEXUS_TTS_FREE', 'on') !== 'off',
    /** Web-fallback voice (StreamElements / Amazon Polly): Brian, Amy, Emma, Joanna... */
    ttsFreeVoice: str('NEXUS_TTS_FREE_VOICE', 'Brian'),
  },

  /** Default timezone (IANA, e.g. America/Chicago) when a user's can't be inferred. */
  defaultTz: str('BOT_TZ') || str('TZ'),

  /** Optional Cobalt instance for social-media downloads (TikTok/IG/X/...). */
  cobaltUrl: str('COBALT_API_URL'),

  /**
   * The website + browser linking panel (see src/web). Linking in a browser
   * beats hunting for a QR code in `docker compose logs`.
   *
   * `password` gates every route that can reveal a QR or issue a pairing code —
   * anyone who sees those can attach THEIR phone as this bot. Leave it empty and
   * the panel refuses to serve at all; only the public landing page stays up.
   */
  web: {
    enabled: str('NEXUS_WEB', 'on') !== 'off',
    port: Number(str('NEXUS_WEB_PORT', '3000')) || 3000,
    /** 0.0.0.0 by default: inside Docker, binding to localhost would make the
     *  published port unreachable from the host. The password is the real guard. */
    host: str('NEXUS_WEB_HOST', '0.0.0.0'),
    password: str('NEXUS_WEB_PASSWORD'),
    /**
     * Where the managed hosting platform lives, for the landing page's
     * "Deploy on Nexus Hosting" button.
     *
     * The same built page is served by two different things: this bot's own
     * server, and the hosting platform (which serves it at `/` and the dashboard
     * at `/app`). The button is therefore a relative `/app` — correct on the
     * platform, a dead 404 here. Set this to the platform's public URL and this
     * server redirects `/app` there instead.
     */
    hostingUrl: str('NEXUS_HOSTING_URL', ''),
  },
} as const;

/** Change the command prefixes at runtime (used by .setprefix). `config` is
 *  `as const` so we cast at this single, deliberate spot instead of everywhere. */
export function setPrefixes(chars: string[]): void {
  (config as { prefixes: string[] }).prefixes = chars;
}

export function isPrivateMode(): boolean {
  return config.mode === 'private';
}

export function nexusEnabled(): boolean {
  return Boolean(config.nexus.key);
}
