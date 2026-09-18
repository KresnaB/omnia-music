import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const MAX_PLAYLISTS_PER_USER = 10;
export const MAX_TRACKS_PER_PLAYLIST = 50;

export class PlaylistService {
  constructor(dbPath = config.playlistDbPath || './storage/playlists.db') {
    this.dbPath = path.resolve(dbPath);
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.init();
  }

  init() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        created_at INTEGER NOT NULL,
        UNIQUE(guild_id, user_id, name)
      );

      CREATE TABLE IF NOT EXISTS playlist_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        uploader TEXT DEFAULT '',
        duration INTEGER DEFAULT 0,
        thumbnail TEXT,
        position INTEGER NOT NULL,
        added_at INTEGER NOT NULL,
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(guild_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_pos ON playlist_tracks(playlist_id, position);
    `);
  }

  createPlaylist(guildId, userId, name) {
    const cleanName = String(name || '').trim();
    if (!cleanName || cleanName.length > 50) {
      throw new Error('Nama playlist harus antara 1 sampai 50 karakter.');
    }

    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM playlists WHERE guild_id = ? AND user_id = ?');
    const { count } = countStmt.get(guildId, userId);
    if (count >= MAX_PLAYLISTS_PER_USER) {
      throw new Error(`Batas maksimal ${MAX_PLAYLISTS_PER_USER} playlist per user tercapai.`);
    }

    const existingStmt = this.db.prepare('SELECT id FROM playlists WHERE guild_id = ? AND user_id = ? AND name = ?');
    if (existingStmt.get(guildId, userId, cleanName)) {
      throw new Error(`Playlist "${cleanName}" sudah ada.`);
    }

    const now = Date.now();
    const insertStmt = this.db.prepare('INSERT INTO playlists (guild_id, user_id, name, created_at) VALUES (?, ?, ?, ?)');
    const result = insertStmt.run(guildId, userId, cleanName, now);

    return {
      id: Number(result.lastInsertRowid),
      guildId,
      userId,
      name: cleanName,
      createdAt: now
    };
  }

  importPlaylist(guildId, userId, name, tracks) {
    const cleanName = String(name || '').trim();
    if (!cleanName || cleanName.length > 50) {
      throw new Error('Nama playlist harus antara 1 sampai 50 karakter.');
    }
    if (!Array.isArray(tracks) || tracks.length === 0) {
      throw new Error('Tidak ada lagu yang ditemukan untuk diimpor.');
    }

    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM playlists WHERE guild_id = ? AND user_id = ?');
    const { count } = countStmt.get(guildId, userId);
    if (count >= MAX_PLAYLISTS_PER_USER) {
      throw new Error(`Batas maksimal ${MAX_PLAYLISTS_PER_USER} playlist per user tercapai.`);
    }

    const existingStmt = this.db.prepare('SELECT id FROM playlists WHERE guild_id = ? AND user_id = ? AND name = ?');
    if (existingStmt.get(guildId, userId, cleanName)) {
      throw new Error(`Playlist "${cleanName}" sudah ada.`);
    }

    const tracksToInsert = tracks.slice(0, MAX_TRACKS_PER_PLAYLIST);
    const now = Date.now();

    this.db.exec('BEGIN TRANSACTION');
    try {
      const insertPlStmt = this.db.prepare('INSERT INTO playlists (guild_id, user_id, name, created_at) VALUES (?, ?, ?, ?)');
      const plResult = insertPlStmt.run(guildId, userId, cleanName, now);
      const playlistId = Number(plResult.lastInsertRowid);

      const insertTrackStmt = this.db.prepare(`
        INSERT INTO playlist_tracks (playlist_id, title, url, uploader, duration, thumbnail, position, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < tracksToInsert.length; i += 1) {
        const t = tracksToInsert[i];
        insertTrackStmt.run(
          playlistId,
          String(t.title || 'Unknown title').trim(),
          String(t.url || t.webpageUrl || '').trim(),
          String(t.uploader || '').trim(),
          Number(t.duration || 0),
          t.thumbnail || null,
          i + 1,
          now
        );
      }

      this.db.exec('COMMIT');

      return {
        id: playlistId,
        guildId,
        userId,
        name: cleanName,
        createdAt: now,
        importedCount: tracksToInsert.length,
        totalProvided: tracks.length
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  addTrack(guildId, userId, name, trackMeta) {
    const cleanName = String(name || '').trim();
    const plStmt = this.db.prepare('SELECT id FROM playlists WHERE guild_id = ? AND user_id = ? AND name = ?');
    const playlist = plStmt.get(guildId, userId, cleanName);
    if (!playlist) {
      throw new Error(`Playlist "${cleanName}" tidak ditemukan.`);
    }

    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM playlist_tracks WHERE playlist_id = ?');
    const { count } = countStmt.get(playlist.id);
    if (count >= MAX_TRACKS_PER_PLAYLIST) {
      throw new Error(`Playlist "${cleanName}" sudah penuh (maksimal ${MAX_TRACKS_PER_PLAYLIST} lagu).`);
    }

    const maxPosStmt = this.db.prepare('SELECT COALESCE(MAX(position), 0) as max_pos FROM playlist_tracks WHERE playlist_id = ?');
    const { max_pos } = maxPosStmt.get(playlist.id);
    const nextPos = max_pos + 1;
    const now = Date.now();

    const insertStmt = this.db.prepare(`
      INSERT INTO playlist_tracks (playlist_id, title, url, uploader, duration, thumbnail, position, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      playlist.id,
      String(trackMeta.title || 'Unknown title').trim(),
      String(trackMeta.url || trackMeta.webpageUrl || '').trim(),
      String(trackMeta.uploader || '').trim(),
      Number(trackMeta.duration || 0),
      trackMeta.thumbnail || null,
      nextPos,
      now
    );

    return {
      playlistId: playlist.id,
      position: nextPos,
      trackCount: count + 1
    };
  }

  getPlaylists(guildId, userId) {
    const stmt = this.db.prepare(`
      SELECT p.id, p.name, p.created_at,
             COUNT(t.id) as track_count,
             COALESCE(SUM(t.duration), 0) as total_duration
      FROM playlists p
      LEFT JOIN playlist_tracks t ON p.id = t.playlist_id
      WHERE p.guild_id = ? AND p.user_id = ?
      GROUP BY p.id
      ORDER BY p.name ASC
    `);

    return stmt.all(guildId, userId).map((row) => ({
      id: Number(row.id),
      name: row.name,
      createdAt: Number(row.created_at),
      trackCount: Number(row.track_count),
      totalDuration: Number(row.total_duration)
    }));
  }

  getPlaylistWithTracks(guildId, userId, name, { page = 1, pageSize = 10 } = {}) {
    const cleanName = String(name || '').trim();
    const plStmt = this.db.prepare('SELECT id, name, created_at FROM playlists WHERE guild_id = ? AND user_id = ? AND name = ?');
    const playlist = plStmt.get(guildId, userId, cleanName);
    if (!playlist) {
      return null;
    }

    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as total_tracks,
             COALESCE(SUM(duration), 0) as total_duration
      FROM playlist_tracks
      WHERE playlist_id = ?
    `);
    const stats = countStmt.get(playlist.id);
    const totalTracks = Number(stats.total_tracks);
    const totalDuration = Number(stats.total_duration);

    let tracks = [];
    let totalPages = 1;
    let currentPage = 1;

    if (page !== null && page !== undefined && pageSize > 0) {
      totalPages = Math.max(1, Math.ceil(totalTracks / pageSize));
      const requested = Number(page);
      currentPage = Number.isInteger(requested) ? Math.min(Math.max(1, requested), totalPages) : 1;
      const offset = (currentPage - 1) * pageSize;

      const tracksStmt = this.db.prepare(`
        SELECT id, title, url, uploader, duration, thumbnail, position, added_at
        FROM playlist_tracks
        WHERE playlist_id = ?
        ORDER BY position ASC
        LIMIT ? OFFSET ?
      `);
      tracks = tracksStmt.all(playlist.id, pageSize, offset);
    } else {
      const tracksStmt = this.db.prepare(`
        SELECT id, title, url, uploader, duration, thumbnail, position, added_at
        FROM playlist_tracks
        WHERE playlist_id = ?
        ORDER BY position ASC
      `);
      tracks = tracksStmt.all(playlist.id);
    }

    return {
      playlist: {
        id: Number(playlist.id),
        name: playlist.name,
        createdAt: Number(playlist.created_at)
      },
      totalTracks,
      totalDuration,
      totalPages,
      currentPage,
      tracks: tracks.map((t) => ({
        id: Number(t.id),
        title: t.title,
        url: t.url,
        uploader: t.uploader,
        duration: Number(t.duration),
        thumbnail: t.thumbnail,
        position: Number(t.position),
        addedAt: Number(t.added_at)
      }))
    };
  }

  getAllTracks(guildId, userId, name) {
    const cleanName = String(name || '').trim();
    const plStmt = this.db.prepare('SELECT id, name FROM playlists WHERE guild_id = ? AND user_id = ? AND name = ?');
    const playlist = plStmt.get(guildId, userId, cleanName);
    if (!playlist) {
      return null;
    }

    const stmt = this.db.prepare(`
      SELECT id, title, url, uploader, duration, thumbnail, position
      FROM playlist_tracks
      WHERE playlist_id = ?
      ORDER BY position ASC
    `);

    return stmt.all(playlist.id).map((t) => ({
      id: String(t.id),
      title: t.title,
      url: t.url,
      webpageUrl: t.url,
      uploader: t.uploader,
      duration: Number(t.duration),
      thumbnail: t.thumbnail,
      position: Number(t.position)
    }));
  }

  removeTrack(guildId, userId, name, position) {
    const cleanName = String(name || '').trim();
    const pos = Number(position);
    if (!Number.isInteger(pos) || pos <= 0) {
      throw new Error('Nomor urut lagu harus bilangan bulat positif.');
    }

    const plStmt = this.db.prepare('SELECT id FROM playlists WHERE guild_id = ? AND user_id = ? AND name = ?');
    const playlist = plStmt.get(guildId, userId, cleanName);
    if (!playlist) {
      throw new Error(`Playlist "${cleanName}" tidak ditemukan.`);
    }

    const trackStmt = this.db.prepare('SELECT id, title FROM playlist_tracks WHERE playlist_id = ? AND position = ?');
    const track = trackStmt.get(playlist.id, pos);
    if (!track) {
      throw new Error(`Lagu nomor ${pos} tidak ditemukan di playlist "${cleanName}".`);
    }

    this.db.exec('BEGIN TRANSACTION');
    try {
      this.db.prepare('DELETE FROM playlist_tracks WHERE id = ?').run(track.id);
      this.db.prepare('UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ?').run(playlist.id, pos);
      this.db.exec('COMMIT');

      const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM playlist_tracks WHERE playlist_id = ?');
      const { count } = countStmt.get(playlist.id);

      return {
        removedTrack: { id: Number(track.id), title: track.title },
        remainingCount: count
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  deletePlaylist(guildId, userId, name) {
    const cleanName = String(name || '').trim();
    const plStmt = this.db.prepare('SELECT id FROM playlists WHERE guild_id = ? AND user_id = ? AND name = ?');
    const playlist = plStmt.get(guildId, userId, cleanName);
    if (!playlist) {
      throw new Error(`Playlist "${cleanName}" tidak ditemukan.`);
    }

    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(playlist.id);
    return true;
  }

  close() {
    this.db.close();
  }
}
