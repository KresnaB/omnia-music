package models

import (
	"omnia-music/server/database"
	"time"
)

type HistoryEntry struct {
	ID         int    `json:"id"`
	UserID     int    `json:"user_id"`
	TrackID    int    `json:"track_id"`
	ListenedAt string `json:"listened_at"`
	Track      *Track `json:"track,omitempty"`
}

func LogListen(userID, trackID int) error {
	now := time.Now().Format(time.RFC3339)
	_, err := database.DB.Exec(
		"INSERT INTO history (user_id, track_id, listened_at) VALUES (?, ?, ?)",
		userID, trackID, now,
	)
	return err
}

func GetHistory(userID, limit int) ([]HistoryEntry, error) {
	if limit < 1 { limit = 50 }
	rows, err := database.DB.Query(
		`SELECT h.id, h.user_id, h.track_id, h.listened_at,
		        t.id, t.track_id, t.title, t.artist, t.thumbnail, t.duration, t.file_name
		 FROM history h JOIN tracks t ON h.track_id = t.id
		 WHERE h.user_id = ? ORDER BY h.listened_at DESC LIMIT ?`,
		userID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	entries := []HistoryEntry{}
	for rows.Next() {
		var h HistoryEntry
		var t Track
		if err := rows.Scan(&h.ID, &h.UserID, &h.TrackID, &h.ListenedAt, &t.ID, &t.TrackID, &t.Title, &t.Artist, &t.Thumbnail, &t.Duration, &t.FileName); err != nil {
			continue
		}
		h.Track = &t
		entries = append(entries, h)
	}
	return entries, nil
}

func DeleteHistoryEntry(id, userID int) error {
	_, err := database.DB.Exec("DELETE FROM history WHERE id = ? AND user_id = ?", id, userID)
	return err
}
