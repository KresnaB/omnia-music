package media

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"omnia-music/internal/config"
)

type LyricsClient struct {
	baseURL string
	client  *http.Client
}

type LyricsResult struct {
	TrackName    string `json:"trackName"`
	ArtistName   string `json:"artistName"`
	AlbumName    string `json:"albumName"`
	PlainLyrics  string `json:"plainLyrics"`
	SyncedLyrics string `json:"syncedLyrics"`
}

func NewLyricsClient(cfg *config.Config) *LyricsClient {
	return &LyricsClient{
		baseURL: strings.TrimRight(cfg.LRCLibBaseURL, "/"),
		client:  &http.Client{},
	}
}

func (c *LyricsClient) Search(ctx context.Context, title, artist string) (*LyricsResult, error) {
	endpoint := fmt.Sprintf("%s/api/search?track_name=%s&artist_name=%s",
		c.baseURL,
		url.QueryEscape(title),
		url.QueryEscape(artist),
	)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("lrclib returned status %d", resp.StatusCode)
	}

	var payload []LyricsResult
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	if len(payload) == 0 {
		return nil, fmt.Errorf("lyrics not found")
	}

	return &payload[0], nil
}
