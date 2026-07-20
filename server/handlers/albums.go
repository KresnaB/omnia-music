package handlers

import (
	"net/url"
	"strconv"

	"omnia-music/server/models"

	"github.com/gofiber/fiber/v2"
)

func GetAlbums(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	page, _ := strconv.Atoi(c.Query("page", "1"))
	if limit < 1 || limit > 5000 {
		limit = 50
	}
	if page < 1 {
		page = 1
	}
	offset := (page - 1) * limit

	albums, err := models.GetAlbums(limit, offset)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "database error"})
	}

	return c.JSON(fiber.Map{
		"albums": albums,
		"page":   page,
		"limit":  limit,
	})
}

func GetAlbum(c *fiber.Ctx) error {
	// Use wildcard param (*) to support album names with /
	name, err := url.QueryUnescape(c.Params("*"))
	if err != nil {
		name = c.Params("*")
	}
	// Remove leading slash if present
	if len(name) > 0 && name[0] == '/' {
		name = name[1:]
	}
	if name == "" {
		return c.Status(400).JSON(fiber.Map{"error": "album name required"})
	}

	album, tracks, err := models.GetAlbumByName(name)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "album not found"})
	}

	return c.JSON(fiber.Map{
		"album":  album,
		"tracks": tracks,
	})
}

func GetArtistAlbums(c *fiber.Ctx) error {
	artist, err := url.QueryUnescape(c.Params("name"))
	if err != nil {
		artist = c.Params("name")
	}
	if artist == "" {
		return c.Status(400).JSON(fiber.Map{"error": "artist name required"})
	}

	albums, err := models.GetAlbumsByArtist(artist)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "database error"})
	}

	return c.JSON(albums)
}
