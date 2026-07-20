package handlers

import (
	"strconv"

	"omnia-music/server/models"

	"github.com/gofiber/fiber/v2"
)

func GetPlaylists(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(int)
	playlists, err := models.GetPlaylistsByUser(userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to fetch playlists"})
	}
	return c.JSON(playlists)
}

func CreatePlaylist(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(int)
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if body.Name == "" {
		return c.Status(400).JSON(fiber.Map{"error": "name is required"})
	}

	playlist, err := models.CreatePlaylist(userID, body.Name, body.Description)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to create playlist"})
	}
	return c.Status(201).JSON(playlist)
}

func GetPlaylist(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(int)
	id, err := strconv.Atoi(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid playlist id"})
	}

	playlist, err := models.GetPlaylistByID(id, userID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "playlist not found"})
	}
	return c.JSON(playlist)
}

func UpdatePlaylist(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(int)
	id, err := strconv.Atoi(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid playlist id"})
	}

	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	if err := models.UpdatePlaylist(id, userID, body.Name, body.Description); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to update playlist"})
	}
	return c.JSON(fiber.Map{"message": "updated"})
}

func DeletePlaylist(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(int)
	id, err := strconv.Atoi(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid playlist id"})
	}

	if err := models.DeletePlaylist(id, userID); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to delete playlist"})
	}
	return c.JSON(fiber.Map{"message": "deleted"})
}

func AddTrackToPlaylist(c *fiber.Ctx) error {
	playlistID, err := strconv.Atoi(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid playlist id"})
	}

	var body struct {
		TrackID int `json:"track_id"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	if err := models.AddTrackToPlaylist(playlistID, body.TrackID); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to add track"})
	}
	return c.Status(201).JSON(fiber.Map{"message": "track added"})
}

func RemoveTrackFromPlaylist(c *fiber.Ctx) error {
	playlistID, err := strconv.Atoi(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid playlist id"})
	}
	trackID, err := strconv.Atoi(c.Params("trackId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid track id"})
	}

	if err := models.RemoveTrackFromPlaylist(playlistID, trackID); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to remove track"})
	}
	return c.JSON(fiber.Map{"message": "track removed"})
}
