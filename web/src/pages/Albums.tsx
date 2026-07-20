import { Component, createSignal, onMount, For, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api } from '../api/client';
import Breadcrumbs from '../components/Breadcrumbs';

const Albums: Component = () => {
  const navigate = useNavigate();
  const [albums, setAlbums] = createSignal<any[]>([]);
  const [loading, setLoading] = createSignal(true);

  onMount(async () => {
    try {
      const data = await api.getAlbums();
      setAlbums(data);
    } catch (err) {
      console.error('Failed to load albums:', err);
    }
    setLoading(false);
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

      <Show when={!loading()} fallback={<div class="loading">Memuat...</div>}>
        <Show when={albums().length > 0} fallback={<div class="empty-state">Belum ada album</div>}>
          <div class="album-grid">
            <For each={albums()}>
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
                  <div class="album-meta">{album.track_count} lagu</div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
};

export default Albums;
