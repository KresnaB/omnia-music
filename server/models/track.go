package models

import (
	"omnia-music/server/database"
)

type Track struct {
	ID           int    `json:"id"`
	TrackID      string `json:"track_id"`
	CanonicalKey string `json:"canonical_key"`
	FileName     string `json:"file_name"`
	Title        string `json:"title"`
	Artist       string `json:"artist"`
	Album        string `json:"album"`
	Thumbnail    string `json:"thumbnail"`
	Duration     int    `json:"duration"`
	SizeBytes    int64  `json:"size_bytes"`
	Source       string `json:"source"`
	CacheFormat  string `json:"cache_format"`
	CacheCodec   string `json:"cache_codec"`
	Bitrate      int    `json:"cache_bitrate"`
}

type PaginatedTracks struct {
	Tracks   []Track `json:"tracks"`
	Total    int     `json:"total"`
	Page     int     `json:"page"`
	Limit    int     `json:"limit"`
	HasMore  bool    `json:"has_more"`
}

func GetTracks(page, limit int) (*PaginatedTracks, error) {
	if page < 1 { page = 1 }
	if limit < 1 { limit = 50 }
	if limit > 100 { limit = 100 }
	offset := (page - 1) * limit

	var total int
	err := database.DB.QueryRow("SELECT COUNT(*) FROM tracks").Scan(&total)
	if err != nil {
		return nil, err
	}

	rows, err := database.DB.Query(
		"SELECT id, track_id, canonical_key, file_name, title, artist, thumbnail, duration, size_bytes, source, cache_format, cache_codec, cache_bitrate FROM tracks ORDER BY artist, title LIMIT ? OFFSET ?",
		limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tracks := []Track{}
	for rows.Next() {
		var t Track
		if err := rows.Scan(&t.ID, &t.TrackID, &t.CanonicalKey, &t.FileName, &t.Title, &t.Artist, &t.Thumbnail, &t.Duration, &t.SizeBytes, &t.Source, &t.CacheFormat, &t.CacheCodec, &t.Bitrate); err != nil {
			continue
		}
		tracks = append(tracks, t)
	}

	return &PaginatedTracks{
		Tracks:  tracks,
		Total:   total,
		Page:    page,
		Limit:   limit,
		HasMore: offset+limit < total,
	}, nil
}

func SearchTracks(query string, limit int) ([]Track, error) {
	if limit < 1 { limit = 50 }
	search := "%" + query + "%"
	rows, err := database.DB.Query(
		"SELECT id, track_id, canonical_key, file_name, title, artist, thumbnail, duration, size_bytes, source, cache_format, cache_codec, cache_bitrate FROM tracks WHERE title LIKE ? OR artist LIKE ? LIMIT ?",
		search, search, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tracks := []Track{}
	for rows.Next() {
		var t Track
		if err := rows.Scan(&t.ID, &t.TrackID, &t.CanonicalKey, &t.FileName, &t.Title, &t.Artist, &t.Thumbnail, &t.Duration, &t.SizeBytes, &t.Source, &t.CacheFormat, &t.CacheCodec, &t.Bitrate); err != nil {
			continue
		}
		tracks = append(tracks, t)
	}
	return tracks, nil
}

func GetTrackByID(id int) (*Track, error) {
	t := &Track{}
	err := database.DB.QueryRow(
		"SELECT id, track_id, canonical_key, file_name, title, artist, thumbnail, duration, size_bytes, source, cache_format, cache_codec, cache_bitrate FROM tracks WHERE id = ?",
		id,
	).Scan(&t.ID, &t.TrackID, &t.CanonicalKey, &t.FileName, &t.Title, &t.Artist, &t.Thumbnail, &t.Duration, &t.SizeBytes, &t.Source, &t.CacheFormat, &t.CacheCodec, &t.Bitrate)
	if err != nil {
		return nil, err
	}
	return t, nil
}
