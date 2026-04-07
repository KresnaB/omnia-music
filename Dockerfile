FROM golang:1.25-bookworm AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/omnia-music ./cmd/bot

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /out/omnia-music /app/omnia-music
COPY .env.example /app/.env.example

RUN mkdir -p /app/config

ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV YTDLP_PATH=/usr/local/bin/yt-dlp

CMD ["/app/omnia-music"]
