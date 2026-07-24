const BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('omnia_token');
}

export function setToken(token: string) {
  localStorage.setItem('omnia_token', token);
}

export function clearToken() {
  localStorage.removeItem('omnia_token');
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    if (res.status === 401 && !path.includes('/auth/')) {
      clearToken();
      window.location.href = '/login';
      throw new Error('session expired');
    }
    const err = await res.json().catch(() => ({ error: 'request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Auth
  register: (username: string, password: string) =>
    request<{ user: any; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  login: (username: string, password: string, captchaAnswer: number, captchaToken: string) =>
    request<{ user: any; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, captcha_answer: captchaAnswer, captcha_token: captchaToken }),
    }),

  getCaptcha: () => request<{ question: string; token: string }>('/auth/captcha'),

  me: () => request<{ id: number; username: string }>('/auth/me'),

  // Tracks
  getTracks: (page = 1, limit = 50, genre?: string, artist?: string, sort?: string) => {
    let url = `/tracks?page=${page}&limit=${limit}`;
    if (genre) url += `&genre=${encodeURIComponent(genre)}`;
    if (artist) url += `&artist=${encodeURIComponent(artist)}`;
    if (sort) url += `&sort=${encodeURIComponent(sort)}`;
    return request<{ tracks: any[]; total: number; page: number; has_more: boolean }>(url);
  },

  searchTracks: (q: string, limit = 50) =>
    request<{ tracks: any[]; artists: any[]; albums: any[]; playlists: any[] }>(
      `/tracks/search?q=${encodeURIComponent(q)}&limit=${limit}`
    ),

  getTrack: (id: number) => request<any>(`/tracks/${id}`),

  streamUrl: (id: number) => {
    const token = getToken();
    return `${BASE}/tracks/${id}/stream${token ? `?token=${token}` : ''}`;
  },

  // Artists & Genres
  getArtists: (genre?: string, limit = 200) => {
    let url = `/artists?limit=${limit}`;
    if (genre) url += `&genre=${encodeURIComponent(genre)}`;
    return request<any[]>(url);
  },

  getGenres: () => request<any[]>('/genres'),

  // Recommendations
  getRecommendations: (trackId?: number, limit = 20) => {
    let url = `/tracks/recommendations?limit=${limit}`;
    if (trackId) url += `&track_id=${trackId}`;
    return request<any[]>(url);
  },

  // For You (personalized)
  getForYou: () => request<{
    recently_played: any[];
    top_artists: any[];
    top_genres: any[];
    for_you: any[];
  }>('/foryou'),

  // Lyrics
  getLyrics: (trackId: number) =>
    request<{ lyrics: string | null; synced_lyrics: string | null; track_name: string; artist_name: string }>(
      `/lyrics?track_id=${trackId}`
    ),

  // Albums
  getAlbums: (limit = 200, minTracks = 2) =>
    request<{ albums: any[] }>(`/albums?limit=${limit}&min_tracks=${minTracks}`).then(r => r.albums || []),

  getAlbum: (name: string) => request<{ album: any; tracks: any[] }>(`/albums/${encodeURIComponent(name)}`),

  getArtistAlbums: (artist: string) =>
    request<any[]>(`/artists/${encodeURIComponent(artist)}/albums`).catch(() => []),

  getSimilarArtists: (artist: string) =>
    request<any[]>(`/artists/similar?artist=${encodeURIComponent(artist)}`),

  getArtistPlaylists: (artist: string) =>
    request<any[]>(`/playlists?artist=${encodeURIComponent(artist)}`).catch(() => []),

  // Playlists
  getPlaylists: () => request<any[]>('/playlists'),

  createPlaylist: (name: string, description = '') =>
    request<any>('/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),

  getPlaylist: (id: number) => request<any>(`/playlists/${id}`),

  updatePlaylist: (id: number, name: string, description: string) =>
    request<any>(`/playlists/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, description }),
    }),

  deletePlaylist: (id: number) =>
    request<any>(`/playlists/${id}`, { method: 'DELETE' }),

  addTrackToPlaylist: (playlistId: number, trackId: number) =>
    request<any>(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ track_id: trackId }),
    }),

  removeTrackFromPlaylist: (playlistId: number, trackId: number) =>
    request<any>(`/playlists/${playlistId}/tracks/${trackId}`, {
      method: 'DELETE',
    }),

  // History
  getHistory: (limit = 100) => request<any[]>(`/history?limit=${limit}`),

  logListen: (trackId: number) =>
    request<any>('/history', {
      method: 'POST',
      body: JSON.stringify({ track_id: trackId }),
    }),

  deleteHistoryEntry: (id: number) =>
    request<any>(`/history/${id}`, { method: 'DELETE' }),

  deleteHistory: (id: number) =>
    request<any>(`/history/${id}`, { method: 'DELETE' }),
};
