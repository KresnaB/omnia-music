package config

import "os"

type Config struct {
	Port       string
	DBPath     string
	AudioPath  string
	JWTSecret  string
	IndexPath  string
}

func Load() *Config {
	return &Config{
		Port:      getEnv("PORT", "3000"),
		DBPath:    getEnv("DB_PATH", "./data/omnia.db"),
		AudioPath: getEnv("AUDIO_PATH", "./storage/audio-cache"),
		JWTSecret: getEnv("JWT_SECRET", "omnia-music-secret-change-me"),
		IndexPath: getEnv("INDEX_PATH", "./storage/audio-cache/index.json"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
