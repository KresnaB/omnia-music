package middleware

import (
	"os"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID   int    `json:"user_id"`
	Username string `json:"username"`
	jwt.RegisteredClaims
}

func JWTSecret() []byte {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "omnia-music-secret-change-me"
	}
	return []byte(secret)
}

// validateToken parses and validates a JWT token string, setting user locals
func validateToken(c *fiber.Ctx, tokenStr string) error {
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
		return JWTSecret(), nil
	})
	if err != nil || !token.Valid {
		return fiber.NewError(401, "invalid or expired token")
	}
	c.Locals("user_id", claims.UserID)
	c.Locals("username", claims.Username)
	return nil
}

// AuthRequired requires JWT from Authorization header only
func AuthRequired() fiber.Handler {
	return func(c *fiber.Ctx) error {
		authHeader := c.Get("Authorization")
		if authHeader == "" {
			return c.Status(401).JSON(fiber.Map{"error": "missing authorization header"})
		}

		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")
		if tokenStr == authHeader {
			return c.Status(401).JSON(fiber.Map{"error": "invalid authorization format"})
		}

		if err := validateToken(c, tokenStr); err != nil {
			return c.Status(401).JSON(fiber.Map{"error": "invalid or expired token"})
		}
		return c.Next()
	}
}

// AuthQueryOrHeader accepts JWT from either Authorization header OR ?token= query param
// Used for streaming endpoints where HTML5 Audio can't send headers
func AuthQueryOrHeader() fiber.Handler {
	return func(c *fiber.Ctx) error {
		tokenStr := ""

		// Try Authorization header first
		authHeader := c.Get("Authorization")
		if authHeader != "" {
			tokenStr = strings.TrimPrefix(authHeader, "Bearer ")
			if tokenStr == authHeader {
				tokenStr = ""
			}
		}

		// Fall back to query param
		if tokenStr == "" {
			tokenStr = c.Query("token")
		}

		if tokenStr == "" {
			return c.Status(401).JSON(fiber.Map{"error": "missing authorization"})
		}

		if err := validateToken(c, tokenStr); err != nil {
			return c.Status(401).JSON(fiber.Map{"error": "invalid or expired token"})
		}
		return c.Next()
	}
}
