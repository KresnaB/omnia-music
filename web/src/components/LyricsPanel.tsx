import { Component, Show, For } from 'solid-js';
import { current, lyrics, syncedLyrics, lyricsLoading, toggleLyrics } from '../stores/player';

const LyricsPanel: Component = () => {
  return (
    <div class="lyrics-panel">
      <div class="lyrics-header">
        <div>
          <div class="lyrics-title">{current()?.title}</div>
          <div class="lyrics-artist">{current()?.normalized_artist || current()?.artist}</div>
        </div>
        <button class="btn-player" onClick={toggleLyrics}>
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <div class="lyrics-content">
        <Show
          when={!lyricsLoading()}
          fallback={<div class="lyrics-loading">Memuat lirik...</div>}
        >
          <Show
            when={lyrics()}
            fallback={
              <div class="lyrics-empty">
                <span class="material-symbols-outlined" style="font-size:3rem;color:var(--text-muted);">music_off</span>
                <div style="margin-top:12px;">Lirik tidak ditemukan</div>
              </div>
            }
          >
            <div class="lyrics-text">
              <For each={lyrics()!.split('\n')}>
                {(line) => (
                  <div class="lyrics-line">{line || <br />}</div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
};

export default LyricsPanel;
