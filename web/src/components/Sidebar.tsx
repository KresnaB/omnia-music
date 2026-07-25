import { Component, Show } from 'solid-js';
import { A, useLocation } from '@solidjs/router';
import { user, logout } from '../stores/auth';

const Sidebar: Component = () => {
  const location = useLocation();
  const isActive = (path: string) => location.pathname === path;

  return (
    <nav class="sidebar">
      <div class="sidebar-logo">
        <img src="/logo.png" alt="Omnia" style="width:28px;height:28px;border-radius:6px;" />
        <span>Omnia Music</span>
      </div>

      <div class="sidebar-nav">
        <A href="/" class="nav-item" classList={{ active: isActive('/') }}>
          <span class="material-symbols-outlined nav-icon">home</span>
          <span>Beranda</span>
        </A>
        <A href="/search" class="nav-item" classList={{ active: isActive('/search') }}>
          <span class="material-symbols-outlined nav-icon">search</span>
          <span>Cari</span>
        </A>
        <A href="/artists" class="nav-item" classList={{ active: isActive('/artists') }}>
          <span class="material-symbols-outlined nav-icon">person</span>
          <span>Artis</span>
        </A>
        <A href="/albums" class="nav-item" classList={{ active: isActive('/albums') }}>
          <span class="material-symbols-outlined nav-icon">album</span>
          <span>Album</span>
        </A>

        <Show when={user()}>
          <A href="/playlists" class="nav-item" classList={{ active: isActive('/playlists') }}>
            <span class="material-symbols-outlined nav-icon">library_music</span>
            <span>Playlist</span>
          </A>
          <A href="/history" class="nav-item" classList={{ active: isActive('/history') }}>
            <span class="material-symbols-outlined nav-icon">history</span>
            <span>Riwayat</span>
          </A>
        </Show>
      </div>

      <div class="sidebar-footer">
        <div class="user-section">
          <Show
            when={user()}
            fallback={
              <A href="/login" class="btn-login">
                Masuk
              </A>
            }
          >
            <span class="user-name"><span class="material-symbols-outlined" style="font-size:1rem;vertical-align:middle;">person</span> {user()!.username}</span>
            <button class="btn-logout" onClick={logout}>
              Keluar
            </button>
          </Show>
        </div>
      </div>
    </nav>
  );
};

export default Sidebar;
