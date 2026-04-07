# Omnia Music

Bot musik Discord berbasis Go yang ringan, cepat, dan siap deploy via Docker.

## Fitur

- Slash command: `/play`, `/skip`, `/stop`, `/seek`, `/queue`, `/loop`, `/shuffle`, `/autoplay`, `/help`, `/move`, `/status`, `/lyrics`, `/sleep`, `/reconnect`
- Embed now playing dengan judul, durasi, requester, uploader, dan source
- Tombol kontrol: play/pause, skip, stop, shuffle, autoplay, loop, queue, lyrics
- Integrasi lyrics via LRCLIB
- `yt-dlp` dengan PO Token provider (`bgutil-pot`) dan cookies opsional
- Dockerfile dan `docker-compose.yml`

## Setup Lokal

1. Copy `.env.example` menjadi `.env`
2. Isi `DISCORD_TOKEN` dan `DEV_GUILD_ID`
3. Jika ingin memakai cookies untuk konten tertentu, isi `YTDLP_COOKIES_FILE` dan simpan cookies format Netscape di path yang ditentukan
4. Pastikan `ffmpeg` dan `yt-dlp` tersedia
5. Jalankan:

```bash
go mod tidy
go run ./cmd/bot
```

## Setup Discord Developer Portal

1. Buka [Discord Developer Portal](https://discord.com/developers/applications)
2. Klik `New Application`, beri nama bot Anda, lalu buka aplikasi tersebut
3. Masuk ke menu `Bot`, lalu klik `Add Bot`
4. Di halaman yang sama:
   - aktifkan `Message Content Intent` bila nanti Anda ingin menambah command berbasis pesan biasa
   - pastikan bot token dibuat, lalu copy token itu ke `DISCORD_TOKEN`
5. Masuk ke menu `OAuth2 > URL Generator`
6. Pada `Scopes`, centang:
   - `bot`
   - `applications.commands`
7. Pada `Bot Permissions`, centang minimal:
   - `View Channels`
   - `Send Messages`
   - `Embed Links`
   - `Connect`
   - `Speak`
   - `Use Slash Commands`
   - `Read Message History`
8. Copy URL hasil generator, buka di browser, lalu invite bot ke server Anda
9. Untuk `DEV_GUILD_ID`, aktifkan `Developer Mode` di Discord client, lalu klik kanan server target dan pilih `Copy Server ID`

## Catatan Discord

- Slash command didaftarkan ke `DEV_GUILD_ID` agar sinkronisasinya cepat saat development
- Jika nanti ingin command global, ubah proses registrasinya agar tidak hanya ke guild development
- Bot harus punya hak `Connect` dan `Speak` pada voice channel yang dipakai

## Setup Docker

1. Buat folder `config`
2. Jika ingin memakai cookies, simpan di `config/cookies.txt`
3. Set `.env`:
   - `YTDLP_COOKIES_FILE=/app/config/cookies.txt` bila memakai cookies
   - `YTDLP_YOUTUBE_EXTRACTOR_ARGS=youtube:player_client=default,mweb`
   - `YTDLP_POT_PROVIDER_ARGS=youtubepot-bgutilhttp:base_url=http://bgutil-pot:4416;disable_innertube=1`
4. Jalankan:

```bash
docker compose up --build -d
```

## Troubleshooting yt-dlp

Kalau `/play` membalas error `yt-dlp resolve failed`, cek ini di server:

1. Pastikan service POT provider aktif:

```bash
docker compose ps
docker compose logs --tail=100 bgutil-pot
```

2. Verifikasi `yt-dlp` dalam container bisa melihat plugin/provider:

```bash
docker compose exec omnia-music yt-dlp -v "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

3. Jika memakai cookies, pastikan file cookies memang ada:

```bash
ls -lah ~/omnia-music/config/cookies.txt
```

4. Pastikan format cookies adalah format Netscape, bukan hasil copy mentah dari browser

5. Tes manual di host:

```bash
yt-dlp --extractor-args "youtube:player_client=default,mweb" --extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416;disable_innertube=1" --no-playlist --default-search youtube -f bestaudio/best --print-json "ytsearch1:alan walker faded"
```

6. Tes juga dari dalam container:

```bash
docker compose exec omnia-music yt-dlp --extractor-args "youtube:player_client=default,mweb" --extractor-args "youtubepot-bgutilhttp:base_url=http://bgutil-pot:4416;disable_innertube=1" --no-playlist --default-search youtube -f bestaudio/best --print-json "ytsearch1:alan walker faded"
```

7. Kalau hasilnya error login, age restriction, atau cookies invalid, export ulang cookies browser lalu restart container

8. Lihat log bot:

```bash
docker compose logs -f
```

## Catatan

- Spotify tidak di-stream langsung dari Spotify karena DRM. Praktiknya bot memakai query/URL yang bisa di-resolve `yt-dlp`.
- `DEV_GUILD_ID` direkomendasikan saat development agar slash command cepat muncul.
