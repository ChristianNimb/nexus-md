# Nexus-MD — WhatsApp bot
# Single-stage image: runs directly with tsx (no compile step, so real vs.
# shimmed type differences never block the build).

FROM node:20-slim

# ffmpeg: .sticker/audio;  fontconfig + fonts: canvas rendering;
# python3 + default-jdk: developer mode (.py / .java). The JDK is ~300MB — drop
# 'default-jdk' from this line if you don't need Java in developer mode.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg ca-certificates curl fontconfig fonts-dejavu-core fonts-noto-color-emoji \
       python3 python3-pip default-jdk \
       poppler-utils unzip \
       tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim \
  && rm -rf /var/lib/apt/lists/*

# Edge Neural TTS — free, no API key, natural-sounding Microsoft neural voices.
# This is Nexus's primary voice (Piper below is the offline fallback).
# yt-dlp — reliable YouTube search + download for .play/.video/.ytmp3/.ytmp4
# (replaces the fragile ytdl-core/youtube-sr libs that broke constantly).
# rembg — background removal for .nobg (CPU / onnxruntime; downloads its model
# on first use). No GPU required.
RUN pip3 install --no-cache-dir --break-system-packages edge-tts yt-dlp rembg onnxruntime pillow

# Deno — a JS runtime yt-dlp / youtubei.js use to solve YouTube's player
# signature ("nsig") challenges. Without it, recent YouTube downloads fail with
# "Failed to extract signature" / bot checks even when cookies are present.
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
  && unzip -o /tmp/deno.zip -d /usr/local/bin \
  && chmod +x /usr/local/bin/deno \
  && rm /tmp/deno.zip \
  && deno --version

# Piper — local, offline, unlimited, free text-to-speech (Nexus's voice).
# Self-contained prebuilt binary + several neural voices you can switch between
# with ".voice ...". This is why voice works with no API key, no billing, and no
# rate limits. A voice that fails to download is skipped (build won't break).
RUN cd /opt \
  && curl -fsSL -o piper.tar.gz https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
  && tar -xzf piper.tar.gz && rm piper.tar.gz \
  && mkdir -p /opt/piper-voices
COPY docker/fetch-voices.sh /tmp/fetch-voices.sh
RUN sh /tmp/fetch-voices.sh

# Point Nexus at the baked-in Piper install (override in .env to change voice).
ENV PIPER_BIN=/opt/piper/piper \
    PIPER_VOICE=/opt/piper-voices/en_GB-alan-medium.onnx \
    PIPER_VOICE_DIR=/opt/piper-voices

WORKDIR /app

# Install dependencies first for better layer caching.
# PUPPETEER_SKIP_DOWNLOAD: @nexus21/nexus-api depends on puppeteer, but only its
# unused legacy class needs Chromium — our scrapers are axios/cheerio. Skipping
# the ~400MB Chromium download keeps the image lean and the build fast.
COPY package.json package-lock.json* ./
RUN PUPPETEER_SKIP_DOWNLOAD=1 npm install --no-audit --no-fund

# App source.
COPY . .

# Let @nexus21/nexus-api find the same YouTube cookies the bot uses. It looks in
# ~/youtube_cookies.txt (home = /root here); point that at the mounted cookies.txt
# so you maintain ONE cookies file (./cookies.txt) for both yt-dlp paths.
RUN ln -sf /app/cookies.txt /root/youtube_cookies.txt

# Persisted at runtime via volumes (see docker-compose.yml).
ENV NODE_ENV=production \
    SESSION_DIR=session \
    DB_PATH=data/nexus.json

# The two writable directories, created here and owned by an unprivileged uid.
#
# This matters for hosted deployments. A hosting platform runs untrusted images
# as a non-root user, and Docker seeds a fresh named volume from whatever the
# IMAGE has at that path — including its ownership. Without these lines the
# volume is created root-owned, the process runs as 10001, and the bot
# crash-loops on EACCES writing its own session lock.
#
# Running `docker compose up` directly is unaffected: that runs as root, which
# can write regardless of who owns the directory.
RUN mkdir -p /app/session /app/data && chown -R 10001:10001 /app/session /app/data

# tsx is the runner; `npm start` -> tsx src/index.ts
CMD ["npm", "start"]
