import { Component, createSignal, onMount, Show, For } from 'solid-js';
import { api } from '../api/client';
import Breadcrumbs from '../components/Breadcrumbs';
import { Track, current, isPlaying, playTrackFromList } from '../stores/player';

function formatTime(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

const History: Component = () => {
  const [history, setHistory] = createSignal<any[]>([]);
  const [loading, setLoading] = createSignal(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.getHistory(200);
      setHistory(data);
    } catch (err) {
      console.error('Failed to load history:', err);
    }
    setLoading(false);
  };

  onMount(load);

  const deleteEntry = async (e: MouseEvent, id: number) => {
    e.stopPropagation();
    if (confirm('Hapus lagu ini dari riwayat?')) {
      try {
        await api.deleteHistory(id);
        setHistory(prev => prev.filter(h => h.id !== id));
      } catch (err) {
        console.error('Failed to delete history item:', err);
      }
    }
  };

  const tracks = (): Track[] => {
    return history().map((h: any) => ({
      id: h.track?.id || h.track_id,
      track_id: h.track?.track_id || '',
      title: h.track?.title || 'Unknown',
      artist: h.track?.artist || 'Unknown',
      thumbnail: h.track?.thumbnail || '',
      duration: h.track?.duration || 0,
      file_name: h.track?.file_name || '',
    }));
  };

  return (
    <div class="page">
      <Breadcrumbs items={[{ label: 'Beranda', href: '/' }, { label: 'Riwayat' }]} />

      <div class="page-header">
        <h1>Riwayat Dengar</h1>
        <span class="track-count">{history().length} lagu</span>
      </div>

      {loading() && <div class="loading">Memuat...</div>}

      <Show when={!loading() && history().length === 0}>
        <div class="empty-state">Belum ada riwayat dengar.</div>
      </Show>

      <Show when={!loading() && history().length > 0}>
        <div class="track-list">
          <For each={history()}>
            {(item, i) => {
              const track: Track = {
                id: item.track?.id || item.track_id,
                track_id: item.track?.track_id || '',
                title: item.track?.title || 'Unknown',
                artist: item.track?.artist || 'Unknown',
                thumbnail: item.track?.thumbnail || '',
                duration: item.track?.duration || 0,
                file_name: item.track?.file_name || '',
              };
              return (
                <div
                  class={`track-row ${current()?.id === track.id ? 'track-active' : ''}`}
                  onClick={() => playTrackFromList(track, tracks())}
                >
                  <div class="track-idx">
                    {current()?.id === track.id && isPlaying() ? (
                      <span class="material-symbols-outlined playing-icon icon-filled">equalizer</span>
                    ) : (
                      i() + 1
                    )}
                  </div>
                  <img
                    class="track-thumb"
                    src={track.thumbnail || ''}
                    alt=""
                    loading="lazy"
                    onError={(e) => (e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" fill="%23333"><rect width="40" height="40"/><text x="10" y="28" font-size="20">♪</text></svg>')}
                  />
                  <div class="track-info">
                    <div class="track-title">{track.title}</div>
                    <div class="track-artist">
                      {track.artist}
                    </div>
                  </div>
                  <button
                    class="track-menu-btn"
                    onClick={(e) => deleteEntry(e, item.id)}
                    title="Hapus dari riwayat"
                  >
                    <span class="material-symbols-outlined" style="font-size: 1.1rem; color: var(--text-muted);">delete</span>
                  </button>
                  <div class="track-duration">{formatTime(track.duration)}</div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default History;
