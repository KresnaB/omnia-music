package handlers

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	"omnia-music/server/middleware"
	"omnia-music/server/models"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// Login rate limiting: IP -> attempts
var (
	loginAttempts = make(map[string][]time.Time)
	loginMu       sync.Mutex
	maxAttempts   = 5
	windowDuration = 15 * time.Minute
)

func isRateLimited(ip string) bool {
	loginMu.Lock()
	defer loginMu.Unlock()

	now := time.Now()
	attempts := loginAttempts[ip]

	// Clean old attempts
	var valid []time.Time
	for _, t := range attempts {
		if now.Sub(t) < windowDuration {
			valid = append(valid, t)
		}
	}
	loginAttempts[ip] = valid

	return len(valid) >= maxAttempts
}

func recordAttempt(ip string) {
	loginMu.Lock()
	defer loginMu.Unlock()
	loginAttempts[ip] = append(loginAttempts[ip], time.Now())
}

// CAPTCHA system
var captchaSecret string

func SetCaptchaSecret(secret string) {
	captchaSecret = secret
}

type CaptchaChallenge struct {
	Question string `json:"question"`
	Token    string `json:"token"`
}

func GenerateCaptcha(c *fiber.Ctx) error {
	// Generate random math problem
	a, _ := rand.Int(rand.Reader, big.NewInt(20))
	b, _ := rand.Int(rand.Reader, big.NewInt(20))
	aVal := int(a.Int64()) + 1
	bVal := int(b.Int64()) + 1

	operators := []string{"+", "-", "×"}
	opIdx, _ := rand.Int(rand.Reader, big.NewInt(3))
	op := operators[opIdx.Int64()]

	var answer int
	switch op {
	case "+":
		answer = aVal + bVal
	case "-":
		// Ensure positive result
		if aVal < bVal {
			aVal, bVal = bVal, aVal
		}
		answer = aVal - bVal
	case "×":
		aVal = int(a.Int64()) + 1
		bVal = int(b.Int64()) + 1
		answer = aVal * bVal
	}

	question := fmt.Sprintf("%d %s %d = ?", aVal, op, bVal)

	// Create HMAC-signed token with answer
	token := signCaptchaAnswer(answer)

	return c.JSON(CaptchaChallenge{
		Question: question,
		Token:    token,
	})
}

func signCaptchaAnswer(answer int) string {
	msg := fmt.Sprintf("%d:%d", answer, time.Now().Unix()/60) // Valid for ~1 minute
	mac := hmac.New(sha256.New, []byte(captchaSecret))
	mac.Write([]byte(msg))
	sig := hex.EncodeToString(mac.Sum(nil))
	return fmt.Sprintf("%s|%s", msg, sig)
}

func verifyCaptchaAnswer(token string, userAnswer int) bool {
	parts := strings.SplitN(token, "|", 2)
	if len(parts) != 2 {
		return false
	}
	msg := parts[0]
	sig := parts[1]

	// Verify HMAC
	mac := hmac.New(sha256.New, []byte(captchaSecret))
	mac.Write([]byte(msg))
	expectedSig := hex.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(sig), []byte(expectedSig)) {
		return false
	}

	// Extract answer from msg
	msgParts2 := strings.SplitN(msg, ":", 2)
	if len(msgParts2) != 2 {
		return false
	}

	var storedAnswer int
	fmt.Sscanf(msgParts2[0], "%d", &storedAnswer)

	return storedAnswer == userAnswer
}

func Register(c *fiber.Ctx) error {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}
	if body.Username == "" || body.Password == "" {
		return c.Status(400).JSON(fiber.Map{"error": "username and password required"})
	}
	if len(body.Username) < 3 || len(body.Username) > 32 {
		return c.Status(400).JSON(fiber.Map{"error": "username must be 3-32 characters"})
	}
	if len(body.Password) < 4 {
		return c.Status(400).JSON(fiber.Map{"error": "password must be at least 4 characters"})
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "internal error"})
	}

	if err := models.CreateUser(body.Username, string(hash)); err != nil {
		return c.Status(409).JSON(fiber.Map{"error": "username already exists"})
	}

	user, _ := models.GetUserByUsername(body.Username)
	token, err := generateToken(user)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to generate token"})
	}

	return c.Status(201).JSON(fiber.Map{
		"user":  fiber.Map{"id": user.ID, "username": user.Username},
		"token": token,
	})
}

func Login(c *fiber.Ctx) error {
	ip := c.IP()

	// Rate limit check
	if isRateLimited(ip) {
		return c.Status(429).JSON(fiber.Map{"error": "too many login attempts, try again later"})
	}

	var body struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		CaptchaAns  int    `json:"captcha_answer"`
		CaptchaToken string `json:"captcha_token"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid request"})
	}

	// Verify CAPTCHA
	if body.CaptchaToken == "" {
		return c.Status(400).JSON(fiber.Map{"error": "captcha required"})
	}
	if !verifyCaptchaAnswer(body.CaptchaToken, body.CaptchaAns) {
		recordAttempt(ip)
		return c.Status(400).JSON(fiber.Map{"error": "captcha salah, coba lagi"})
	}

	user, err := models.GetUserByUsername(body.Username)
	if err != nil {
		recordAttempt(ip)
		return c.Status(401).JSON(fiber.Map{"error": "invalid credentials"})
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		recordAttempt(ip)
		return c.Status(401).JSON(fiber.Map{"error": "invalid credentials"})
	}

	token, err := generateToken(user)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "failed to generate token"})
	}

	return c.JSON(fiber.Map{
		"user":  fiber.Map{"id": user.ID, "username": user.Username},
		"token": token,
	})
}

func GetMe(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(int)
	user, err := models.GetUserByID(userID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "user not found"})
	}
	return c.JSON(fiber.Map{"id": user.ID, "username": user.Username, "created_at": user.CreatedAt})
}

func generateToken(user *models.User) (string, error) {
	claims := &middleware.Claims{
		UserID:   user.ID,
		Username: user.Username,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(72 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(middleware.JWTSecret())
}
