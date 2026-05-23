package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	App      AppConfig
	Database DatabaseConfig
	JWT      JWTConfig
	Auth     AuthConfig
	CORS     CORSConfig
	Jenkins  JenkinsConfig
	SMTP     SMTPConfig
}

type AppConfig struct {
	Port        string
	Env         string // development | production
	LogLevel    string
	AdminEmail    string
	AdminPassword string
	ExternalURL   string // Base URL for email links, e.g. http://47.108.197.129:8888
	CookieDomain   string
	CookieSameSite string // lax | strict | none
	CookieSecure   string // auto | true | false
}

type DatabaseConfig struct {
	DSN             string
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
	SlowThreshold   time.Duration // log slow queries
}

type JWTConfig struct {
	Secret          string
	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration
}

type AuthConfig struct {
	SingleSessionEnabled bool
}

type CORSConfig struct {
	AllowOrigins     []string
	AllowCredentials bool
}

type SMTPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	Security string // auto | ssl | starttls | none
	Enabled  bool
}

type JenkinsConfig struct {
	RequestTimeout      time.Duration
	MaxConcurrentCalls  int
	RetryCount          int
	RetryWaitSeconds    int
}

var Global *Config

// Load reads environment variables (and optional .env file) into Global config.
func Load() error {
	// Load .env if present (non-fatal if missing)
	_ = godotenv.Load()

	cfg := &Config{}

	// App
	cfg.App = AppConfig{
		Port:          getEnv("PORT", "8080"),
		Env:           getEnv("APP_ENV", "development"),
		LogLevel:      getEnv("LOG_LEVEL", "info"),
		AdminEmail:    getEnv("ADMIN_EMAIL", "admin@atop.local"),
		AdminPassword: getEnv("ADMIN_PASSWORD", "#PassW0rd"),
		ExternalURL:   getEnv("EXTERNAL_URL", ""),
		CookieDomain:  getEnv("COOKIE_DOMAIN", ""),
		CookieSameSite: getEnv("COOKIE_SAME_SITE", "lax"),
		CookieSecure:  getEnv("COOKIE_SECURE", "auto"),
	}

	// Database
	dsn := os.Getenv("DB_DSN")
	if dsn == "" {
		host     := getEnv("DB_HOST", "localhost")
		port     := getEnv("DB_PORT", "3306")
		user     := getEnv("DB_USER", "root")
		password := getEnv("DB_PASSWORD", "")
		dbname   := getEnv("DB_NAME", "atop")
		dsn = fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?charset=utf8mb4&parseTime=True&loc=Local",
			user, password, host, port, dbname)
	}
	cfg.Database = DatabaseConfig{
		DSN:             dsn,
		MaxOpenConns:    getEnvInt("DB_MAX_OPEN_CONNS", 50),
		MaxIdleConns:    getEnvInt("DB_MAX_IDLE_CONNS", 10),
		ConnMaxLifetime: time.Duration(getEnvInt("DB_CONN_MAX_LIFETIME_MINUTES", 30)) * time.Minute,
		ConnMaxIdleTime: time.Duration(getEnvInt("DB_CONN_MAX_IDLE_MINUTES", 10)) * time.Minute,
		SlowThreshold:   time.Duration(getEnvInt("DB_SLOW_THRESHOLD_MS", 200)) * time.Millisecond,
	}

	// JWT
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		jwtSecret = "atop-dev-secret-change-in-production"
		if os.Getenv("APP_ENV") == "production" {
			panic("[SECURITY] JWT_SECRET must be set in production! Never use default secret.")
		}
	}
	cfg.JWT = JWTConfig{
		Secret:          jwtSecret,
		AccessTokenTTL:  time.Duration(getEnvInt("JWT_ACCESS_TTL_HOURS", 8)) * time.Hour,
		RefreshTokenTTL: time.Duration(getEnvInt("JWT_REFRESH_TTL_DAYS", 7)) * 24 * time.Hour,
	}
	cfg.Auth = AuthConfig{
		SingleSessionEnabled: getEnvBool("AUTH_SINGLE_SESSION_ENABLED", false),
	}

	// CORS
	cfg.CORS = CORSConfig{
		AllowOrigins:     splitAndTrim(getEnv("CORS_ALLOW_ORIGINS", "")),
		AllowCredentials: getEnvBool("CORS_ALLOW_CREDENTIALS", true),
	}

	// Jenkins
	cfg.Jenkins = JenkinsConfig{
		RequestTimeout:     time.Duration(getEnvInt("JENKINS_TIMEOUT_SECONDS", 10)) * time.Second,
		MaxConcurrentCalls: getEnvInt("JENKINS_MAX_CONCURRENT", 20),
		RetryCount:         getEnvInt("JENKINS_RETRY_COUNT", 3),
		RetryWaitSeconds:   getEnvInt("JENKINS_RETRY_WAIT_SECONDS", 30),
	}

	// SMTP
	smtpFrom := getEnv("SMTP_FROM", "")
	if smtpFrom == "" {
		smtpFrom = getEnv("SMTP_USER", "")
	}
	cfg.SMTP = SMTPConfig{
		Host:     getEnv("SMTP_HOST", ""),
		Port:     getEnvInt("SMTP_PORT", 465),
		Username: getEnv("SMTP_USER", ""),
		Password: getEnv("SMTP_PASS", ""),
		From:     smtpFrom,
		Security: strings.ToLower(getEnv("SMTP_SECURITY", "auto")),
	}
	cfg.SMTP.Enabled = cfg.SMTP.Host != "" &&
		cfg.SMTP.Port > 0 &&
		cfg.SMTP.Username != "" &&
		cfg.SMTP.Password != "" &&
		cfg.SMTP.From != ""

	Global = cfg
	return nil
}

func getEnv(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return defaultVal
}

func getEnvBool(key string, defaultVal bool) bool {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		switch strings.ToLower(v) {
		case "1", "true", "yes", "on":
			return true
		case "0", "false", "no", "off":
			return false
		}
	}
	return defaultVal
}

func splitAndTrim(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}

	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if item := strings.TrimSpace(part); item != "" {
			result = append(result, item)
		}
	}
	return result
}
