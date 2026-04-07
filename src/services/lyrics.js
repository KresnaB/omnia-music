import { config } from '../config.js';

export class LyricsService {
  async search(trackTitle, artistName) {
    const endpoint = new URL('/api/search', config.lrclibBaseUrl);
    endpoint.searchParams.set('track_name', trackTitle);
    endpoint.searchParams.set('artist_name', artistName || '');

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
