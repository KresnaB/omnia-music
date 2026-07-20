package database

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"

	_ "github.com/mattn/go-sqlite3"
	"golang.org/x/crypto/bcrypt"
)

type TrackEntry struct {
	CanonicalKey string `json:"canonicalKey"`
	FileName     string `json:"fileName"`
	SizeBytes    int64  `json:"sizeBytes"`
	Track        struct {
		ID               string `json:"id"`
		Title            string `json:"title"`
		URL              string `json:"url"`
		WebpageURL       string `json:"webpageUrl"`
		Duration         int    `json:"duration"`
		Uploader         string `json:"uploader"`
		Thumbnail        string `json:"thumbnail"`
		Source           string `json:"source"`
		CanonicalKey     string `json:"canonicalKey"`
		CacheFormat      string `json:"cacheFormat"`
		CacheCodec       string `json:"cacheCodec"`
		CacheBitrateKbps int    `json:"cacheBitrateKbps"`
		Album            string `json:"album"`
		NormalizedArtist string `json:"normalizedArtist"`
	} `json:"track"`
}

type IndexFile struct {
	Entries []TrackEntry `json:"entries"`
}

var DB *sql.DB

// Labels and channels that are NOT real artists
var labelPatterns = []string{
	"musica studios", "sony music", "trinity optima", "hits records",
	"nagaswara", "emotion entertainment", "gp records", "1thek",
	"20th century", "warner records", "universal music", "atlantic records",
	"republic records", "interscope", "columbia records", "rca records",
	"def jam", "capitol records", "virgin records", "parlophone",
	"official video", "official channel", "records", "entertainment",
	"production", "music channel", "vevo",
	"7clouds", "1106 radio", "as tone", "no copyrightsounds",
	"aquarius musikindo", "nagaswara official", "aini musik",
	"musik proaktif", "indolirik", "latin hype", "sonymusicidvevo",
	"dan music", "510 music",
}

// Genre classification keywords
var genreKeywords = map[string][]string{
	"Rock":        {"rock", "metal", "punk", "grunge", "alternative", "indie rock", "emo", "screamo", "hardcore", "metallica", "linkin park", "green day", "nirvana", "foo fighters", "avenged sevenfold", "my chemical romance", "slipknot", "system of a down"},
	"Pop":         {"pop", "dance pop", "electropop", "synth pop", "kpop", "k-pop", "jpop", "j-pop", "ariana grande", "taylor swift", "billie eilish", "dua lipa", "olivia rodrigo", "sabrina carpenter", "bts", "blackpink", "twice", "iu"},
	"Hip-Hop":     {"hip hop", "hip-hop", "rap", "trap", "drill", "drake", "kendrick", "j cole", "travis scott", "21 savage", "eminem", "kanye", "tyler the creator", "post malone"},
	"R&B":         {"r&b", "rnb", "r and b", "soul", "neo soul", "frank ocean", "sza", "the weeknd", "brent faiyaz", "daniel caesar", "joji"},
	"Electronic":  {"electronic", "edm", "house", "techno", "trance", "dubstep", "drum and bass", "ambient", "synthwave", "lo-fi", "lofi", "chillwave"},
	"Jazz":        {"jazz", "smooth jazz", "fusion jazz", "swing", "bossa nova", "barry likumahuwa"},
	"Indonesian":  {"dangdut", "koplo", "melayu", "campursari", "gamelan", "keroncong", "indonesian", "hindia", "feast", "fourtwnty", "tulus", "raisa", "risa", "agnez mo", "marion jola", "maliq", "sheila on 7", "peterpan", "noah", "ungu", "wali", "slank", "nego", "setia band", "geisha", "letto", "vierra", "nyong franco", "steven coconuttreez", "juicy luicy"},
	"K-Pop":       {"k-pop", "kpop", "bts", "blackpink", "twice", "red velvet", "exo", "nct", "stray kids", "aespa", "ive", "newjeans", "le sserafim", "gidle", "(g)i-dle", "itzy", "mamamoo", "momoland", "iu", "bigbang", "psy", "seventeen", "enhypen", "txt", "ateez"},
	"J-Pop":       {"j-pop", "jpop", "anime", "japanese", "ado", "yoasobi", "king gnu", "official髭男dism", "yonezu kenshi", "aimyon", "perfume", "babymetal", "band-maid", "one ok rock", "lisa", "miku", "hatsune miku", "vocaloid", "rodenasite", "roku de nashi"},
	"Latin":       {"latin", "reggaeton", "salsa", "bachata", "cumbia", "bad bunny", "j balvin", "ozuna", "daddy yankee", "maluma", "shakira", "karol g"},
	"Country":     {"country", "folk country", "bro country", "morgan wallen", "luke combs", "chris stapleton", "zach bryan"},
	"Folk":        {"folk", "acoustic folk", "indie folk", "singer-songwriter", "bon iver", "fleet foxes", "mumford"},
	"Classical":   {"classical", "orchestra", "symphony", "sonata", "concerto", "piano sonata", "chopin", "beethoven", "mozart", "bach"},
}

var coverPatterns = regexp.MustCompile(`(?i)(cover|koplo|dangdut|remix|acoustic|live\s*(session|cover|at|performance)|karaoke|piano\s*(cover|version|arrangement)|guitar\s*cover|ukulele\s*cover|slowed|reverb|nightcore|lofi\s*version|orchestral|instrumental|ver\.|version)`)
// liveRecordingPatterns matches album names that are actually live recordings,
// bootlegs, or concert recordings from YouTube — not real studio albums.
var liveRecordingPatterns = regexp.MustCompile(`(?i)(` +
	// Date-prefixed concerts: "2016-07-30: SAP Center, San Jose, CA, USA"
	`\d{4}-\d{2}-\d{2}:|` +
	// Live at/in venue names
	`\blive\s+(at|in|on|from)\b|` +
	// Tour names as album
	`\b(tour|festival|concert|world tour)\b|` +
	// Specific venue patterns
	`\b(amphitheatre|arena|stadium|colosseum|madison square|pyramid stage|grammy museum)\b|` +
	// Radio/TV appearances
	`\b(saturday night live|iheartradio|kroq|bbc radio|paradiso fm|cbc exclusive)\b|` +
	// "Live" album naming patterns
	`\b(k\s+bye\s+for\s+now|live\s+rarities|live\s+from|synchronicity\s+concert)\b|` +
	// Compilation/generic non-album
	`\b(the video year mix|spotify singles|video collection)\b` +
	`)`)

// isLiveRecording checks if an album name is a live recording or bootleg.
func isLiveRecording(album string) bool {
	return liveRecordingPatterns.MatchString(album)
}


func Init(dbPath string) error {
	var err error
	DB, err = sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return fmt.Errorf("failed to open database: %w", err)
	}

	DB.SetMaxOpenConns(5)
	DB.SetMaxIdleConns(2)

	if err := migrate(); err != nil {
		return fmt.Errorf("failed to migrate: %w", err)
	}

	return nil
}

func migrate() error {
	tables := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS tracks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			track_id TEXT UNIQUE NOT NULL,
			canonical_key TEXT NOT NULL,
			file_name TEXT NOT NULL,
			title TEXT NOT NULL,
			artist TEXT NOT NULL,
			album TEXT DEFAULT '',
			thumbnail TEXT,
			duration INTEGER DEFAULT 0,
			size_bytes INTEGER DEFAULT 0,
			source TEXT DEFAULT 'youtube',
			cache_format TEXT DEFAULT 'ogg',
			cache_codec TEXT DEFAULT 'opus',
			cache_bitrate INTEGER DEFAULT 128
		)`,
		`CREATE TABLE IF NOT EXISTS playlists (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			name TEXT NOT NULL,
			description TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS playlist_tracks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			playlist_id INTEGER NOT NULL,
			track_id INTEGER NOT NULL,
			position INTEGER NOT NULL,
			added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
			FOREIGN KEY (track_id) REFERENCES tracks(id)
		)`,
		`CREATE TABLE IF NOT EXISTS history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			track_id INTEGER NOT NULL,
			listened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
			FOREIGN KEY (track_id) REFERENCES tracks(id)
		)`,
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL DEFAULT ''
		)`,
	}

	for _, q := range tables {
		if _, err := DB.Exec(q); err != nil {
			return fmt.Errorf("table creation failed: %w\nQuery: %s", err, q)
		}
	}

	alterQueries := []string{
		`ALTER TABLE tracks ADD COLUMN normalized_artist TEXT DEFAULT ''`,
		`ALTER TABLE tracks ADD COLUMN genre TEXT DEFAULT 'Other'`,
		`ALTER TABLE tracks ADD COLUMN is_cover INTEGER DEFAULT 0`,
		`ALTER TABLE tracks ADD COLUMN album TEXT DEFAULT ''`,
	}

	// Create albums virtual view — only show real albums (not artist-as-album)
	viewQueries := []string{
		`DROP VIEW IF EXISTS albums`,
		`CREATE VIEW IF NOT EXISTS albums AS
		SELECT
			album,
			normalized_artist AS artist,
			MIN(thumbnail) AS thumbnail,
			COUNT(*) AS track_count,
			SUM(duration) AS total_duration
		FROM tracks
		WHERE album != '' AND album IS NOT NULL AND album != normalized_artist
		GROUP BY album, normalized_artist
		ORDER BY album ASC`,
	}
	for _, q := range viewQueries {
		if _, err := DB.Exec(q); err != nil {
			return fmt.Errorf("view creation failed: %w\nQuery: %s", err, q)
		}
	}
	for _, q := range alterQueries {
		DB.Exec(q)
	}

	indexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist)`,
		`CREATE INDEX IF NOT EXISTS idx_tracks_normalized_artist ON tracks(normalized_artist)`,
		`CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre)`,
		`CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title)`,
		`CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album)`,
		`CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_history_listened ON history(listened_at)`,
		`CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id)`,
	}

	for _, q := range indexes {
		if _, err := DB.Exec(q); err != nil {
			return fmt.Errorf("index creation failed: %w\nQuery: %s", err, q)
		}
	}

	return nil
}

// SeedDefaultUser creates default user if not exists
func SeedDefaultUser(username, password string) error {
	var count int
	err := DB.QueryRow("SELECT COUNT(*) FROM users WHERE username = ?", username).Scan(&count)
	if err != nil {
		return err
	}
	if count > 0 {
		return nil // already exists
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	_, err = DB.Exec("INSERT INTO users (username, password_hash) VALUES (?, ?)", username, string(hash))
	if err != nil {
		return err
	}

	log.Printf("Seeded default user: %s", username)
	return nil
}

// normalizeArtist extracts the real artist from title when uploader is a label
func normalizeArtist(title, uploader string) string {
	lowerUploader := strings.ToLower(uploader)

	isLabel := false
	for _, label := range labelPatterns {
		if strings.Contains(lowerUploader, label) {
			isLabel = true
			break
		}
	}

	if !isLabel {
		return uploader
	}

	if idx := strings.Index(title, " - "); idx > 0 && idx < 50 {
		artist := strings.TrimSpace(title[:idx])
		if len(artist) > 1 && len(artist) < 60 {
			return artist
		}
	}
	if idx := strings.Index(title, " : "); idx > 0 && idx < 50 {
		artist := strings.TrimSpace(title[:idx])
		if len(artist) > 1 && len(artist) < 60 {
			return artist
		}
	}

	if strings.HasPrefix(title, "[") {
		if end := strings.Index(title, "]"); end > 1 && end < 50 {
			return strings.TrimSpace(title[1:end])
		}
	}

	lowerTitle := strings.ToLower(title)
	if idx := strings.LastIndex(lowerTitle, " by "); idx > 0 {
		artist := strings.TrimSpace(title[idx+4:])
		if len(artist) > 1 && len(artist) < 60 {
			return artist
		}
	}

	if strings.HasSuffix(title, ")") {
		if start := strings.LastIndex(title, "("); start > len(title)-60 {
			artist := strings.TrimSpace(title[start+1 : len(title)-1])
			if len(artist) > 1 && len(artist) < 40 && !strings.Contains(artist, "Official") {
				return artist
			}
		}
	}

	return uploader
}

func classifyGenre(title, artist string) string {
	lowerTitle := strings.ToLower(title)
	lowerArtist := strings.ToLower(artist)
	combined := lowerTitle + " " + lowerArtist

	bestGenre := "Other"
	bestScore := 0

	for genre, keywords := range genreKeywords {
		score := 0
		for _, kw := range keywords {
			if strings.Contains(combined, kw) {
				score++
			}
		}
		if score > bestScore {
			bestScore = score
			bestGenre = genre
		}
	}

	return bestGenre
}

func detectCover(title string) bool {
	return coverPatterns.MatchString(title)
}

// detectAlbum extracts album name from title if it matches "song - artist | Album Name" or "song (Album Name)" patterns
func detectAlbum(title string) string {
	// Match patterns like: "title | Album Name" or "title (Album Name)"
	pipeIdx := strings.LastIndex(title, " | ")
	if pipeIdx > 0 {
		album := strings.TrimSpace(title[pipeIdx+3:])
		if len(album) > 1 && len(album) < 100 {
			return album
		}
	}
	// Try "(from \"Album\")" or "(Album Name)" at end
	if strings.HasSuffix(title, "\")") {
		start := strings.LastIndex(title, "(\"")
		if start > 0 {
			album := title[start+2 : len(title)-2]
			if len(album) > 1 && len(album) < 100 {
				return album
			}
		}
	}
	return ""
}

func ImportTracks(indexPath string) error {
	var count int
	err := DB.QueryRow("SELECT COUNT(*) FROM tracks").Scan(&count)
	if err != nil {
		return err
	}
	if count > 0 {
		log.Printf("Tracks table already has %d entries, skipping import", count)
		// Always re-enrich and re-assign albums on startup
		go func() {
			reEnrichAllTracks()
			cleanLiveRecordings()
			syncAlbumsFromIndex(indexPath)
			assignAlbums()
		}()
		return nil
	}

	data, err := os.ReadFile(indexPath)
	if err != nil {
		return fmt.Errorf("failed to read index.json: %w", err)
	}

	var index IndexFile
	if err := json.Unmarshal(data, &index); err != nil {
		return fmt.Errorf("failed to parse index.json: %w", err)
	}

	tx, err := DB.Begin()
	if err != nil {
		return err
	}

	stmt, err := tx.Prepare(`INSERT OR IGNORE INTO tracks 
		(track_id, canonical_key, file_name, title, artist, normalized_artist, genre, is_cover, album, thumbnail, duration, size_bytes, source, cache_format, cache_codec, cache_bitrate) 
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	defer stmt.Close()

	imported := 0
	for _, entry := range index.Entries {
		normalized := normalizeArtist(entry.Track.Title, entry.Track.Uploader)
		genre := classifyGenre(entry.Track.Title, normalized)
		isCover := 0
		if detectCover(entry.Track.Title) {
			isCover = 1
		}
		// Use album from index.json if available, otherwise detect from title
		album := entry.Track.Album
		if album == "" {
			album = detectAlbum(entry.Track.Title)
		}
		if album == "" {
			album = normalized
		}

		_, err := stmt.Exec(
			entry.Track.ID,
			entry.CanonicalKey,
			entry.FileName,
			entry.Track.Title,
			entry.Track.Uploader,
			normalized,
			genre,
			isCover,
			album,
			entry.Track.Thumbnail,
			entry.Track.Duration,
			entry.SizeBytes,
			entry.Track.Source,
			entry.Track.CacheFormat,
			entry.Track.CacheCodec,
			entry.Track.CacheBitrateKbps,
		)
		if err != nil {
			log.Printf("Warning: failed to insert track %s: %v", entry.Track.ID, err)
			continue
		}
		imported++
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	log.Printf("Imported %d tracks from index.json", imported)
	return nil
}

// ImportNewTracks reads index.json and inserts only tracks that don't exist in DB yet.
// Returns the number of newly imported tracks.
func ImportNewTracks(indexPath string) (int, error) {
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return 0, fmt.Errorf("failed to read index.json: %w", err)
	}

	var index IndexFile
	if err := json.Unmarshal(data, &index); err != nil {
		return 0, fmt.Errorf("failed to parse index.json: %w", err)
	}

	tx, err := DB.Begin()
	if err != nil {
		return 0, err
	}

	stmt, err := tx.Prepare(`INSERT OR IGNORE INTO tracks 
		(track_id, canonical_key, file_name, title, artist, normalized_artist, genre, is_cover, album, thumbnail, duration, size_bytes, source, cache_format, cache_codec, cache_bitrate) 
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return 0, err
	}
	defer stmt.Close()

	imported := 0
	for _, entry := range index.Entries {
		normalized := normalizeArtist(entry.Track.Title, entry.Track.Uploader)
		genre := classifyGenre(entry.Track.Title, normalized)
		isCover := 0
		if detectCover(entry.Track.Title) {
			isCover = 1
		}
		album := entry.Track.Album
		if album == "" {
			album = detectAlbum(entry.Track.Title)
		}
		if album == "" {
			album = normalized
		}

		result, err := stmt.Exec(
			entry.Track.ID,
			entry.CanonicalKey,
			entry.FileName,
			entry.Track.Title,
			entry.Track.Uploader,
			normalized,
			genre,
			isCover,
			album,
			entry.Track.Thumbnail,
			entry.Track.Duration,
			entry.SizeBytes,
			entry.Track.Source,
			entry.Track.CacheFormat,
			entry.Track.CacheCodec,
			entry.Track.CacheBitrateKbps,
		)
		if err != nil {
			log.Printf("Warning: failed to insert track %s: %v", entry.Track.ID, err)
			continue
		}
		rowsAffected, _ := result.RowsAffected()
		if rowsAffected > 0 {
			imported++
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}

	if imported > 0 {
		log.Printf("Synced %d new tracks from index.json", imported)
		// Re-enrich new tracks and sync albums from index.json in background
		go func() {
			reEnrichAllTracks()
			syncAlbumsFromIndex(indexPath)
			assignAlbums()
		}()
	} else {
		// Even if no new tracks, sync albums from index.json (album metadata may have updated)
		go syncAlbumsFromIndex(indexPath)
	}

	return imported, nil
}

func enrichTracks() {
	rows, err := DB.Query("SELECT id, title, artist FROM tracks WHERE normalized_artist = '' OR genre = 'Other'")
	if err != nil {
		return
	}
	defer rows.Close()

	tx, _ := DB.Begin()
	stmt, _ := tx.Prepare("UPDATE tracks SET normalized_artist = ?, genre = ?, is_cover = ? WHERE id = ?")
	defer stmt.Close()

	updated := 0
	for rows.Next() {
		var id int
		var title, artist string
		rows.Scan(&id, &title, &artist)

		normalized := normalizeArtist(title, artist)
		genre := classifyGenre(title, normalized)
		isCover := 0
		if detectCover(title) {
			isCover = 1
		}

		stmt.Exec(normalized, genre, isCover, id)
		updated++
	}

	tx.Commit()
	if updated > 0 {
		log.Printf("Enriched %d tracks with artist/genre/cover data", updated)
	}

	// Build albums from artist groupings
	assignAlbums()
}

// reEnrichAllTracks re-enriches ALL tracks (not just empty ones)
// Used on startup to apply updated label patterns and genre classification
func reEnrichAllTracks() {
	rows, err := DB.Query("SELECT id, title, artist FROM tracks")
	if err != nil {
		return
	}
	defer rows.Close()

	tx, _ := DB.Begin()
	stmt, _ := tx.Prepare("UPDATE tracks SET normalized_artist = ?, genre = ?, is_cover = ? WHERE id = ?")
	defer stmt.Close()

	updated := 0
	for rows.Next() {
		var id int
		var title, artist string
		rows.Scan(&id, &title, &artist)

		normalized := normalizeArtist(title, artist)
		genre := classifyGenre(title, normalized)
		isCover := 0
		if detectCover(title) {
			isCover = 1
		}

		stmt.Exec(normalized, genre, isCover, id)
		updated++
	}

	tx.Commit()
	if updated > 0 {
		log.Printf("Re-enriched %d tracks with updated patterns", updated)
	}
}

// assignAlbums creates album entries based on artist names.
// For YouTube-sourced music without album metadata, we group by artist.
// Only fills in tracks that DON'T already have an album set.
func assignAlbums() {
	result, err := DB.Exec(`UPDATE tracks SET album = normalized_artist WHERE normalized_artist != '' AND (album IS NULL OR album = '')`)
	if err != nil {
		log.Printf("Warning: failed to assign albums: %v", err)
		return
	}
	affected, _ := result.RowsAffected()
	if affected > 0 {
		log.Printf("Assigned artist-as-album to %d tracks without album data", affected)
	}
}

// syncAlbumsFromIndex reads index.json and updates DB album field for tracks
// that have a real album (not just artist name). Used after MusicBrainz lookup.
func syncAlbumsFromIndex(indexPath string) {
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return
	}
	var index IndexFile
	if err := json.Unmarshal(data, &index); err != nil {
		return
	}

	tx, _ := DB.Begin()
	stmt, _ := tx.Prepare("UPDATE tracks SET album = ? WHERE track_id = ? AND album != ?")
	defer stmt.Close()

	updated := 0
	skippedLive := 0
	for _, entry := range index.Entries {
		if entry.Track.Album == "" || entry.Track.Album == entry.Track.NormalizedArtist {
			continue
		}
		// Skip live recordings, bootlegs, and concert recordings
		if isLiveRecording(entry.Track.Album) {
			skippedLive++
			continue
		}
		_, err := stmt.Exec(entry.Track.Album, entry.Track.ID, entry.Track.Album)
		if err == nil {
			updated++
		}
	}
	tx.Commit()
	if updated > 0 {
		log.Printf("Synced %d album names from index.json to database", updated)
	}
	if skippedLive > 0 {
		log.Printf("Skipped %d live recordings/bootlegs from album sync", skippedLive)
	}
}
// cleanLiveRecordings resets album names that match live recording patterns
// back to the artist name. Run once on startup to clean up bad MusicBrainz data.
func cleanLiveRecordings() {
	rows, err := DB.Query("SELECT id, album FROM tracks WHERE album IS NOT NULL AND album != ''")
	if err != nil {
		return
	}
	defer rows.Close()

	tx, _ := DB.Begin()
	stmt, _ := tx.Prepare("UPDATE tracks SET album = '' WHERE id = ?")
	defer stmt.Close()

	cleaned := 0
	for rows.Next() {
		var id int
		var album string
		rows.Scan(&id, &album)
		if isLiveRecording(album) {
			stmt.Exec(id)
			cleaned++
		}
	}
	tx.Commit()
	if cleaned > 0 {
		log.Printf("Cleaned %d live recording album names from database", cleaned)
	}
}

func Close() {
	if DB != nil {
		DB.Close()
	}
}
