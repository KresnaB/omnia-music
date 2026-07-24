import { Component, createSignal, createMemo, onMount, For, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api } from '../api/client';
import Breadcrumbs from '../components/Breadcrumbs';

const formatDuration = (seconds: number): string => {
  if (!seconds || seconds <= 0) return '';
  const totalMins = Math.round(seconds / 60);
  if (totalMins <= 0) return '1 menit';
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) {
    return mins > 0 ? `${hours} jam ${mins} menit` : `${hours} jam`;
  }
  return `${mins} menit`;
};

const Albums: Component = () => {
  const navigate = useNavigate();
  const [albums, setAlbums] = createSignal<any[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [searchQuery, setSearchQuery] = createSignal('');

  onMount(async () => {
    try {
      const data = await api.getAlbums();
      setAlbums(data);
    } catch (err) {
      console.error('Failed to load albums:', err);
    }
    setLoading(false);
  });

  const filteredAlbums = createMemo(() => {
    const q = searchQuery().toLowerCase().trim();
    if (!q) return albums();
    return albums().filter((album) => {
      const name = (album.name || album.album_name || '').toLowerCase();
      const artist = (album.artist || '').toLowerCase();
      return name.includes(q) || artist.includes(q);
    });
  });

  return (
    <div class="page">
      <Breadcrumbs items={[{ label: 'Beranda', href: '/' }, { label: 'Album' }]} />

      <div class="page-header">
        <div>
          <h1>Album</h1>
          <div class="subtitle">Jelajahi album musik</div>
        </div>
      </div>

      <div class="search-box">
        <span class="material-symbols-outlined search-icon">search</span>
        <input
          type="text"
          placeholder="Cari album atau artis..."
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />
      </div>

      <Show when={!loading()} fallback={<div class="loading">Memuat...</div>}>
        <Show when={albums().length > 0} fallback={<div class="empty-state">Belum ada album</div>}>
          <Show when={filteredAlbums().length > 0} fallback={<div class="empty-state">Album tidak ditemukan</div>}>
            <div class="album-grid">
              <For each={filteredAlbums()}>
                {(album) => (
                  <div class="album-card" onClick={() => navigate(`/albums/${encodeURIComponent(album.name || album.album_name)}`)}>
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
                    <div class="album-meta">
                      {album.track_count} lagu{formatDuration(album.total_duration) ? ` · ${formatDuration(album.total_duration)}` : ''}
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

export default Albums;
