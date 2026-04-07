import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

const resolveCache = new Map();

function getCache(key) {
  const item = resolveCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    resolveCache.delete(key);
    return null;
  }
  // Deep clone to prevent accidental queue modification affecting memory cache
  return JSON.parse(JSON.stringify(item.data));
}

function setCache(key, data, ttlMs = 15 * 60 * 1000) { // 15 mins cache
  if (resolveCache.size > 200) {
    const oldest = resolveCache.keys().next().value;
    resolveCache.delete(oldest);
  }
  resolveCache.set(key, { data: JSON.parse(JSON.stringify(data)), expires: Date.now() + ttlMs });
}

function parseJsonBlob(output) {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if ((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))) {
      return JSON.parse(line);
    }
  }

  return JSON.parse(output);
}

function isUrl(input) {
  return /^https?:\/\//i.test(input.trim());
}

function isPlaylistLike(query, result) {
  if (Array.isArray(result?.entries) && result.entries.length > 1) return true;
  return /[?&]list=/.test(query) || /\/playlist\?/.test(query);
}

function buildBaseArgs() {
  const args = [
    '--default-search',
    config.defaultSearchPlatform,
    '--no-warnings',
    '--skip-download'
  ];

  if (config.ytDlpYoutubeArgs) {
    args.push('--extractor-args', config.ytDlpYoutubeArgs);
  }

  if (config.ytDlpPotProviderArgs) {
    args.push('--extractor-args', config.ytDlpPotProviderArgs);
  }

  if (config.ytDlpCookiesFile) {
    args.push('--cookies', config.ytDlpCookiesFile);
  }

  return args;
}

function extractStreamUrl(entry) {
  // Coba cari format audio terbaik dari field `formats`
  if (Array.isArray(entry.formats) && entry.formats.length > 0) {
    // Prioritas: format audio-only dengan extension webm/ogg/m4a
    const audioOnly = entry.formats.filter(
      (f) => f.vcodec === 'none' && f.url && /^https?:\/\//.test(f.url)
    );
    if (audioOnly.length > 0) {
      // Pilih bitrate tertinggi
      audioOnly.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
      return audioOnly[0].url;
    }
    // Fallback: format apapun yang ada URL http
    const anyHttp = entry.formats.filter((f) => f.url && /^https?:\/\//.test(f.url));
    if (anyHttp.length > 0) return anyHttp[anyHttp.length - 1].url;
  }
  // Fallback ke entry.url langsung
  return entry.url && /^https?:\/\//.test(entry.url) ? entry.url : null;
}

function normalizeEntry(entry, fallbackQuery = '') {
  const webpageUrl = entry.webpage_url || entry.original_url || entry.url || fallbackQuery;
  const streamUrl = extractStreamUrl(entry);
  return {
    id: entry.id || webpageUrl,
    title: entry.title || entry.fulltitle || fallbackQuery || 'Unknown title',
    url: webpageUrl,
    webpageUrl,
    streamUrl,
    duration: Math.floor(entry.duration || 0),
    uploader: entry.uploader || entry.channel || entry.artist || 'Unknown',
    thumbnail: entry.thumbnail || null,
    source: String(entry.extractor_key || entry.ie_key || 'youtube').toLowerCase(),
    searchQuery: fallbackQuery,
    // Tandai sudah dihydrate jika streamUrl langsung tersedia
    preparedAt: streamUrl ? Date.now() : null,
    seekSeconds: 0
  };
}

export class YTDlpService {
  async resolve(query) {
    const cached = getCache(query);
    if (cached) return cached;

    const isPlaylist = isUrl(query) && (/[?&]list=/.test(query) || /\/playlist\?/.test(query));
    const target = isUrl(query) ? query : `ytsearch1:${query}`;

    const args = [
      ...buildBaseArgs(),
      '--dump-single-json',
      '--playlist-end',
      String(config.maxPlaylistTracks),
      // Minta format stream sekaligus jika single track
      // Gunakan --flat-playlist agar ekstraksi 100 list instan dan bypass ekstraksi stream (akan diambil saat play nanti pakai hydrate)
      ...(isPlaylist ? ['--flat-playlist'] : ['-f', 'bestaudio/best']),
      target
    ];

    try {
      const { stdout, stderr } = await execFileAsync(config.ytDlpPath, args, { maxBuffer: 16 * 1024 * 1024 });
      const payload = parseJsonBlob(`${stdout}\n${stderr}`);

      if (Array.isArray(payload.entries) && payload.entries.length > 0) {
        if (isPlaylistLike(query, payload)) {
          const entries = payload.entries
            .filter(Boolean)
            .slice(0, config.maxPlaylistTracks)
            .map((entry) => normalizeEntry(entry, entry.title || query));

          const resultPayload = {
            type: 'playlist',
            playlistTitle: payload.title || 'Playlist',
            tracks: entries
          };
          setCache(query, resultPayload);
          return resultPayload;
        }

        const resultPayload = {
          type: 'single',
          tracks: [normalizeEntry(payload.entries[0], query)]
        };
        setCache(query, resultPayload);
        return resultPayload;
      }

      const resultPayload = {
        type: 'single',
        tracks: [normalizeEntry(payload, query)]
      };
      setCache(query, resultPayload);
      return resultPayload;
    } catch (error) {
      const detail = `${error.stdout || ''}\n${error.stderr || ''}`.trim() || error.message;
      throw new Error(`yt-dlp resolve failed: ${detail.slice(0, 1000)}`);
    }
  }

  async hydrate(track) {
    if (track.streamUrl && track.preparedAt && Date.now() - track.preparedAt < 10 * 60 * 1000) {
      return track;
    }

    const target = track.webpageUrl || track.url || track.searchQuery || track.title;
    const args = [
      ...buildBaseArgs(),
      '--dump-single-json',
      '--no-playlist',
      target
    ];

    try {
      const { stdout, stderr } = await execFileAsync(config.ytDlpPath, args, { maxBuffer: 16 * 1024 * 1024 });
      const payload = parseJsonBlob(`${stdout}\n${stderr}`);
      const next = normalizeEntry(payload, track.searchQuery || track.title);

      track.id = next.id;
      track.title = next.title;
      track.url = next.url;
      track.webpageUrl = next.webpageUrl;
      track.streamUrl = next.streamUrl;
      track.duration = next.duration;
      track.uploader = next.uploader;
      track.thumbnail = next.thumbnail;
      track.source = next.source;
      track.preparedAt = Date.now();
      return track;
    } catch (error) {
      const detail = `${error.stdout || ''}\n${error.stderr || ''}`.trim() || error.message;
      throw new Error(`yt-dlp hydrate failed: ${detail.slice(0, 1000)}`);
    }
  }
}
