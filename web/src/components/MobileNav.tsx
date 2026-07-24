import { Component, Show } from 'solid-js';
import { A, useLocation } from '@solidjs/router';
import { user } from '../stores/auth';

const MobileNav: Component = () => {
  const location = useLocation();
  const isActive = (path: string) => {
    const p = location.pathname;
    if (path === '/') return p === '/';
    return p.startsWith(path);
  };

  return (
    <nav class="mobile-nav">
      <A href="/" class="mobile-nav-item" classList={{ active: isActive('/') }}>
        <span class="material-symbols-outlined">home</span>
        <span class="mobile-nav-label">Beranda</span>
      </A>
      <A href="/search" class="mobile-nav-item" classList={{ active: isActive('/search') }}>
        <span class="material-symbols-outlined">search</span>
        <span class="mobile-nav-label">Cari</span>
      </A>
      <A href="/artists" class="mobile-nav-item" classList={{ active: isActive('/artists') }}>
        <span class="material-symbols-outlined">person</span>
        <span class="mobile-nav-label">Artis</span>
      </A>
      <A href="/albums" class="mobile-nav-item" classList={{ active: isActive('/albums') }}>
        <span class="material-symbols-outlined">album</span>
        <span class="mobile-nav-label">Album</span>
      </A>
      <Show when={user()}>
        <A href="/playlists" class="mobile-nav-item" classList={{ active: isActive('/playlists') }}>
          <span class="material-symbols-outlined">library_music</span>
          <span class="mobile-nav-label">Playlist</span>
        </A>
        <A href="/history" class="mobile-nav-item" classList={{ active: isActive('/history') }}>
          <span class="material-symbols-outlined">history</span>
          <span class="mobile-nav-label">Riwayat</span>
        </A>
      </Show>
    </nav>
  );
};

export default MobileNav;
