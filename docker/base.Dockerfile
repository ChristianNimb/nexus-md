# Nexus-MD base — the heavy, rarely-changing half of the image.
#
#   docker build -f docker/base.Dockerfile -t nexus-md-base:1 .
#
# ffmpeg, the JDK, the Python stack, Deno and the Piper voices come to about
# 4 GB and change perhaps twice a year. The bot's own code changes daily. Kept
# in one Dockerfile they were rebuilt together, so every bot on the host carried
# its own private 4 GB copy: eleven images summing to 21 GB deduplicated to
# 19.7 GB, because images built from different revisions of that file share no
# layers at all.
#
# Splitting them means this is stored once and every bot starts from it.
#
# A base *image* rather than build cache, specifically. Build cache is what
# `docker builder prune` throws away first when the disk fills — which is
# exactly what happened here, and why deploys went back to twenty-five minutes
# afterwards. An image is not cache and is not reclaimed while something
# references it.
#
# Bump the tag when this file changes. Never move an existing tag: bots pinned
# to :1 must keep resolving to the same bytes they were built against.
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
#
# `--retry` on every network fetch below is not defensive padding. A Docker
# build is a long chain of downloads where ANY single dropped connection throws
# away the whole layer and everything after it, and TLS handshakes to GitHub do
# drop — one of these steps has failed with SSL_ERROR_SYSCALL while the step
# immediately before it, to the same host, succeeded. `--retry-connrefused`
# matters because a refused connection is not retried by default, and
# `--retry-all-errors` covers the mid-transfer resets that curl otherwise
# treats as fatal.
RUN curl -fsSL --retry 5 --retry-delay 3 --retry-connrefused --retry-all-errors \
  https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
  && unzip -o /tmp/deno.zip -d /usr/local/bin \
  && chmod +x /usr/local/bin/deno \
  && rm /tmp/deno.zip \
  && deno --version

# Piper — local, offline, unlimited, free text-to-speech (Nexus's voice).
# Self-contained prebuilt binary + several neural voices you can switch between
# with ".voice ...". This is why voice works with no API key, no billing, and no
# rate limits. A voice that fails to download is skipped (build won't break).
RUN cd /opt \
  && curl -fsSL --retry 5 --retry-delay 3 --retry-connrefused --retry-all-errors \
       -o piper.tar.gz https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
  && tar -xzf piper.tar.gz && rm piper.tar.gz \
  && mkdir -p /opt/piper-voices
COPY docker/fetch-voices.sh /tmp/fetch-voices.sh
RUN sh /tmp/fetch-voices.sh

# Point Nexus at the baked-in Piper install (override in .env to change voice).
ENV PIPER_BIN=/opt/piper/piper \
    PIPER_VOICE=/opt/piper-voices/en_GB-alan-medium.onnx \
    PIPER_VOICE_DIR=/opt/piper-voices
