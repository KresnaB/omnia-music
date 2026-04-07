import { config } from '../config.js';

const NOISE_KEYWORDS = [
  'official music video', 'music video', 'official video', 'lyric video',
  'official audio', 'audio video', 'video clip',
  'official', 'video', 'audio', 'lyrics', 'lyric', 'lirik',
  'hd', '4k', 'mv', 'hq', 'visualizer',
  'remastered', 'live', 'version', 'edit',
  'unguofficial', 'officialchannel', 'officialaccount',
  'explicit', 'clean'
];

function cleanTitle(title) {
  if (!title) return '';
  let cleaned = title.toLowerCase();

  // 1. Hapus konteks di dalam kurung biasa dan kurung siku
  cleaned = cleaned.replace(/\([^)]*\)/g, '');
  cleaned = cleaned.replace(/\[[^\]]*\]/g, '');

  // 1.5. Cutoff brutal untuk membuang partisi tag (seperti channelernya)
  if (cleaned.includes('|')) {
    cleaned = cleaned.trim().split('|')[0];
  }

  // 2. Normalisasi ampersand
  cleaned = cleaned.replace(/\s+&\s+/g, ' and ');

  // 3. Buang common noise keywords brutal
  for (const word of NOISE_KEYWORDS) {
    const rx = new RegExp(`\\b${word}\\b`, 'g');
    cleaned = cleaned.replace(rx, '');
  }

  // 4. Bersihkan double slash dan whitespace
  cleaned = cleaned.replace(/\/\//g, '-');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // 5. Buang suffix Featuring dll
  cleaned = cleaned.replace(/\b(feat|ft|featuring)\b.*/g, '');
  // Buang suffix versi di akhir baris (seperti v2.0)
  cleaned = cleaned.replace(/\b(v?\d+(\.\d+)?)\s*$/g, '');

  // 6. Buang sisa das/pipe di ujung-ujungnya
  cleaned = cleaned.replace(/\s*[-|]\s*$/g, '');
  cleaned = cleaned.replace(/^\s*[-|]\s*/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned || title;
}

export class LyricsService {
  async search(trackTitle, artistName) {
    const cleanTrack = cleanTitle(trackTitle);
    const cleanArtist = cleanTitle(artistName);

    const endpoint = new URL('/api/search', config.lrclibBaseUrl);
    endpoint.searchParams.set('track_name', cleanTrack);
    if (cleanArtist && cleanArtist !== 'unknown') {
      endpoint.searchParams.set('artist_name', cleanArtist);
    }

    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`LRCLIB returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload) || payload.length === 0) {
      throw new Error('Lyrics tidak ditemukan');
    }

    return payload[0];
  }
}
