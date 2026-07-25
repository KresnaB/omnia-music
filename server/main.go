package main

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"omnia-music/server/config"
	"omnia-music/server/database"
	"omnia-music/server/handlers"
	"omnia-music/server/middleware"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
)

func main() {
	cfg := config.Load()

	// Ensure data directory exists
	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	// Initialize database
	if err := database.Init(cfg.DBPath); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer database.Close()

	// Seed default user
	if err := database.SeedDefaultUser("kresna", "zilann123"); err != nil {
		log.Printf("Warning: failed to seed default user: %v", err)
	}

	// Set CAPTCHA secret (derived from JWT_SECRET)
	handlers.SetCaptchaSecret(cfg.JWTSecret + "-captcha")

	// Import tracks from index.json
	if err := database.ImportTracks(cfg.IndexPath); err != nil {
		log.Printf("Warning: failed to import tracks: %v", err)
	}

	// Set audio path for handlers
	handlers.AudioPath = cfg.AudioPath
	handlers.IndexPath = cfg.IndexPath

	// Periodic sync: check for new tracks from index.json every 5 minutes
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			imported, err := database.ImportNewTracks(cfg.IndexPath)
			if err != nil {
				log.Printf("Periodic sync error: %v", err)
			} else if imported > 0 {
				log.Printf("Periodic sync: %d new tracks imported", imported)
			}
		}
	}()

	// Create Fiber app
	app := fiber.New(fiber.Config{
		AppName:      "Omnia Music",
		BodyLimit:    1024 * 1024, // 1MB
		StreamRequestBody: true,
	})

	// Middleware
	app.Use(logger.New())
	app.Use(recover.New())
	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
		AllowHeaders: "Origin, Content-Type, Accept, Authorization",
		AllowMethods: "GET, POST, PUT, DELETE, OPTIONS",
	}))

	// Security headers
	app.Use(func(c *fiber.Ctx) error {
		c.Set("X-Content-Type-Options", "nosniff")
		c.Set("X-Frame-Options", "DENY")
		c.Set("X-XSS-Protection", "1; mode=block")
		c.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		return c.Next()
	})

	// Health check (public)
	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok", "app": "omnia-music"})
	})

	// API routes
	api := app.Group("/api")

	// Auth routes (public)
	auth := api.Group("/auth")
	auth.Post("/register", handlers.Register)
	auth.Post("/login", handlers.Login)
	auth.Get("/captcha", handlers.GenerateCaptcha)
	auth.Get("/me", middleware.AuthRequired(), handlers.GetMe)

	// Stream endpoint: accepts token via header OR query param (for HTML5 Audio)
	// MUST be before the protected group to avoid AuthRequired middleware
	api.Get("/tracks/:id/stream", middleware.AuthQueryOrHeader(), handlers.StreamTrack)

	// ALL other API routes require auth
	protected := api.Group("", middleware.AuthRequired())

	// Track routes (most need auth)
	tracks := protected.Group("/tracks")
	tracks.Get("/", handlers.GetTracks)
	tracks.Get("/search", handlers.SearchTracks)
	tracks.Get("/recommendations", handlers.GetRecommendations)
	tracks.Post("/sync", handlers.SyncTracks)
	tracks.Get("/:id", handlers.GetTrack)

	// Artist & Genre routes
	protected.Get("/artists", handlers.GetArtists)
	protected.Get("/genres", handlers.GetGenres)

	// Album routes
	protected.Get("/albums", handlers.GetAlbums)
	protected.Get("/albums/*", handlers.GetAlbum)
	protected.Get("/artists/:name/albums", handlers.GetArtistAlbums)

	// Lyrics route
	protected.Get("/lyrics", handlers.GetLyrics)

	// Settings routes
	protected.Get("/settings/crossfade", handlers.GetCrossfade)
	protected.Post("/settings/crossfade", handlers.ToggleCrossfade)

	// Personalized "For You" route
	protected.Get("/foryou", handlers.GetForYou)

	// Playlist routes
	playlists := protected.Group("/playlists")
	playlists.Get("/", handlers.GetPlaylists)
	playlists.Post("/", handlers.CreatePlaylist)
	playlists.Get("/:id", handlers.GetPlaylist)
	playlists.Put("/:id", handlers.UpdatePlaylist)
	playlists.Delete("/:id", handlers.DeletePlaylist)
	playlists.Post("/:id/tracks", handlers.AddTrackToPlaylist)
	playlists.Delete("/:id/tracks/:trackId", handlers.RemoveTrackFromPlaylist)

	// History routes
	history := protected.Group("/history")
	history.Get("/", handlers.GetHistory)
	history.Post("/", handlers.LogListen)
	history.Delete("/:id", handlers.DeleteHistoryEntry)

	// Serve frontend static files (AFTER all API routes)
	webDir := "./web/dist"
	if _, err := os.Stat(webDir); err == nil {
		app.Static("/assets", filepath.Join(webDir, "assets"))

		// Static root-level files (favicon, logo, manifest, etc.)
		staticFiles := []string{
			"favicon.ico", "favicon-16x16.png", "favicon-32x32.png",
			"apple-touch-icon.png", "android-chrome-192x192.png",
			"android-chrome-512x512.png", "logo.png", "site.webmanifest",
		}
		for _, f := range staticFiles {
			localPath := filepath.Join(webDir, f)
			if _, err := os.Stat(localPath); err == nil {
				app.Get("/"+f, func(c *fiber.Ctx) error {
					return c.SendFile(localPath)
				})
			}
		}

		// SPA catch-all: serve index.html for all non-API, non-static routes
		app.Get("/*", func(c *fiber.Ctx) error {
			return c.SendFile(filepath.Join(webDir, "index.html"))
		})
	} else {
		log.Printf("Warning: frontend not found at %s, serving API only", webDir)
	}

	log.Printf("🎵 Omnia Music starting on port %s", cfg.Port)
	log.Printf("📁 Audio path: %s", cfg.AudioPath)
	log.Printf("💾 Database: %s", cfg.DBPath)
	log.Printf("👤 Default user: kresna (seeded)")

	if err := app.Listen(":" + cfg.Port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
