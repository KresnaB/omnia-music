import { Component, createSignal, onMount, For, Show } from 'solid-js';
import { useSearchParams, useNavigate } from '@solidjs/router';
import { api } from '../api/client';
import { playTrackFromList, Track } from '../stores/player';
import TrackList from '../components/TrackList';
import Breadcrumbs from '../components/Breadcrumbs';

const Artists: Component = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [artists, setArtists] = createSignal<any[]>([]);
  const [genres, setGenres] = createSignal<any[]>([]);
  const [selectedGenre, setSelectedGenre] = createSignal('');
  const [selectedArtist, setSelectedArtist] = createSignal('');
  const [tracks, setTracks] = createSignal<any[]>([]);
  const [albums, setAlbums] = createSignal<any[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [tracksLoading, setTracksLoading] = createSignal(false);
  const [albumsLoading, setAlbumsLoading] = createSignal(false);
  const [showAllTracks, setShowAllTracks] = createSignal(false);

  onMount(async () => {
    try {
      const [artistData, genreData] = await Promise.all([
        api.getArtists(),
        api.getGenres(),
      ]);
      setArtists(artistData);
      setGenres(genreData);

      const artistParam = searchParams.artist;
      if (artistParam && typeof artistParam === 'string') {
        loadArtistDetail(artistParam, false);
      }
    } catch {}
    setLoading(false);
  });

  async function loadArtistDetail(artist: string, pushUrl = true) {
    setSelectedArtist(artist);
    setShowAllTracks(false);
    setTracks([]);
    setAlbums([]);

    // Update URL so browser back works correctly
    if (pushUrl) {
      navigate(`/artists?artist=${encodeURIComponent(artist)}`, { replace: false, scroll: false });
    }

    setTracksLoading(true);
    setAlbumsLoading(true);

    try {
      const data = await api.getTracks(1, 100, undefined, artist);
      setTracks(data.tracks);
    } catch {}
    setTracksLoading(false);

    try {
      const albumData = await api.getArtistAlbums(artist);
      setAlbums(albumData);
    } catch {}
    setAlbumsLoading(false);
  }

  async function filterByGenre(genre: string) {
    setSelectedGenre(genre);
    setSelectedArtist('');
    setTracks([]);
    setAlbums([]);
    setLoading(true);
    try {
      const data = await api.getArtists(genre);
      setArtists(data);
    } catch {}
    setLoading(false);
  }

  function playAll() {
    const t = tracks();
    if (t.length > 0) {
      playTrackFromList(t[0], t);
    }
  }

  return (
    <div>
      <Show when={!selectedArtist()} fallback={
        <Breadcrumbs items={[{ label: 'Beranda', href: '/' }, { label: 'Artis', href: '/artists' }, { label: selectedArtist() }]} />
      }>
        <Breadcrumbs items={[{ label: 'Beranda', href: '/' }, { label: 'Artis' }]} />
      </Show>

      <div class="page-header">
        <div>
          <h1>Artis</h1>
          <div class="subtitle">Jelajahi berdasarkan artis dan genre</div>
        </div>
      </div>

      {/* Genre Filter */}
      <div class="genre-filter">
        <button
          class="genre-chip"
          classList={{ 'genre-chip-active': selectedGenre() === '' }}
          onClick={() => filterByGenre('')}
        >
          Semua
        </button>
        <For each={genres()}>
          {(genre) => (
            <button
              class="genre-chip"
              classList={{ 'genre-chip-active': selectedGenre() === genre.name }}
              onClick={() => filterByGenre(genre.name)}
            >
              {genre.name} ({genre.count})
            </button>
          )}
        </For>
      </div>

      <Show when={!loading()}>
        <Show
          when={!selectedArtist()}
          fallback={
            <div>
              {/* Artist header */}
              <div class="artist-header">
                <button class="btn-back" onClick={() => { setSelectedArtist(''); setTracks([]); setAlbums([]); navigate('/artists', { replace: true }); }}>
                  <span class="material-symbols-outlined" style="vertical-align:middle;">arrow_back</span> Kembali
                </button>
                <h2>{selectedArtist()}</h2>
                <button class="btn-primary" style="width:auto;padding:8px 20px" onClick={playAll}>
                  <span class="material-symbols-outlined icon-filled" style="font-size:1rem;vertical-align:middle;">play_arrow</span> Putar Semua
                </button>
              </div>

              {/* Top Songs */}
              <section class="artist-section">
                <div class="section-header">
                  <h2>Lagu Terpopuler</h2>
                </div>
                <Show when={!tracksLoading()} fallback={<div class="loading">Memuat...</div>}>
                  <Show when={tracks().length > 0} fallback={<div class="empty-state">Tidak ada lagu</div>}>
                    <TrackList
                      tracks={showAllTracks() ? tracks() : tracks().slice(0, 10)}
                      queueTracks={tracks()}
                    />
                    <Show when={!showAllTracks() && tracks().length > 10}>
                      <button class="btn-load-more" onClick={() => setShowAllTracks(true)}>
                        <span class="material-symbols-outlined">expand_more</span>
                        Lihat Semua ({tracks().length} lagu)
                      </button>
                    </Show>
                  </Show>
                </Show>
              </section>

              {/* Albums - YouTube Music style square cards */}
              <section class="artist-section">
                <div class="section-header">
                  <h2>Album</h2>
                </div>
                <Show when={!albumsLoading()} fallback={<div class="loading">Memuat...</div>}>
                  <Show when={albums().length > 0} fallback={<div class="empty-state">Tidak ada album</div>}>
                    <div class="album-grid">
                      <For each={albums()}>
                        {(album) => (
                          <div class="album-card" onClick={() => navigate(`/albums/${encodeURIComponent(album.name || album.album_name || '')}`, { state: { fromArtist: selectedArtist() } })}>
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
                  </Show>
                </Show>
              </section>
            </div>
          }
        >
          {/* Artist grid */}
          <div class="artist-grid">
            <For each={artists()}>
              {(artist) => (
                <div class="artist-card" onClick={() => loadArtistDetail(artist.name)}>
                  <img class="artist-thumb" src={artist.thumbnail} alt="" />
                  <div class="artist-name">{artist.name}</div>
                  <div class="artist-count">{artist.count} lagu</div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={loading()}>
        <div class="loading">Memuat...</div>
      </Show>
    </div>
  );
};

export default Artists;
