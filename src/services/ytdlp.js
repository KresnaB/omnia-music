import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

const resolveCache = new Map();
const STREAM_URL_MAX_AGE_MS = 2 * 60 * 1000;

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

async function runYtDlpJson(args) {
  try {
    return await execFileAsync(config.ytDlpPath, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
    if (!output) {
      throw error;
    }

    try {
      const payload = parseJsonBlob(output);
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        payload
      };
    } catch {
      throw error;
    }
  }
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

function extractHttpHeaders(entry) {
  const source = unwrapSingleEntry(entry);
  const candidates = [];

  if (Array.isArray(source?.requested_downloads)) {
    candidates.push(...source.requested_downloads);
  }

  if (Array.isArray(source?.formats)) {
    const audioOnly = source.formats.filter((f) => f.vcodec === 'none' && f.url && /^https?:\/\//.test(f.url));
    audioOnly.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
    candidates.push(...audioOnly);
  }

  candidates.push(source);

  for (const candidate of candidates) {
    if (candidate?.http_headers && typeof candidate.http_headers === 'object') {
      return { ...candidate.http_headers };
    }
  }

  return null;
}

function unwrapSingleEntry(entry) {
  if (entry?._type === 'playlist' && Array.isArray(entry.entries) && entry.entries.length === 1) {
    return entry.entries[0];
  }

  return entry;
}

function selectBestAudioSource(entry) {
  const source = unwrapSingleEntry(entry);

  if (!source) {
    return { source: null, streamUrl: null };
  }

  if (source._type === 'url' || source._type === 'url_transparent') {
    return { source, streamUrl: null };
  }

  const requestedDownloads = Array.isArray(source.requested_downloads) ? source.requested_downloads : [];
  const requestedAudio = requestedDownloads.find((f) => f?.url && /^https?:\/\//.test(f.url));
  if (requestedAudio?.url) {
    return { source, streamUrl: requestedAudio.url };
  }

  if (Array.isArray(source.formats) && source.formats.length > 0) {
    const audioOnly = source.formats
      .filter((f) => f.vcodec === 'none' && f.url && /^https?:\/\//.test(f.url))
      .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
    if (audioOnly.length > 0) {
      return { source, streamUrl: audioOnly[0].url };
    }

    const anyHttp = source.formats.filter((f) => f.url && /^https?:\/\//.test(f.url));
    if (anyHttp.length > 0) {
      return { source, streamUrl: anyHttp[anyHttp.length - 1].url };
    }
  }

  if (source.url && /^https?:\/\//.test(source.url)) {
    if (source.url.includes('googlevideo.com')) {
      return { source, streamUrl: source.url };
    }

    if (source.url !== source.webpage_url && !source.url.includes('youtube.com/watch')) {
      return { source, streamUrl: source.url };
    }
  }

  return { source, streamUrl: null };
}

async function fetchStreamSelection(target) {
  const args = [
    ...buildBaseArgs(),
    '--no-playlist',
    '--dump-single-json',
    '-f',
    'bestaudio/best',
    target
  ];

  const { stdout, stderr, payload } = await runYtDlpJson(args);
  const { source, streamUrl } = selectBestAudioSource(payload);

  if (!streamUrl) {
    const detail = `${stdout}\n${stderr}`.trim();
    throw new Error(`yt-dlp tidak mengembalikan direct stream URL${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }

  return {
    streamUrl,
    httpHeaders: extractHttpHeaders(source || payload)
  };
}

function extractStreamUrl(entry) {
  return selectBestAudioSource(entry).streamUrl;
}

function buildCanonicalWebpageUrl(entry, fallbackQuery = '') {
  const source = unwrapSingleEntry(entry);
  const candidates = [source?.webpage_url, source?.original_url, source?.url, fallbackQuery].filter(Boolean);

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

  const extractor = String(source?.extractor_key || source?.ie_key || '').toLowerCase();
  const looksLikeYoutubeId = typeof source?.id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(source.id);
  if (((extractor.includes('youtube') || extractor === 'youtube') && source?.id) || looksLikeYoutubeId) {
    return `https://www.youtube.com/watch?v=${source.id}`;
  }

  return fallbackQuery;
}

function normalizeEntry(entry, fallbackQuery = '') {
  const source = unwrapSingleEntry(entry) || entry;
  const webpageUrl = buildCanonicalWebpageUrl(source, fallbackQuery);
  const streamUrl = extractStreamUrl(source);
  return {
    id: source.id || webpageUrl,
    title: source.title || source.fulltitle || fallbackQuery || 'Unknown title',
    url: webpageUrl,
    webpageUrl,
    streamUrl,
    duration: Math.floor(source.duration || 0),
    uploader: source.uploader || source.channel || source.artist || 'Unknown',
    thumbnail: source.thumbnail || null,
    source: String(source.extractor_key || source.ie_key || 'youtube').toLowerCase(),
    searchQuery: fallbackQuery,
    preparedAt: streamUrl ? Date.now() : null,
    seekSeconds: 0,
    httpHeaders: extractHttpHeaders(source),
    metadataPending: !streamUrl || !source.duration || !source.thumbnail || !source.uploader
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
        const { streamUrl, httpHeaders } = await fetchStreamSelection(target);
        const track = buildFastTrack(normalizedQuery);
        track.streamUrl = streamUrl;
        track.httpHeaders = httpHeaders;
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
      const { stdout, stderr, payload } = await runYtDlpJson(args);

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
    if (track.streamUrl && track.preparedAt && Date.now() - track.preparedAt < STREAM_URL_MAX_AGE_MS) {
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
      const { stdout, stderr, payload } = await runYtDlpJson(args);
      const next = normalizeEntry(payload, track.searchQuery || track.title);
      const { streamUrl, httpHeaders } = await fetchStreamSelection(target);

      track.id = next.id;
      track.title = next.title;
      track.url = next.url;
      track.webpageUrl = next.webpageUrl;
      track.streamUrl = streamUrl || next.streamUrl;
      track.httpHeaders = httpHeaders || next.httpHeaders;
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

  async ensureStreamUrl(track) {
    if (track.streamUrl && track.preparedAt && Date.now() - track.preparedAt < STREAM_URL_MAX_AGE_MS) {
      return track;
    }

    const target = track.webpageUrl || track.url || track.searchQuery || track.title;

    try {
      const { streamUrl, httpHeaders } = await fetchStreamSelection(target);
      track.streamUrl = streamUrl;
      track.httpHeaders = httpHeaders || track.httpHeaders || null;
      track.preparedAt = Date.now();
      return track;
    } catch (error) {
      const detail = `${error.stdout || ''}\n${error.stderr || ''}`.trim() || error.message;
      throw new Error(`yt-dlp stream failed: ${detail.slice(0, 1000)}`);
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
      const { stdout, stderr, payload } = await runYtDlpJson(args);
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
