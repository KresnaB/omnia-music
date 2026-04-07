package media

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"omnia-music/internal/config"
)

type Resolver struct {
	cfg *config.Config
}

type TrackInfo struct {
	Title         string
	URL           string
	StreamURL     string
	Duration      time.Duration
	Uploader      string
	Thumbnail     string
	RequestedBy   string
	RequestedByID string
	Source        string
	SearchQuery   string
	Offset        time.Duration
}

type ytDLPResult struct {
	Title      string  `json:"title"`
	WebpageURL string  `json:"webpage_url"`
	URL        string  `json:"url"`
	Duration   float64 `json:"duration"`
	Uploader   string  `json:"uploader"`
	Thumbnail  string  `json:"thumbnail"`
	Extractor  string  `json:"extractor_key"`
	Track      string  `json:"track"`
	Artist     string  `json:"artist"`
}

func NewResolver(cfg *config.Config) *Resolver {
	return &Resolver{cfg: cfg}
}

func (r *Resolver) Resolve(ctx context.Context, query string) (*TrackInfo, error) {
	target := query
	if !looksLikeURL(query) {
		target = fmt.Sprintf("ytsearch1:%s", query)
	}

	args := []string{
		"--cookies", r.cfg.YTDLPCookiesFile,
		"--no-playlist",
		"--default-search", r.cfg.DefaultSearchPlatform,
		"-f", "bestaudio/best",
		"--print-json",
		target,
	}

	cmd := exec.CommandContext(ctx, r.cfg.YTDLPPath, args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("yt-dlp resolve failed: %w", err)
	}

	var result ytDLPResult
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, fmt.Errorf("decode yt-dlp json: %w", err)
	}

	title := result.Title
	if title == "" {
		title = strings.Trim(strings.Join([]string{result.Artist, result.Track}, " - "), " -")
	}
	if title == "" {
		title = query
	}

	pageURL := result.WebpageURL
	if pageURL == "" {
		pageURL = query
	}

	return &TrackInfo{
		Title:       title,
		URL:         pageURL,
		StreamURL:   result.URL,
		Duration:    time.Duration(result.Duration * float64(time.Second)),
		Uploader:    result.Uploader,
		Thumbnail:   result.Thumbnail,
		Source:      strings.ToLower(result.Extractor),
		SearchQuery: query,
	}, nil
}

func looksLikeURL(v string) bool {
	v = strings.ToLower(strings.TrimSpace(v))
	return strings.HasPrefix(v, "http://") || strings.HasPrefix(v, "https://")
}
