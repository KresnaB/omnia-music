import { Component, createSignal, createEffect, For, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api } from '../api/client';
import TrackList from '../components/TrackList';
import Breadcrumbs from '../components/Breadcrumbs';
import { Track, playTrackFromList } from '../stores/player';

type Tab = 'songs' | 'artists' | 'albums' | 'playlists';

const Search: Component = () => {
  const navigate = useNavigate();
  const [query, setQuery] = createSignal('');
  const [activeTab, setActiveTab] = createSignal<Tab>('songs');
  const [loading, setLoading] = createSignal(false);
  const [searched, setSearched] = createSignal(false);

  const [songResults, setSongResults] = createSignal<Track[]>([]);
  const [artistResults, setArtistResults] = createSignal<any[]>([]);
  const [albumResults, setAlbumResults] = createSignal<any[]>([]);
  const [playlistResults, setPlaylistResults] = createSignal<any[]>([]);

  let debounceTimer: ReturnType<typeof setTimeout>;

  const doSearch = async (q: string) => {
    if (q.length < 2) {
      setSongResults([]);
      setArtistResults([]);
      setAlbumResults([]);
      setPlaylistResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const result = await api.searchTracks(q);
      setSongResults(result.tracks || []);
      setArtistResults(result.artists || []);
      setAlbumResults(result.albums || []);
      setPlaylistResults(result.playlists || []);
    } catch (err) {
      console.error('Search failed:', err);
      setSongResults([]);
      setArtistResults([]);
      setAlbumResults([]);
      setPlaylistResults([]);
    }
    setLoading(false);
  };

  const onInput = (value: string) => {
    setQuery(value);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => doSearch(value), 300);
  };

  const tabs: { key: Tab; label: string; count: number }[] = [];

  // Dynamic tabs with counts
  const getTabs = () => {
    const t: { key: Tab; label: string }[] = [];
    if (songResults().length > 0) t.push({ key: 'songs', label: `Lagu (${songResults().length})` });
    if (artistResults().length > 0) t.push({ key: 'artists', label: `Artis (${artistResults().length})` });
    if (albumResults().length > 0) t.push({ key: 'albums', label: `Album (${albumResults().length})` });
    if (playlistResults().length > 0) t.push({ key: 'playlists', label: `Playlist (${playlistResults().length})` });
    return t;
  };

  return (
    <div class="page">
      <Breadcrumbs items={[{ label: 'Beranda', href: '/' }, { label: 'Cari' }]} />

      <div class="page-header">
        <h1>Cari Musik</h1>
      </div>

      <div class="search-box">
        <span class="material-symbols-outlined search-icon">search</span>
        <input
          type="text"
          placeholder="Cari lagu, artis, album, atau playlist..."
          value={query()}
          onInput={(e) => onInput(e.currentTarget.value)}
          autofocus
        />
      </div>

      <Show when={searched() && !loading()}>
        <div class="search-tabs">
          <For each={getTabs()}>
            {(tab) => (
              <button
                class="search-tab"
                classList={{ 'search-tab-active': activeTab() === tab.key }}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      {loading() && <div class="loading">Mencari...</div>}

      <Show when={!loading() && searched() && songResults().length === 0 && artistResults().length === 0 && albumResults().length === 0 && playlistResults().length === 0}>
        <div class="empty-state">Tidak ditemukan hasil untuk "{query()}"</div>
      </Show>

      {/* Songs tab */}
      <Show when={!loading() && searched() && activeTab() === 'songs' && songResults().length > 0}>
        <div class="search-results">
          <TrackList tracks={songResults()} />
        </div>
      </Show>

      {/* Artists tab */}
      <Show when={!loading() && searched() && activeTab() === 'artists' && artistResults().length > 0}>
        <div class="search-results">
          <div class="artist-grid">
            <For each={artistResults()}>
              {(artist) => (
                <div class="artist-card" onClick={() => navigate(`/artists?artist=${encodeURIComponent(artist.name)}`)}>
                  <img class="artist-thumb" src={artist.thumbnail} alt="" loading="lazy" />
                  <div class="artist-name">{artist.name}</div>
                  <div class="artist-count">{artist.count} lagu</div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Albums tab */}
      <Show when={!loading() && searched() && activeTab() === 'albums' && albumResults().length > 0}>
        <div class="search-results">
          <div class="album-grid">
            <For each={albumResults()}>
              {(album) => (
                <div class="album-card" onClick={() => navigate(`/albums/${encodeURIComponent(album.name || album.album_name || '')}`)}>
                  <img
                    class="album-thumb"
                    src={album.thumbnail || ''}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" fill="%23333"><rect width="160" height="160"/><text x="50" y="90" font-size="40" fill="%23666">♪</text></svg>';
                    }}
                  />
                  <div class="album-name">{album.name || album.album_name || 'Unknown Album'}</div>
                  <div class="album-artist">{album.artist}</div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Playlists tab */}
      <Show when={!loading() && searched() && activeTab() === 'playlists' && playlistResults().length > 0}>
        <div class="search-results">
          <div class="playlist-grid">
            <For each={playlistResults()}>
              {(pl) => (
                <div class="playlist-card" onClick={() => navigate(`/playlists/${pl.id}`)}>
                  <span class="material-symbols-outlined playlist-icon icon-filled">library_music</span>
                  <div class="playlist-name">{pl.name}</div>
                  <div class="playlist-desc">{pl.track_count || 0} lagu</div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default Search;
