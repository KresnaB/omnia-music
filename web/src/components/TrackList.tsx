import { Component, For, Show, createSignal } from 'solid-js';
import { current, isPlaying, playTrackFromList, Track } from '../stores/player';
import TrackMenu from './TrackMenu';

interface Props {
  tracks: Track[];
  showIndex?: boolean;
  showRemoveFromPlaylist?: boolean;
  playlistId?: number;
  onRemoveFromPlaylist?: (trackId: number) => void;
  queueTracks?: Track[];  // Full track list for queue (if different from displayed tracks)
}

function formatTime(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

const TrackList: Component<Props> = (props) => {
  const isActive = (track: Track) => current()?.id === track.id;
  const [menuTrack, setMenuTrack] = createSignal<Track | null>(null);
  const [menuPos, setMenuPos] = createSignal({ x: 0, y: 0 });

  const openMenu = (e: MouseEvent, track: Track) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.min(rect.right - 200, window.innerWidth - 220);
    const y = rect.bottom + 4;
    setMenuPos({ x, y });
    setMenuTrack(track);
  };

  const closeMenu = () => setMenuTrack(null);

  return (
    <div class="track-list">
      <Show when={props.tracks.length > 0} fallback={<div class="empty-state">Tidak ada lagu</div>}>
        <For each={props.tracks}>
          {(track, i) => (
            <div
              class={`track-row ${isActive(track) ? 'track-active' : ''}`}
              onClick={() => playTrackFromList(track, props.queueTracks || props.tracks)}
            >
              <div class="track-idx">
                {isActive(track) && isPlaying() ? (
                  <span class="material-symbols-outlined playing-icon icon-filled">equalizer</span>
                ) : (
                  props.showIndex !== false ? i() + 1 : ''
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
                  {track.normalized_artist || track.artist}
                  {track.is_cover && <span class="cover-badge">Cover</span>}
                </div>
              </div>
              <button
                class="track-menu-btn"
                onClick={(e) => openMenu(e, track)}
                title="Opsi lainnya"
              >
                <span class="material-symbols-outlined">more_vert</span>
              </button>
              <div class="track-duration">{formatTime(track.duration)}</div>
            </div>
          )}
        </For>
      </Show>

      <Show when={menuTrack()}>
        <TrackMenu
          track={menuTrack()!}
          x={menuPos().x}
          y={menuPos().y}
          onClose={closeMenu}
          showRemoveFromPlaylist={props.showRemoveFromPlaylist}
          playlistId={props.playlistId}
          onRemoveFromPlaylist={props.onRemoveFromPlaylist}
        />
      </Show>
    </div>
  );
};

export default TrackList;
