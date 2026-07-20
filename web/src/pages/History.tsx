import { Component, createSignal, onMount, Show } from 'solid-js';
import { api } from '../api/client';
import TrackList from '../components/TrackList';
import Breadcrumbs from '../components/Breadcrumbs';
import { Track } from '../stores/player';

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
        <TrackList tracks={tracks()} showIndex={false} />
      </Show>
    </div>
  );
};

export default History;
