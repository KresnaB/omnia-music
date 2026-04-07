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

function normalizeQuery(input) {
  const value = input.trim();
  if (!isUrl(value)) return value;

  try {
    const url = new URL(value);
    if (url.hostname === 'music.youtube.com') {
      url.hostname = 'www.youtube.com';
    }
    return url.toString();
  } catch {
    return value;
  }
}

function isPlaylistLike(query, result) {
  if (Array.isArray(result?.entries) && result.entries.length > 1) return true;
  return /[?&]list=/.test(query) || /\/playlist\?/.test(query);
}

function extractVideoIdFromUrl(input) {
  try {
    const url = new URL(input);
    if (url.searchParams.get('v')) {
      return url.searchParams.get('v');
    }
    const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) {
      return shortsMatch[1];
    }
  } catch {
    return null;
  }
  return null;
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

async function fetchStreamUrl(target) {
  const args = [
    ...buildBaseArgs(),
    '--get-url',
    '--no-playlist',
    '-f',
    'bestaudio/best',
    target
  ];

  const { stdout, stderr } = await execFileAsync(config.ytDlpPath, args, {
    maxBuffer: 16 * 1024 * 1024
  });

  const lines = `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line));

  if (lines.length === 0) {
    throw new Error('yt-dlp tidak mengembalikan direct stream URL');
  }

  return lines[0];
}

function extractStreamUrl(entry) {
  if (entry._type === 'url' || entry._type === 'url_transparent') {
    return null;
  }

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
  
  // Fallback ke requested_formats jika yt-dlp menaruh format terbaik di sana
  if (Array.isArray(entry.requested_formats) && entry.requested_formats.length > 0) {
    const reqAudio = entry.requested_formats.find(f => f.url && /^https?:\/\//.test(f.url));
    if (reqAudio) return reqAudio.url;
  }

  // JANGAN fallback ke entry.url jika itu adalah halaman web (youtube.com, dll)
  // Hanya balikkan URL jika sudah didefinisikan sebagai raw stream
  if (entry.url && /^https?:\/\//.test(entry.url)) {
    // Jika URL mengandung googlevideo, maka ini sudah dipastikan stream
    if (entry.url.includes('googlevideo.com')) {
      return entry.url;
    }
    // Fallback lama jika formatnya berbeda tapi bukan halaman nonton standar
    if (entry.url !== entry.webpage_url && !entry.url.includes('youtube.com/watch')) {
      return entry.url;
    }
  }

  return null;
}

function buildCanonicalWebpageUrl(entry, fallbackQuery = '') {
  const candidates = [entry.webpage_url, entry.original_url, entry.url, fallbackQuery].filter(Boolean);

  for (const candidate of candidates) {
    if (/^https?:\/\//.test(candidate)) {
      try {
        const url = new URL(candidate);
        if (url.hostname === 'music.youtube.com') {
          url.hostname = 'www.youtube.com';
        }
        return url.toString();
      } catch {
        return candidate;
      }
    }
  }

  const extractor = String(entry.extractor_key || entry.ie_key || '').toLowerCase();
  const looksLikeYoutubeId = typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(entry.id);
  if (((extractor.includes('youtube') || extractor === 'youtube') && entry.id) || looksLikeYoutubeId) {
    return `https://www.youtube.com/watch?v=${entry.id}`;
  }

  return fallbackQuery;
}

function normalizeEntry(entry, fallbackQuery = '') {
  const webpageUrl = buildCanonicalWebpageUrl(entry, fallbackQuery);
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

function buildFastTrack(url) {
  const videoId = extractVideoIdFromUrl(url);
  return {
    id: videoId || url,
    title: url,
    url,
    webpageUrl: url,
    streamUrl: null,
    duration: 0,
    uploader: 'Loading...',
    thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null,
    source: 'youtube',
    searchQuery: url,
    preparedAt: null,
    seekSeconds: 0,
    metadataPending: true
  };
}

export class YTDlpService {
  async resolve(query) {
    const normalizedQuery = normalizeQuery(query);
    const cached = getCache(normalizedQuery);
    if (cached) return cached;

    const isPlaylist = isUrl(normalizedQuery) && (/[?&]list=/.test(normalizedQuery) || /\/playlist\?/.test(normalizedQuery) || /[?&]start_radio=/.test(normalizedQuery));
    const target = isUrl(normalizedQuery) ? normalizedQuery : `ytsearch1:${normalizedQuery}`;

    if (isUrl(normalizedQuery) && !isPlaylist) {
      try {
        const streamUrl = await fetchStreamUrl(target);
        const track = buildFastTrack(normalizedQuery);
        track.streamUrl = streamUrl;
        track.preparedAt = Date.now();

        const resultPayload = {
          type: 'single',
          tracks: [track]
        };
        setCache(normalizedQuery, resultPayload, 5 * 60 * 1000);
        return resultPayload;
      } catch (error) {
        // Fallback ke jalur lama bila direct stream cepat gagal.
      }
    }

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
            .map((entry) => normalizeEntry(entry, entry.title || normalizedQuery));

          const resultPayload = {
            type: 'playlist',
            playlistTitle: payload.title || 'Playlist',
            tracks: entries
          };
          setCache(normalizedQuery, resultPayload);
          return resultPayload;
        }

        const resultPayload = {
          type: 'single',
          tracks: [normalizeEntry(payload.entries[0], normalizedQuery)]
        };
        setCache(normalizedQuery, resultPayload);
        return resultPayload;
      }

      const resultPayload = {
        type: 'single',
        tracks: [normalizeEntry(payload, normalizedQuery)]
      };
      setCache(normalizedQuery, resultPayload);
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
      '-f',
      'bestaudio/best',
      '--dump-single-json',
      '--no-playlist',
      target
    ];

    try {
      const { stdout, stderr } = await execFileAsync(config.ytDlpPath, args, { maxBuffer: 16 * 1024 * 1024 });
      const payload = parseJsonBlob(`${stdout}\n${stderr}`);
      const next = normalizeEntry(payload, track.searchQuery || track.title);
      const streamUrl = await fetchStreamUrl(target);

      track.id = next.id;
      track.title = next.title;
      track.url = next.url;
      track.webpageUrl = next.webpageUrl;
      track.streamUrl = streamUrl || next.streamUrl;
      track.duration = next.duration;
      track.uploader = next.uploader;
      track.thumbnail = next.thumbnail;
      track.source = next.source;
      track.preparedAt = Date.now();
      track.metadataPending = false;
      return track;
    } catch (error) {
      const detail = `${error.stdout || ''}\n${error.stderr || ''}`.trim() || error.message;
      throw new Error(`yt-dlp hydrate failed: ${detail.slice(0, 1000)}`);
    }
  }

  async hydrateMetadata(track) {
    const target = track.webpageUrl || track.url || track.searchQuery || track.title;
    const args = [
      ...buildBaseArgs(),
      '-f',
      'bestaudio/best',
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
      track.duration = next.duration;
      track.uploader = next.uploader;
      track.thumbnail = next.thumbnail;
      track.source = next.source;
      track.metadataPending = false;
      if (!track.streamUrl && next.streamUrl) {
        track.streamUrl = next.streamUrl;
        track.preparedAt = Date.now();
      }
      return track;
    } catch (error) {
      const detail = `${error.stdout || ''}\n${error.stderr || ''}`.trim() || error.message;
      throw new Error(`yt-dlp metadata failed: ${detail.slice(0, 1000)}`);
    }
  }
}
