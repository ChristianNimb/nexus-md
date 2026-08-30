FROM ghcr.io/christiannimb/nexus-md-base:1

WORKDIR /app

COPY package.json package-lock.json* ./
RUN PUPPETEER_SKIP_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund

COPY . .

RUN ln -sf /app/cookies.txt /root/youtube_cookies.txt

ENV NODE_ENV=production \
    SESSION_DIR=session \
    DB_PATH=data/nexus.json

RUN mkdir -p /app/session /app/data && chown -R 10001:10001 /app/session /app/data

CMD ["node", "lib/index.js"]
