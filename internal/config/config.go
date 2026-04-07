package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	DiscordToken          string
	DevGuildID            string
	FFmpegPath            string
	YTDLPPath             string
	YTDLPCookiesFile      string
	LRCLibBaseURL         string
	DefaultVolume         int
	DefaultIdleTimeout    time.Duration
	DefaultSearchPlatform string
	LogLevel              string
}

func Load() (*Config, error) {
	_ = godotenv.Load()

	cfg := &Config{
		DiscordToken:          os.Getenv("DISCORD_TOKEN"),
		DevGuildID:            os.Getenv("DEV_GUILD_ID"),
		FFmpegPath:            withDefault(os.Getenv("FFMPEG_PATH"), "ffmpeg"),
		YTDLPPath:             withDefault(os.Getenv("YTDLP_PATH"), "yt-dlp"),
		YTDLPCookiesFile:      os.Getenv("YTDLP_COOKIES_FILE"),
		LRCLibBaseURL:         withDefault(os.Getenv("LRCLIB_BASE_URL"), "https://lrclib.net"),
		DefaultVolume:         envInt("DEFAULT_VOLUME", 100),
		DefaultIdleTimeout:    envDuration("DEFAULT_IDLE_TIMEOUT", 10*time.Minute),
		DefaultSearchPlatform: withDefault(os.Getenv("DEFAULT_SEARCH_PLATFORM"), "youtube"),
		LogLevel:              withDefault(os.Getenv("LOG_LEVEL"), "info"),
	}

	if cfg.DiscordToken == "" {
		return nil, errors.New("DISCORD_TOKEN is required")
	}
	if cfg.YTDLPCookiesFile == "" {
		return nil, errors.New("YTDLP_COOKIES_FILE is required for cookie-based yt-dlp access")
	}
	if cfg.DefaultVolume < 0 || cfg.DefaultVolume > 200 {
		return nil, fmt.Errorf("DEFAULT_VOLUME must be between 0 and 200")
	}

	return cfg, nil
}

func withDefault(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func envInt(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	val, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return val
}

func envDuration(name string, fallback time.Duration) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	val, err := time.ParseDuration(raw)
	if err != nil {
		return fallback
	}
	return val
}
