import { Component, Show, For, createSignal, onMount, onCleanup } from 'solid-js';
import {
  current, queue, isPlaying, currentTime, duration, volume, isMuted,
  loopMode, shuffle, autoplay, crossfade, showLyrics,
  lyrics, lyricsLoading, syncedLyrics, fetchLyrics,
  togglePlay, seek, changeVolume, toggleMute, nextTrack, prevTrack,
  cycleLoopMode, toggleShuffle, toggleAutoplay, toggleCrossfade,
  removeFromQueue, playTrack,
} from '../stores/player';
import type { Track } from '../stores/player';
import TrackMenu from './TrackMenu';

function formatTime(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function volIcon() {
  if (isMuted() || volume() === 0) return 'volume_off';
  if (volume() < 0.5) return 'volume_down';
  return 'volume_up';
}

interface Props {
  onClose: () => void;
}

const DesktopFullscreenPlayer: Component<Props> = (props) => {
  const [activeTab, setActiveTab] = createSignal<'upnext' | 'lyrics'>('upnext');
  const [menuTrack, setMenuTrack] = createSignal<Track | null>(null);
  const [menuPos, setMenuPos] = createSignal({ x: 0, y: 0 });

  const seekProgress = () => {
    const d = duration();
    if (!d) return 0;
    return (currentTime() / d) * 100;
  };

  const volProgress = () => (isMuted() ? 0 : volume()) * 100;

  const upNextTracks = () => queue().slice(0, 30);

  const loadLyricsIfNeeded = () => {
    const cur = current();
    if (cur) fetchLyrics(cur.id);
  };

  const handleTabClick = (tab: 'upnext' | 'lyrics') => {
    setActiveTab(tab);
    if (tab === 'lyrics' && !lyrics() && !lyricsLoading()) {
      loadLyricsIfNeeded();
    }
  };

  // Re-fetch lyrics when track changes and lyrics tab is active
  const trackId = () => current()?.id;
  let prevTrackId: number | undefined;
  const checkTrackChange = () => {
    const id = trackId();
    if (id !== prevTrackId) {
      prevTrackId = id;
      if (activeTab() === 'lyrics') {
        loadLyricsIfNeeded();
      }
    }
  };

  // Keyboard: Escape to close
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };
  onMount(() => {
    document.addEventListener('keydown', handleKey);
    // Track change polling
    const interval = setInterval(checkTrackChange, 500);
    onCleanup(() => {
      document.removeEventListener('keydown', handleKey);
      clearInterval(interval);
    });
  });

  const openTrackMenu = (e: MouseEvent, track: Track) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuPos({ x: rect.right - 200, y: rect.top - 60 });
    setMenuTrack(track);
  };

  const handleRemoveFromQueue = (trackId: number) => {
    removeFromQueue(trackId);
    setMenuTrack(null);
  };

  return (
    <div class="fullscreen-player-backdrop" onClick={props.onClose}>
      <div class="fullscreen-player" onClick={(e) => e.stopPropagation()}>
        {/* Left: Now Playing */}
        <div class="fullscreen-player-left">
          <button class="fullscreen-player-close" onClick={props.onClose}>
            <span class="material-symbols-outlined">keyboard_arrow_down</span>
          </button>
          <img class="fullscreen-player-thumb" src={current()!.thumbnail} alt="" />
          <div class="fullscreen-player-info">
            <div class="fullscreen-player-title">{current()!.title}</div>
            <div class="fullscreen-player-artist">{current()!.normalized_artist || current()!.artist}</div>
          </div>
          <button
            class="btn-player fullscreen-current-menu"
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenuPos({ x: rect.right - 200, y: rect.top - 10 });
              setMenuTrack(current()!);
            }}
          >
            <span class="material-symbols-outlined">more_vert</span>
          </button>
          <div class="fullscreen-player-seek">
            <input
              type="range"
              class="seek-bar"
              min="0"
              max={duration() || 0}
              value={currentTime()}
              style={`--progress: ${seekProgress()}%`}
              onInput={(e) => seek(parseFloat(e.currentTarget.value))}
            />
            <div class="fullscreen-player-times">
              <span class="time-label">{formatTime(currentTime())}</span>
              <span class="time-label">{formatTime(duration())}</span>
            </div>
          </div>
          <div class="fullscreen-player-controls">
            <button
              class="btn-player"
              onClick={toggleShuffle}
              classList={{ 'btn-active': shuffle() }}
            >
              <span class="material-symbols-outlined">shuffle</span>
            </button>
            <button class="btn-player" onClick={prevTrack}>
              <span class="material-symbols-outlined" style="font-size:1.6rem;">skip_previous</span>
            </button>
            <button class="btn-player btn-play-fullscreen" onClick={togglePlay}>
              <span class="material-symbols-outlined icon-filled" style="font-size:2.2rem;">
                {isPlaying() ? 'pause' : 'play_arrow'}
              </span>
            </button>
            <button class="btn-player" onClick={nextTrack}>
              <span class="material-symbols-outlined" style="font-size:1.6rem;">skip_next</span>
            </button>
            <button
              class="btn-player"
              onClick={cycleLoopMode}
              classList={{ 'btn-active': loopMode() !== 'off' }}
            >
              <span class="material-symbols-outlined">
                {loopMode() === 'one' ? 'repeat_one' : 'repeat'}
              </span>
            </button>
          </div>
          <div class="fullscreen-player-extras">
            <button
              class="btn-player"
              onClick={toggleCrossfade}
              classList={{ 'btn-active': crossfade() }}
            >
              <span class="material-symbols-outlined">swap_horiz</span>
            </button>
            <button
              class="btn-player"
              onClick={toggleAutoplay}
              classList={{ 'btn-active': autoplay() }}
            >
              <span class="material-symbols-outlined">bolt</span>
            </button>
            <button class="btn-player" onClick={toggleMute}>
              <span class="material-symbols-outlined">{volIcon()}</span>
            </button>
            <input
              type="range"
              class="volume-bar"
              min="0"
              max="1"
              step="0.01"
              value={isMuted() ? 0 : volume()}
              style={`--progress: ${volProgress()}%`}
              onInput={(e) => changeVolume(parseFloat(e.currentTarget.value))}
            />
          </div>
        </div>

        {/* Right: Tabs - Up Next / Lyrics */}
        <div class="fullscreen-player-right">
          <div class="fullscreen-tabs">
            <button
              class="fullscreen-tab"
              classList={{ 'fullscreen-tab-active': activeTab() === 'upnext' }}
              onClick={() => handleTabClick('upnext')}
            >
              Up Next
            </button>
            <button
              class="fullscreen-tab"
              classList={{ 'fullscreen-tab-active': activeTab() === 'lyrics' }}
              onClick={() => handleTabClick('lyrics')}
            >
              Lyrics
            </button>
          </div>

          <div class="fullscreen-tab-content">
            <Show when={activeTab() === 'upnext'}>
              <div class="fullscreen-upnext">
                <Show when={upNextTracks().length > 0} fallback={
                  <div class="fullscreen-upnext-empty">
                    <span class="material-symbols-outlined" style="font-size:2.5rem;opacity:0.3;">queue_music</span>
                    <div style="margin-top:10px;color:var(--text-muted);">Queue kosong</div>
                  </div>
                }>
                  <For each={upNextTracks()}>
                    {(track, i) => (
                      <div class="fullscreen-upnext-row">
                        <span class="fullscreen-upnext-idx">{i() + 1}</span>
                        <img class="fullscreen-upnext-thumb" src={track.thumbnail} alt="" />
                        <div class="fullscreen-upnext-info">
                          <div class="fullscreen-upnext-title">{track.title}</div>
                          <div class="fullscreen-upnext-artist">{track.normalized_artist || track.artist}</div>
                        </div>
                        <span class="fullscreen-upnext-duration">{formatTime(track.duration)}</span>
                        <button
                          class="btn-player fullscreen-upnext-menu"
                          onClick={(e) => openTrackMenu(e, track)}
                        >
                          <span class="material-symbols-outlined">more_vert</span>
                        </button>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Show>

            <Show when={activeTab() === 'lyrics'}>
              <div class="fullscreen-lyrics">
                <Show
                  when={!lyricsLoading()}
                  fallback={
                    <div class="fullscreen-lyrics-loading">
                      <span class="material-symbols-outlined" style="font-size:2rem;animation:spin 1s linear infinite;">autorenew</span>
                      <div style="margin-top:10px;">Mencari lirik...</div>
                    </div>
                  }
                >
                  <Show
                    when={lyrics()}
                    fallback={
                      <div class="fullscreen-lyrics-empty">
                        <span class="material-symbols-outlined" style="font-size:3rem;opacity:0.3;">music_off</span>
                        <div style="margin-top:12px;">Lirik tidak ditemukan</div>
                        <button class="fullscreen-lyrics-retry" onClick={loadLyricsIfNeeded}>
                          <span class="material-symbols-outlined">refresh</span>
                          Coba Lagi
                        </button>
                      </div>
                    }
                  >
                    <div class="fullscreen-lyrics-text">
                      <For each={lyrics()!.split('\n')}>
                        {(line) => (
                          <div class="fullscreen-lyrics-line">{line || <br />}</div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>
            </Show>
          </div>
        </div>

        {/* Inline track menu for queue items */}
        <Show when={menuTrack()}>
          <div class="track-menu-backdrop" onClick={() => setMenuTrack(null)} />
          <div
            class="track-menu"
            style={{ left: `${menuPos().x}px`, top: `${menuPos().y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <button class="track-menu-item" onClick={() => handleRemoveFromQueue(menuTrack()!.id)}>
              <span class="material-symbols-outlined track-menu-icon">remove_circle_outline</span>
              Hapus dari Queue
            </button>
            <button class="track-menu-item" onClick={() => { playTrack(menuTrack()!); setMenuTrack(null); }}>
              <span class="material-symbols-outlined track-menu-icon">play_arrow</span>
              Putar Sekarang
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default DesktopFullscreenPlayer;
