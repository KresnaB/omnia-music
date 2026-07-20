import { Component, createSignal, onMount, Show } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { api } from '../api/client';
import TrackList from '../components/TrackList';
import Breadcrumbs from '../components/Breadcrumbs';
import { Track } from '../stores/player';

const PlaylistDetail: Component = () => {
  const params = useParams();
  const navigate = useNavigate();
  const [playlist, setPlaylist] = createSignal<any>(null);
  const [loading, setLoading] = createSignal(true);

  const load = async () => {
    setLoading(true);
    try {
      const pl = await api.getPlaylist(Number(params.id));
      setPlaylist(pl);
    } catch (err) {
      console.error('Failed to load playlist:', err);
      navigate('/playlists');
    }
    setLoading(false);
  };

  onMount(load);

  const removeTrack = async (trackId: number) => {
    try {
      await api.removeTrackFromPlaylist(Number(params.id), trackId);
      load();
    } catch (err) {
      console.error('Failed to remove track:', err);
    }
  };

  const tracks = (): Track[] => {
    const pl = playlist();
    if (!pl?.tracks) return [];
    return pl.tracks.map((pt: any) => ({
      id: pt.track?.id || pt.track_id,
      track_id: pt.track?.track_id || '',
      title: pt.track?.title || 'Unknown',
      artist: pt.track?.artist || 'Unknown',
      thumbnail: pt.track?.thumbnail || '',
      duration: pt.track?.duration || 0,
      file_name: pt.track?.file_name || '',
    }));
  };

  return (
    <div class="page">
      <Show when={!loading() && playlist()}>
        <Breadcrumbs items={[
          { label: 'Beranda', href: '/' },
          { label: 'Playlist', href: '/playlists' },
          { label: playlist()?.name || '' }
        ]} />

        <div class="page-header">
          <div>
            <h1>{playlist()?.name}</h1>
            <p class="subtitle">{playlist()?.description || ''}</p>
          </div>
        </div>

        <Show when={tracks().length > 0} fallback={<div class="empty-state">Playlist kosong. Tambahkan lagu dari halaman Beranda atau Cari.</div>}>
          <TrackList tracks={tracks()} />
        </Show>
      </Show>

      {loading() && <div class="loading">Memuat...</div>}
    </div>
  );
};

export default PlaylistDetail;
