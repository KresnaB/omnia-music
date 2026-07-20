package handlers

import (
	"strconv"

	"omnia-music/server/models"

	"github.com/gofiber/fiber/v2"
)

func GetHistory(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(int)
	limit, _ := strconv.Atoi(c.Query("limit", "100"))

	history, err := models.GetHistory(userID, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch history"})
	}
	return c.JSON(history)
}

func LogListen(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(int)
	var body struct {
		TrackID int `json:"track_id"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	if err := models.LogListen(userID, body.TrackID); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to log listen"})
	}
	return c.Status(201).JSON(fiber.Map{"message": "logged"})
}

func DeleteHistoryEntry(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(int)
	id, err := strconv.Atoi(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}

	if err := models.DeleteHistoryEntry(id, userID); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete"})
	}
	return c.JSON(fiber.Map{"message": "deleted"})
}
