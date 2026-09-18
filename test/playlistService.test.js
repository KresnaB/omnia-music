import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PlaylistService, MAX_PLAYLISTS_PER_USER, MAX_TRACKS_PER_PLAYLIST } from '../src/services/playlistService.js';
import fs from 'node:fs';
import path from 'node:path';

describe('PlaylistService', () => {
  const testDbPath = path.resolve('./storage/test_playlists.db');
  let service;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    service = new PlaylistService(testDbPath);
  });

  afterEach(() => {
    service.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it('creates a playlist successfully', () => {
    const pl = service.createPlaylist('guild-1', 'user-1', 'My Favorites');
    assert.equal(pl.name, 'My Favorites');
    assert.equal(pl.guildId, 'guild-1');
    assert.equal(pl.userId, 'user-1');

    const list = service.getPlaylists('guild-1', 'user-1');
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'My Favorites');
    assert.equal(list[0].trackCount, 0);
  });

  it('rejects empty or excessively long playlist names', () => {
    assert.throws(() => service.createPlaylist('guild-1', 'user-1', ''), /1 sampai 50 karakter/);
    assert.throws(() => service.createPlaylist('guild-1', 'user-1', 'a'.repeat(51)), /1 sampai 50 karakter/);
  });

  it('rejects duplicate playlist names for same user and guild (case-insensitive)', () => {
    service.createPlaylist('guild-1', 'user-1', 'Chill');
    assert.throws(() => service.createPlaylist('guild-1', 'user-1', 'chill'), /sudah ada/);
  });

  it('allows same playlist name for different users or different guilds', () => {
    service.createPlaylist('guild-1', 'user-1', 'Rock');
    const plUser2 = service.createPlaylist('guild-1', 'user-2', 'Rock');
    const plGuild2 = service.createPlaylist('guild-2', 'user-1', 'Rock');
    assert.equal(plUser2.name, 'Rock');
    assert.equal(plGuild2.name, 'Rock');
  });

  it('enforces maximum 10 playlists per user in a guild', () => {
    for (let i = 1; i <= MAX_PLAYLISTS_PER_USER; i += 1) {
      service.createPlaylist('guild-1', 'user-1', `Playlist ${i}`);
    }
    assert.throws(
      () => service.createPlaylist('guild-1', 'user-1', 'Playlist 11'),
      /Batas maksimal 10 playlist/
    );
  });

  it('adds tracks to playlist and respects 50-track limit', () => {
    service.createPlaylist('guild-1', 'user-1', 'Pop Hits');

    for (let i = 1; i <= MAX_TRACKS_PER_PLAYLIST; i += 1) {
      const res = service.addTrack('guild-1', 'user-1', 'Pop Hits', {
        title: `Song ${i}`,
        url: `https://youtube.com/watch?v=${i}`,
        uploader: 'Artist',
        duration: 180
      });
      assert.equal(res.position, i);
      assert.equal(res.trackCount, i);
    }

    assert.throws(
      () => service.addTrack('guild-1', 'user-1', 'Pop Hits', { title: 'Over limit', url: 'http://test' }),
      /maksimal 50 lagu/
    );
  });

  it('imports playlist from tracks and caps at 50', () => {
    const fakeTracks = Array.from({ length: 60 }, (_, i) => ({
      title: `Imported Song ${i + 1}`,
      url: `https://youtube.com/watch?v=import_${i + 1}`,
      uploader: 'Various',
      duration: 200
    }));

    const result = service.importPlaylist('guild-1', 'user-1', 'Imported YouTube', fakeTracks);
    assert.equal(result.importedCount, 50);
    assert.equal(result.totalProvided, 60);

    const list = service.getPlaylistWithTracks('guild-1', 'user-1', 'Imported YouTube', { page: 1, pageSize: 20 });
    assert.equal(list.totalTracks, 50);
    assert.equal(list.tracks.length, 20);
    assert.equal(list.totalPages, 3);
  });

  it('removes track and re-indexes remaining positions', () => {
    service.createPlaylist('guild-1', 'user-1', 'My Mix');
    service.addTrack('guild-1', 'user-1', 'My Mix', { title: 'Track 1', url: 'http://1' });
    service.addTrack('guild-1', 'user-1', 'My Mix', { title: 'Track 2', url: 'http://2' });
    service.addTrack('guild-1', 'user-1', 'My Mix', { title: 'Track 3', url: 'http://3' });

    const removed = service.removeTrack('guild-1', 'user-1', 'My Mix', 2);
    assert.equal(removed.removedTrack.title, 'Track 2');
    assert.equal(removed.remainingCount, 2);

    const remaining = service.getAllTracks('guild-1', 'user-1', 'My Mix');
    assert.equal(remaining.length, 2);
    assert.equal(remaining[0].title, 'Track 1');
    assert.equal(remaining[0].position, 1);
    assert.equal(remaining[1].title, 'Track 3');
    assert.equal(remaining[1].position, 2);
  });

  it('deletes playlist and cascades tracks deletion', () => {
    service.createPlaylist('guild-1', 'user-1', 'To Delete');
    service.addTrack('guild-1', 'user-1', 'To Delete', { title: 'Track 1', url: 'http://1' });

    const deleted = service.deletePlaylist('guild-1', 'user-1', 'To Delete');
    assert.equal(deleted, true);

    const pl = service.getPlaylistWithTracks('guild-1', 'user-1', 'To Delete');
    assert.equal(pl, null);
  });

  it('safely handles unicode, emoji, and SQL injection strings', () => {
    const maliciousName = "'; DROP TABLE playlists; -- 🎵 日本語";
    const pl = service.createPlaylist('guild-1', 'user-1', maliciousName);
    assert.equal(pl.name, maliciousName);

    const trackTitle = "Track'); DELETE FROM playlist_tracks; -- 🎧";
    const addResult = service.addTrack('guild-1', 'user-1', maliciousName, {
      title: trackTitle,
      url: 'https://youtube.com/watch?v=inject',
      uploader: "O'Reilly & Associates",
      duration: 120
    });
    assert.equal(addResult.position, 1);

    const list = service.getPlaylists('guild-1', 'user-1');
    assert.equal(list.length, 1);
    assert.equal(list[0].name, maliciousName);
    assert.equal(list[0].trackCount, 1);
  });

  it('rejects invalid or out-of-bounds removeTrack positions', () => {
    service.createPlaylist('guild-1', 'user-1', 'Bounds Test');
    service.addTrack('guild-1', 'user-1', 'Bounds Test', { title: 'T1', url: 'http://1' });

    assert.throws(() => service.removeTrack('guild-1', 'user-1', 'Bounds Test', 0), /bilangan bulat positif/);
    assert.throws(() => service.removeTrack('guild-1', 'user-1', 'Bounds Test', -1), /bilangan bulat positif/);
    assert.throws(() => service.removeTrack('guild-1', 'user-1', 'Bounds Test', 2.5), /bilangan bulat positif/);
    assert.throws(() => service.removeTrack('guild-1', 'user-1', 'Bounds Test', 99), /tidak ditemukan/);
    assert.throws(() => service.removeTrack('guild-1', 'user-1', 'NonExistent', 1), /tidak ditemukan/);
  });

  it('throws error when deleting non-existent playlist', () => {
    assert.throws(() => service.deletePlaylist('guild-1', 'user-1', 'Ghost'), /tidak ditemukan/);
  });

  it('handles pagination boundary cases correctly', () => {
    service.createPlaylist('guild-1', 'user-1', 'Paging Test');
    for (let i = 1; i <= 25; i += 1) {
      service.addTrack('guild-1', 'user-1', 'Paging Test', { title: `Track ${i}`, url: `http://${i}`, duration: 100 });
    }

    // Negative or zero page clamps to 1
    const pageZero = service.getPlaylistWithTracks('guild-1', 'user-1', 'Paging Test', { page: 0, pageSize: 10 });
    assert.equal(pageZero.currentPage, 1);
    assert.equal(pageZero.tracks.length, 10);
    assert.equal(pageZero.tracks[0].position, 1);

    // Overflow page clamps to totalPages (3)
    const pageOverflow = service.getPlaylistWithTracks('guild-1', 'user-1', 'Paging Test', { page: 99, pageSize: 10 });
    assert.equal(pageOverflow.currentPage, 3);
    assert.equal(pageOverflow.tracks.length, 5);
    assert.equal(pageOverflow.tracks[0].position, 21);

    // PageSize 0 returns all tracks
    const allTracks = service.getPlaylistWithTracks('guild-1', 'user-1', 'Paging Test', { page: 1, pageSize: 0 });
    assert.equal(allTracks.tracks.length, 25);
  });

  it('handles missing optional track fields gracefully', () => {
    service.createPlaylist('guild-1', 'user-1', 'Bare Minimum');
    const res = service.addTrack('guild-1', 'user-1', 'Bare Minimum', {});
    assert.equal(res.position, 1);

    const tracks = service.getAllTracks('guild-1', 'user-1', 'Bare Minimum');
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].title, 'Unknown title');
    assert.equal(tracks[0].url, '');
    assert.equal(tracks[0].duration, 0);
    assert.equal(tracks[0].thumbnail, null);
  });

  it('rejects import with empty tracks array or non-array', () => {
    assert.throws(() => service.importPlaylist('guild-1', 'user-1', 'Empty List', []), /Tidak ada lagu/);
    assert.throws(() => service.importPlaylist('guild-1', 'user-1', 'Null List', null), /Tidak ada lagu/);
  });

  it('returns null when getting non-existent playlist tracks', () => {
    assert.equal(service.getPlaylistWithTracks('guild-1', 'user-1', 'Unknown'), null);
    assert.equal(service.getAllTracks('guild-1', 'user-1', 'Unknown'), null);
  });
});
