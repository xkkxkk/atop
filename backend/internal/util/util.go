package util

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// ── JSON helpers ──────────────────────────────────────────────────────────

func ToJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func FromJSON[T any](s string) (T, error) {
	var v T
	err := json.Unmarshal([]byte(s), &v)
	return v, err
}

func FromJSONDefault[T any](s string, def T) T {
	if s == "" {
		return def
	}
	v, err := FromJSON[T](s)
	if err != nil {
		return def
	}
	return v
}

// ── Pagination ────────────────────────────────────────────────────────────

func PageParams(pageStr, sizeStr string) (page, size, offset int) {
	page, _ = strconv.Atoi(pageStr)
	size, _ = strconv.Atoi(sizeStr)
	if page <= 0 {
		page = 1
	}
	if size <= 0 || size > 200 {
		size = 20
	}
	offset = (page - 1) * size
	return
}

// ── String helpers ────────────────────────────────────────────────────────

func StringsContains(slice []string, val string) bool {
	for _, s := range slice {
		if s == val {
			return true
		}
	}
	return false
}

func TruncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

// ── Encryption (AES-256-GCM) ──────────────────────────────────────────────

func getAESKey() []byte {
	key := os.Getenv("AES_KEY")
	if key == "" {
		key = "atop-dev-aes-key-change-in-prod!"
		if os.Getenv("APP_ENV") == "production" {
			panic("[SECURITY] AES_KEY must be set in production! Never use default key.")
		}
	}
	// Derive 32-byte key using SHA-256
	h := sha256.Sum256([]byte(key))
	return h[:]
}

func Encrypt(plaintext string) (string, error) {
	block, err := aes.NewCipher(getAESKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func Decrypt(encoded string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(getAESKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// ── SHA256 hash ───────────────────────────────────────────────────────────

func SHA256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return fmt.Sprintf("%x", h)
}

// ── IP extraction ─────────────────────────────────────────────────────────

func RealIP(forwardedFor, remoteAddr string) string {
	if forwardedFor != "" {
		parts := strings.Split(forwardedFor, ",")
		return strings.TrimSpace(parts[0])
	}
	// Strip port from remoteAddr
	if idx := strings.LastIndex(remoteAddr, ":"); idx != -1 {
		return remoteAddr[:idx]
	}
	return remoteAddr
}
