import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
    canonicalKey: track.canonicalKey || canonicalizeTitle(track.title)
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
    const finalName = `${baseName}.mp3`;
    const tempName = `${baseName}.${Date.now()}.part.mp3`;
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
      'libmp3lame',
      '-b:a',
      `${config.audioCacheBitrateKbps}k`,
      '-f',
      'mp3',
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
  }
}
