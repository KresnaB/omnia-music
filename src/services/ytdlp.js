import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { truncate } from '../utils/format.js';
import { isExternalMusicUrl, resolveExternalMusicUrl } from './externalLinks.js';
import { createYoutubeError, isYoutubeServiceUnavailableError } from './youtubeErrors.js';

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
    const { stdout, stderr } = await execFileAsync(config.ytDlpPath, args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000,
    });
    // Jalur sukses (exit 0): stdout berisi JSON dump, parse langsung.
    return {
      stdout,
      stderr,
      payload: parseJsonBlob(stdout),
    };
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

export function selectBestSearchEntry(entries, query = '') {
  const valid = (entries || []).filter(Boolean);
  if (valid.length <= 1) return valid[0] || null;

  const qLower = String(query || '').toLowerCase();
  const queryTokens = qLower
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  const wantsLyrics = /\b(lyrics?|lirik)\b/i.test(qLower);
  const wantsAltVersion = /\b(nightcore|slowed|reverb|karaoke|instrumental|cover|remix|8d)\b/i.test(qLower);

  let bestEntry = valid[0];
  let bestScore = -Infinity;

  for (let i = 0; i < valid.length; i += 1) {
    const entry = valid[i];
    const title = String(entry.title || '').toLowerCase();
    const channel = String(entry.channel || entry.uploader || '').toLowerCase();
    let score = -i * 2;

    if (/\s-\stopic$/i.test(channel)) {
      score += 40;
    }
    if (channel && queryTokens.some((tok) => channel.includes(tok))) {
      score += 35;
    }
    if (/vevo$|official$/i.test(channel)) {
      score += 10;
    }
    if (/official audio/i.test(title)) {
      score += 15;
    }

    if (/\b(lyrics?|lirik|lyric video)\b/i.test(title)) {
      score += wantsLyrics ? 40 : -30;
    }
    if (!wantsAltVersion && /\b(nightcore|slowed|reverb|karaoke|instrumental|cover|8d audio)\b/i.test(title)) {
      score -= 20;
    }

    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  return bestEntry;
}

function buildBaseArgs(youtubeArgsOverride = config.ytDlpYoutubeArgs) {
  const args = [
    '--default-search',
    config.defaultSearchPlatform,
    '--no-warnings',
    '--skip-download',
    '--socket-timeout',
    '15'
  ];

  if (youtubeArgsOverride) {
    args.push('--extractor-args', youtubeArgsOverride);
  }

  if (config.ytDlpPotProviderArgs) {
    args.push('--extractor-args', config.ytDlpPotProviderArgs);
  }

  if (config.ytDlpCookiesFile) {
    args.push('--cookies', config.ytDlpCookiesFile);
  }

  return args;
}

export function buildYoutubeClientCandidates(primaryArgs = config.ytDlpYoutubeArgs) {
  const candidates = [];
  const seen = new Set();

  for (const candidate of [primaryArgs || null, 'youtube:player_client=android', null]) {
    const key = candidate || '__default__';
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  }

  return candidates;
}

export function isRetryableYoutubeClientError(error) {
  if (isYoutubeServiceUnavailableError(error)) {
    return true;
  }

  const text = [error?.message, error?.stdout, error?.stderr, error?.cause?.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /requested format is not available|no video formats found|no playable track found|empty track metadata|empty payload/.test(
    text
  );
}

function parsePotBaseUrl(potArgs = config.ytDlpPotProviderArgs) {
  const match = String(potArgs || '').match(/base_url=([^;\s]+)/i);
  return match ? match[1] : null;
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

export function normalizeEntry(entry, fallbackQuery = '') {
  const source = unwrapSingleEntry(entry);
  if (!source || typeof source !== 'object') {
    throw new Error('yt-dlp returned empty track metadata');
  }
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

export class YTDlpService {
  constructor() {
    this.lastStatus = null;
  }

  recordStatus(ok, client, error = null) {
    this.lastStatus = {
      ok,
      at: Date.now(),
      client: client || 'default',
      error: error ? truncate(error.message || String(error), 120) : null
    };
  }

  async runWithClientFallback(operation, fn) {
    const candidates = buildYoutubeClientCandidates();
    let lastError = null;

    for (let i = 0; i < candidates.length; i += 1) {
      const clientArgs = candidates[i];
      try {
        const result = await fn(clientArgs);
        if (i > 0) {
          console.log(`[YTDLP:${operation}] Fallback client succeeded: ${clientArgs || 'default'}`);
        }
        this.recordStatus(true, clientArgs);
        return result;
      } catch (error) {
        lastError = error;
        const canRetry = i < candidates.length - 1 && isRetryableYoutubeClientError(error);
        if (!canRetry) {
          break;
        }
        console.warn(
          `[YTDLP:${operation}] Client "${clientArgs || 'default'}" failed (${truncate(error.message || '', 120)}), trying fallback...`
        );
      }
    }

    this.recordStatus(false, candidates[0], lastError);
    throw lastError;
  }

  async getHealthReport() {
    let cookies = { configured: Boolean(config.ytDlpCookiesFile), ok: false, updatedAt: null, reason: 'not configured' };
    if (config.ytDlpCookiesFile) {
      try {
        const info = await stat(config.ytDlpCookiesFile);
        cookies = {
          configured: true,
          ok: info.size > 0,
          updatedAt: info.mtimeMs,
          reason: info.size > 0 ? 'ok' : 'empty file'
        };
      } catch (error) {
        cookies = {
          configured: true,
          ok: false,
          updatedAt: null,
          reason: error.code || 'missing'
        };
      }
    }

    const potUrl = parsePotBaseUrl();
    let pot = { configured: Boolean(potUrl), ok: false, url: potUrl, reason: 'not configured' };
    if (potUrl) {
      try {
        const res = await fetch(potUrl, { signal: AbortSignal.timeout(2000) });
        pot = {
          configured: true,
          ok: res.status < 500,
          url: potUrl,
          reason: `HTTP ${res.status}`
        };
      } catch (error) {
        pot = {
          configured: true,
          ok: false,
          url: potUrl,
          reason: error.code || error.message || 'unreachable'
        };
      }
    }

    return {
      cookies,
      pot,
      lastStatus: this.lastStatus
    };
  }

  async resolve(query, { bypassCache = false } = {}) {
    const normalizedQuery = normalizeQuery(query);
    console.log(`[YTDLP:resolve] Resolving query | original="${truncate(query, 100)}" | normalized="${truncate(normalizedQuery, 100)}"`);

    const cached = bypassCache ? null : getCache(normalizedQuery);
    if (cached) {
      console.log(`[YTDLP:resolve] Cache hit | type=${cached.type} | tracks=${cached.tracks?.length || 0}`);
      return cached;
    }
    console.log(`[YTDLP:resolve] ${bypassCache ? 'Cache bypassed' : 'Cache miss'}, will resolve`);

    if (isExternalMusicUrl(normalizedQuery)) {
      const external = await resolveExternalMusicUrl(normalizedQuery);
      if (external.type === 'single') {
        const resolved = await this.resolve(external.queries[0], { bypassCache });
        setCache(normalizedQuery, resolved);
        return resolved;
      }

      const resultPayload = {
        type: 'playlist',
        playlistTitle: external.playlistTitle,
        tracks: external.tracks.map((t) => ({
          id: t.query,
          title: t.title,
          url: null,
          webpageUrl: null,
          streamUrl: null,
          duration: 0,
          uploader: t.artist || 'Unknown',
          thumbnail: null,
          source: external.provider,
          searchQuery: t.query,
          preparedAt: null,
          seekSeconds: 0,
          httpHeaders: null,
          metadataPending: true
        }))
      };
      setCache(normalizedQuery, resultPayload);
      return resultPayload;
    }

    const queryIsUrl = isUrl(normalizedQuery);
    const isPlaylist = queryIsUrl && (/[?&]list=/.test(normalizedQuery) || /\/playlist\?/.test(normalizedQuery) || /[?&]start_radio=/.test(normalizedQuery));
    const isTextSearch = !queryIsUrl;
    const target = queryIsUrl ? normalizedQuery : `ytsearch5:${normalizedQuery}`;
    console.log(`[YTDLP:resolve] isPlaylist=${isPlaylist} | target="${truncate(target, 100)}"`);

    try {
      return await this.runWithClientFallback('resolve', async (clientArgs) => {
        const args = [
          ...buildBaseArgs(clientArgs),
          '--dump-single-json',
          '--playlist-end',
          String(isTextSearch ? 5 : config.maxPlaylistTracks),
          // Minta format stream sekaligus jika single URL; gunakan --flat-playlist untuk playlist atau text search (5 kandidat)
          ...(isPlaylist || isTextSearch ? ['--flat-playlist'] : ['-f', 'bestaudio/best']),
          target
        ];

        const { stdout, stderr, payload } = await runYtDlpJson(args);

        if (!payload || typeof payload !== 'object') {
          throw Object.assign(new Error('yt-dlp returned empty payload'), { stdout, stderr });
        }

        if (Array.isArray(payload.entries)) {
          const validEntries = payload.entries.filter(Boolean);
          if (validEntries.length === 0) {
            throw Object.assign(new Error('No playable track found in yt-dlp output'), { stdout, stderr });
          }

          if (!isTextSearch && isPlaylistLike(query, payload)) {
            const entries = validEntries
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

          const chosen = isTextSearch ? selectBestSearchEntry(validEntries, normalizedQuery) : validEntries[0];
          const resultPayload = {
            type: 'single',
            tracks: [normalizeEntry(chosen, normalizedQuery)]
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
      });
    } catch (error) {
      throw createYoutubeError(error, 'resolve');
    }
  }

  async hydrate(track) {
    console.log(`[YTDLP:hydrate] Hydrating track | title="${truncate(track?.title || 'unknown', 80)}" | hasStream=${Boolean(track?.streamUrl)} | preparedAt=${track?.preparedAt ? new Date(track.preparedAt).toISOString() : 'null'} | age=${track?.preparedAt ? (Date.now() - track.preparedAt) + 'ms' : 'N/A'}`);

    if (track.streamUrl && track.preparedAt && Date.now() - track.preparedAt < STREAM_URL_MAX_AGE_MS) {
      console.log(`[YTDLP:hydrate] Stream URL still fresh, skipping`);
      return track;
    }

    const rawTarget = track.webpageUrl || track.url || track.searchQuery || track.title;
    const target = isUrl(rawTarget) ? rawTarget : `ytsearch1:${rawTarget}`;
    console.log(`[YTDLP:hydrate] Fetching fresh data for target="${truncate(target, 100)}"`);

    try {
      return await this.runWithClientFallback('hydrate', async (clientArgs) => {
        const args = [
          ...buildBaseArgs(clientArgs),
          '-f',
          'bestaudio/best',
          '--dump-single-json',
          '--no-playlist',
          target
        ];
        const { payload } = await runYtDlpJson(args);
        console.log(`[YTDLP:hydrate] Got payload | id=${payload?.id} | title=${truncate(payload?.title || '', 80)}`);
        const next = normalizeEntry(payload, track.searchQuery || track.title);

        track.id = next.id;
        track.title = next.title;
        track.url = next.url;
        track.webpageUrl = next.webpageUrl;
        track.streamUrl = next.streamUrl;
        track.httpHeaders = next.httpHeaders;
        track.duration = next.duration;
        track.uploader = next.uploader;
        track.thumbnail = next.thumbnail;
        track.source = next.source;
        track.preparedAt = Date.now();
        track.metadataPending = false;
        console.log(`[YTDLP:hydrate] Hydration complete | streamUrl=${Boolean(track.streamUrl)} | duration=${track.duration}s | uploader=${track.uploader}`);
        return track;
      });
    } catch (error) {
      const detail = `${error.stdout || ''}\n${error.stderr || ''}`.trim() || error.message;
      console.error(`[YTDLP:hydrate] Failed: ${detail.slice(0, 500)}`);
      throw createYoutubeError(error, 'hydrate');
    }
  }

  async hydrateMetadata(track) {
    console.log(`[YTDLP:hydrateMeta] Hydrating metadata | title="${truncate(track?.title || 'unknown', 80)}" | hasStream=${Boolean(track?.streamUrl)}`);

    const rawTarget = track.webpageUrl || track.url || track.searchQuery || track.title;
    const target = isUrl(rawTarget) ? rawTarget : `ytsearch1:${rawTarget}`;
    console.log(`[YTDLP:hydrateMeta] target="${truncate(target, 100)}"`);

    try {
      return await this.runWithClientFallback('metadata', async (clientArgs) => {
        const args = [
          ...buildBaseArgs(clientArgs),
          '-f',
          'bestaudio/best',
          '--dump-single-json',
          '--no-playlist',
          target
        ];
        const { payload } = await runYtDlpJson(args);
        console.log(`[YTDLP:hydrateMeta] Got payload | id=${payload?.id} | title=${truncate(payload?.title || '', 80)}`);
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
          console.log(`[YTDLP:hydrateMeta] Also got streamUrl from metadata`);
          track.streamUrl = next.streamUrl;
          track.preparedAt = Date.now();
        }
        console.log(`[YTDLP:hydrateMeta] Complete | title="${truncate(track.title, 80)}" | duration=${track.duration}s | uploader=${track.uploader}`);
        return track;
      });
    } catch (error) {
      const detail = `${error.stdout || ''}\n${error.stderr || ''}`.trim() || error.message;
      console.error(`[YTDLP:hydrateMeta] Failed: ${detail.slice(0, 500)}`);
      throw createYoutubeError(error, 'metadata');
    }
  }
}
