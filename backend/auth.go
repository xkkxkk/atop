package handler

import (
  "crypto/rand"
  "encoding/hex"
  "fmt"
  "net/http"
  "os"
  "strings"
  "time"

  "github.com/gin-gonic/gin"
  "github.com/google/uuid"
  "go.uber.org/zap"
  "golang.org/x/crypto/bcrypt"
  "gorm.io/gorm"

  "github.com/company/atop-backend/internal/config"
  "github.com/company/atop-backend/internal/database"
  "github.com/company/atop-backend/internal/middleware"
  "github.com/company/atop-backend/internal/model"
  "github.com/company/atop-backend/internal/util"
  "github.com/company/atop-backend/pkg/jwt"
  "github.com/company/atop-backend/pkg/logger"
  "github.com/company/atop-backend/pkg/response"
)

type AuthHandler struct{}

type loginReq struct {
  Email    string `json:"email" binding:"required,email"`
  Password string `json:"password" binding:"required,min=1"`
}

type refreshReq struct {
  RefreshToken string `json:"refreshToken"`
}

type changePwdReq struct {
  OldPassword string `json:"oldPassword" binding:"required"`
  NewPassword string `json:"newPassword" binding:"required,min=8"`
}

const refreshTokenCookieName = "atop_refresh_token"

func refreshCookieSameSite() http.SameSite {
  switch strings.ToLower(strings.TrimSpace(config.Global.App.CookieSameSite)) {
  case "strict":
    return http.SameSiteStrictMode
  case "none":
    return http.SameSiteNoneMode
  default:
    return http.SameSiteLaxMode
  }
}

func validatePasswordStrength(password string) error {
  if len(password) < 8 {
    return fmt.Errorf("密码至少 8 位")
  }

  hasUpper, hasLower, hasDigit := false, false, false
  for _, c := range password {
    switch {
    case c >= 'A' && c <= 'Z':
      hasUpper = true
    case c >= 'a' && c <= 'z':
      hasLower = true
    case c >= '0' && c <= '9':
      hasDigit = true
    }
  }

  if !hasUpper || !hasLower || !hasDigit {
    return fmt.Errorf("密码需包含大写字母、小写字母和数字")
  }

  return nil
}

func refreshCookieSecure(c *gin.Context) bool {
  switch strings.ToLower(strings.TrimSpace(config.Global.App.CookieSecure)) {
  case "true", "1", "yes", "on":
    return true
  case "false", "0", "no", "off":
    return false
  }

  if refreshCookieSameSite() == http.SameSiteNoneMode {
    return true
  }

  if strings.EqualFold(strings.TrimSpace(c.GetHeader("X-Forwarded-Proto")), "https") {
    return true
  }
  return strings.HasPrefix(strings.ToLower(strings.TrimSpace(config.Global.App.ExternalURL)), "https://")
}

func setRefreshTokenCookie(c *gin.Context, token string) {
  http.SetCookie(c.Writer, &http.Cookie{
    Name:     refreshTokenCookieName,
    Value:    token,
    Domain:   strings.TrimSpace(config.Global.App.CookieDomain),
    Path:     "/",
    MaxAge:   int(config.Global.JWT.RefreshTokenTTL.Seconds()),
    HttpOnly: true,
    SameSite: refreshCookieSameSite(),
    Secure:   refreshCookieSecure(c),
  })
}

func clearRefreshTokenCookie(c *gin.Context) {
  http.SetCookie(c.Writer, &http.Cookie{
    Name:     refreshTokenCookieName,
    Value:    "",
    Domain:   strings.TrimSpace(config.Global.App.CookieDomain),
    Path:     "/",
    MaxAge:   -1,
    HttpOnly: true,
    SameSite: refreshCookieSameSite(),
    Secure:   refreshCookieSecure(c),
  })
}

func resolveRefreshToken(c *gin.Context, bodyToken string) string {
  if cookieToken, err := c.Cookie(refreshTokenCookieName); err == nil {
    if token := strings.TrimSpace(cookieToken); token != "" {
      return token
    }
  }
  return strings.TrimSpace(bodyToken)
}

func buildPublicBaseURL(c *gin.Context) string {
  if external := strings.TrimSpace(config.Global.App.ExternalURL); external != "" {
    return strings.TrimRight(external, "/")
  }

  scheme := strings.TrimSpace(c.GetHeader("X-Forwarded-Proto"))
  if scheme == "" {
    if c.Request.TLS != nil {
      scheme = "https"
    } else {
      scheme = "http"
    }
  }

  host := strings.TrimSpace(c.GetHeader("X-Forwarded-Host"))
  if host == "" {
    host = c.Request.Host
  }

  return fmt.Sprintf("%s://%s", scheme, host)
}

func getUserRoles(userID string) []string {
  var bindings []model.UserRoleBinding
  database.DB.Where("user_id = ?", userID).Find(&bindings)

  roles := make([]string, 0, len(bindings))
  for _, binding := range bindings {
    roles = append(roles, binding.RoleName)
  }

  if len(roles) == 0 {
    var user model.User
    if err := database.DB.Select("role").First(&user, "id = ?", userID).Error; err == nil {
      if string(user.Role) != "" {
        roles = append(roles, string(user.Role))
      }
    }
  }

  return roles
}

func singleSessionEnabled() bool {
  return config.Global != nil && config.Global.Auth.SingleSessionEnabled
}

func issueAuthSession(c *gin.Context, user *model.User, mustChangePwd bool) (gin.H, error) {
  projects := util.FromJSONDefault[[]string](user.Projects, []string{})
  roles := getUserRoles(user.ID)
  sessionID := uuid.New().String()
  refreshTokenValue := uuid.New().String()
  refreshToken := model.RefreshToken{
    ID:        uuid.New().String(),
    UserID:    user.ID,
    Token:     refreshTokenValue,
    SessionID: sessionID,
    ExpiresAt: time.Now().Add(config.Global.JWT.RefreshTokenTTL),
  }

  if singleSessionEnabled() {
    if err := database.DB.Transaction(func(tx *gorm.DB) error {
      if err := tx.Model(&model.User{}).
        Where("id = ?", user.ID).
        Update("current_session_id", sessionID).Error; err != nil {
        return err
      }
      if err := tx.Where("user_id = ?", user.ID).Delete(&model.RefreshToken{}).Error; err != nil {
        return err
      }
      if err := tx.Create(&refreshToken).Error; err != nil {
        return err
      }
      return nil
    }); err != nil {
      return nil, err
    }
    user.CurrentSessionID = sessionID
    middleware.InvalidateUserCache(user.ID)
  } else if err := database.DB.Create(&refreshToken).Error; err != nil {
    return nil, err
  }

  accessToken, err := jwt.GenerateAccessToken(user.ID, user.Email, roles, projects, sessionID)
  if err != nil {
    return nil, err
  }

  setRefreshTokenCookie(c, refreshTokenValue)

  return gin.H{
    "accessToken":   accessToken,
    "mustChangePwd": mustChangePwd,
    "user": gin.H{
      "id":            user.ID,
      "username":      user.Username,
      "email":         user.Email,
      "roles":         roles,
      "role":          user.Role,
      "projects":      projects,
      "status":        user.Status,
      "avatarUrl":     user.AvatarURL,
      "mustChangePwd": mustChangePwd,
    },
  }, nil
}

func (h *AuthHandler) Login(c *gin.Context) {
  var req loginReq
  if err := c.ShouldBindJSON(&req); err != nil {
    response.BadRequest(c, "INVALID_PARAMS", err.Error())
    return
  }

  var user model.User
  if err := database.DB.Where("email = ?", req.Email).First(&user).Error; err != nil {
    response.Unauthorized(c, "邮箱或密码错误")
    return
  }

  if user.Status != "active" {
    response.Unauthorized(c, "账户已被禁用")
    return
  }

  if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
    response.Unauthorized(c, "邮箱或密码错误")
    return
  }

  if user.MustChangePwd && user.TempPasswordExpiresAt != nil && time.Now().After(*user.TempPasswordExpiresAt) {
    database.DB.Model(&user).Updates(map[string]any{
      "password_hash":             "",
      "temp_password_expires_at":  nil,
      "reset_token":               "",
      "reset_token_exp":           0,
    })
    response.Unauthorized(c, "临时密码已过期，请联系管理员重新重置密码")
    return
  }

  payload, err := issueAuthSession(c, &user, user.MustChangePwd)
  if err != nil {
    response.InternalError(c, "生成 Token 失败")
    return
  }

  now := time.Now()
  database.DB.Model(&user).Update("last_login_at", now)
  WriteAuditLog(user.ID, user.Email, "登录", "用户", user.ID, user.Username,
    util.RealIP(c.GetHeader("X-Forwarded-For"), c.Request.RemoteAddr), nil)

  response.OK(c, payload)
}

func (h *AuthHandler) Refresh(c *gin.Context) {
  var req refreshReq
  if err := c.ShouldBindJSON(&req); err != nil && err.Error() != "EOF" {
    response.BadRequest(c, "INVALID_PARAMS", "refreshToken 格式不正确")
    return
  }

  refreshToken := resolveRefreshToken(c, req.RefreshToken)
  if refreshToken == "" {
    clearRefreshTokenCookie(c)
    response.Unauthorized(c, "Refresh Token 无效或已过期")
    return
  }

  var session model.RefreshToken
  if err := database.DB.Where("token = ? AND expires_at > ?", refreshToken, time.Now()).First(&session).Error; err != nil {
    clearRefreshTokenCookie(c)
    response.Unauthorized(c, "Refresh Token 无效或已过期")
    return
  }

  var user model.User
  if err := database.DB.First(&user, "id = ?", session.UserID).Error; err != nil {
    clearRefreshTokenCookie(c)
    response.Unauthorized(c, "用户不存在")
    return
  }

  if user.Status != "active" {
    clearRefreshTokenCookie(c)
    response.Unauthorized(c, "账户已被禁用")
    return
  }

  if singleSessionEnabled() && (session.SessionID == "" || session.SessionID != user.CurrentSessionID) {
    database.DB.Delete(&session)
    clearRefreshTokenCookie(c)
    response.Unauthorized(c, "当前账号已在其他地方登录，请重新登录")
    return
  }

  projects := util.FromJSONDefault[[]string](user.Projects, []string{})
  roles := getUserRoles(user.ID)

  accessToken, err := jwt.GenerateAccessToken(user.ID, user.Email, roles, projects, session.SessionID)
  if err != nil {
    response.InternalError(c, "生成 Token 失败")
    return
  }

  response.OK(c, gin.H{"accessToken": accessToken})
}

func (h *AuthHandler) Logout(c *gin.Context) {
  if refreshToken := resolveRefreshToken(c, ""); refreshToken != "" {
    database.DB.Where("token = ?", refreshToken).Delete(&model.RefreshToken{})
  }
  clearRefreshTokenCookie(c)
  response.OK(c, gin.H{"ok": true})
}

func (h *AuthHandler) ChangePassword(c *gin.Context) {
  var req changePwdReq
  if err := c.ShouldBindJSON(&req); err != nil {
    response.BadRequest(c, "INVALID_PARAMS", err.Error())
    return
  }

  if err := validatePasswordStrength(req.NewPassword); err != nil {
    response.BadRequest(c, "WEAK_PASSWORD", err.Error())
    return
  }

  userID := middleware.GetUserID(c)
  var user model.User
  if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
    response.NotFound(c, "用户不存在")
    return
  }

  if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.OldPassword)); err != nil {
    response.BadRequest(c, "WRONG_PASSWORD", "旧密码错误")
    return
  }

  hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
  if err != nil {
    response.InternalError(c, "密码加密失败")
    return
  }

  if err := database.DB.Model(&user).Updates(map[string]any{
    "password_hash":             string(hash),
    "must_change_pwd":           false,
    "temp_password_expires_at":  nil,
  }).Error; err != nil {
    response.InternalError(c, "密码保存失败")
    return
  }
  user.PasswordHash = string(hash)
  user.MustChangePwd = false
  user.TempPasswordExpiresAt = nil

  database.DB.Where("user_id = ?", user.ID).Delete(&model.RefreshToken{})
  payload, err := issueAuthSession(c, &user, false)
  if err != nil {
    response.InternalError(c, "创建会话失败")
    return
  }

  response.OK(c, payload)
}

func (h *AuthHandler) Health(c *gin.Context) {
  if err := database.Ping(); err != nil {
    response.InternalError(c, "database unreachable")
    return
  }
  response.OK(c, gin.H{"status": "ok", "db": "ok", "version": "1.0.0"})
}

func (h *AuthHandler) Version(c *gin.Context) {
  response.OK(c, gin.H{
    "name":      "atop-backend",
		"version":   envOr("APP_VERSION", "v1.0.26"),
		"latest":    envOr("APP_LATEST_VERSION", envOr("APP_VERSION", "v1.0.26")),
		"buildTime": envOr("BUILD_TIME", "2026-05-22 08:45"),
		"commit":    envOr("GIT_COMMIT", "remove-document-center-20260522"),
    "env":       envOr("APP_ENV", "development"),
    "status":    "ok",
    "features": []string{
      "流水线运行调度",
      "Jenkins 上报",
      "运行质量统计",
      "版本快照与回滚",
      "用户级筛选视图",
      "用户偏好配置",
      "通知规则测试",
      "前后端版本提示",
      "版本管理页",
      "版本管理左侧菜单",
      "Jenkins 模板折叠",
      "Agent 容量状态收敛",
      "版本管理页精修",
      "版本搜索定位与复制修复",
      "版本管理工作区间距修正",
      "文档中心能力移除",
    },
    "changes": []string{
      "新增 saved_filter_views 表与 /saved-filter-views 接口，筛选视图按用户和页面保存",
      "新增 user_preferences 表与 /users/me/preferences/:key 接口，顶部固定标签按用户偏好保存",
      "新增 /notifications/rules/:id/test 接口，支持站内消息、邮件、钉钉、飞书和自定义 Webhook 真实测试发送",
      "通知规则测试发送按规则接收人配置投递，不再只发送给当前登录用户",
      "通知规则查询、创建、编辑、删除、启停和测试接口补齐后端权限校验",
			"数据库迁移会在后端启动时自动创建新增表",
			"后端版本接口补充本次后端更新内容，版本弹窗可正确展示后端变更",
			"前端固定标签偏好读取增加同用户同权限签名硬闸门，避免重复渲染触发连续请求",
			"通知规则测试结果只统计实际勾选并发送成功的渠道，未勾选邮件时不返回邮箱数量",
			"前端优化全局命令搜索、消息铃铛与用户级筛选视图交互",
			"筛选条件已命中预设或已保存视图时，保存当前进入已保存状态，避免重复保存",
			"运行大盘的全屏按钮改为当前页面直接进入浏览器全屏，不再跳转独立全屏页",
			"统一页面底部 10px 间距，Jenkins 实例等页面底部不再贴边",
			"版本弹窗等待前端静态版本和后端版本接口都完成检测后再一次性汇总展示",
			"版本弹窗改为单一滚动区和版本摘要布局，避免前后端内容分段闪现和卡片内部滚动条",
			"原全屏大盘中的高频流水线质量、质量风险 Top 5、Agent 容量状态已并入运行大盘",
			"前端移除文档中心路由、导航、搜索入口和相关渲染依赖，平台聚焦 DevOps 主线",
			"后端版本接口同步返回 v1.0.26 信息，并从当前版本特性中移除文档中心定位",
		},
	})
}

func envOr(key, fallback string) string {
  if value := os.Getenv(key); value != "" {
    return value
  }
  return fallback
}

func (h *AuthHandler) ForgotPassword(c *gin.Context) {
  var req struct {
    Email string `json:"email"`
  }
  if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Email) == "" {
    response.BadRequest(c, "INVALID_PARAMS", "请输入邮箱")
    return
  }

  successMessage := "如果该邮箱已注册，重置链接已发送，请查收邮件"

  var user model.User
  if err := database.DB.Where("email = ?", strings.TrimSpace(req.Email)).First(&user).Error; err != nil {
    response.OK(c, gin.H{"message": successMessage})
    return
  }

  if user.Status != "active" {
    response.OK(c, gin.H{"message": successMessage})
    return
  }

  tokenBytes := make([]byte, 32)
  if _, err := rand.Read(tokenBytes); err != nil {
    response.InternalError(c, "生成重置链接失败")
    return
  }
  token := hex.EncodeToString(tokenBytes)
  expires := time.Now().Add(30 * time.Minute).Unix()

  database.DB.Model(&user).Updates(map[string]any{
    "reset_token":     token,
    "reset_token_exp": expires,
  })

  cfg := config.Global.SMTP
  if cfg.Enabled {
    resetURL := fmt.Sprintf("%s/reset-password?token=%s", buildPublicBaseURL(c), token)

    go func() {
      htmlBody := util.ResetPasswordEmailHTML(user.Username, resetURL, 30)
      if err := util.SendEmail(cfg.Host, cfg.Port, cfg.Username, cfg.Password, cfg.From, user.Email, "【ATOP】密码重置申请", htmlBody, cfg.Security); err != nil {
        logger.Error("send reset email failed", zap.String("email", user.Email), zap.Error(err))
      }
    }()
  }

  response.OK(c, gin.H{"message": successMessage})
}

func (h *AuthHandler) ResetPasswordByToken(c *gin.Context) {
  var req struct {
    Token       string `json:"token"`
    NewPassword string `json:"newPassword"`
  }
  if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Token) == "" || strings.TrimSpace(req.NewPassword) == "" {
    response.BadRequest(c, "INVALID_PARAMS", "参数不完整")
    return
  }

  if err := validatePasswordStrength(req.NewPassword); err != nil {
    response.BadRequest(c, "WEAK_PASSWORD", err.Error())
    return
  }

  var user model.User
  if err := database.DB.Where("reset_token = ?", strings.TrimSpace(req.Token)).First(&user).Error; err != nil {
    response.BadRequest(c, "INVALID_TOKEN", "重置链接无效或已过期")
    return
  }

  if user.ResetTokenExp == 0 || time.Now().Unix() > user.ResetTokenExp {
    database.DB.Model(&user).Updates(map[string]any{"reset_token": "", "reset_token_exp": 0})
    response.BadRequest(c, "TOKEN_EXPIRED", "重置链接已过期（30分钟有效期），请重新申请")
    return
  }

  hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
  if err != nil {
    response.InternalError(c, "密码加密失败")
    return
  }

  if err := database.DB.Model(&user).Updates(map[string]any{
    "password_hash":             string(hash),
    "must_change_pwd":           false,
    "temp_password_expires_at":  nil,
    "reset_token":               "",
    "reset_token_exp":           0,
  }).Error; err != nil {
    response.InternalError(c, "密码保存失败")
    return
  }
  user.PasswordHash = string(hash)
  user.MustChangePwd = false
  user.TempPasswordExpiresAt = nil
  user.ResetToken = ""
  user.ResetTokenExp = 0

  database.DB.Where("user_id = ?", user.ID).Delete(&model.RefreshToken{})
  payload, err := issueAuthSession(c, &user, false)
  if err != nil {
    response.InternalError(c, "创建会话失败")
    return
  }

  WriteAuditLog(user.ID, user.Email, "重置密码", "用户", user.ID, user.Username,
    util.RealIP(c.GetHeader("X-Forwarded-For"), c.Request.RemoteAddr), nil)

  payload["message"] = "密码重置成功，已为你自动登录"
  response.OK(c, payload)
}

func (h *AuthHandler) ValidateResetToken(c *gin.Context) {
  token := strings.TrimSpace(c.Query("token"))
  if token == "" {
    response.BadRequest(c, "MISSING_TOKEN", "缺少 token")
    return
  }

  var user model.User
  if err := database.DB.Where("reset_token = ?", token).First(&user).Error; err != nil {
    response.OK(c, gin.H{"valid": false, "reason": "链接无效"})
    return
  }

  if time.Now().Unix() > user.ResetTokenExp {
    response.OK(c, gin.H{"valid": false, "reason": "链接已过期，请重新申请"})
    return
  }

  response.OK(c, gin.H{"valid": true, "email": user.Email, "username": user.Username})
}
