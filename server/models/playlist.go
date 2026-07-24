package models

import (
	"omnia-music/server/database"
	"time"
)

type Playlist struct {
	ID          int            `json:"id"`
	UserID      int            `json:"user_id"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	CreatedAt   string         `json:"created_at"`
	UpdatedAt   string         `json:"updated_at"`
	TrackCount  int            `json:"track_count"`
	Tracks      []PlaylistTrack `json:"tracks,omitempty"`
}

type PlaylistTrack struct {
	ID       int    `json:"id"`
	TrackID  int    `json:"track_id"`
	Position int    `json:"position"`
	AddedAt  string `json:"added_at"`
	Track    *Track `json:"track,omitempty"`
}

func CreatePlaylist(userID int, name, description string) (*Playlist, error) {
	now := time.Now().Format(time.RFC3339)
	result, err := database.DB.Exec(
		"INSERT INTO playlists (user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		userID, name, description, now, now,
	)
	if err != nil {
		return nil, err
	}
	id, _ := result.LastInsertId()
	return &Playlist{ID: int(id), UserID: userID, Name: name, Description: description, CreatedAt: now, UpdatedAt: now}, nil
}

func GetPlaylistsByUser(userID int) ([]Playlist, error) {
	rows, err := database.DB.Query(
		`SELECT p.id, p.user_id, p.name, p.description, p.created_at, p.updated_at,
		        COALESCE((SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id), 0) AS track_count
		 FROM playlists p WHERE p.user_id = ? ORDER BY p.updated_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	playlists := []Playlist{}
	for rows.Next() {
		var p Playlist
		if err := rows.Scan(&p.ID, &p.UserID, &p.Name, &p.Description, &p.CreatedAt, &p.UpdatedAt, &p.TrackCount); err != nil {
			continue
		}
		playlists = append(playlists, p)
	}
	return playlists, nil
}

func GetPlaylistByID(id, userID int) (*Playlist, error) {
	p := &Playlist{}
	err := database.DB.QueryRow(
		"SELECT id, user_id, name, description, created_at, updated_at FROM playlists WHERE id = ? AND user_id = ?",
		id, userID,
	).Scan(&p.ID, &p.UserID, &p.Name, &p.Description, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}

	rows, err := database.DB.Query(
		`SELECT pt.id, pt.track_id, pt.position, pt.added_at,
		        t.id, t.track_id, t.title, t.artist, t.thumbnail, t.duration, t.file_name
		 FROM playlist_tracks pt JOIN tracks t ON pt.track_id = t.id
		 WHERE pt.playlist_id = ? ORDER BY pt.position`,
		id,
	)
	if err != nil {
		return p, nil
	}
	defer rows.Close()

	p.Tracks = []PlaylistTrack{}
	for rows.Next() {
		var pt PlaylistTrack
		var t Track
		if err := rows.Scan(&pt.ID, &pt.TrackID, &pt.Position, &pt.AddedAt, &t.ID, &t.TrackID, &t.Title, &t.Artist, &t.Thumbnail, &t.Duration, &t.FileName); err != nil {
			continue
		}
		pt.Track = &t
		p.Tracks = append(p.Tracks, pt)
	}
	return p, nil
}

func UpdatePlaylist(id, userID int, name, description string) error {
	now := time.Now().Format(time.RFC3339)
	_, err := database.DB.Exec(
		"UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ? AND user_id = ?",
		name, description, now, id, userID,
	)
	return err
}

func DeletePlaylist(id, userID int) error {
	_, err := database.DB.Exec("DELETE FROM playlists WHERE id = ? AND user_id = ?", id, userID)
	return err
}

func AddTrackToPlaylist(playlistID, trackID int) error {
	var maxPos int
	database.DB.QueryRow("SELECT COALESCE(MAX(position), 0) FROM playlist_tracks WHERE playlist_id = ?", playlistID).Scan(&maxPos)
	now := time.Now().Format(time.RFC3339)
	_, err := database.DB.Exec(
		"INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)",
		playlistID, trackID, maxPos+1, now,
	)
	if err != nil {
		return err
	}
	database.DB.Exec("UPDATE playlists SET updated_at = ? WHERE id = ?", now, playlistID)
	return nil
}

func RemoveTrackFromPlaylist(playlistID, trackID int) error {
	_, err := database.DB.Exec(
		"DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?",
		playlistID, trackID,
	)
	return err
}
