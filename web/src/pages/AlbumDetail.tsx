import { Component, createSignal, onMount, Show } from 'solid-js';
import { useParams, useNavigate, useLocation } from '@solidjs/router';
import { api } from '../api/client';
import TrackList from '../components/TrackList';
import Breadcrumbs from '../components/Breadcrumbs';
import { Track, playTrackFromList } from '../stores/player';

const AlbumDetail: Component = () => {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation<any>();
  const [album, setAlbum] = createSignal<any>(null);
  const [loading, setLoading] = createSignal(true);

  const fromArtist = (): string | undefined => location.state?.fromArtist;

  onMount(async () => {
    try {
      const albumName = decodeURIComponent(params.name || '');
      const data = await api.getAlbum(albumName);
      setAlbum(data);
    } catch (err) {
      console.error('Failed to load album:', err);
      navigate('/albums');
    }
    setLoading(false);
  });

  const tracks = (): Track[] => {
    const a = album();
    if (!a?.tracks) return [];
    return a.tracks.map((t: any) => ({
      id: t.id,
      track_id: t.track_id || '',
      title: t.title,
      artist: t.artist || a.artist || 'Unknown',
      thumbnail: t.thumbnail || a.thumbnail || '',
      duration: t.duration || 0,
      normalized_artist: t.normalized_artist || t.artist || a.artist,
    }));
  };

  const playAll = () => {
    const t = tracks();
    if (t.length > 0) playTrackFromList(t[0], t);
  };

  return (
    <div class="page">
      <Show when={!loading() && album()} fallback={<div class="loading">Memuat...</div>}>
        <Show
          when={fromArtist()}
          fallback={
            <Breadcrumbs items={[
              { label: 'Beranda', href: '/' },
              { label: 'Album', href: '/albums' },
              { label: album()?.name || album()?.album_name || 'Unknown Album' }
            ]} />
          }
        >
          <Breadcrumbs items={[
            { label: 'Beranda', href: '/' },
            { label: 'Artis', href: '/artists' },
            { label: fromArtist()!, href: `/artists?artist=${encodeURIComponent(fromArtist()!)}` },
            { label: album()?.name || album()?.album_name || 'Unknown Album' }
          ]} />
        </Show>

        <div class="album-detail-header">
          <button class="btn-back" onClick={() => window.history.back()}>
            <span class="material-symbols-outlined" style="vertical-align:middle;">arrow_back</span> Kembali
          </button>
        </div>

        <div class="album-detail-hero">
          <img
            class="album-detail-thumb"
            src={album()?.thumbnail || ''}
            alt=""
            onError={(e) => {
              e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" fill="%23333"><rect width="200" height="200"/><text x="65" y="115" font-size="50" fill="%23666">♪</text></svg>';
            }}
          />
          <div class="album-detail-info">
            <span class="album-detail-label">ALBUM</span>
            <h1 class="album-detail-title">{album()?.name || album()?.album_name || 'Unknown Album'}</h1>
            <p class="album-detail-artist">{album()?.artist}</p>
            <p class="album-detail-meta">
              {album()?.track_count || tracks().length} lagu
            </p>
            <button class="btn-primary" style="width:auto;padding:10px 28px" onClick={playAll}>
              <span class="material-symbols-outlined icon-filled" style="font-size:1rem;vertical-align:middle;">play_arrow</span> Putar Semua
            </button>
          </div>
        </div>

        <div class="album-detail-tracks">
          <Show when={tracks().length > 0} fallback={<div class="empty-state">Tidak ada lagu di album ini</div>}>
            <TrackList tracks={tracks()} />
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default AlbumDetail;
