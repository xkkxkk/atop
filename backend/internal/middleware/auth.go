package middleware

import (
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
	pkgjwt "github.com/company/atop-backend/pkg/jwt"
	"github.com/company/atop-backend/pkg/response"
)

const (
	CtxUserID    = "userID"
	CtxUserRoles = "userRoles" // comma-separated role names
	CtxUserEmail = "userEmail"
	CtxProjects  = "projects"
	// Backward compat
	CtxUserRole = "userRole"
)

type statusEntry struct {
	disabled  bool
	sessionID string
	expiresAt time.Time
}

var (
	statusCache   = make(map[string]statusEntry)
	statusCacheMu sync.RWMutex
	cacheTTL      = 30 * time.Second
)

func InvalidateUserCache(userID string) {
	statusCacheMu.Lock()
	delete(statusCache, userID)
	statusCacheMu.Unlock()
}

func validateUserSession(userID, sessionID string) (disabled bool, sessionMismatch bool) {
	singleSessionEnabled := config.Global != nil && config.Global.Auth.SingleSessionEnabled
	statusCacheMu.RLock()
	entry, ok := statusCache[userID]
	statusCacheMu.RUnlock()

	if ok && time.Now().Before(entry.expiresAt) && !singleSessionEnabled {
		return entry.disabled, false
	}

	var user model.User
	if err := database.DB.Select("status", "current_session_id").First(&user, "id = ?", userID).Error; err != nil {
		return true, false
	}

	disabled = user.Status != "active"
	statusCacheMu.Lock()
	statusCache[userID] = statusEntry{
		disabled:  disabled,
		sessionID: user.CurrentSessionID,
		expiresAt: time.Now().Add(cacheTTL),
	}
	statusCacheMu.Unlock()

	if singleSessionEnabled {
		if user.CurrentSessionID == "" || sessionID == "" || user.CurrentSessionID != sessionID {
			return disabled, true
		}
	}
	return disabled, false
}

// Auth validates the Bearer token and checks user is still active.
func Auth() gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if header == "" || !strings.HasPrefix(header, "Bearer ") {
			response.Unauthorized(c, "缺少认证 Token")
			c.Abort()
			return
		}

		tokenStr := strings.TrimPrefix(header, "Bearer ")
		claims, err := pkgjwt.ParseToken(tokenStr)
		if err != nil {
			response.Unauthorized(c, "Token 无效或已过期")
			c.Abort()
			return
		}

		disabled, sessionMismatch := validateUserSession(claims.UserID, claims.SessionID)
		if disabled {
			response.Unauthorized(c, "账户已被禁用，请联系管理员")
			c.Abort()
			return
		}
		if sessionMismatch {
			response.Unauthorized(c, "当前账号已在其他地方登录，请重新登录")
			c.Abort()
			return
		}

		rolesStr := strings.Join(claims.Roles, ",")
		c.Set(CtxUserID, claims.UserID)
		c.Set(CtxUserRoles, rolesStr)
		c.Set(CtxUserEmail, claims.Email)
		c.Set(CtxProjects, claims.Projects)

		if len(claims.Roles) > 0 {
			c.Set(CtxUserRole, claims.Roles[0])
		} else {
			c.Set(CtxUserRole, "")
		}
		c.Next()
	}
}

// GetUserRoles returns the user's roles from context.
func GetUserRoles(c *gin.Context) []string {
	rolesStr := c.GetString(CtxUserRoles)
	if rolesStr == "" {
		return []string{}
	}
	return strings.Split(rolesStr, ",")
}

// HasRole checks if the user has a specific role.
func HasRole(c *gin.Context, role string) bool {
	for _, r := range GetUserRoles(c) {
		if r == role {
			return true
		}
	}
	return false
}

// IsSuperAdmin checks if user has super_admin role.
func IsSuperAdmin(c *gin.Context) bool {
	return HasRole(c, string(model.RoleSuperAdmin))
}

// RequireRole ensures the user has one of the allowed roles.
func RequireRole(roles ...model.UserRole) gin.HandlerFunc {
	return func(c *gin.Context) {
		userRoles := GetUserRoles(c)
		for _, ur := range userRoles {
			for _, r := range roles {
				if ur == string(r) {
					c.Next()
					return
				}
			}
		}
		response.Forbidden(c, "权限不足")
		c.Abort()
	}
}

func SuperAdmin() gin.HandlerFunc {
	return RequireRole(model.RoleSuperAdmin)
}

func ProjectManager() gin.HandlerFunc {
	return RequireRole(model.RoleSuperAdmin, model.RoleProjectManager)
}

// RequirePermission allows super_admin always, plus checks all user roles + user overrides (union).
func RequirePermission(resource, action string) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetString(CtxUserID)
		userRoles := GetUserRoles(c)

		for _, r := range userRoles {
			if r == string(model.RoleSuperAdmin) {
				c.Next()
				return
			}
		}

		for _, roleName := range userRoles {
			if roleName == "" {
				continue
			}
			var roleObj struct{ Status string }
			if err := database.DB.Table("roles").
				Where("name = ?", roleName).
				Select("status").First(&roleObj).Error; err != nil {
				continue
			}
			if roleObj.Status == "disabled" {
				continue
			}
			var rp struct{ Allow bool }
			if err := database.DB.Table("role_permissions").
				Where("role = ? AND resource = ? AND action = ?", roleName, resource, action).
				First(&rp).Error; err == nil && rp.Allow {
				c.Next()
				return
			}
		}

		var up struct{ Allow bool }
		if err := database.DB.Table("user_permissions").
			Where("user_id = ? AND resource = ? AND action = ?", userID, resource, action).
			First(&up).Error; err == nil && up.Allow {
			c.Next()
			return
		}

		c.JSON(403, gin.H{"code": "FORBIDDEN", "message": "权限不足"})
		c.Abort()
	}
}

func GetUserID(c *gin.Context) string    { return c.GetString(CtxUserID) }
func GetUserRole(c *gin.Context) string  { return c.GetString(CtxUserRole) }
func GetUserEmail(c *gin.Context) string { return c.GetString(CtxUserEmail) }

