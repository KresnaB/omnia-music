# Omnia Music

Bot musik Discord berbasis Node.js dengan `discord.js` + `@discordjs/voice`, siap untuk voice stack modern yang mendukung DAVE.

## Fitur

- Slash command: `/play`, `/skip`, `/stop`, `/seek`, `/queue`, `/loop`, `/shuffle`, `/autoplay`, `/help`, `/move`, `/status`, `/lyrics`, `/sleep`, `/reconnect`
- Embed now playing dengan tombol play/pause, skip, stop, shuffle, autoplay, loop, queue, dan lyrics
- Playlist URL otomatis dimasukkan ke queue dengan batas maksimum 100 lagu pertama
- Preprocessing lagu berikutnya agar perpindahan track lebih cepat
- First play memakai deferred interaction agar tidak timeout saat resolve awal
- Lyrics dari LRCLIB
- `yt-dlp` + POT provider `bgutil-pot`
- Docker deployment

## Stack

- Node.js 24
- `discord.js`
- `@discordjs/voice`
- `yt-dlp`
- `ffmpeg`
- `bgutil-pot`

## Setup Discord Developer Portal

1. Buka [Discord Developer Portal](https://discord.com/developers/applications)
2. Klik `New Application`
3. Buka menu `Bot`, lalu klik `Add Bot`
4. Copy bot token ke `DISCORD_TOKEN`
5. Copy `Application ID` ke `DISCORD_CLIENT_ID`
6. Masuk ke `OAuth2 > URL Generator`
7. Pada `Scopes`, centang:
   - `bot`
   - `applications.commands`
8. Pada `Bot Permissions`, centang minimal:
   - `View Channels`
   - `Send Messages`
   - `Embed Links`
   - `Connect`
   - `Speak`
   - `Read Message History`
9. Invite bot ke server Anda
10. Untuk `DEV_GUILD_ID`, aktifkan `Developer Mode`, klik kanan server, lalu `Copy Server ID`

## Setup Lokal

1. Copy `.env.example` menjadi `.env`
2. Isi `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, dan `DEV_GUILD_ID`
3. Jika ingin cookies, simpan file Netscape cookie di path yang Anda atur di `.env`
4. Pastikan `ffmpeg`, `yt-dlp`, dan Node.js 24 tersedia
5. Jalankan:

```bash
npm install
npm start
```

## Setup Docker

Struktur folder:

```bash
~/omnia-music/
  .env
  docker-compose.yml
  config/
    cookies.txt
```

Catatan:
- `config/cookies.txt` di host akan dipasang sebagai `/app/config/cookies.txt` di container
- cookies opsional, jadi `YTDLP_COOKIES_FILE` boleh dikosongkan

Jalankan:

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f omnia-music
docker compose logs -f bgutil-pot
```

## Environment

Contoh isi `.env`:

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_application_client_id
DEV_GUILD_ID=your_test_guild_id
FFMPEG_PATH=/usr/bin/ffmpeg
YTDLP_PATH=/usr/local/bin/yt-dlp
YTDLP_COOKIES_FILE=/app/config/cookies.txt
YTDLP_YOUTUBE_EXTRACTOR_ARGS=youtube:player_client=default,mweb
YTDLP_POT_PROVIDER_ARGS=youtubepot-bgutilhttp:base_url=http://bgutil-pot:4416;disable_innertube=1
LRCLIB_BASE_URL=https://lrclib.net
DEFAULT_VOLUME=100
DEFAULT_IDLE_TIMEOUT_MS=600000
DEFAULT_SEARCH_PLATFORM=youtube
```

Jika tidak memakai cookies:

```env
YTDLP_COOKIES_FILE=
```

## Cara Kerja Queue dan Preload

- Jika user paste playlist URL, bot hanya mengambil 100 lagu pertama
- Saat satu lagu mulai diputar, bot langsung menyiapkan metadata/stream URL lagu berikutnya
- Tujuannya agar pindah ke lagu selanjutnya lebih cepat dan first play tidak terasa terlalu lama

## Troubleshooting

Tes `yt-dlp` di dalam container:

```bash
docker compose exec omnia-music yt-dlp --extractor-args "youtube:player_client=default,mweb" --extractor-args "youtubepot-bgutilhttp:base_url=http://bgutil-pot:4416;disable_innertube=1" --no-playlist --default-search youtube --dump-single-json "ytsearch1:alan walker faded"
```

Cek runtime JavaScript untuk challenge solver:

```bash
docker compose exec omnia-music deno --version
```

Cek service provider:

```bash
docker compose logs --tail=100 bgutil-pot
```

## Catatan

- Spotify tidak di-stream langsung dari Spotify karena DRM. Untuk URL Spotify, praktik paling aman tetap mencocokkan metadata lalu memutar hasil resolusi sumber yang didukung `yt-dlp`
- Command didaftarkan ke `DEV_GUILD_ID` agar propagasi slash command lebih cepat saat development
