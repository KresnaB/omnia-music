import { Component, createSignal, onMount, onCleanup, For, Show } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { api } from '../api/client';
import { playTrackFromList, Track } from '../stores/player';
import { user } from '../stores/auth';
import TrackList from '../components/TrackList';

const Home: Component = () => {
  const [recentlyPlayed, setRecentlyPlayed] = createSignal<Track[]>([]);
  const [topArtists, setTopArtists] = createSignal<any[]>([]);
  const [topGenres, setTopGenres] = createSignal<any[]>([]);
  const [forYou, setForYou] = createSignal<Track[]>([]);
  const [topIndo, setTopIndo] = createSignal<Track[]>([]);
  const [topGlobal, setTopGlobal] = createSignal<Track[]>([]);
  const [playlists, setPlaylists] = createSignal<any[]>([]);
  const [loading, setLoading] = createSignal(true);
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    try {
      const [foryou, indo, global, pls] = await Promise.all([
        api.getForYou(),
        api.getTracks(1, 100, 'Indonesian', undefined, 'random'),
        api.getTracks(1, 100, undefined, undefined, 'random'),
        api.getPlaylists().catch(() => []),
      ]);

      setRecentlyPlayed(foryou.recently_played || []);
      setTopArtists(foryou.top_artists || []);
      setTopGenres(foryou.top_genres || []);
      setForYou(foryou.for_you || []);
      setTopIndo(indo.tracks);
      setTopGlobal(global.tracks);
      setPlaylists(pls);
    } catch (err) {
      console.error('Home load error:', err);
    }
    setLoading(false);
  };

  onMount(load);

  // Auto-refresh home every 5 minutes
  const refreshInterval = setInterval(load, 5 * 60 * 1000);

  const handleHistoryUpdated = () => {
    load();
  };

  // Listen for custom refresh event from player (when new track is played)
  if (typeof window !== 'undefined') {
    window.addEventListener('omnia:history-updated', handleHistoryUpdated);
  }

  onCleanup(() => {
    clearInterval(refreshInterval);
    if (typeof window !== 'undefined') {
      window.removeEventListener('omnia:history-updated', handleHistoryUpdated);
    }
  });

  const playIndo = () => { if (topIndo().length) playTrackFromList(topIndo()[0], topIndo()); };
  const playGlobal = () => { if (topGlobal().length) playTrackFromList(topGlobal()[0], topGlobal()); };
  const playForYou = () => { if (forYou().length) playTrackFromList(forYou()[0], forYou()); };
  const playRecent = () => { if (recentlyPlayed().length) playTrackFromList(recentlyPlayed()[0], recentlyPlayed()); };

  return (
    <div class="home-page">
      <Show when={!loading()} fallback={<div class="loading">Memuat...</div>}>

        {/* Personalized greeting */}
        <div class="home-greeting">
          <h1>Halo, {user()?.username} 👋</h1>
        </div>

        {/* Recently Played */}
        <Show when={recentlyPlayed().length > 0}>
          <section class="home-section">
            <div class="section-header">
              <h2><span class="material-symbols-outlined section-icon">history</span> Baru Saja Diputar</h2>
              <button class="btn-play-all" onClick={playRecent}>
                <span class="material-symbols-outlined icon-filled">play_arrow</span> Putar
              </button>
            </div>
            <TrackList tracks={recentlyPlayed().slice(0, 20)} queueTracks={recentlyPlayed()} />
          </section>
        </Show>

        {/* For You */}
        <Show when={forYou().length > 0}>
          <section class="home-section">
            <div class="section-header">
              <h2><span class="material-symbols-outlined section-icon icon-filled">auto_awesome</span> Untuk Kamu</h2>
              <button class="btn-play-all" onClick={playForYou}>
                <span class="material-symbols-outlined icon-filled">play_arrow</span> Putar
              </button>
            </div>
            <TrackList tracks={forYou().slice(0, 20)} queueTracks={forYou()} />
          </section>
        </Show>

        {/* Top Artists from History */}
        <Show when={topArtists().length > 0}>
          <section class="home-section">
            <div class="section-header">
              <h2><span class="material-symbols-outlined section-icon icon-filled">star</span> Artis Favorit</h2>
              <A href="/artists" class="section-link">Lihat Semua</A>
            </div>
            <div class="horizontal-scroll">
              <For each={topArtists()}>
                {(artist) => (
                  <div class="artist-card-h" onClick={() => navigate(`/artists?artist=${encodeURIComponent(artist.name)}`)}>
                    <img class="artist-thumb-h" src={artist.thumbnail} alt="" loading="lazy" />
                    <div class="artist-name-h">{artist.name}</div>
                    <div class="artist-count-h">{artist.count}x diputar</div>
                  </div>
                )}
              </For>
            </div>
          </section>
        </Show>

        {/* Playlists */}
        <Show when={playlists().length > 0}>
          <section class="home-section">
            <div class="section-header">
              <h2><span class="material-symbols-outlined section-icon">library_music</span> Playlist Saya</h2>
              <A href="/playlists" class="section-link">Lihat Semua</A>
            </div>
            <div class="horizontal-scroll">
              <For each={playlists()}>
                {(pl) => (
                  <A href={`/playlists/${pl.id}`} class="playlist-card-h">
                    <span class="material-symbols-outlined playlist-icon-h icon-filled">library_music</span>
                    <div class="playlist-name-h">{pl.name}</div>
                    <div class="playlist-desc-h">{pl.track_count || 0} lagu</div>
                  </A>
                )}
              </For>
            </div>
          </section>
        </Show>

        {/* Top 100 Indonesia */}
        <section class="home-section">
          <div class="section-header">
            <h2><span class="material-symbols-outlined section-icon icon-filled">flag</span> Top 100 Indonesia</h2>
            <button class="btn-play-all" onClick={playIndo}>
              <span class="material-symbols-outlined icon-filled">play_arrow</span> Putar
            </button>
          </div>
          <TrackList tracks={topIndo().slice(0, 20)} queueTracks={topIndo()} />
        </section>

        {/* Top 100 Global */}
        <section class="home-section">
          <div class="section-header">
            <h2><span class="material-symbols-outlined section-icon icon-filled">public</span> Top 100 Global</h2>
            <button class="btn-play-all" onClick={playGlobal}>
              <span class="material-symbols-outlined icon-filled">play_arrow</span> Putar
            </button>
          </div>
          <TrackList tracks={topGlobal().slice(0, 20)} queueTracks={topGlobal()} />
        </section>

      </Show>
    </div>
  );
};

export default Home;
