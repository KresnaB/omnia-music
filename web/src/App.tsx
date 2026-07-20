import { Component, onMount, Show, createSignal } from 'solid-js';
import { Router, Route, Navigate } from '@solidjs/router';
import { initAuth, loading, user } from './stores/auth';
import Sidebar from './components/Sidebar';
import PlayerBar from './components/PlayerBar';
import MobileNav from './components/MobileNav';
import Home from './pages/Home';
import Search from './pages/Search';
import Artists from './pages/Artists';
import Albums from './pages/Albums';
import AlbumDetail from './pages/AlbumDetail';
import Login from './pages/Login';
import Playlists from './pages/Playlists';
import PlaylistDetail from './pages/PlaylistDetail';
import History from './pages/History';

const Layout = (props: any) => {
  const [ready, setReady] = createSignal(false);
  onMount(async () => {
    await initAuth();
    setReady(true);
  });

  return (
    <Show
      when={ready()}
      fallback={<div class="loading-screen">Memuat...</div>}
    >
      <Show
        when={user()}
        fallback={<Navigate href="/login" />}
      >
        <div class="app">
          <Sidebar />
          <main class="main-content">
            {props.children}
          </main>
          <PlayerBar />
          <MobileNav />
        </div>
      </Show>
    </Show>
  );
};

const App: Component = () => {
  return (
    <Router>
      <Route path="/login" component={Login} />
      <Route path="/" component={Layout}>
        <Route path="/" component={Home} />
        <Route path="/search" component={Search} />
        <Route path="/artists" component={Artists} />
        <Route path="/albums" component={Albums} />
        <Route path="/albums/:name" component={AlbumDetail} />
        <Route path="/playlists" component={Playlists} />
        <Route path="/playlists/:id" component={PlaylistDetail} />
        <Route path="/history" component={History} />
      </Route>
    </Router>
  );
};

export default App;
