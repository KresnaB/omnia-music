package models

import (
	"omnia-music/server/database"
)

type Setting struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

func GetSetting(key string) (string, error) {
	var value string
	err := database.DB.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&value)
	if err != nil {
		return "", err
	}
	return value, nil
}

func SetSetting(key, value string) error {
	_, err := database.DB.Exec(
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
		key, value, value,
	)
	return err
}
