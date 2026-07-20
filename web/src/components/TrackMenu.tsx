import { Component, createSignal, Show, For, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { useNavigate } from '@solidjs/router';
import { addToQueue, queue, removeFromQueue } from '../stores/player';
import { api } from '../api/client';

interface TrackMenuProps {
  track: {
    id: number;
    title: string;
    artist: string;
    normalized_artist?: string;
    thumbnail: string;
    duration: number;
  };
  onClose: () => void;
  x: number;
  y: number;
  showRemoveFromPlaylist?: boolean;
  playlistId?: number;
  onRemoveFromPlaylist?: (trackId: number) => void;
  onAddToPlaylist?: (trackId: number) => void;
}

const TrackMenu: Component<TrackMenuProps> = (props) => {
  const navigate = useNavigate();
  const [showPlaylistPicker, setShowPlaylistPicker] = createSignal(false);
  const [playlists, setPlaylists] = createSignal<any[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = createSignal(false);
  const [addingTo, setAddingTo] = createSignal<number | null>(null);
  const [addedTo, setAddedTo] = createSignal<number | null>(null);

  const handleAddToPlaylist = async () => {
    if (props.onAddToPlaylist) {
      props.onAddToPlaylist(props.track.id);
      props.onClose();
      return;
    }
    // Show playlist picker popup
    setLoadingPlaylists(true);
    setShowPlaylistPicker(true);
    try {
      const list = await api.getPlaylists();
      setPlaylists(list || []);
    } catch {
      setPlaylists([]);
    }
    setLoadingPlaylists(false);
  };

  const handleSelectPlaylist = async (playlistId: number) => {
    setAddingTo(playlistId);
    try {
      await api.addTrackToPlaylist(playlistId, props.track.id);
      setAddedTo(playlistId);
      setTimeout(() => {
        setShowPlaylistPicker(false);
        props.onClose();
      }, 800);
    } catch (err) {
      console.error('Failed to add to playlist:', err);
    }
    setAddingTo(null);
  };

  const handleRemoveFromPlaylist = () => {
    if (props.onRemoveFromPlaylist) {
      props.onRemoveFromPlaylist(props.track.id);
    }
    props.onClose();
  };

  const handlePlayNext = () => {
    addToQueue(props.track as any);
    props.onClose();
  };

  const isInQueue = () => queue().some(t => t.id === props.track.id);

  const handleRemoveFromQueue = () => {
    removeFromQueue(props.track.id);
    props.onClose();
  };

  const handleGoToArtist = () => {
    navigate(`/artists?artist=${encodeURIComponent(props.track.normalized_artist || props.track.artist)}`);
    props.onClose();
  };

  const handleGoToAlbum = () => {
    props.onClose();
  };

  return (
    <Portal>
      {/* Backdrop to close menu */}
      <div class="track-menu-backdrop" onClick={props.onClose} />
      <div
        class="track-menu"
        style={{ left: `${props.x}px`, top: `${props.y}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        <Show when={!showPlaylistPicker()}>
          <button class="track-menu-item" onClick={handleAddToPlaylist}>
            <span class="material-symbols-outlined track-menu-icon">playlist_add</span>
            Tambahkan ke Playlist
          </button>
          <Show when={props.showRemoveFromPlaylist}>
            <button class="track-menu-item" onClick={handleRemoveFromPlaylist}>
              <span class="material-symbols-outlined track-menu-icon">playlist_remove</span>
              Hapus dari Playlist
            </button>
          </Show>
          <button class="track-menu-item" onClick={handlePlayNext}>
            <span class="material-symbols-outlined track-menu-icon">skip_next</span>
            Putar Selanjutnya
          </button>
          <Show when={isInQueue()}>
            <button class="track-menu-item" onClick={handleRemoveFromQueue}>
              <span class="material-symbols-outlined track-menu-icon">remove_circle_outline</span>
              Hapus dari Queue
            </button>
          </Show>
          <button class="track-menu-item" onClick={handleGoToArtist}>
            <span class="material-symbols-outlined track-menu-icon">person</span>
            Ke Artis
          </button>
          <button class="track-menu-item" onClick={handleGoToAlbum}>
            <span class="material-symbols-outlined track-menu-icon">album</span>
            Ke Album
          </button>
        </Show>

        {/* Playlist picker sub-popup */}
        <Show when={showPlaylistPicker()}>
          <div class="playlist-picker">
            <div class="playlist-picker-header">
              <button class="playlist-picker-back" onClick={() => setShowPlaylistPicker(false)}>
                <span class="material-symbols-outlined">arrow_back</span>
              </button>
              <span>Pilih Playlist</span>
            </div>
            <Show when={!loadingPlaylists()} fallback={
              <div class="playlist-picker-loading">Memuat...</div>
            }>
              <Show when={playlists().length > 0} fallback={
                <div class="playlist-picker-empty">
                  <span class="material-symbols-outlined" style="font-size: 2rem; opacity: 0.4;">playlist_add</span>
                  <span>Belum ada playlist</span>
                  <button class="playlist-picker-create" onClick={() => {
                    props.onClose();
                    navigate('/playlists');
                  }}>Buat Playlist</button>
                </div>
              }>
                <div class="playlist-picker-list">
                  <For each={playlists()}>
                    {(pl) => (
                      <button
                        class="playlist-picker-item"
                        classList={{
                          'playlist-picker-adding': addingTo() === pl.id,
                          'playlist-picker-added': addedTo() === pl.id,
                        }}
                        onClick={() => handleSelectPlaylist(pl.id)}
                        disabled={addingTo() !== null}
                      >
                        <span class="material-symbols-outlined playlist-picker-icon">
                          {addedTo() === pl.id ? 'check_circle' : 'queue_music'}
                        </span>
                        <div class="playlist-picker-info">
                          <div class="playlist-picker-name">{pl.name}</div>
                          <div class="playlist-picker-count">{pl.track_count || 0} lagu</div>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </Show>
      </div>
    </Portal>
  );
};

export default TrackMenu;
