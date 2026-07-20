package handlers

import (
	"omnia-music/server/models"

	"github.com/gofiber/fiber/v2"
)

func ToggleCrossfade(c *fiber.Ctx) error {
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	value := "false"
	if body.Enabled {
		value = "true"
	}

	if err := models.SetSetting("crossfade", value); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to save setting"})
	}

	return c.JSON(fiber.Map{
		"key":   "crossfade",
		"value": value,
	})
}

func GetCrossfade(c *fiber.Ctx) error {
	value, err := models.GetSetting("crossfade")
	if err != nil {
		return c.JSON(fiber.Map{
			"key":   "crossfade",
			"value": "false",
		})
	}

	return c.JSON(fiber.Map{
		"key":   "crossfade",
		"value": value,
	})
}
