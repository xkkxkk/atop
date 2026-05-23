package jwt

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/company/atop-backend/internal/config"
)

type Claims struct {
	UserID   string   `json:"userId"`
	Email    string   `json:"email"`
	Roles    []string `json:"roles"`
	Projects []string `json:"projects"`
	SessionID string   `json:"sid,omitempty"`
	jwt.RegisteredClaims
}

// GenerateAccessToken creates a short-lived access token.
func GenerateAccessToken(userID, email string, roles, projects []string, sessionID string) (string, error) {
	cfg := config.Global.JWT
	claims := Claims{
		UserID:   userID,
		Email:    email,
		Roles:    roles,
		Projects: projects,
		SessionID: sessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(cfg.AccessTokenTTL)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "atop",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(cfg.Secret))
}

// ParseToken validates a JWT string and returns the claims.
func ParseToken(tokenStr string) (*Claims, error) {
	cfg := config.Global.JWT
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(cfg.Secret), nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}
