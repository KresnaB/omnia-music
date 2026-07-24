package models

import (
	"omnia-music/server/database"
)

type Album struct {
	Name          string `json:"name"`
	Artist        string `json:"artist"`
	Thumbnail     string `json:"thumbnail"`
	TrackCount    int    `json:"track_count"`
	TotalDuration int    `json:"total_duration"`
}

func GetAlbums(limit, offset int, minTracks int) ([]Album, error) {
	if limit < 1 {
		limit = 50
	}
	if limit > 5000 {
		limit = 5000
	}

	rows, err := database.DB.Query(
		"SELECT album, artist, thumbnail, track_count, total_duration FROM albums WHERE track_count >= ? ORDER BY track_count DESC, album ASC LIMIT ? OFFSET ?",
		minTracks, limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	albums := []Album{}
	for rows.Next() {
		var a Album
		if err := rows.Scan(&a.Name, &a.Artist, &a.Thumbnail, &a.TrackCount, &a.TotalDuration); err != nil {
			continue
		}
		albums = append(albums, a)
	}
	return albums, nil
}

func GetAlbumByName(name string) (*Album, []Track, error) {
	a := &Album{}
	var trackCount int
	err := database.DB.QueryRow(
		"SELECT album, artist, thumbnail, track_count, total_duration FROM albums WHERE album = ?",
		name,
	).Scan(&a.Name, &a.Artist, &a.Thumbnail, &trackCount, &a.TotalDuration)
	if err != nil {
		return nil, nil, err
	}
	a.TrackCount = trackCount

	rows, err := database.DB.Query(
		"SELECT id, track_id, canonical_key, file_name, title, artist, thumbnail, duration, size_bytes, source, cache_format, cache_codec, cache_bitrate FROM tracks WHERE album = ? ORDER BY title ASC",
		name,
	)
	if err != nil {
		return nil, nil, err
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
	return a, tracks, nil
}

func GetAlbumsByArtist(artist string) ([]Album, error) {
	rows, err := database.DB.Query(
		"SELECT album, artist, thumbnail, track_count, total_duration FROM albums WHERE artist = ? ORDER BY album ASC",
		artist,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	albums := []Album{}
	for rows.Next() {
		var a Album
		if err := rows.Scan(&a.Name, &a.Artist, &a.Thumbnail, &a.TrackCount, &a.TotalDuration); err != nil {
			continue
		}
		albums = append(albums, a)
	}
	return albums, nil
}
