import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fuse from 'fuse.js';
import { config } from '../config.js';

const CANONICAL_NOISE_PATTERNS = [
  /\b(official|audio|video|lyrics?|lyric|visualizer|mv|hd|hq|4k|8k)\b/gi,
  /\b(remaster(?:ed)?|mono|stereo|version|edit|mix)\b/gi,
  /\b(live|concert|acoustic|karaoke|cover|performance|session|radio edit)\b/gi,
  /\b(full album|full song|original soundtrack|ost)\b/gi,
  /\bfeat\.?\b.*$/gi,
  /\bft\.?\b.*$/gi,
  /\([^)]*(official|audio|video|lyrics?|lyric|visualizer|mv|hd|hq|4k|8k|remaster(?:ed)?|live|acoustic|karaoke|cover|performance|session|radio edit)[^)]*\)/gi,
  /\[[^\]]*(official|audio|video|lyrics?|lyric|visualizer|mv|hd|hq|4k|8k|remaster(?:ed)?|live|acoustic|karaoke|cover|performance|session|radio edit)[^\]]*\]/gi,
  /\{[^}]*(official|audio|video|lyrics?|lyric|visualizer|mv|hd|hq|4k|8k|remaster(?:ed)?|live|acoustic|karaoke|cover|performance|session|radio edit)[^}]*\}/gi,
  /[-|:]\s*(official|audio|video|lyrics?|lyric|visualizer|mv|hd|hq|4k|8k|remaster(?:ed)?|live|acoustic|karaoke|cover|performance|session|radio edit).*$/gi
];

function sanitizeFilePart(value) {
  return String(value || 'track')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'track';
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function canonicalizeTitle(value) {
  let normalized = normalizeText(value)
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[._]/g, ' ');

  for (const pattern of CANONICAL_NOISE_PATTERNS) {
    normalized = normalized.replace(pattern, ' ');
  }

  normalized = normalized
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\b\d{4}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || 'unknown-track';
}

function createSearchDocument(entry) {
  const title = String(entry.track?.title || '');
  const uploader = String(entry.track?.uploader || '');
  const canonicalTitle = canonicalizeTitle(title);
  const canonicalUploader = canonicalizeTitle(uploader);

  return {
    canonicalKey: entry.canonicalKey,
    title,
    uploader,
    canonicalTitle,
    canonicalUploader,
    combined: `${title} ${uploader} ${entry.canonicalKey}`.trim(),
    normalizedCombined: `${canonicalTitle} ${canonicalUploader} ${entry.canonicalKey}`.trim(),
    entry
  };
}

function cloneTrackMeta(track) {
  return {
    id: track.id || null,
    title: track.title || 'Unknown title',
    url: track.url || track.webpageUrl || null,
    webpageUrl: track.webpageUrl || track.url || null,
    duration: Number(track.duration || 0),
    uploader: track.uploader || 'Unknown',
    thumbnail: track.thumbnail || null,
    source: track.source || 'youtube',
    canonicalKey: track.canonicalKey || canonicalizeTitle(track.title),
    cacheFormat: 'ogg',
    cacheCodec: 'opus',
    cacheBitrateKbps: config.audioCacheBitrateKbps
  };
}

function cloneTrackFromEntry(entry, overrides = {}) {
  return {
    ...(entry.track || {}),
    canonicalKey: entry.canonicalKey,
    localPath: entry.filePath,
    streamUrl: null,
    httpHeaders: null,
    preparedAt: Date.now(),
    metadataPending: false,
    cacheStatus: 'cached',
    cacheError: null,
    ...overrides
  };
}

function waitForExit(process, label) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    process.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    process.once('error', reject);
    process.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ''}`));
    });
  });
}

function buildHttpHeaders(track) {
  const headers = { ...(track.httpHeaders || {}) };

  if (track.webpageUrl && /^https?:\/\//.test(track.webpageUrl)) {
    headers.Referer ??= track.webpageUrl;
  }

  headers.Origin ??= 'https://www.youtube.com';
  headers['User-Agent'] ??=
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

  return Object.entries(headers)
    .filter(([, value]) => value !== null && value !== undefined && String(value).length > 0)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join('');
}

export class AudioCacheService {
  constructor() {
    this.index = new Map();
    this.downloads = new Map();
    this.readyPromise = null;
    this.persistPromise = Promise.resolve();
    this.searchDocs = [];
    this.fuse = null;
  }

  rebuildSearchIndex() {
    this.searchDocs = [...this.index.values()].map((entry) => createSearchDocument(entry));
    this.fuse = new Fuse(this.searchDocs, {
      includeScore: true,
      shouldSort: true,
      ignoreLocation: true,
      threshold: 0.3,
      minMatchCharLength: 3,
      keys: [
        { name: 'title', weight: 0.5 },
        { name: 'canonicalTitle', weight: 0.25 },
        { name: 'uploader', weight: 0.15 },
        { name: 'canonicalUploader', weight: 0.05 },
        { name: 'canonicalKey', weight: 0.05 }
      ]
    });
  }

  searchEntries(query, { excludeCanonicalKeys = [], limit = 20, maxScore = 0.35 } = {}) {
    const needle = String(query || '').trim();
    if (!needle || !this.fuse) {
      return [];
    }

    const canonicalNeedle = canonicalizeTitle(needle);
    if (!canonicalNeedle || canonicalNeedle === 'unknown-track') {
      return [];
    }

    const excluded = new Set(excludeCanonicalKeys.filter(Boolean));
    const directResults = this.searchDocs
      .filter((doc) => !excluded.has(doc.canonicalKey))
      .map((doc) => {
        let rank = -1;
        if (doc.canonicalTitle === canonicalNeedle || doc.canonicalKey === canonicalNeedle) {
          rank = 0;
        } else if (doc.canonicalTitle.split(/\s+/).includes(canonicalNeedle)) {
          rank = 1;
        } else if (doc.canonicalTitle.startsWith(canonicalNeedle) || doc.title.toLowerCase().startsWith(needle.toLowerCase())) {
          rank = 2;
        } else if (doc.canonicalTitle.includes(canonicalNeedle) || doc.canonicalKey.includes(canonicalNeedle)) {
          rank = 3;
        } else if (doc.canonicalUploader.includes(canonicalNeedle)) {
          rank = 4;
        }

        return rank === -1 ? null : {
          entry: doc.entry,
          score: rank * 0.01,
          directRank: rank
        };
      })
      .filter(Boolean)
      .sort((a, b) =>
        a.directRank - b.directRank ||
        b.entry.lastAccessedAt - a.entry.lastAccessedAt
      )
      .slice(0, limit);

    if (directResults.length > 0) {
      return directResults.map(({ entry, score }) => ({ entry, score }));
    }

    return this.fuse.search(needle, { limit: Math.max(limit * 5, limit) })
      .filter((result) => !excluded.has(result.item.canonicalKey))
      .filter((result) => result.score === undefined || result.score <= maxScore)
      .slice(0, limit)
      .map((result) => ({
        entry: result.item.entry,
        score: result.score ?? 0
      }));
  }

  async init() {
    if (!this.readyPromise) {
      this.readyPromise = this.loadIndex();
    }
    await this.readyPromise;
  }

  async loadIndex() {
    await mkdir(config.audioCacheDir, { recursive: true });
    await mkdir(path.dirname(config.audioCacheIndexFile), { recursive: true });

    let parsed = [];
    try {
      const raw = await readFile(config.audioCacheIndexFile, 'utf8');
      const payload = JSON.parse(raw);
      if (Array.isArray(payload?.entries)) {
        parsed = payload.entries;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[audio-cache] failed to read index:', error.message);
      }
    }

    for (const entry of parsed) {
      if (!entry?.canonicalKey || !entry?.fileName) {
        continue;
      }

      const filePath = path.join(config.audioCacheDir, entry.fileName);
      try {
        const fileStat = await stat(filePath);
        this.index.set(entry.canonicalKey, {
          canonicalKey: entry.canonicalKey,
          fileName: entry.fileName,
          filePath,
          sizeBytes: fileStat.size,
          createdAt: entry.createdAt || Date.now(),
          lastAccessedAt: entry.lastAccessedAt || entry.createdAt || Date.now(),
          track: entry.track || {}
        });
      } catch {
        // File sudah hilang, abaikan index lama.
      }
    }

    await this.persistIndex();
    await this.enforceLimits();
    this.rebuildSearchIndex();
  }

  async persistIndex() {
    const entries = [...this.index.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => ({
        canonicalKey: entry.canonicalKey,
        fileName: entry.fileName,
        sizeBytes: entry.sizeBytes,
        createdAt: entry.createdAt,
        lastAccessedAt: entry.lastAccessedAt,
        track: entry.track
      }));

    this.persistPromise = this.persistPromise.then(() =>
      writeFile(config.audioCacheIndexFile, JSON.stringify({ entries }, null, 2), 'utf8')
    );

    await this.persistPromise;
  }

  getCanonicalKey(track) {
    return canonicalizeTitle(track?.title || track?.searchQuery || track?.webpageUrl || track?.id || '');
  }

  async getStats() {
    await this.init();
    const entries = [...this.index.values()];
    return {
      totalTracks: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      maxTracks: config.audioCacheMaxTracks,
      maxBytes: config.audioCacheMaxSizeBytes
    };
  }

  async listEntries({ query = '', limit = 20, offset = 0 } = {}) {
    await this.init();
    const entries = query
      ? this.searchEntries(query, { limit: this.index.size || limit, maxScore: 0.4 }).map((result) => result.entry)
      : [...this.index.values()].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);

    return {
      total: entries.length,
      entries: entries.slice(offset, offset + limit).map((entry) => ({ ...entry }))
    };
  }

  async resolveQueryToTrack(query, overrides = {}) {
    await this.init();
    const needle = canonicalizeTitle(query || '');
    if (!needle || needle === 'unknown-track') {
      return null;
    }

    const exact = this.index.get(needle);
    if (exact) {
      exact.lastAccessedAt = Date.now();
      await this.persistIndex();
      return cloneTrackFromEntry(exact, overrides);
    }

    const partial = this.searchEntries(query, { limit: 1, maxScore: 0.35 })[0]?.entry;

    if (!partial) {
      return null;
    }

    partial.lastAccessedAt = Date.now();
    await this.persistIndex();
    return cloneTrackFromEntry(partial, overrides);
  }

  async getBestMatchTrack({ query = '', excludeCanonicalKeys = [], minScore = 25, requester, originalQuery = 'Cache Fallback' } = {}) {
    await this.init();
    const maxScore = Math.max(0.05, Math.min(0.4, 1 - (minScore / 100)));
    const chosen = this.searchEntries(query, {
      excludeCanonicalKeys,
      limit: 1,
      maxScore
    })[0]?.entry;
    if (!chosen) {
      return null;
    }

    chosen.lastAccessedAt = Date.now();
    await this.persistIndex();
    return cloneTrackFromEntry(chosen, {
      requester,
      addedAt: Date.now(),
      originalQuery,
      requestStartedAt: Date.now(),
      failoverFromYoutube: true
    });
  }

  async getAutoplayCandidate({ excludeCanonicalKeys = [], requester, originalQuery = 'Cache Autoplay' } = {}) {
    await this.init();
    const excluded = new Set(excludeCanonicalKeys.filter(Boolean));
    let candidates = [...this.index.values()]
      .filter((entry) => !excluded.has(entry.canonicalKey))
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);

    if (candidates.length === 0) {
      candidates = [...this.index.values()].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
    }

    if (candidates.length === 0) {
      return null;
    }

    const chosen = candidates[Math.floor(Math.random() * Math.min(candidates.length, 15))];
    chosen.lastAccessedAt = Date.now();
    await this.persistIndex();
    return cloneTrackFromEntry(chosen, {
      requester,
      addedAt: Date.now(),
      originalQuery,
      requestStartedAt: Date.now(),
      failoverFromYoutube: true
    });
  }

  async deleteByQuery(query) {
    await this.init();
    const needle = canonicalizeTitle(query || '');
    if (!needle || needle === 'unknown-track') {
      return null;
    }

    let entry = this.index.get(needle) || null;
    if (!entry) {
      entry = this.searchEntries(query, { limit: 1, maxScore: 0.4 })[0]?.entry || null;
    }

    if (!entry) {
      return null;
    }

    this.index.delete(entry.canonicalKey);
    await rm(entry.filePath, { force: true }).catch(() => null);
    await this.persistIndex();
    this.rebuildSearchIndex();
    return { ...entry };
  }

  async hydrateLocalReference(track) {
    await this.init();
    const canonicalKey = this.getCanonicalKey(track);
    track.canonicalKey = canonicalKey;

    const entry = this.index.get(canonicalKey);
    if (!entry) {
      return null;
    }

    try {
      await stat(entry.filePath);
    } catch {
      this.index.delete(canonicalKey);
      await this.persistIndex();
      return null;
    }

    track.id = entry.track.id || track.id;
    track.title = entry.track.title || track.title;
    track.url = entry.track.url || track.url;
    track.webpageUrl = entry.track.webpageUrl || track.webpageUrl;
    track.duration = entry.track.duration || track.duration;
    track.uploader = entry.track.uploader || track.uploader;
    track.thumbnail = entry.track.thumbnail || track.thumbnail;
    track.source = entry.track.source || track.source;
    track.localPath = entry.filePath;
    track.streamUrl = null;
    track.httpHeaders = null;
    track.preparedAt = Date.now();
    track.metadataPending = false;

    entry.lastAccessedAt = Date.now();
    await this.persistIndex();
    return entry;
  }

  async queueDownload(track) {
    await this.init();
    const canonicalKey = track.canonicalKey || this.getCanonicalKey(track);
    track.canonicalKey = canonicalKey;

    if (this.index.has(canonicalKey)) {
      return this.index.get(canonicalKey);
    }

    if (this.downloads.has(canonicalKey)) {
      return this.downloads.get(canonicalKey);
    }

    const promise = this.downloadTrack(track, canonicalKey)
      .catch((error) => {
        console.warn(`[audio-cache] download failed for "${track.title}":`, error.message);
        return null;
      })
      .finally(() => {
        this.downloads.delete(canonicalKey);
      });

    this.downloads.set(canonicalKey, promise);
    return promise;
  }

  async downloadTrack(track, canonicalKey) {
    if (!track.streamUrl) {
      throw new Error('direct stream URL belum tersedia untuk download cache');
    }

    const baseName = sanitizeFilePart(`${canonicalKey}-${track.title || 'track'}`);
    const finalName = `${baseName}.ogg`;
    const tempName = `${baseName}.${Date.now()}.part.ogg`;
    const finalPath = path.join(config.audioCacheDir, finalName);
    const tempPath = path.join(config.audioCacheDir, tempName);
    const headers = buildHttpHeaders(track);

    const ffmpegArgs = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_on_network_error',
      '1',
      '-reconnect_on_http_error',
      '4xx,5xx',
      '-reconnect_delay_max',
      '5',
      ...(headers ? ['-headers', headers] : []),
      '-i',
      track.streamUrl,
      '-vn',
      '-sn',
      '-dn',
      '-map',
      'a?',
      '-c:a',
      'libopus',
      '-application',
      'audio',
      '-frame_duration',
      '20',
      '-compression_level',
      '10',
      '-b:a',
      `${config.audioCacheBitrateKbps}k`,
      '-vbr',
      'on',
      '-f',
      'ogg',
      '-y',
      tempPath
    ];

    const ffmpegProcess = spawn(config.ffmpegPath, ffmpegArgs, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    try {
      await waitForExit(ffmpegProcess, 'ffmpeg');

      await rm(finalPath, { force: true }).catch(() => null);
      await rename(tempPath, finalPath);
      const fileStat = await stat(finalPath);
      const entry = {
        canonicalKey,
        fileName: finalName,
        filePath: finalPath,
        sizeBytes: fileStat.size,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        track: cloneTrackMeta({
          ...track,
          canonicalKey
        })
      };

      this.index.set(canonicalKey, entry);
      await this.enforceLimits();
      await this.persistIndex();
      this.rebuildSearchIndex();
      return entry;
    } catch (error) {
      ffmpegProcess.kill('SIGKILL');
      await rm(tempPath, { force: true }).catch(() => null);
      throw error;
    }
  }

  async enforceLimits() {
    let entries = [...this.index.values()].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    let totalTracks = entries.length;
    let totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

    while (
      entries.length > 0 &&
      (totalTracks > config.audioCacheMaxTracks || totalBytes > config.audioCacheMaxSizeBytes)
    ) {
      const victim = entries.shift();
      this.index.delete(victim.canonicalKey);
      totalTracks -= 1;
      totalBytes -= victim.sizeBytes;
      await rm(victim.filePath, { force: true }).catch(() => null);
    }

    this.rebuildSearchIndex();
  }
}
