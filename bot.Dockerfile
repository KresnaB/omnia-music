# Dockerfile khusus Discord bot (Node.js) — Omnia Music bot.
# NOTE: Dockerfile utama di repo build Go web server (omnia-music:3002).
# Bot ini di-build terpisah dari file ini.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
    unzip \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/download/2026.06.09/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && curl -fsSL https://deno.land/install.sh | sh \
  && ln -sf /root/.deno/bin/deno /usr/local/bin/deno \
  && mkdir -p /root/yt-dlp-plugins \
  && curl -L https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-ytdlp-pot-provider-rs.zip -o /tmp/bgutil-pot.zip \
  && unzip /tmp/bgutil-pot.zip -d /root/yt-dlp-plugins \
  && rm -f /tmp/bgutil-pot.zip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json /app/
RUN npm ci --omit=dev

COPY src /app/src
COPY .env.example /app/.env.example

RUN mkdir -p /app/config

ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV HOME=/root

CMD ["node", "src/index.js"]
