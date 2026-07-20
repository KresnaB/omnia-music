package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"omnia-music/server/database"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
)

var AudioPath string
var IndexPath string

func GetTracks(c *fiber.Ctx) error {
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	genre := c.Query("genre", "")
	artist := c.Query("artist", "")
	sort := c.Query("sort", "")

	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 50
	}
	offset := (page - 1) * limit

	orderBy := "ORDER BY id"
	if sort == "random" {
		orderBy = "ORDER BY RANDOM()"
	}

	where := "WHERE 1=1"
	args := []interface{}{}

	if genre != "" {
		where += " AND genre = ?"
		args = append(args, genre)
	}
	if artist != "" {
		where += " AND normalized_artist = ?"
		args = append(args, artist)
	}

	var total int
	countQuery := "SELECT COUNT(*) FROM tracks " + where
	database.DB.QueryRow(countQuery, args...).Scan(&total)

	query := fmt.Sprintf("SELECT id, track_id, canonical_key, file_name, title, artist, normalized_artist, genre, is_cover, thumbnail, duration, size_bytes, source, cache_format, cache_codec, cache_bitrate FROM tracks %s %s LIMIT ? OFFSET ?", where, orderBy)
	args = append(args, limit, offset)

	rows, err := database.DB.Query(query, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "database error"})
	}
	defer rows.Close()

	tracks := []fiber.Map{}
	for rows.Next() {
		var id int
		var trackID, canonicalKey, fileName, title, artistName, normalizedArtist, genre, thumbnail, source, cacheFormat, cacheCodec string
		var duration, cacheBitrate int
		var sizeBytes int64
		var isCover int

		rows.Scan(&id, &trackID, &canonicalKey, &fileName, &title, &artistName, &normalizedArtist, &genre, &isCover, &thumbnail, &duration, &sizeBytes, &source, &cacheFormat, &cacheCodec, &cacheBitrate)

		tracks = append(tracks, fiber.Map{
			"id":                id,
			"track_id":          trackID,
			"canonical_key":     canonicalKey,
			"file_name":         fileName,
			"title":             title,
			"artist":            artistName,
			"normalized_artist": normalizedArtist,
			"genre":             genre,
			"is_cover":          isCover == 1,
			"thumbnail":         thumbnail,
			"duration":          duration,
			"size_bytes":        sizeBytes,
			"source":            source,
			"cache_format":      cacheFormat,
			"cache_codec":       cacheCodec,
			"cache_bitrate":     cacheBitrate,
		})
	}

	return c.JSON(fiber.Map{
		"tracks":   tracks,
		"total":    total,
		"page":     page,
		"limit":    limit,
		"has_more": offset+limit < total,
	})
}

func SearchTracks(c *fiber.Ctx) error {
	q := c.Query("q", "")
	limit, _ := strconv.Atoi(c.Query("limit", "50"))

	if q == "" {
		return c.JSON(fiber.Map{
			"tracks":    []interface{}{},
			"artists":   []interface{}{},
			"albums":    []interface{}{},
			"playlists": []interface{}{},
		})
	}

	searchQ := "%" + strings.ToLower(q) + "%"

	// 1. Search tracks
	rows, err := database.DB.Query(
		"SELECT id, track_id, canonical_key, file_name, title, artist, normalized_artist, genre, is_cover, thumbnail, duration, size_bytes, source, cache_format, cache_codec, cache_bitrate FROM tracks WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(normalized_artist) LIKE ? LIMIT ?",
		searchQ, searchQ, searchQ, limit,
	)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "database error"})
	}
	defer rows.Close()

	tracks := []fiber.Map{}
	for rows.Next() {
		var id int
		var trackID, canonicalKey, fileName, title, artistName, normalizedArtist, genre, thumbnail, source, cacheFormat, cacheCodec string
		var duration, cacheBitrate int
		var sizeBytes int64
		var isCover int

		rows.Scan(&id, &trackID, &canonicalKey, &fileName, &title, &artistName, &normalizedArtist, &genre, &isCover, &thumbnail, &duration, &sizeBytes, &source, &cacheFormat, &cacheCodec, &cacheBitrate)

		tracks = append(tracks, fiber.Map{
			"id":                id,
			"track_id":          trackID,
			"canonical_key":     canonicalKey,
			"file_name":         fileName,
			"title":             title,
			"artist":            artistName,
			"normalized_artist": normalizedArtist,
			"genre":             genre,
			"is_cover":          isCover == 1,
			"thumbnail":         thumbnail,
			"duration":          duration,
			"size_bytes":        sizeBytes,
			"source":            source,
			"cache_format":      cacheFormat,
			"cache_codec":       cacheCodec,
			"cache_bitrate":     cacheBitrate,
		})
	}

	// 2. Search artists (normalized_artist)
	artistRows, err := database.DB.Query(
		`SELECT normalized_artist, COUNT(*) as track_count, MIN(thumbnail) as thumbnail
		 FROM tracks
		 WHERE LOWER(normalized_artist) LIKE ?
		 GROUP BY normalized_artist
		 ORDER BY track_count DESC
		 LIMIT 10`, searchQ)
	artists := []fiber.Map{}
	if err == nil {
		defer artistRows.Close()
		for artistRows.Next() {
			var name, thumbnail string
			var count int
			artistRows.Scan(&name, &count, &thumbnail)
			artists = append(artists, fiber.Map{
				"name":      name,
				"count":     count,
				"thumbnail": thumbnail,
			})
		}
	}

	// 3. Search albums
	albumRows, err := database.DB.Query(
		`SELECT album, artist, thumbnail, track_count, total_duration
		 FROM albums
		 WHERE LOWER(album) LIKE ? OR LOWER(artist) LIKE ?
		 LIMIT 10`, searchQ, searchQ)
	albums := []fiber.Map{}
	if err == nil {
		defer albumRows.Close()
		for albumRows.Next() {
			var name, artistName, thumbnail string
			var trackCount, totalDuration int
			albumRows.Scan(&name, &artistName, &thumbnail, &trackCount, &totalDuration)
			albums = append(albums, fiber.Map{
				"name":           name,
				"artist":         artistName,
				"thumbnail":      thumbnail,
				"track_count":    trackCount,
				"total_duration": totalDuration,
			})
		}
	}

	// 4. Search playlists (user-specific)
	userID := c.Locals("user_id").(int)
	playlistRows, err := database.DB.Query(
		"SELECT id, name, description, created_at, updated_at FROM playlists WHERE user_id = ? AND LOWER(name) LIKE ? LIMIT 10",
		userID, searchQ)
	playlists := []fiber.Map{}
	if err == nil {
		defer playlistRows.Close()
		for playlistRows.Next() {
			var id int
			var name, description, createdAt, updatedAt string
			playlistRows.Scan(&id, &name, &description, &createdAt, &updatedAt)
			playlists = append(playlists, fiber.Map{
				"id":          id,
				"name":        name,
				"description": description,
				"created_at":  createdAt,
				"updated_at":  updatedAt,
			})
		}
	}

	return c.JSON(fiber.Map{
		"tracks":    tracks,
		"artists":   artists,
		"albums":    albums,
		"playlists": playlists,
	})
}

func GetTrack(c *fiber.Ctx) error {
	id, err := strconv.Atoi(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid track id"})
	}

	var trackID, canonicalKey, fileName, title, artistName, normalizedArtist, genre, thumbnail, source, cacheFormat, cacheCodec string
	var duration, cacheBitrate int
	var sizeBytes int64
	var isCover int

	err = database.DB.QueryRow(
		"SELECT id, track_id, canonical_key, file_name, title, artist, normalized_artist, genre, is_cover, thumbnail, duration, size_bytes, source, cache_format, cache_codec, cache_bitrate FROM tracks WHERE id = ?",
		id,
	).Scan(&id, &trackID, &canonicalKey, &fileName, &title, &artistName, &normalizedArtist, &genre, &isCover, &thumbnail, &duration, &sizeBytes, &source, &cacheFormat, &cacheCodec, &cacheBitrate)

	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "track not found"})
	}

	return c.JSON(fiber.Map{
		"id":                id,
		"track_id":          trackID,
		"canonical_key":     canonicalKey,
		"file_name":         fileName,
		"title":             title,
		"artist":            artistName,
		"normalized_artist": normalizedArtist,
		"genre":             genre,
		"is_cover":          isCover == 1,
		"thumbnail":         thumbnail,
		"duration":          duration,
		"size_bytes":        sizeBytes,
		"source":            source,
		"cache_format":      cacheFormat,
		"cache_codec":       cacheCodec,
		"cache_bitrate":     cacheBitrate,
	})
}

func StreamTrack(c *fiber.Ctx) error {
	id, err := strconv.Atoi(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid track id"})
	}

	var fileName string
	err = database.DB.QueryRow("SELECT file_name FROM tracks WHERE id = ?", id).Scan(&fileName)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "track not found"})
	}

	filePath := filepath.Join(AudioPath, fileName)
	_, err = os.Stat(filePath)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "audio file not found"})
	}

	c.Set("Content-Type", "audio/ogg")
	c.Set("Accept-Ranges", "bytes")
	c.Set("Cache-Control", "public, max-age=86400")

	return c.SendFile(filePath)
}

// GetArtists returns unique normalized artists with track counts
func GetArtists(c *fiber.Ctx) error {
	genre := c.Query("genre", "")
	limit, _ := strconv.Atoi(c.Query("limit", "200"))

	where := "WHERE normalized_artist != ''"
	args := []interface{}{}

	if genre != "" {
		where += " AND genre = ?"
		args = append(args, genre)
	}

	query := fmt.Sprintf(`
		SELECT normalized_artist, COUNT(*) as track_count, 
			MIN(thumbnail) as thumbnail
		FROM tracks %s 
		GROUP BY normalized_artist 
		HAVING track_count >= 1
		ORDER BY track_count DESC 
		LIMIT ?`, where)
	args = append(args, limit)

	rows, err := database.DB.Query(query, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "database error"})
	}
	defer rows.Close()

	artists := []fiber.Map{}
	for rows.Next() {
		var name, thumbnail string
		var count int
		rows.Scan(&name, &count, &thumbnail)
		artists = append(artists, fiber.Map{
			"name":      name,
			"count":     count,
			"thumbnail": thumbnail,
		})
	}

	return c.JSON(artists)
}

// GetGenres returns unique genres with track counts
func GetGenres(c *fiber.Ctx) error {
	rows, err := database.DB.Query(`
		SELECT genre, COUNT(*) as track_count 
		FROM tracks 
		GROUP BY genre 
		HAVING track_count >= 1
		ORDER BY track_count DESC`)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "database error"})
	}
	defer rows.Close()

	genres := []fiber.Map{}
	for rows.Next() {
		var genre string
		var count int
		rows.Scan(&genre, &count)
		genres = append(genres, fiber.Map{
			"name":  genre,
			"count": count,
		})
	}

	return c.JSON(genres)
}

// GetRecommendations returns recommended tracks based on current track
func GetRecommendations(c *fiber.Ctx) error {
	trackID, _ := strconv.Atoi(c.Query("track_id", "0"))
	limit, _ := strconv.Atoi(c.Query("limit", "20"))

	if trackID == 0 {
		// Random tracks if no seed
		rows, err := database.DB.Query(
			"SELECT id, track_id, title, artist, normalized_artist, genre, is_cover, thumbnail, duration FROM tracks ORDER BY RANDOM() LIMIT ?", limit)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "database error"})
		}
		defer rows.Close()
		return c.JSON(scanTrackRows(rows))
	}

	// Get current track info
	var artist, normalizedArtist, genre string
	err := database.DB.QueryRow(
		"SELECT artist, normalized_artist, genre FROM tracks WHERE id = ?", trackID,
	).Scan(&artist, &normalizedArtist, &genre)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "track not found"})
	}

	// Priority 1: Same normalized artist (25%)
	// Priority 2: Same genre (50%)
	// Priority 3: Random (25%)
	artistLimit := limit / 4
	genreLimit := limit / 2
	randomLimit := limit - artistLimit - genreLimit

	tracks := []fiber.Map{}

	// Same artist tracks
	if normalizedArtist != "" {
		rows, _ := database.DB.Query(
			"SELECT id, track_id, title, artist, normalized_artist, genre, is_cover, thumbnail, duration FROM tracks WHERE normalized_artist = ? AND id != ? ORDER BY RANDOM() LIMIT ?",
			normalizedArtist, trackID, artistLimit)
		if rows != nil {
			tracks = append(tracks, scanTrackRows(rows)...)
			rows.Close()
		}
	}

	// Same genre tracks
	rows, _ := database.DB.Query(
		"SELECT id, track_id, title, artist, normalized_artist, genre, is_cover, thumbnail, duration FROM tracks WHERE genre = ? AND id != ? ORDER BY RANDOM() LIMIT ?",
		genre, trackID, genreLimit)
	if rows != nil {
		tracks = append(tracks, scanTrackRows(rows)...)
		rows.Close()
	}

	// Random tracks
	remaining := limit - len(tracks)
	if remaining > 0 {
		rows, _ := database.DB.Query(
			"SELECT id, track_id, title, artist, normalized_artist, genre, is_cover, thumbnail, duration FROM tracks WHERE id != ? ORDER BY RANDOM() LIMIT ?",
			trackID, randomLimit)
		if rows != nil {
			tracks = append(tracks, scanTrackRows(rows)...)
			rows.Close()
		}
	}

	// Shuffle the result
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	r.Shuffle(len(tracks), func(i, j int) {
		tracks[i], tracks[j] = tracks[j], tracks[i]
	})

	return c.JSON(tracks)
}

func scanTrackRows(rows *sql.Rows) []fiber.Map {
	tracks := []fiber.Map{}
	for rows.Next() {
		var id int
		var trackID, title, artistName, normalizedArtist, genre, thumbnail string
		var duration int
		var isCover int
		rows.Scan(&id, &trackID, &title, &artistName, &normalizedArtist, &genre, &isCover, &thumbnail, &duration)
		tracks = append(tracks, fiber.Map{
			"id":                id,
			"track_id":          trackID,
			"title":             title,
			"artist":            artistName,
			"normalized_artist": normalizedArtist,
			"genre":             genre,
			"is_cover":          isCover == 1,
			"thumbnail":         thumbnail,
			"duration":          duration,
		})
	}
	return tracks
}

// GetLyrics fetches lyrics from LRCLIB
func GetLyrics(c *fiber.Ctx) error {
	trackID, _ := strconv.Atoi(c.Query("track_id", "0"))
	if trackID == 0 {
		return c.Status(400).JSON(fiber.Map{"error": "track_id required"})
	}

	var title, artist string
	err := database.DB.QueryRow("SELECT title, artist FROM tracks WHERE id = ?", trackID).Scan(&title, &artist)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "track not found"})
	}

	// Clean title for LRCLIB search
	cleanTitle := cleanTitleForLyrics(title)
	cleanArtist := cleanArtistForLyrics(artist)

	// Call LRCLIB API
	endpoint := fmt.Sprintf("https://lrclib.net/api/search?track_name=%s&artist_name=%s",
		url.QueryEscape(cleanTitle),
		url.QueryEscape(cleanArtist))

	client := &http.Client{Timeout: 5 * time.Second}
	req, _ := http.NewRequest("GET", endpoint, nil)
	req.Header.Set("User-Agent", "OmniaMusic/1.0")

	resp, err := client.Do(req)
	if err != nil {
		return c.JSON(fiber.Map{"lyrics": nil, "error": "lrclib unavailable"})
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	var results []map[string]interface{}
	if err := json.Unmarshal(body, &results); err != nil || len(results) == 0 {
		// Try with just title
		endpoint2 := fmt.Sprintf("https://lrclib.net/api/search?track_name=%s", url.QueryEscape(cleanTitle))
		req2, _ := http.NewRequest("GET", endpoint2, nil)
		req2.Header.Set("User-Agent", "OmniaMusic/1.0")

		resp2, err := client.Do(req2)
		if err != nil {
			return c.JSON(fiber.Map{"lyrics": nil})
		}
		defer resp2.Body.Close()

		body2, _ := io.ReadAll(resp2.Body)
		if err := json.Unmarshal(body2, &results); err != nil || len(results) == 0 {
			return c.JSON(fiber.Map{"lyrics": nil})
		}
	}

	// Return first result
	result := results[0]
	plainLyrics, _ := result["plainLyrics"].(string)
	syncedLyrics, _ := result["syncedLyrics"].(string)

	return c.JSON(fiber.Map{
		"lyrics":        plainLyrics,
		"synced_lyrics": syncedLyrics,
		"track_name":    result["trackName"],
		"artist_name":   result["artistName"],
	})
}

func cleanTitleForLyrics(title string) string {
	// Remove common suffixes
	replacements := []string{
		"(Official Music Video)", "(Official Video)", "(Official Audio)",
		"(Music Video)", "(Lyric Video)", "(Lyrics)", "(Official Lyric Video)",
		"(Live)", "(Acoustic)", "(Cover)", "(Remix)",
		"[Official Music Video]", "[Official Video]", "[Official Audio]",
		"[Music Video]", "[Lyric Video]", "[Lyrics]",
	}
	cleaned := title
	for _, r := range replacements {
		cleaned = strings.ReplaceAll(cleaned, r, "")
	}
	// Remove content in parentheses at the end
	if idx := strings.LastIndex(cleaned, "("); idx > 0 && idx > len(cleaned)-30 {
		cleaned = cleaned[:idx]
	}
	return strings.TrimSpace(cleaned)
}

func cleanArtistForLyrics(artist string) string {
	replacements := []string{
		"Official", "VEVO", "Records", "Music", "Channel",
		"Production", "Entertainment",
	}
	cleaned := artist
	for _, r := range replacements {
		cleaned = strings.ReplaceAll(cleaned, r, "")
	}
	return strings.TrimSpace(cleaned)
}

// GetForYou returns personalized content for the home page
func GetForYou(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(int)
	limit, _ := strconv.Atoi(c.Query("limit", "20"))

	result := fiber.Map{
		"recently_played": []fiber.Map{},
		"top_artists":     []fiber.Map{},
		"top_genres":      []fiber.Map{},
		"for_you":         []fiber.Map{},
	}

	// 1. Recently played (last 50)
	rows, err := database.DB.Query(`
		SELECT DISTINCT t.id, t.track_id, t.title, t.artist, t.normalized_artist, t.genre, t.is_cover, t.thumbnail, t.duration, h.listened_at
		FROM history h JOIN tracks t ON h.track_id = t.id
		WHERE h.user_id = ?
		ORDER BY h.listened_at DESC LIMIT 50`, userID)
	if err == nil {
		defer rows.Close()
		recent := []fiber.Map{}
		for rows.Next() {
			var id int
			var trackID, title, artistName, normalizedArtist, genre, thumbnail string
			var duration int
			var isCover int
			var listenedAt string
			rows.Scan(&id, &trackID, &title, &artistName, &normalizedArtist, &genre, &isCover, &thumbnail, &duration, &listenedAt)
			recent = append(recent, fiber.Map{
				"id": id, "track_id": trackID, "title": title, "artist": artistName,
				"normalized_artist": normalizedArtist, "genre": genre, "is_cover": isCover == 1,
				"thumbnail": thumbnail, "duration": duration, "listened_at": listenedAt,
			})
		}
		result["recently_played"] = recent
	}

	// 2. Top artists from history
	rows2, err := database.DB.Query(`
		SELECT t.normalized_artist, COUNT(*) as play_count, MIN(t.thumbnail) as thumbnail
		FROM history h JOIN tracks t ON h.track_id = t.id
		WHERE h.user_id = ? AND t.normalized_artist != ''
		GROUP BY t.normalized_artist
		ORDER BY play_count DESC LIMIT 10`, userID)
	if err == nil {
		defer rows2.Close()
		topArtists := []fiber.Map{}
		for rows2.Next() {
			var name, thumbnail string
			var count int
			rows2.Scan(&name, &count, &thumbnail)
			topArtists = append(topArtists, fiber.Map{
				"name": name, "count": count, "thumbnail": thumbnail,
			})
		}
		result["top_artists"] = topArtists
	}

	// 3. Top genres from history
	rows3, err := database.DB.Query(`
		SELECT t.genre, COUNT(*) as play_count
		FROM history h JOIN tracks t ON h.track_id = t.id
		WHERE h.user_id = ? AND t.genre != 'Other'
		GROUP BY t.genre
		ORDER BY play_count DESC LIMIT 5`, userID)
	if err == nil {
		defer rows3.Close()
		topGenres := []fiber.Map{}
		for rows3.Next() {
			var genre string
			var count int
			rows3.Scan(&genre, &count)
			topGenres = append(topGenres, fiber.Map{"name": genre, "count": count})
		}
		result["top_genres"] = topGenres
	}

	// 4. "For You" — tracks from top genres/artists that user hasn't heard recently
	forYouTracks := []fiber.Map{}

	// Try tracks from top genres
	if genres, ok := result["top_genres"].([]fiber.Map); ok && len(genres) > 0 {
		topGenre, _ := genres[0]["name"].(string)
		rows4, _ := database.DB.Query(`
			SELECT id, track_id, title, artist, normalized_artist, genre, is_cover, thumbnail, duration 
			FROM tracks WHERE genre = ? AND id NOT IN (
				SELECT track_id FROM history WHERE user_id = ?
			) ORDER BY RANDOM() LIMIT ?`, topGenre, userID, limit/2)
		if rows4 != nil {
			defer rows4.Close()
			for rows4.Next() {
				var id int
				var trackID, title, artistName, normalizedArtist, genre, thumbnail string
				var duration int
				var isCover int
				rows4.Scan(&id, &trackID, &title, &artistName, &normalizedArtist, &genre, &isCover, &thumbnail, &duration)
				forYouTracks = append(forYouTracks, fiber.Map{
					"id": id, "track_id": trackID, "title": title, "artist": artistName,
					"normalized_artist": normalizedArtist, "genre": genre, "is_cover": isCover == 1,
					"thumbnail": thumbnail, "duration": duration,
				})
			}
		}
	}

	// Fill remaining with random popular tracks
	remaining := limit - len(forYouTracks)
	if remaining > 0 {
		rows5, _ := database.DB.Query(`
			SELECT id, track_id, title, artist, normalized_artist, genre, is_cover, thumbnail, duration 
			FROM tracks WHERE id NOT IN (
				SELECT track_id FROM history WHERE user_id = ?
			) ORDER BY RANDOM() LIMIT ?`, userID, remaining)
		if rows5 != nil {
			defer rows5.Close()
			for rows5.Next() {
				var id int
				var trackID, title, artistName, normalizedArtist, genre, thumbnail string
				var duration int
				var isCover int
				rows5.Scan(&id, &trackID, &title, &artistName, &normalizedArtist, &genre, &isCover, &thumbnail, &duration)
				forYouTracks = append(forYouTracks, fiber.Map{
					"id": id, "track_id": trackID, "title": title, "artist": artistName,
					"normalized_artist": normalizedArtist, "genre": genre, "is_cover": isCover == 1,
					"thumbnail": thumbnail, "duration": duration,
				})
			}
		}
	}

	// Shuffle forYouTracks
	r := time.Now().UnixNano()
	for i := len(forYouTracks) - 1; i > 0; i-- {
		j := int(r%int64(i+1))
		forYouTracks[i], forYouTracks[j] = forYouTracks[j], forYouTracks[i]
		r = r / 2
	}

	result["for_you"] = forYouTracks

	return c.JSON(result)
}

// SyncTracks checks index.json for new tracks and imports them
func SyncTracks(c *fiber.Ctx) error {
	if IndexPath == "" {
		return c.Status(500).JSON(fiber.Map{"error": "index path not configured"})
	}

	imported, err := database.ImportNewTracks(IndexPath)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	return c.JSON(fiber.Map{
		"imported": imported,
		"message":  fmt.Sprintf("Synced %d new tracks", imported),
	})
}
