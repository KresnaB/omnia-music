# Omnia Music

Bot musik Discord berbasis Node.js dengan `discord.js` + `@discordjs/voice`, siap untuk voice stack modern yang mendukung Discord DAVE (E2EE voice protocol).

## Fitur

- **Modern & Clean Discord Player**:
  - Embed player yang rapi dan ringkas (menampilkan Judul, Uploader, Durasi, dan status Settings).
  - Footer terintegrasi: `Powered by Kubiku Technology • Requested by <User>`.
  - Kontrol interaktif emoji-only (tanpa label teks panjang):
    - Baris 1: `▶️`/`⏸️` (Play/Pause), `⏭️` (Skip), `⏹️` (Stop), `🔀` (Shuffle)
    - Baris 2: `✨` (Autoplay), `🔁`/`🔂` (Loop Mode), `📋` (Queue), `🎤` (Lyrics), `💾` (Simpan ke Playlist)
- **Slash Commands Lengkap**:
  - **Playback**: `/play`, `/skip`, `/stop`, `/seek`, `/queue`, `/loop`, `/shuffle`, `/autoplay`, `/move`
  - **Playlist Pribadi (SQLite)**: `/playlist <create|import|add|add-current|play|list|view|remove|delete>`
  - **Offline & Cache**: `/offlinemode`, `/normalmode`, `/cache-stats`, `/cache-list`, `/cache-delete`
  - **Utility**: `/lyrics`, `/status`, `/sleep`, `/reconnect`, `/help`
- **Manajemen Playlist Kustom**:
  - Simpan lagu favorit ke playlist server pribadi menggunakan database SQLite bawaan (`node:sqlite`).
  - Impor playlist langsung dari link YouTube.
  - Tambah lagu saat ini langsung lewat tombol player (`💾`) atau command `/playlist add-current`.
- **Audio Pipeline Cepat & Andal**:
  - Preprocessing 1 lagu berikutnya di background agar transisi lagu instan tanpa jeda buffering.
  - Fallback otomatis ke audio cache lokal saat YouTube/jaringan mengalami gangguan.
  - Pembersihan link otomatis: normalisasi URL `music.youtube.com` ke YouTube standar.
  - Direct stream URL cepat untuk video tunggal; metadata dimuat di background.
- **Lirik Lagu**: Mengambil synced / plain lyrics secara otomatis via LRCLIB.
- **Bypass & Anti-Bot**: Integrasi `yt-dlp` dengan POT provider `bgutil-pot`.
- **Docker Deployment**: Siap dijalankan dengan Docker & Docker Compose.

## Stack

- Node.js 24
- `discord.js` v14
- `@discordjs/voice` + `@snazzah/davey` (DAVE voice support)
- `node:sqlite` (penyimpanan playlist lokal)
- `yt-dlp` + `ffmpeg`
- `bgutil-pot` (POT token provider)

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

Jalankan pengujian:

```bash
npm test
```

## Setup Docker

Struktur folder:

```bash
~/omnia-music/
  .env
  docker-compose.yml
  config/
    cookies.txt
  storage/
```

Catatan:
- `config/cookies.txt` di host akan dipasang sebagai `/app/config/cookies.txt` di container
- `storage/` di host akan dipasang sebagai `/app/storage` agar database playlist dan cache lagu tetap tersimpan saat container di-build ulang
- Cookies opsional, jadi `YTDLP_COOKIES_FILE` boleh dikosongkan

Jalankan:

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f omnia-bot
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

- Jika user paste playlist URL, bot mengambil hingga 100 lagu pertama ke dalam antrean.
- Saat lagu mulai diputar, bot langsung menyiapkan metadata dan stream URL lagu berikutnya dari queue di background.
- Jika queue kosong tetapi autoplay aktif, bot otomatis menyiapkan kandidat lagu autoplay di background sebelum lagu selesai.
- Transisi antar lagu berjalan mulus tanpa jeda buffering panjang.

## Troubleshooting

Tes `yt-dlp` di dalam container:

```bash
docker compose exec omnia-bot yt-dlp --extractor-args "youtube:player_client=default,mweb" --extractor-args "youtubepot-bgutilhttp:base_url=http://bgutil-pot:4416;disable_innertube=1" --no-playlist --default-search youtube --dump-single-json "ytsearch1:alan walker faded"
```

Cek runtime JavaScript untuk challenge solver:

```bash
docker compose exec omnia-bot deno --version
```

Cek service provider:

```bash
docker compose logs --tail=100 bgutil-pot
```

Log server juga akan menulis timing proses per lagu dengan format:

```text
[timing:GUILD_ID] "judul lagu" request_to_playing=2400ms queue_wait=120ms hydrate=300ms pipeline=850ms
```

## Catatan

- Spotify tidak di-stream langsung dari Spotify karena DRM. Untuk URL Spotify, bot mencocokkan metadata lalu memutar hasil resolusi sumber yang didukung `yt-dlp`.
- Command didaftarkan ke `DEV_GUILD_ID` saat development agar pembaruan slash command langsung aktif tanpa menunggu cache global Discord.
