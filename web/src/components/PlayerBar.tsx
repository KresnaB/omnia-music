import { Component, Show, createSignal, onCleanup } from 'solid-js';
import {
  current, isPlaying, currentTime, duration, volume, isMuted,
  loopMode, shuffle, autoplay, crossfade, showLyrics,
  togglePlay, seek, changeVolume, toggleMute, nextTrack, prevTrack,
  cycleLoopMode, toggleShuffle, toggleAutoplay, toggleCrossfade, toggleLyrics,
} from '../stores/player';
import LyricsPanel from './LyricsPanel';
import TrackMenu from './TrackMenu';
import DesktopFullscreenPlayer from './DesktopFullscreenPlayer';

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

const PlayerBar: Component = () => {
  let seekRef: HTMLInputElement | undefined;
  let volRef: HTMLInputElement | undefined;
  const [expanded, setExpanded] = createSignal(false);
  const [desktopExpanded, setDesktopExpanded] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuPos, setMenuPos] = createSignal({ x: 0, y: 0 });

  const seekProgress = () => {
    const d = duration();
    if (!d) return 0;
    return (currentTime() / d) * 100;
  };

  const volProgress = () => {
    return (isMuted() ? 0 : volume()) * 100;
  };

  const openMenu = (e: MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Position menu above the button, aligned to right
    const x = Math.min(rect.right, window.innerWidth - 220);
    const y = rect.top - 10;
    setMenuPos({ x, y });
    setMenuOpen(true);
  };

  const openMenuMobile = (e: MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.min(rect.left, window.innerWidth - 220);
    const y = rect.top - 200; // Position above the button
    setMenuPos({ x, y: Math.max(10, y) });
    setMenuOpen(true);
  };

  return (
    <>
      {/* Desktop fullscreen player */}
      <Show when={desktopExpanded() && current()}>
        <DesktopFullscreenPlayer onClose={() => setDesktopExpanded(false)} />
      </Show>

      <Show when={showLyrics() && current()}>
        <LyricsPanel />
      </Show>

      {/* Track context menu */}
      <Show when={menuOpen() && current()}>
        <TrackMenu
          track={current()!}
          onClose={() => setMenuOpen(false)}
          x={menuPos().x}
          y={menuPos().y}
        />
      </Show>

      {/* Mobile expanded player overlay */}
      <Show when={expanded() && current()}>
        <div class="mobile-player-expanded" onClick={() => setExpanded(false)}>
          <div class="mobile-player-expanded-inner" onClick={(e) => e.stopPropagation()}>
            <button class="mobile-player-collapse" onClick={() => setExpanded(false)}>
              <span class="material-symbols-outlined">keyboard_arrow_down</span>
            </button>
            <img class="mobile-player-expanded-thumb" src={current()!.thumbnail} alt="" />
            <div class="mobile-player-expanded-info">
              <div class="mobile-player-expanded-title">{current()!.title}</div>
              <div class="mobile-player-expanded-artist">{current()!.normalized_artist || current()!.artist}</div>
            </div>
            <div class="mobile-player-expanded-seek">
              <input
                type="range"
                class="seek-bar"
                min="0"
                max={duration() || 0}
                value={currentTime()}
                style={`--progress: ${seekProgress()}%`}
                onInput={(e) => seek(parseFloat(e.currentTarget.value))}
              />
              <div class="mobile-player-expanded-times">
                <span class="time-label">{formatTime(currentTime())}</span>
                <span class="time-label">{formatTime(duration())}</span>
              </div>
            </div>
            <div class="mobile-player-expanded-controls">
              <button
                class="btn-player"
                onClick={toggleShuffle}
                classList={{ 'btn-active': shuffle() }}
              >
                <span class="material-symbols-outlined">shuffle</span>
              </button>
              <button class="btn-player" onClick={prevTrack}>
                <span class="material-symbols-outlined">skip_previous</span>
              </button>
              <button class="btn-player btn-play-mobile" onClick={togglePlay}>
                <span class="material-symbols-outlined icon-filled">
                  {isPlaying() ? 'pause' : 'play_arrow'}
                </span>
              </button>
              <button class="btn-player" onClick={nextTrack}>
                <span class="material-symbols-outlined">skip_next</span>
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
            <div class="mobile-player-expanded-extras">
              <button
                class="btn-player"
                onClick={toggleLyrics}
                classList={{ 'btn-active': showLyrics() }}
              >
                <span class="material-symbols-outlined">lyrics</span>
              </button>
              <button
                class="btn-player"
                onClick={toggleAutoplay}
                classList={{ 'btn-active': autoplay() }}
              >
                <span class="material-symbols-outlined">bolt</span>
              </button>
              <button class="btn-player" onClick={openMenuMobile}>
                <span class="material-symbols-outlined">more_vert</span>
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
        </div>
      </Show>

      {/* Desktop player bar */}
      <div class="player-bar" classList={{ 'player-bar-empty': !current() }}>
        <Show when={current()} fallback={<div />}>
          {/* Desktop: full layout */}
          <div class="player-track-info player-track-info-clickable" onClick={() => setDesktopExpanded(true)}>
            <img class="player-thumb" src={current()!.thumbnail} alt="" />
            <div class="player-text">
              <div class="player-title">{current()!.title}</div>
              <div class="player-artist">{current()!.normalized_artist || current()!.artist}</div>
            </div>
            <button class="btn-player player-menu-btn" onClick={(e) => { e.stopPropagation(); openMenu(e); }} title="Opsi lainnya">
              <span class="material-symbols-outlined" style="font-size:1.2rem;">more_vert</span>
            </button>
          </div>

          <div class="player-controls">
            <div class="player-buttons">
              <button
                class="btn-player btn-player-desktop"
                onClick={toggleShuffle}
                classList={{ 'btn-active': shuffle() }}
                title="Shuffle"
              >
                <span class="material-symbols-outlined" style="font-size:1.2rem;">shuffle</span>
              </button>
              <button class="btn-player btn-player-desktop" onClick={prevTrack} title="Previous">
                <span class="material-symbols-outlined" style="font-size:1.3rem;">skip_previous</span>
              </button>
              <button class="btn-player btn-play" onClick={togglePlay}>
                <span class="material-symbols-outlined icon-filled" style="font-size:1.3rem;">
                  {isPlaying() ? 'pause' : 'play_arrow'}
                </span>
              </button>
              <button class="btn-player btn-player-desktop" onClick={nextTrack} title="Next">
                <span class="material-symbols-outlined" style="font-size:1.3rem;">skip_next</span>
              </button>
              <button
                class="btn-player btn-player-desktop"
                onClick={cycleLoopMode}
                classList={{ 'btn-active': loopMode() !== 'off' }}
                title={`Loop: ${loopMode()}`}
              >
                <span class="material-symbols-outlined" style="font-size:1.2rem;">
                  {loopMode() === 'one' ? 'repeat_one' : 'repeat'}
                </span>
              </button>
            </div>
            <div class="player-seek">
              <span class="time-label">{formatTime(currentTime())}</span>
              <input
                ref={seekRef}
                type="range"
                class="seek-bar"
                min="0"
                max={duration() || 0}
                value={currentTime()}
                style={`--progress: ${seekProgress()}%`}
                onInput={(e) => seek(parseFloat(e.currentTarget.value))}
              />
              <span class="time-label">{formatTime(duration())}</span>
            </div>
          </div>

          <div class="player-volume">
            <button
              class="btn-player btn-player-desktop"
              onClick={toggleCrossfade}
              classList={{ 'btn-active': crossfade() }}
              title={`Crossfade: ${crossfade() ? 'ON' : 'OFF'}`}
            >
              <span class="material-symbols-outlined" style="font-size:1.2rem;">swap_horiz</span>
            </button>
            <button
              class="btn-player btn-player-desktop"
              onClick={toggleLyrics}
              classList={{ 'btn-active': showLyrics() }}
              title="Lyrics"
            >
              <span class="material-symbols-outlined" style="font-size:1.2rem;">lyrics</span>
            </button>
            <button
              class="btn-player btn-player-desktop"
              onClick={toggleAutoplay}
              classList={{ 'btn-active': autoplay() }}
              title={`Autoplay: ${autoplay() ? 'ON' : 'OFF'}`}
            >
              <span class="material-symbols-outlined" style="font-size:1.2rem;">bolt</span>
            </button>
            <button class="btn-player vol-icon btn-player-desktop" onClick={toggleMute}>
              <span class="material-symbols-outlined" style="font-size:1.2rem;">{volIcon()}</span>
            </button>
            <input
              ref={volRef}
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

          {/* Mobile: compact inline player */}
          <div class="player-mobile-compact">
            <div class="player-mobile-compact-left" onClick={() => setDesktopExpanded(true)}>
              <img class="player-mobile-thumb" src={current()!.thumbnail} alt="" />
              <div class="player-mobile-text">
                <div class="player-title">{current()!.title}</div>
                <div class="player-artist">{current()!.normalized_artist || current()!.artist}</div>
              </div>
            </div>
            <div class="player-mobile-compact-right">
              <button class="btn-player" onClick={togglePlay}>
                <span class="material-symbols-outlined icon-filled">
                  {isPlaying() ? 'pause' : 'play_arrow'}
                </span>
              </button>
              <button class="btn-player" onClick={nextTrack}>
                <span class="material-symbols-outlined">skip_next</span>
              </button>
              <button class="btn-player" onClick={openMenuMobile}>
                <span class="material-symbols-outlined">more_vert</span>
              </button>
            </div>
            <div class="player-mobile-progress">
              <div class="player-mobile-progress-bar" style={`width: ${seekProgress()}%`} />
            </div>
          </div>
        </Show>
      </div>
    </>
  );
};

export default PlayerBar;
