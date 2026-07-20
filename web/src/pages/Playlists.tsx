import { Component, createSignal, onMount, For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { api } from '../api/client';
import Breadcrumbs from '../components/Breadcrumbs';

const Playlists: Component = () => {
  const [playlists, setPlaylists] = createSignal<any[]>([]);
  const [showCreate, setShowCreate] = createSignal(false);
  const [newName, setNewName] = createSignal('');
  const [newDesc, setNewDesc] = createSignal('');
  const [loading, setLoading] = createSignal(true);

  const load = async () => {
    setLoading(true);
    try {
      const list = await api.getPlaylists();
      setPlaylists(list);
    } catch (err) {
      console.error('Failed to load playlists:', err);
    }
    setLoading(false);
  };

  onMount(load);

  const createPlaylist = async () => {
    if (!newName()) return;
    try {
      await api.createPlaylist(newName(), newDesc());
      setNewName('');
      setNewDesc('');
      setShowCreate(false);
      load();
    } catch (err) {
      console.error('Failed to create playlist:', err);
    }
  };

  const deletePlaylist = async (id: number) => {
    if (!confirm('Hapus playlist ini?')) return;
    try {
      await api.deletePlaylist(id);
      load();
    } catch (err) {
      console.error('Failed to delete playlist:', err);
    }
  };

  return (
    <div class="page">
      <Breadcrumbs items={[{ label: 'Beranda', href: '/' }, { label: 'Playlist' }]} />

      <div class="page-header">
        <h1>Playlist Saya</h1>
        <button class="btn-primary" onClick={() => setShowCreate(!showCreate())} style="width:auto;padding:8px 20px">
          <span class="material-symbols-outlined icon-filled" style="font-size:1rem;vertical-align:middle;">add</span>
          {showCreate() ? ' Batal' : ' Buat Playlist'}
        </button>
      </div>

      <Show when={showCreate()}>
        <div class="create-form">
          <input
            type="text"
            placeholder="Nama playlist"
            value={newName()}
            onInput={(e) => setNewName(e.currentTarget.value)}
          />
          <input
            type="text"
            placeholder="Deskripsi (opsional)"
            value={newDesc()}
            onInput={(e) => setNewDesc(e.currentTarget.value)}
          />
          <button class="btn-primary" onClick={createPlaylist}>Buat</button>
        </div>
      </Show>

      {loading() && <div class="loading">Memuat...</div>}

      <Show when={!loading() && playlists().length === 0}>
        <div class="empty-state">
          Belum ada playlist. Buat playlist pertama kamu!
        </div>
      </Show>

      <div class="playlist-grid">
        <For each={playlists()}>
          {(pl) => (
            <div class="playlist-card">
              <A href={`/playlists/${pl.id}`}>
                <span class="material-symbols-outlined playlist-icon icon-filled" style="color:var(--accent);">library_music</span>
                <div class="playlist-name">{pl.name}</div>
                <div class="playlist-desc">{pl.description || 'Tanpa deskripsi'}</div>
              </A>
              <button class="btn-delete" onClick={() => deletePlaylist(pl.id)}>
                <span class="material-symbols-outlined" style="font-size:1.1rem;">delete</span>
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

export default Playlists;
