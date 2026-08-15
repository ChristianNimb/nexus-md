# Nexus-MD

A lightweight, multi-functional WhatsApp bot framework written in TypeScript.

Nexus-MD runs on [Baileys](https://github.com/WhiskeySockets/Baileys) (no Selenium, no
Chromium), loads its ~130 commands from drop-in plugin files, and ships with a Docker
image that already contains ffmpeg, yt-dlp, Piper TTS and the rest — so a fresh machine
goes from clone to a linked bot in one `docker compose up`.

---

## Highlights

- **AI assistant** — chat, vision, speech-to-text and code help through any
  OpenAI-compatible endpoint (Groq, OpenRouter, OpenAI, local Ollama) or the Anthropic
  API. Configure a fallback provider and the bot fails over automatically when your
  primary is unreachable, so it never goes silent.
- **Voice** — Edge Neural TTS by default (free, no key), with Piper baked into the image
  as an offline fallback and an optional hook for a local expressive TTS server.
- **Media & downloads** — stickers, image/video tools, logo rendering, YouTube via
  yt-dlp, and social platforms via a self-hosted [Cobalt](https://github.com/imputnet/cobalt)
  instance included in the compose file.
- **Group management** — welcome/goodbye, antilink, antibot, warnings, member tools,
  presence and admin utilities.
- **Automation** — scheduled messages, keyword filters, AFK, birthdays, auto-status.
- **Web panel** — a small React site on port 3000 for linking via QR or pairing code,
  password-gated by `NEXUS_WEB_PASSWORD`.

Commands are grouped into these categories, browsable in-chat with `.menu`:
`nexus` · `ai` · `tools` · `group` · `owner` · `media` · `downloader` · `fun` ·
`automation` · `system` · `utility` · `developer`

---

## Quick start (Docker — recommended)

Docker is the supported path. The image bundles every native dependency the bot needs.

```bash
git clone https://github.com/<you>/nexus-md.git
cd nexus-md
cp .env.example .env
cp cookies.txt.example cookies.txt
```

Edit `.env` and set at minimum an AI key — a free Groq key from
[console.groq.com/keys](https://console.groq.com/keys) is the fastest start:

```dotenv
PREFIX=.
MODE=private
NEXUS_API_KEY=gsk_your_real_key_here
```

Then bring it up and link your WhatsApp account:

```bash
docker compose up -d --build
```

```bash
docker compose logs -f nexus
```

Scan the QR from the logs with **WhatsApp → Linked Devices → Link a Device**, or open
<http://localhost:3000/link> for the browser panel. Once it reports `connected`, send
`.menu` to the bot to confirm it's alive.

The first build takes several minutes — it installs ffmpeg, a JDK, Deno and downloads
Piper voices.

> `cp cookies.txt.example cookies.txt` matters: `docker-compose.yml` bind-mounts that
> file, and Docker silently creates a **directory** in its place if it's missing, which
> breaks the mount. An empty file is fine.

For the staged walkthrough — Groq first, then local GPU models, then expressive voice —
see **[SETUP.md](SETUP.md)**. Docker specifics live in **[DOCKER.md](DOCKER.md)**.

## Running without Docker

Node 20+ is required. You'll need `ffmpeg` and `yt-dlp` on your `PATH` for media and
download commands to work.

```bash
npm install
cp .env.example .env
npm start
```

| Script | Purpose |
| --- | --- |
| `npm start` | Run the bot with `tsx` (no build step) |
| `npm run dev` | Same, with watch-and-reload |
| `npm run typecheck` | Type-check without emitting |
| `npm run build` | Compile to `dist/` |
| `npm run build:web` | Bundle the React web panel |

## Project layout

```
src/
  index.ts       entry point
  config.ts      env parsing
  client/        Baileys connection + reconnect handling
  core/          message pipeline, registry, media, downloaders, storage
  db/            JSON store
  plugins/       one file per feature — commands register themselves on import
  web/           link panel: server, static site, React UI
docker/          Piper voice fetcher, optional local TTS server
```

To add a command, drop a file in `src/plugins/` and call `command()`:

```ts
import { command } from '../core/registry.js';

command({ pattern: 'ping', desc: 'Health check', category: 'system' },
  async (m) => m.reply('pong'));
```

The loader imports every plugin at startup — no registration list to update.

## Configuration

Every option is documented inline in **[.env.example](.env.example)**. The ones worth
knowing up front:

| Variable | Meaning |
| --- | --- |
| `PREFIX` | Command prefix characters, e.g. `.` or `.!/` |
| `MODE` | `public` (anyone) or `private` (owner/sudo only) |
| `OWNERS` | Extra owner numbers, country code, no `+`. The linked account is always owner. |
| `NEXUS_API_KEY` / `NEXUS_API_URL` / `NEXUS_MODEL` | Primary AI provider |
| `NEXUS_FALLBACK_*` | Provider used when the primary is unreachable |
| `NEXUS_WEB_PASSWORD` | Gate for the web link panel — **set this before exposing port 3000** |
| `BOT_TZ` | Default IANA timezone when a user's can't be inferred |

## Security notes

- `.env` and `cookies.txt` are gitignored and must stay that way. `cookies.txt` holds a
  live Google session — treat it like a password.
- `session/` is your WhatsApp login. Anyone with it can act as your account. Never
  commit or share it.
- Set `NEXUS_WEB_PASSWORD` before exposing port 3000 beyond localhost.
- Running the bot on your personal number carries a ban risk. WhatsApp does not permit
  unofficial clients; use an account you can afford to lose.

## License

MIT — see [LICENSE](LICENSE).
