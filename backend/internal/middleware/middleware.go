package middleware

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/pkg/logger"
)

// CORS restricts origins based on CORS_ALLOW_ORIGINS env var.
// Defaults to localhost variants when no explicit allowlist is configured.
func CORS() gin.HandlerFunc {
	originSet := map[string]bool{}
	allowCredentials := true
	if config.Global != nil {
		for _, origin := range config.Global.CORS.AllowOrigins {
			if origin != "" {
				originSet[origin] = true
			}
		}
		allowCredentials = config.Global.CORS.AllowCredentials
	}

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		allowed := origin == ""

		if origin != "" {
			switch {
			case originSet["*"]:
				allowed = true
			case originSet[origin]:
				allowed = true
			case len(originSet) == 0:
				allowed = strings.Contains(origin, "localhost") || strings.Contains(origin, "127.0.0.1")
			default:
				allowed = false
			}
		}

		if !allowed && c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusForbidden)
			return
		}

		if origin != "" && allowed {
			if originSet["*"] && !allowCredentials {
				c.Header("Access-Control-Allow-Origin", "*")
			} else {
				c.Header("Access-Control-Allow-Origin", origin)
				c.Header("Vary", "Origin")
			}
			if allowCredentials {
				c.Header("Access-Control-Allow-Credentials", "true")
			}
		}
		c.Header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS,PATCH")
		c.Header("Access-Control-Allow-Headers", "Authorization,Content-Type,Origin,Accept,X-Requested-With,X-Button,X-Module,X-Request-ID")
		c.Header("Access-Control-Max-Age", "3600")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// loginAttempts tracks failed login attempts per IP.
var (
	loginMu       sync.Mutex
	loginAttempts = map[string]*loginBucket{}
)

type loginBucket struct {
	count     int
	lockUntil time.Time
	lastReset time.Time
}

const (
	loginMaxAttempts = 10      // max failures before lockout
	loginWindowSecs  = 10 * 60 // 10-minute window
	loginLockoutSecs = 30 * 60 // 30-minute lockout
)

// LoginRateLimit middleware blocks IPs with too many failed login attempts.
func LoginRateLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		loginMu.Lock()
		b, ok := loginAttempts[ip]
		if !ok {
			b = &loginBucket{lastReset: time.Now()}
			loginAttempts[ip] = b
		}
		if time.Since(b.lastReset).Seconds() > loginWindowSecs {
			b.count = 0
			b.lastReset = time.Now()
		}
		if !b.lockUntil.IsZero() && time.Now().Before(b.lockUntil) {
			remaining := int(time.Until(b.lockUntil).Minutes()) + 1
			loginMu.Unlock()
			c.JSON(http.StatusTooManyRequests, gin.H{
				"code":    "TOO_MANY_ATTEMPTS",
				"message": fmt.Sprintf("登录尝试次数过多，请 %d 分钟后再试", remaining),
			})
			c.Abort()
			return
		}
		loginMu.Unlock()

		c.Next()

		if c.Writer.Status() == http.StatusUnauthorized {
			loginMu.Lock()
			b.count++
			if b.count >= loginMaxAttempts {
				b.lockUntil = time.Now().Add(loginLockoutSecs * time.Second)
			}
			loginMu.Unlock()
		} else if c.Writer.Status() == http.StatusOK {
			loginMu.Lock()
			b.count = 0
			b.lockUntil = time.Time{}
			loginMu.Unlock()
		}
	}
}

// SecurityHeaders adds standard security response headers.
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("X-XSS-Protection", "1; mode=block")
		c.Header("Referrer-Policy", "strict-origin-when-cross-origin")
		c.Header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		if c.GetHeader("X-Forwarded-Proto") == "https" {
			c.Header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		c.Next()
	}
}

// externalURLCache caches the detected platform URL for notification emails.
var (
	externalURLOnce  sync.Once
	externalURLCache string
)

// SetExternalURLOnce stores the platform external URL the first time it's called.
func SetExternalURLOnce(url string) {
	if url == "" || url == "http://" || url == "https://" {
		return
	}
	externalURLOnce.Do(func() { externalURLCache = url })
}

// GetCachedExternalURL returns the auto-detected external URL.
func GetCachedExternalURL() string { return externalURLCache }

// RequestSizeLimit rejects requests with body larger than maxBytes.
func RequestSizeLimit(maxBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.ContentLength > maxBytes {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{
				"code":    "PAYLOAD_TOO_LARGE",
				"message": "请求体超过最大限制",
			})
			c.Abort()
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
		c.Next()
	}
}

// RequestLogger logs each incoming request with latency and status.
func RequestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path

		proto := c.GetHeader("X-Forwarded-Proto")
		if proto == "" {
			proto = "http"
		}
		host := c.GetHeader("X-Forwarded-Host")
		if host == "" {
			host = c.Request.Host
		}
		SetExternalURLOnce(proto + "://" + host)

		c.Next()
		latency := time.Since(start)
		status := c.Writer.Status()

		lvl := zap.InfoLevel
		if status >= 500 {
			lvl = zap.ErrorLevel
		} else if status >= 400 {
			lvl = zap.WarnLevel
		}

		logger.Log.Log(lvl, "http",
			zap.String("method", c.Request.Method),
			zap.String("path", path),
			zap.Int("status", status),
			zap.Duration("latency", latency),
			zap.String("ip", c.ClientIP()),
		)
	}
}

// Recovery recovers from panics and returns 500.
func Recovery() gin.HandlerFunc {
	return gin.CustomRecovery(func(c *gin.Context, recovered any) {
		logger.Error("panic recovered", zap.Any("err", recovered))
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    "INTERNAL_ERROR",
			"message": "服务器内部错误",
		})
	})
}

