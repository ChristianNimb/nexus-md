# Nexus-MD — Full Setup Guide

Set it up in **stages**. After each stage you have a *working* bot — only move to the
next once the current one runs. Don't do it all at once.

- **Stage 1** — Bot running on Groq (works in ~10 min, no GPU needed)
- **Stage 2** — Local chat + vision on your RTX 4060 (Ollama)
- **Stage 3** — Expressive described voice (Higgs / Qwen3-TTS)
- **Stage 4** — Move it to the always-on HP laptop (optional, later)

---

## Stage 1 — Get it running on Groq (do this first)

**1. Install Docker Desktop** → https://docker.com/products/docker-desktop — install, open it, leave it running.

**2. Get a free Groq key** → https://console.groq.com/keys — sign in, "Create API Key", copy the `gsk_...` string.

**3. Make your `.env`.** In the `nexus-md` folder, copy `.env.example` to `.env` and set the AI section to **exactly this** (no duplicate keys!):

```dotenv
PREFIX=.
MODE=private
OWNERS=            # your number w/ country code, no + (optional; linked account is always owner)

NEXUS_API_URL=https://api.groq.com/openai/v1/chat/completions
NEXUS_API_KEY=gsk_your_real_key_here
NEXUS_MODEL=llama-3.3-70b-versatile
NEXUS_VISION_MODEL=qwen/qwen3.6-27b
NEXUS_STT_MODEL=whisper-large-v3
NEXUS_TTS_MODEL=
NEXUS_TTS_FREE=on
NEXUS_TTS_FREE_VOICE=Brian
NEXUS_SEARCH_ENGINE=ddg
BOT_TZ=Asia/Shanghai
```

**4. Start it:**
```powershell
docker compose up -d --build
```
First build takes a few minutes (it downloads Piper voices).

**5. Link WhatsApp.** Watch the logs for the QR code:
```powershell
docker compose logs -f nexus
```
Scan it with WhatsApp → Linked Devices → Link a Device. Once it says "connected", you're live. Send `.menu` to test.

✅ **You now have a fully working bot on Groq** (free). Everything works: chat, voice (Edge), images, search. Stop here if that's all you need.

---

## Stage 2 — Local chat + vision on the 4060 (Ollama)

This makes chat + vision run on *your GPU* — no rate limits — with Groq as an automatic safety net.

**1. Install Ollama** → https://ollama.com — install, then in a terminal:
```powershell
ollama pull qwen3:8b
ollama pull qwen2.5vl:7b
```

**2. Let Docker reach Ollama.** Ollama must listen on all interfaces so the container can reach it:
- Set a Windows environment variable **`OLLAMA_HOST`** = `0.0.0.0`
  (Search "Edit environment variables" → New → Name `OLLAMA_HOST`, Value `0.0.0.0`), then **restart Ollama** (quit from the tray icon and reopen).

**3. Switch your `.env`** to local (keep the Groq lines as the fallback):
```dotenv
# primary = local (no limits)
NEXUS_API_URL=http://host.docker.internal:11434/v1/chat/completions
NEXUS_API_KEY=ollama
NEXUS_MODEL=qwen3:8b
NEXUS_VISION_MODEL=qwen2.5vl:7b
# safety net = Groq (used only when Ollama is off/unreachable)
NEXUS_FALLBACK_URL=https://api.groq.com/openai/v1/chat/completions
NEXUS_FALLBACK_KEY=gsk_your_real_key_here
NEXUS_FALLBACK_MODEL=llama-3.3-70b-versatile
NEXUS_VISION_FALLBACK_MODEL=qwen/qwen3.6-27b
```
(Keep the shared lines — `NEXUS_STT_MODEL`, `NEXUS_TTS_*`, `NEXUS_SEARCH_ENGINE`, `BOT_TZ`.)

**4. Rebuild:**
```powershell
docker compose up -d --build
```

**Test:** chat with Nexus. Then stop Ollama (quit it) and chat again — it should keep working via Groq. Restart Ollama → back to local. That's the failover.

> 8GB VRAM note: chat and vision swap in/out (one loads, the other unloads), so the *first* image after chatting has a couple seconds of lag. Normal.

---

## Stage 3 — Expressive described voice (Higgs / Qwen3-TTS)

Optional — this is what lets Nexus talk "soft, romantic, whispering" etc.

**1. Pick + install a model** on the 4060 machine:
- **Qwen3-TTS 0.6B** — light, pairs with Qwen, fits alongside chat/vision. *Recommended start.*
- **Higgs Audio V2** — most expressive + voice cloning, but heavy (~3B, tight on 8GB).

**2. Install the server deps + run it:**
```powershell
pip install fastapi uvicorn soundfile torch
# + your chosen model's package (see its README)
python docker/tts-server/server.py
```
Open `docker/tts-server/server.py` and fill in the `synth()` function with your model's
generate call (there are Higgs *and* Qwen3-TTS examples in the comments).

**3. Point the bot at it** — add to `.env`:
```dotenv
NEXUS_TTS_LOCAL_URL=http://host.docker.internal:8020/
```

**4. Rebuild** → then say: *"nexus talk in a soft romantic voice"* and *"nexus say I missed you"*.
If the server's off, voice quietly falls back to Edge — nothing breaks.

---

## Stage 4 — Move to the always-on HP laptop (later)

When you want it running 24/7 without keeping your 4060 open:

1. Install **Docker Desktop** on the HP laptop, copy the `nexus-md` folder over.
2. Use the **Groq `.env`** (Stage 1) on the HP — it has no GPU, so it uses Groq for the AI. Voice = Edge (free).
3. Optional: to still use your 4060's local models from the HP, install **Tailscale** on both laptops, and set `NEXUS_API_URL` on the HP to your 4060's Tailscale address instead of `host.docker.internal`. When the 4060 is off, it falls back to Groq automatically.
4. On the HP: keep it **plugged in**, **on wifi**, and set Windows to **never sleep** (Settings → Power → Screen and sleep → both "Never" on plugged in).

---

## Handy commands

```powershell
docker compose logs -f nexus       # watch logs / QR
docker compose restart nexus       # restart after .env change (no rebuild)
docker compose up -d --build       # rebuild after code/Dockerfile change
docker compose down                # stop
```

## If something's off
- **Bot won't connect / no QR** → check `docker compose logs -f nexus`.
- **"couldn't reach Ollama"** → is Ollama running? Is `OLLAMA_HOST=0.0.0.0` set + Ollama restarted?
- **Rule of thumb:** every `NEXUS_...` key should appear **once** in `.env`. Duplicates → only the last wins.
- Changed only `.env`? → `docker compose restart nexus` (faster than rebuild).
