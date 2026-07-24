import { Component, createSignal, onMount, Show } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { api } from '../api/client';
import TrackList from '../components/TrackList';
import Breadcrumbs from '../components/Breadcrumbs';
import { Track, playTrackFromList } from '../stores/player';

const PlaylistDetail: Component = () => {
  const params = useParams();
  const navigate = useNavigate();
  const [playlist, setPlaylist] = createSignal<any>(null);
  const [loading, setLoading] = createSignal(true);
  const [isEditing, setIsEditing] = createSignal(false);
  const [editName, setEditName] = createSignal('');
  const [saving, setSaving] = createSignal(false);

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

  const playAll = () => {
    const t = tracks();
    if (t.length > 0) playTrackFromList(t[0], t);
  };

  const handleSaveName = async () => {
    const newName = editName().trim();
    if (!newName) return;
    setSaving(true);
    try {
      await api.updatePlaylist(Number(params.id), newName, playlist()?.description || '');
      setPlaylist((prev: any) => ({ ...prev, name: newName }));
      setIsEditing(false);
    } catch (err) {
      console.error('Failed to update playlist name:', err);
    }
    setSaving(false);
  };

  return (
    <div class="page">
      <Show when={!loading() && playlist()}>
        <Breadcrumbs items={[
          { label: 'Beranda', href: '/' },
          { label: 'Playlist', href: '/playlists' },
          { label: playlist()?.name || '' }
        ]} />

        <div class="page-header" style="align-items: flex-start;">
          <div>
            <Show
              when={isEditing()}
              fallback={
                <div style="display: flex; align-items: center; gap: 8px;">
                  <h1>{playlist()?.name}</h1>
                  <button
                    class="btn-icon"
                    style="background: none; border: none; color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; padding: 4px;"
                    onClick={() => { setEditName(playlist()?.name || ''); setIsEditing(true); }}
                    title="Edit Nama Playlist"
                  >
                    <span class="material-symbols-outlined" style="font-size: 1.2rem;">edit</span>
                  </button>
                </div>
              }
            >
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <input
                  type="text"
                  style="background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text-primary); font-size: 1.2rem; font-weight: bold; padding: 6px 12px; border-radius: 6px; outline: none;"
                  value={editName()}
                  onInput={(e) => setEditName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveName();
                    if (e.key === 'Escape') setIsEditing(false);
                  }}
                />
                <button
                  class="btn-primary"
                  style="width: auto; padding: 6px 16px; font-size: 0.85rem;"
                  onClick={handleSaveName}
                  disabled={saving()}
                >
                  Simpan
                </button>
                <button
                  class="btn-logout"
                  style="width: auto; padding: 6px 16px; font-size: 0.85rem;"
                  onClick={() => setIsEditing(false)}
                >
                  Batal
                </button>
              </div>
            </Show>
            <p class="subtitle">{playlist()?.description || ''}</p>
          </div>

          <Show when={tracks().length > 0}>
            <button class="btn-primary" style="width:auto;padding:10px 28px" onClick={playAll}>
              <span class="material-symbols-outlined icon-filled" style="font-size:1rem;vertical-align:middle;">play_arrow</span> Putar Semua
            </button>
          </Show>
        </div>

        <Show when={tracks().length > 0} fallback={<div class="empty-state">Playlist kosong. Tambahkan lagu dari halaman Beranda atau Cari.</div>}>
          <TrackList
            tracks={tracks()}
            showRemoveFromPlaylist={true}
            playlistId={Number(params.id)}
            onRemoveFromPlaylist={removeTrack}
          />
        </Show>
      </Show>

      {loading() && <div class="loading">Memuat...</div>}
    </div>
  );
};

export default PlaylistDetail;
