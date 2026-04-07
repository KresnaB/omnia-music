FROM golang:1.25-bookworm AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/omnia-music ./cmd/bot

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
    unzip \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && curl -fsSL https://deno.land/install.sh | sh \
  && ln -sf /root/.deno/bin/deno /usr/local/bin/deno \
  && mkdir -p /root/yt-dlp-plugins \
  && curl -L https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-ytdlp-pot-provider-rs.zip -o /tmp/bgutil-pot.zip \
  && unzip /tmp/bgutil-pot.zip -d /root/yt-dlp-plugins \
  && rm -f /tmp/bgutil-pot.zip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /out/omnia-music /app/omnia-music
COPY .env.example /app/.env.example

RUN mkdir -p /app/config

ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV HOME=/root

CMD ["/app/omnia-music"]
