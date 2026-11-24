import { config } from '../config.js';

const SPOTIFY_URL_RE = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|playlist|album)\/([a-zA-Z0-9]+)/i;
const APPLE_MUSIC_URL_RE = /^https?:\/\/music\.apple\.com\/[a-z]{2}\/(song|album|playlist)\/[^?#]+/i;

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9'
};

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function extractMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match =
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i'));
  return match ? decodeHtmlEntities(match[1].trim()) : '';
}

export function parseExternalMusicUrl(input) {
  const trimmed = String(input || '').trim();
  const spotifyMatch = trimmed.match(SPOTIFY_URL_RE);
  if (spotifyMatch) {
    return {
      provider: 'spotify',
      kind: spotifyMatch[1].toLowerCase(),
      id: spotifyMatch[2],
      url: trimmed
    };
  }

  const appleMatch = trimmed.match(APPLE_MUSIC_URL_RE);
  if (appleMatch) {
    let kind = appleMatch[1].toLowerCase();
    try {
      const parsed = new URL(trimmed);
      if (kind === 'album' && parsed.searchParams.has('i')) {
        kind = 'song';
      }
    } catch {
      // Keep original kind
    }
    return {
      provider: 'apple_music',
      kind,
      id: null,
      url: trimmed
    };
  }

  return null;
}

export function isExternalMusicUrl(input) {
  return parseExternalMusicUrl(input) !== null;
}

export function extractSpotifyEmbedTracks(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return { title: '', tracks: [] };

  try {
    const data = JSON.parse(match[1]);
    const entity = data?.props?.pageProps?.state?.data?.entity;
    const title = entity?.name || entity?.title || '';
    const trackList = Array.isArray(entity?.trackList) ? entity.trackList : [];
    const tracks = trackList
      .map((item) => {
        const trackTitle = String(item?.title || '').trim();
        const artist = String(item?.subtitle || '').trim();
        if (!trackTitle) return null;
        return {
          title: trackTitle,
          artist,
          query: artist ? `${trackTitle} ${artist}` : trackTitle
        };
      })
      .filter(Boolean);
    return { title, tracks };
  } catch {
    return { title: '', tracks: [] };
  }
}

async function resolveSpotify(parsed) {
  if (parsed.kind === 'track') {
    const res = await fetch(`https://open.spotify.com/embed/track/${parsed.id}`, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10_000)
    });
    if (res.ok) {
      const html = await res.text();
      const { title, tracks } = extractSpotifyEmbedTracks(html);
      if (tracks.length > 0) {
        return {
          provider: 'spotify',
          type: 'single',
          title: tracks[0].title,
          queries: [tracks[0].query]
        };
      }
      if (title) {
        return { provider: 'spotify', type: 'single', title, queries: [title] };
      }
    }

    const oembedRes = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(parsed.url)}`, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10_000)
    });
    if (oembedRes.ok) {
      const json = await oembedRes.json();
      if (json?.title) {
        return { provider: 'spotify', type: 'single', title: json.title, queries: [json.title] };
      }
    }

    throw new Error('Gagal membaca metadata track Spotify.');
  }

  const embedUrl = `https://open.spotify.com/embed/${parsed.kind}/${parsed.id}`;
  const res = await fetch(embedUrl, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(12_000)
  });
  if (!res.ok) {
    throw new Error(`Spotify mengembalikan HTTP ${res.status}.`);
  }

  const html = await res.text();
  const { title, tracks } = extractSpotifyEmbedTracks(html);
  if (tracks.length === 0) {
    throw new Error('Tidak ada lagu yang ditemukan di playlist/album Spotify tersebut.');
  }

  return {
    provider: 'spotify',
    type: 'playlist',
    playlistTitle: title || 'Spotify Playlist',
    tracks: tracks.slice(0, config.maxPlaylistTracks)
  };
}

export function extractAppleMusicMetadata(html, kind) {
  const ogTitle = extractMeta(html, 'og:title');
  const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleTag = titleTagMatch ? decodeHtmlEntities(titleTagMatch[1].trim()) : '';

  if (kind === 'song') {
    const byMatch = titleTag.match(/^(.+?)\s+by\s+(.+?)\s+on\s+Apple Music/i);
    if (byMatch) {
      const title = byMatch[1].trim();
      const artist = byMatch[2].trim();
      return {
        provider: 'apple_music',
        type: 'single',
        title,
        queries: [`${title} ${artist}`]
      };
    }

    const cleanTitle = ogTitle.replace(/\s+on\s+Apple Music$/i, '').trim() || titleTag;
    if (!cleanTitle) {
      throw new Error('Gagal membaca metadata lagu Apple Music.');
    }
    return {
      provider: 'apple_music',
      type: 'single',
      title: cleanTitle,
      queries: [cleanTitle]
    };
  }

  const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    try {
      const parsed = JSON.parse(m[1]);
      const items = Array.isArray(parsed?.track) ? parsed.track : Array.isArray(parsed?.tracks) ? parsed.tracks : [];
      if (items.length > 0) {
        const tracks = items
          .map((item) => {
            const trackTitle = String(item?.name || '').trim();
            const artist = String(item?.byArtist?.name || parsed?.byArtist?.name || '').trim();
            if (!trackTitle) return null;
            return {
              title: trackTitle,
              artist,
              query: artist ? `${trackTitle} ${artist}` : trackTitle
            };
          })
          .filter(Boolean);
        if (tracks.length > 0) {
          return {
            provider: 'apple_music',
            type: 'playlist',
            playlistTitle: parsed?.name || ogTitle || 'Apple Music Playlist',
            tracks: tracks.slice(0, config.maxPlaylistTracks)
          };
        }
      }
    } catch {
      // Try next JSON-LD block
    }
  }

  const fallbackTitle = ogTitle.replace(/\s+on\s+Apple Music$/i, '').trim();
  if (fallbackTitle) {
    return {
      provider: 'apple_music',
      type: 'single',
      title: fallbackTitle,
      queries: [fallbackTitle]
    };
  }

  throw new Error('Gagal membaca metadata Apple Music.');
}

async function resolveAppleMusic(parsed) {
  const res = await fetch(parsed.url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(12_000)
  });
  if (!res.ok) {
    throw new Error(`Apple Music mengembalikan HTTP ${res.status}.`);
  }
  const html = await res.text();
  return extractAppleMusicMetadata(html, parsed.kind);
}

export async function resolveExternalMusicUrl(url) {
  const parsed = parseExternalMusicUrl(url);
  if (!parsed) {
    return null;
  }

  if (parsed.provider === 'spotify') {
    return resolveSpotify(parsed);
  }
  return resolveAppleMusic(parsed);
}
