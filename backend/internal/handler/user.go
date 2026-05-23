package handler

import (
	"crypto/rand"
	"encoding/csv"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	mysqlDriver "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"go.uber.org/zap"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/logger"
	"github.com/company/atop-backend/pkg/response"
)

type UserHandler struct{}

type createUserReq struct {
	Username string   `json:"username" binding:"required"`
	Email    string   `json:"email" binding:"required,email"`
	Password string   `json:"password"`
	Role     string   `json:"role"`     // backward compat: single role
	Roles    []string `json:"roles"`    // multi-role
	Projects []string `json:"projects"`
}

type updateAvatarReq struct {
	AvatarURL string `json:"avatarUrl"`
}

const (
	maxAvatarDataURLLength  = 768 * 1024
	defaultInitialPassword  = "#PassW0rd"
	temporaryPasswordLength = 16
	temporaryPasswordTTL    = 24 * time.Hour
)

var temporaryPasswordGroups = []string{
	"ABCDEFGHJKLMNPQRSTUVWXYZ",
	"abcdefghijkmnopqrstuvwxyz",
	"23456789",
	"!@#$%*.?",
}

func secureRandomChar(alphabet string) (byte, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
	if err != nil {
		return 0, err
	}
	return alphabet[n.Int64()], nil
}

func generateTemporaryPassword() (string, error) {
	chars := make([]byte, 0, temporaryPasswordLength)
	for _, group := range temporaryPasswordGroups {
		ch, err := secureRandomChar(group)
		if err != nil {
			return "", err
		}
		chars = append(chars, ch)
	}

	allChars := strings.Join(temporaryPasswordGroups, "")
	for len(chars) < temporaryPasswordLength {
		ch, err := secureRandomChar(allChars)
		if err != nil {
			return "", err
		}
		chars = append(chars, ch)
	}

	for i := len(chars) - 1; i > 0; i-- {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
		if err != nil {
			return "", err
		}
		j := int(n.Int64())
		chars[i], chars[j] = chars[j], chars[i]
	}

	return string(chars), nil
}

func validateAvatarDataURL(avatarURL string) error {
	if avatarURL == "" {
		return nil
	}
	if len(avatarURL) > maxAvatarDataURLLength {
		return fmt.Errorf("头像图片过大，请压缩后重试")
	}
	allowed := []string{
		"data:image/png;base64,",
		"data:image/jpeg;base64,",
		"data:image/jpg;base64,",
		"data:image/webp;base64,",
		"data:image/gif;base64,",
	}
	for _, prefix := range allowed {
		if strings.HasPrefix(avatarURL, prefix) {
			return nil
		}
	}
	return fmt.Errorf("头像必须是 PNG、JPG、WebP 或 GIF 图片")
}

func (h *UserHandler) List(c *gin.Context) {
	page, size, offset := util.PageParams(c.Query("page"), c.Query("pageSize"))
	db := database.DB.Model(&model.User{}).Order("created_at DESC")
	if v := c.Query("keyword"); v != "" { db = db.Where("username LIKE ? OR email LIKE ?", "%"+v+"%", "%"+v+"%") }
	if v := c.Query("role");    v != "" {
		// Filter by role: find user IDs that have this role binding
		var userIDs []string
		database.DB.Model(&model.UserRoleBinding{}).Where("role_name = ?", v).Pluck("user_id", &userIDs)
		// Also check legacy role field
		db = db.Where("id IN ? OR role = ?", userIDs, v)
	}
	if v := c.Query("status");  v != "" { db = db.Where("status = ?", v) }

	var total int64
	db.Count(&total)
	var users []model.User
	db.Limit(size).Offset(offset).Find(&users)

	// Batch load role bindings
	userIDs := make([]string, len(users))
	for i, u := range users { userIDs[i] = u.ID }
	var allBindings []model.UserRoleBinding
	if len(userIDs) > 0 {
		database.DB.Where("user_id IN ?", userIDs).Find(&allBindings)
	}
	bindingMap := make(map[string][]string)
	for _, b := range allBindings {
		bindingMap[b.UserID] = append(bindingMap[b.UserID], b.RoleName)
	}

	type userResp struct {
		model.User
		Projects []string `json:"projects"`
		Roles    []string `json:"roles"`
	}
	var result []userResp
	for _, u := range users {
		projs := util.FromJSONDefault[[]string](u.Projects, []string{})
		roles := bindingMap[u.ID]
		if len(roles) == 0 && string(u.Role) != "" {
			roles = []string{string(u.Role)} // fallback
		}
		result = append(result, userResp{User: u, Projects: projs, Roles: roles})
	}
	if result == nil { result = []userResp{} }
	response.Page(c, result, total, page, size)
}

func (h *UserHandler) Create(c *gin.Context) {
	var req createUserReq
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error()); return
	}
	// Check email uniqueness
	var count int64
	database.DB.Unscoped().Model(&model.User{}).Where("email = ?", req.Email).Count(&count)
	if count > 0 {
		response.Conflict(c, "EMAIL_EXISTS", "邮箱已被使用"); return
	}
	initialPassword := strings.TrimSpace(req.Password)
	if initialPassword == "" {
		initialPassword = defaultInitialPassword
	}
	if len(initialPassword) < 8 {
		response.BadRequest(c, "INVALID_PASSWORD", "密码至少 8 位")
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(initialPassword), bcrypt.DefaultCost)

	// Resolve roles: prefer Roles array, fallback to single Role
	roles := req.Roles
	if len(roles) == 0 && req.Role != "" {
		roles = []string{req.Role}
	}
	if len(roles) > 0 {
		var existingRoles []string
		database.DB.Model(&model.Role{}).Where("name IN ?", roles).Pluck("name", &existingRoles)
		existing := make(map[string]struct{}, len(existingRoles))
		for _, name := range existingRoles {
			existing[name] = struct{}{}
		}
		for _, roleName := range roles {
			if _, ok := existing[roleName]; !ok {
				response.BadRequest(c, "INVALID_ROLE", "角色不存在: "+roleName)
				return
			}
		}
	}

	user := model.User{
		Username:     req.Username,
		Email:        req.Email,
		PasswordHash: string(hash),
		Projects:     util.ToJSON(req.Projects),
		Status:       "active",
		Role:         "", // no default role
		MustChangePwd: true,
	}
	if len(roles) > 0 {
		user.Role = model.UserRole(roles[0])
	}
	if err := database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&user).Error; err != nil {
			return err
		}
		if err := database.UpsertUserIdentitySnapshot(tx, &user, nil); err != nil {
			return err
		}

		// Keep the legacy role column and binding table in sync.
		for _, r := range roles {
			binding := model.UserRoleBinding{UserID: user.ID, RoleName: r}
			if err := tx.Create(&binding).Error; err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		var mysqlErr *mysqlDriver.MySQLError
		if errors.As(err, &mysqlErr) {
			switch mysqlErr.Number {
			case 1062:
				response.Conflict(c, "EMAIL_EXISTS", "邮箱已被使用")
				return
			case 1452:
				response.BadRequest(c, "INVALID_ROLE", "角色不存在或已被删除")
				return
			}
		}
		response.InternalError(c, "创建用户失败: "+err.Error())
		return
	}

	if roles == nil { roles = []string{} }

	WriteAuditLogFromCtx(c, "创建", "用户", user.ID, user.Username,
		map[string]any{"email": req.Email, "roles": roles})

	response.Created(c, gin.H{
		"id": user.ID, "username": user.Username, "email": user.Email,
		"roles": roles, "role": user.Role, "status": user.Status,
	})
}

func (h *UserHandler) UpdateStatus(c *gin.Context) {
	id := c.Param("id")
	var body struct{ Status string `json:"status"` }
	c.ShouldBindJSON(&body)
	if body.Status != "active" && body.Status != "disabled" {
		response.BadRequest(c, "INVALID_STATUS", "status 必须是 active 或 disabled"); return
	}

	var target model.User
	if err := database.DB.First(&target, "id = ?", id).Error; err != nil {
		response.NotFound(c, "用户不存在"); return
	}
	if target.Email == config.Global.App.AdminEmail {
		response.BadRequest(c, "PROTECTED", "系统默认管理员不允许停用或启用"); return
	}

	// Cannot disable yourself
	if id == middleware.GetUserID(c) {
		response.BadRequest(c, "CANNOT_DISABLE_SELF", "不能禁用自己的账户"); return
	}

	// Cannot disable the last active super admin
	if body.Status == "disabled" {
		// Check if user is super_admin via role bindings
		var saBindingCount int64
		database.DB.Model(&model.UserRoleBinding{}).
			Where("user_id = ? AND role_name = 'super_admin'", id).Count(&saBindingCount)
		isSA := saBindingCount > 0 || target.Role == model.RoleSuperAdmin
		if isSA {
			var count int64
			database.DB.Model(&model.User{}).
				Where("role = ? AND status = 'active' AND id != ?", model.RoleSuperAdmin, id).
				Count(&count)
			if count == 0 {
				response.BadRequest(c, "LAST_SUPER_ADMIN", "系统中至少保留一个可用的超级管理员，无法禁用"); return
			}
		}
	}

	database.DB.Model(&model.User{}).Where("id = ?", id).Update("status", body.Status)
	middleware.InvalidateUserCache(id) // force re-check on next request
	if body.Status == "disabled" {
		NotifyUserEvent(id, model.NotiUserDisabled,
			"账户已被禁用", "你的账户已被管理员禁用，如有疑问请联系管理员。")
	}

	// Audit log
	var statusUser model.User
	database.DB.Select("username").First(&statusUser, "id = ?", id)
	statusLabel := "启用"
	if body.Status == "disabled" { statusLabel = "禁用" }
	WriteAuditLogFromCtx(c, statusLabel, "用户", id, statusUser.Username,
		map[string]any{"status": body.Status})

	response.OK(c, gin.H{"status": body.Status})
}

func (h *UserHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	var user model.User
	if err := database.DB.First(&user, "id = ?", id).Error; err != nil {
		response.NotFound(c, "用户不存在")
		return
	}

	// Protect system admin
	if user.Email == config.Global.App.AdminEmail {
		response.BadRequest(c, "PROTECTED", "系统默认管理员不可删除")
		return
	}
	if id == middleware.GetUserID(c) {
		response.BadRequest(c, "CANNOT_DELETE_SELF", "不能删除自己的账户")
		return
	}

	if err := database.DB.Transaction(func(tx *gorm.DB) error {
		deletedAt := time.Now()
		if err := database.UpsertUserIdentitySnapshot(tx, &user, &deletedAt); err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.UserRoleBinding{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.UserPermission{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.RefreshToken{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.NotificationPreference{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.Notification{}).Error; err != nil {
			return err
		}
		return tx.Unscoped().Delete(&user).Error
	}); err != nil {
		response.InternalError(c, "删除用户失败: "+err.Error())
		return
	}

	WriteAuditLogFromCtx(c, "删除", "用户", user.ID, user.Username,
		map[string]any{"username": user.Username, "email": user.Email})
	response.OK(c, gin.H{"ok": true})
}

func (h *UserHandler) ResetPassword(c *gin.Context) {
	id := c.Param("id")

	var resetUser model.User
	if err := database.DB.First(&resetUser, "id = ?", id).Error; err != nil {
		response.NotFound(c, "用户不存在")
		return
	}

	tempPassword, err := generateTemporaryPassword()
	if err != nil {
		response.InternalError(c, "生成临时密码失败")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(tempPassword), bcrypt.DefaultCost)
	if err != nil {
		response.InternalError(c, "密码加密失败")
		return
	}
	expiresAt := time.Now().Add(temporaryPasswordTTL)

	if err := database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.User{}).Where("id = ?", id).Updates(map[string]any{
			"password_hash":             string(hash),
			"must_change_pwd":           true,
			"temp_password_expires_at":  expiresAt,
			"reset_token":               "",
			"reset_token_exp":           0,
		}).Error; err != nil {
			return err
		}
		return tx.Where("user_id = ?", id).Delete(&model.RefreshToken{}).Error
	}); err != nil {
		response.InternalError(c, "重置密码失败: "+err.Error())
		return
	}

	NotifyUserInAppEvent(id, model.NotiPasswordReset,
		"密码已被重置", "管理员已为你生成临时密码，有效期 24 小时。请查看邮箱或联系管理员获取，登录后请立即修改。")

	cfg := config.Global.SMTP
	emailSent := false
	if cfg.Enabled && userEmailNotificationEnabled(id, model.NotiPasswordReset) && strings.TrimSpace(resetUser.Email) != "" {
		emailSent = true
		go func(user model.User, password string) {
			htmlBody := util.TemporaryPasswordEmailHTML(user.Username, password, 24)
			if err := util.SendEmail(cfg.Host, cfg.Port, cfg.Username, cfg.Password, cfg.From, user.Email, "【ATOP】你的临时密码", htmlBody, cfg.Security); err != nil {
				logger.Error("send temporary password email failed", zap.String("email", user.Email), zap.Error(err))
			}
		}(resetUser, tempPassword)
	}

	WriteAuditLogFromCtx(c, "重置密码", "用户", id, resetUser.Username,
		map[string]any{"emailSent": emailSent, "mustChangePwd": true, "expiresAt": expiresAt})

	response.OK(c, gin.H{
		"tempPassword": tempPassword,
		"emailSent":    emailSent,
		"expiresAt":    expiresAt,
		"note":         "临时密码仅显示一次，24 小时内有效，用户下次登录时将被强制要求修改密码",
	})
}

func userEmailNotificationEnabled(userID, event string) bool {
	var pref model.NotificationPreference
	if err := database.DB.Where("user_id = ?", userID).First(&pref).Error; err != nil {
		return false
	}
	if !pref.EmailEnabled {
		return false
	}
	return isEventEnabled(pref.EventSwitches, event)
}

func (h *UserHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Username string    `json:"username"`
		Role     string    `json:"role"`     // backward compat
		Roles    *[]string `json:"roles"`    // multi-role, pointer to distinguish nil vs empty
		Projects []string  `json:"projects"`
	}
	c.ShouldBindJSON(&body)

	var targetUser model.User
	if err := database.DB.Select("username, email").First(&targetUser, "id = ?", id).Error; err != nil {
		response.NotFound(c, "用户不存在"); return
	}
	isDefaultAdmin := targetUser.Email == config.Global.App.AdminEmail
	if isDefaultAdmin && (body.Username != "" || body.Projects != nil) {
		response.BadRequest(c, "PROTECTED", "系统默认管理员不允许编辑基本信息"); return
	}

	updates := map[string]any{}
	if body.Username != "" { updates["username"] = body.Username }
	if body.Projects != nil { updates["projects"] = util.ToJSON(body.Projects) }

	// Handle roles update: only if roles field was provided (not nil)
	if body.Roles != nil {
		roles := *body.Roles
		// Protect system admin's super_admin role
		if isDefaultAdmin {
			hasSuperAdmin := false
			for _, r := range roles {
				if r == "super_admin" { hasSuperAdmin = true; break }
			}
			if !hasSuperAdmin {
				response.BadRequest(c, "PROTECTED", "系统默认管理员必须保留超级管理员角色")
				return
			}
		}

		// Update legacy role field
		if len(roles) > 0 {
			updates["role"] = roles[0]
		} else {
			updates["role"] = ""
		}

		// Replace role bindings
		database.DB.Where("user_id = ?", id).Delete(&model.UserRoleBinding{})
		for _, r := range roles {
			binding := model.UserRoleBinding{UserID: id, RoleName: r}
			database.DB.Create(&binding)
		}
	} else if body.Role != "" {
		if isDefaultAdmin && body.Role != string(model.RoleSuperAdmin) {
			response.BadRequest(c, "PROTECTED", "系统默认管理员必须保留超级管理员角色")
			return
		}
		// Legacy single role update
		updates["role"] = body.Role
		database.DB.Where("user_id = ?", id).Delete(&model.UserRoleBinding{})
		binding := model.UserRoleBinding{UserID: id, RoleName: body.Role}
		database.DB.Create(&binding)
	}

	if len(updates) > 0 {
		database.DB.Model(&model.User{}).Where("id = ?", id).Updates(updates)
		var updatedUser model.User
		if err := database.DB.First(&updatedUser, "id = ?", id).Error; err == nil {
			_ = database.UpsertUserIdentitySnapshot(database.DB, &updatedUser, nil)
		}
	}

	// Build audit log
	changes := []string{}
	if body.Username != "" { changes = append(changes, "用户名: "+body.Username) }
	if body.Roles != nil {
		roleNames := []string{}
		for _, r := range *body.Roles { roleNames = append(roleNames, r) }
		if len(roleNames) > 0 {
			changes = append(changes, "角色: "+strings.Join(roleNames, "、"))
		} else {
			changes = append(changes, "角色: 全部移除")
		}
	}
	if body.Projects != nil { changes = append(changes, "项目已更新") }
	actionText := "编辑基本信息"
	if len(changes) > 0 { actionText = "编辑基本信息：" + strings.Join(changes, "、") }
	WriteAuditLogFromCtx(c, "更新", "用户", id, targetUser.Username,
		map[string]any{"changes": changes, "summary": actionText})

	response.OK(c, gin.H{"ok": true})
}

// UpdateMyAvatar saves the current user's avatar data URL.
func (h *UserHandler) UpdateMyAvatar(c *gin.Context) {
	userID := middleware.GetUserID(c)
	var body updateAvatarReq
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}
	body.AvatarURL = strings.TrimSpace(body.AvatarURL)
	if err := validateAvatarDataURL(body.AvatarURL); err != nil {
		response.BadRequest(c, "INVALID_AVATAR", err.Error())
		return
	}

	var user model.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		response.NotFound(c, "用户不存在")
		return
	}
	if err := database.DB.Model(&user).Update("avatar_url", body.AvatarURL).Error; err != nil {
		response.InternalError(c, "头像保存失败")
		return
	}

	user.AvatarURL = body.AvatarURL
	projects := util.FromJSONDefault[[]string](user.Projects, []string{})
	roles := getUserRoles(user.ID)
	response.OK(c, gin.H{
		"user": gin.H{
			"id":            user.ID,
			"username":      user.Username,
			"email":         user.Email,
			"roles":         roles,
			"role":          user.Role,
			"projects":      projects,
			"status":        user.Status,
			"avatarUrl":     user.AvatarURL,
			"createdAt":     user.CreatedAt,
			"mustChangePwd": user.MustChangePwd,
		},
	})
}

// ── Audit Logs ────────────────────────────────────────────────────────────

type AuditHandler struct{}

type auditLogResp struct {
	model.AuditLog
	OperatorName  string `json:"operatorName"`
	OperatorEmail string `json:"operatorEmail,omitempty"`
}

type auditTrackReq struct {
	Action       string `json:"action"`
	ResourceType string `json:"resourceType"`
	ResourceID   string `json:"resourceId"`
	ResourceName string `json:"resourceName"`
	Button       string `json:"button"`
	Module       string `json:"module"`
	DiffJSON     any    `json:"diffJson"`
}

var auditActionLabels = map[string]string{
	"create":       "创建",
	"update":       "更新",
	"edit":         "编辑",
	"delete":       "删除",
	"restore":      "还原",
	"deploy":       "部署",
	"创建":           "创建",
	"更新":           "更新",
	"编辑":           "编辑",
	"删除":           "删除",
	"启用":           "启用",
	"禁用":           "禁用",
	"还原":           "还原",
	"部署":           "部署",
	"执行":           "执行",
	"同步":           "同步",
	"查看":           "查看",
	"点击按钮":         "点击按钮",
	"点击菜单":         "点击菜单",
	"触发运行":         "触发运行",
	"重新运行":         "重新运行",
	"外部触发":         "外部触发",
	"更新权限":         "更新权限",
	"分配用户":         "分配用户",
	"移出用户":         "移出用户",
	"保存DAG":        "保存DAG",
	"中止":           "中止",
	"登录":           "登录",
	"重置密码":         "重置密码",
}

var auditResourceLabels = map[string]string{
	"notification_rule": "通知规则",
	"env_profile":       "环境部署配置",
	"pipeline_version":  "流水线版本",
	"pipeline":          "流水线",
	"test_set":          "测试集",
	"users":             "用户",
	"roles":             "角色",
	"permission":        "权限",
	"vars":              "变量",
	"jenkins":           "Jenkins 实例",
	"cleanup":           "数据清理",
	"task":              "任务",
	"button":            "按钮",
	"menu":              "菜单",
	"通知规则":              "通知规则",
	"环境部署配置":            "环境部署配置",
	"流水线版本":             "流水线版本",
	"流水线":               "流水线",
	"测试集":               "测试集",
	"用户":                "用户",
	"角色":                "角色",
	"权限":                "权限",
	"变量":                "变量",
	"Jenkins 实例":        "Jenkins 实例",
	"数据清理":              "数据清理",
	"任务":                "任务",
	"按钮":                "按钮",
	"菜单":                "菜单",
	"界面":                "界面",
	"公共变量":              "公共变量",
	"函数库":               "函数库",
	"数据字典":              "数据字典",
}

func auditText(value string, max int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > max {
		return string(runes[:max])
	}
	return value
}

func auditLabel(value string, labels map[string]string) string {
	value = strings.TrimSpace(value)
	if label := labels[value]; label != "" {
		return label
	}
	return value
}

func auditQueryValues(value string, labels map[string]string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	seen := map[string]bool{}
	values := []string{}
	add := func(v string) {
		v = strings.TrimSpace(v)
		if v != "" && !seen[v] {
			seen[v] = true
			values = append(values, v)
		}
	}
	add(value)
	for raw, label := range labels {
		if raw == value || label == value {
			add(raw)
			add(label)
		}
	}
	return values
}

func auditLooksLikeUUID(value string) bool {
	value = strings.TrimSpace(value)
	return len(value) == 36 && strings.Count(value, "-") == 4
}

func auditReadableResourceName(item model.AuditLog) string {
	name := strings.TrimSpace(item.ResourceName)
	if name != "" && !auditLooksLikeUUID(name) {
		return name
	}
	resourceType := auditLabel(item.ResourceType, auditResourceLabels)
	if resourceType != "" && auditLooksLikeUUID(name) {
		return resourceType + "记录"
	}
	if resourceType != "" {
		return resourceType
	}
	return name
}

func enrichAuditLogs(items []model.AuditLog) []auditLogResp {
	userIDs := make([]string, 0, len(items))
	for _, item := range items {
		if strings.TrimSpace(item.UserID) != "" {
			userIDs = append(userIDs, item.UserID)
		}
	}
	nameMap := ResolveUserNames(userIDs)
	result := make([]auditLogResp, 0, len(items))
	for _, item := range items {
		operatorName := strings.TrimSpace(nameMap[item.UserID])
		operatorEmail := strings.TrimSpace(item.Username)
		if operatorName == "" {
			operatorName = operatorEmail
			if idx := strings.Index(operatorName, "@"); idx > 0 {
				operatorName = operatorName[:idx]
			}
		}
		if operatorName == "" {
			operatorName = "已删除用户"
		}
		result = append(result, auditLogResp{
			AuditLog:      item,
			OperatorName:  operatorName,
			OperatorEmail: operatorEmail,
		})
	}
	return result
}

func (h *AuditHandler) List(c *gin.Context) {
	page, size, offset := util.PageParams(c.Query("page"), c.Query("pageSize"))
	db := database.DB.Model(&model.AuditLog{}).Order("created_at DESC")
	if v := c.Query("keyword"); v != "" {
		kw := "%" + v + "%"
		actionValues := auditQueryValues(v, auditActionLabels)
		resourceValues := auditQueryValues(v, auditResourceLabels)
		db = db.Where(
			"username LIKE ? OR resource_name LIKE ? OR action LIKE ? OR resource_type LIKE ? OR button LIKE ? OR module LIKE ? OR ip LIKE ? OR action IN ? OR resource_type IN ?",
			kw, kw, kw, kw, kw, kw, kw, actionValues, resourceValues,
		)
	}
	if v := c.Query("action"); v != "" {
		db = db.Where("action IN ?", auditQueryValues(v, auditActionLabels))
	}
	if v := c.Query("resourceType"); v != "" {
		db = db.Where("resource_type IN ?", auditQueryValues(v, auditResourceLabels))
	}
	if v := c.Query("startDate"); v != "" {
		db = db.Where("created_at >= ?", v)
	}
	if v := c.Query("endDate"); v != "" {
		db = db.Where("created_at <= ?", v)
	}

	var total int64
	db.Count(&total)
	var items []model.AuditLog
	db.Limit(size).Offset(offset).Find(&items)
	if items == nil {
		items = []model.AuditLog{}
	}
	response.Page(c, enrichAuditLogs(items), total, page, size)
}

func (h *AuditHandler) Export(c *gin.Context) {
	db := database.DB.Model(&model.AuditLog{}).Order("created_at DESC")
	if v := c.Query("keyword"); v != "" {
		kw := "%" + v + "%"
		actionValues := auditQueryValues(v, auditActionLabels)
		resourceValues := auditQueryValues(v, auditResourceLabels)
		db = db.Where(
			"username LIKE ? OR resource_name LIKE ? OR action LIKE ? OR resource_type LIKE ? OR button LIKE ? OR module LIKE ? OR ip LIKE ? OR action IN ? OR resource_type IN ?",
			kw, kw, kw, kw, kw, kw, kw, actionValues, resourceValues,
		)
	}
	if v := c.Query("action"); v != "" {
		db = db.Where("action IN ?", auditQueryValues(v, auditActionLabels))
	}
	if v := c.Query("resourceType"); v != "" {
		db = db.Where("resource_type IN ?", auditQueryValues(v, auditResourceLabels))
	}
	if v := c.Query("startDate"); v != "" {
		db = db.Where("created_at >= ?", v)
	}
	if v := c.Query("endDate"); v != "" {
		db = db.Where("created_at <= ?", v)
	}

	var items []model.AuditLog
	db.Limit(5000).Find(&items)
	rows := enrichAuditLogs(items)

	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", `attachment; filename="audit.csv"`)

	var buf strings.Builder
	buf.WriteString("\ufeff") // UTF-8 BOM for Excel
	writer := csv.NewWriter(&buf)
	_ = writer.Write([]string{"时间", "操作人", "邮箱", "操作类型", "资源类型", "资源名称", "操作按钮", "来源页面", "IP地址", "状态码"})
	for _, item := range rows {
		_ = writer.Write([]string{
			item.CreatedAt.Format("2006-01-02 15:04:05"),
			item.OperatorName,
			item.OperatorEmail,
			auditLabel(item.Action, auditActionLabels),
			auditLabel(item.ResourceType, auditResourceLabels),
			auditReadableResourceName(item.AuditLog),
			item.Button,
			item.Module,
			item.IP,
			fmt.Sprintf("%d", item.StatusCode),
		})
	}
	writer.Flush()
	c.Data(200, "text/csv; charset=utf-8", []byte(buf.String()))
}

func (h *AuditHandler) Track(c *gin.Context) {
	var req auditTrackReq
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_AUDIT_EVENT", "审计事件格式不正确")
		return
	}

	action := auditText(req.Action, 50)
	if action == "" {
		action = "点击"
	}
	resourceType := auditText(req.ResourceType, 50)
	if resourceType == "" {
		resourceType = "界面"
	}
	button := auditText(req.Button, 100)
	if button == "" {
		button = auditText(c.GetHeader("X-Button"), 100)
	}
	module := auditText(req.Module, 50)
	if module == "" {
		module = auditText(c.GetHeader("X-Module"), 50)
	}
	resourceName := auditText(req.ResourceName, 300)
	if resourceName == "" {
		resourceName = button
	}
	if resourceName == "" {
		resourceName = module
	}
	if resourceName == "" {
		resourceName = resourceType
	}

	WriteAuditLog(
		middleware.GetUserID(c),
		middleware.GetUserEmail(c),
		action,
		resourceType,
		auditText(req.ResourceID, 36),
		resourceName,
		util.RealIP(c.GetHeader("X-Forwarded-For"), c.Request.RemoteAddr),
		req.DiffJSON,
		AuditExtra{
			Button:    button,
			Module:    module,
			UserAgent: c.Request.UserAgent(),
			RequestID: c.GetHeader("X-Request-ID"),
			Status:    200,
		},
	)
	response.OK(c, gin.H{"tracked": true})
}

// AuditExtra carries optional extra context for audit logs.
type AuditExtra struct {
	Button    string
	Module    string
	UserAgent string
	RequestID string
	Status    int
}

// WriteAuditLog records an operation to the audit log.
func WriteAuditLog(userID, username, action, resourceType, resourceID, resourceName, ip string, diff any, extras ...AuditExtra) {
	log := model.AuditLog{
		UserID:       userID,
		Username:     username,
		Action:       auditLabel(action, auditActionLabels),
		ResourceType: auditLabel(resourceType, auditResourceLabels),
		ResourceID:   resourceID,
		ResourceName: resourceName,
		IP:           ip,
		DiffJSON:     util.ToJSON(diff),
		StatusCode:   200,
	}
	log.ID = uuid.New().String()
	if len(extras) > 0 {
		ex := extras[0]
		if ex.Button != "" {
			log.Button = ex.Button
		}
		if ex.Module != "" {
			log.Module = ex.Module
		}
		if ex.UserAgent != "" {
			log.UserAgent = ex.UserAgent
		}
		if ex.RequestID != "" {
			log.RequestID = ex.RequestID
		}
		if ex.Status != 0 {
			log.StatusCode = ex.Status
		}
	}

	database.DB.Create(&log)
}
// WriteAuditLogFromCtx is a convenience wrapper extracting user info from gin context.
func WriteAuditLogFromCtx(c *gin.Context, action, resourceType, resourceID, resourceName string, diff any) {
	extra := AuditExtra{
		Button:    c.GetHeader("X-Button"),
		Module:    c.GetHeader("X-Module"),
		UserAgent: c.Request.UserAgent(),
		RequestID: c.GetHeader("X-Request-ID"),
	}
	WriteAuditLog(
		middleware.GetUserID(c), middleware.GetUserEmail(c),
		action, resourceType, resourceID, resourceName,
		util.RealIP(c.GetHeader("X-Forwarded-For"), c.Request.RemoteAddr),
		diff, extra,
	)
}



// BatchImport creates multiple users from a CSV upload.
// CSV format: username,email,roles,projects,status
// roles: super_admin|project_manager|member|viewer; multiple values can use ";" or "|"
// projects: project IDs; multiple values can use ";" or "|" (empty = all)
func (h *UserHandler) BatchImport(c *gin.Context) {
	file, _, err := c.Request.FormFile("file")
	if err != nil {
		response.BadRequest(c, "MISSING_FILE", "请上传 CSV 文件"); return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true
	records, err := reader.ReadAll()
	if err != nil {
		response.BadRequest(c, "INVALID_CSV", "CSV 解析失败: "+err.Error()); return
	}
	if len(records) < 2 {
		response.BadRequest(c, "EMPTY_CSV", "CSV 至少需要表头和一行数据"); return
	}

	type importErr struct {
		Row    int    `json:"row"`
		Reason string `json:"reason"`
	}
	success, failed := 0, 0
	var errors []importErr

	validRoles := map[string]bool{
		"super_admin": true, "project_manager": true, "member": true, "viewer": true,
	}
	headerIndex := map[string]int{}
	for index, name := range records[0] {
		normalized := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(name)), "\ufeff")
		headerIndex[normalized] = index
	}
	cell := func(row []string, names ...string) string {
		for _, name := range names {
			if index, ok := headerIndex[name]; ok && index >= 0 && index < len(row) {
				return strings.TrimSpace(row[index])
			}
		}
		return ""
	}
	normalizeStatus := func(value string) string {
		switch strings.TrimSpace(value) {
		case "", "active", "启用", "已启用":
			return "active"
		case "disabled", "停用", "已停用":
			return "disabled"
		default:
			return strings.TrimSpace(value)
		}
	}

	// Skip header row
	for i, row := range records[1:] {
		if len(row) > 0 && strings.HasPrefix(strings.TrimSpace(row[0]), "说明") {
			continue
		}
		username := cell(row, "username", "name", "用户名")
		email := cell(row, "email", "邮箱")
		rolesStr := cell(row, "roles", "role", "角色")
		projectsStr := cell(row, "projects", "project", "项目")
		status := normalizeStatus(cell(row, "status", "状态"))
		if username == "" && email == "" && rolesStr == "" {
			continue
		}
		if username == "" || email == "" || rolesStr == "" {
			failed++
			errors = append(errors, importErr{Row: i + 2, Reason: "username/email/roles 不能为空"})
			continue
		}
		if status != "active" && status != "disabled" {
			failed++
			errors = append(errors, importErr{Row: i + 2, Reason: "status 无效: " + status})
			continue
		}

		// Check email uniqueness
		var count int64
		database.DB.Model(&model.User{}).Where("email = ?", email).Count(&count)
		if count > 0 {
			failed++
			errors = append(errors, importErr{Row: i + 2, Reason: "邮箱已存在: " + email})
			continue
		}

		var roles []string
		roleInvalid := false
		for _, r := range strings.FieldsFunc(rolesStr, func(ch rune) bool { return ch == ';' || ch == '|' || ch == '，' || ch == ',' }) {
			if r = strings.TrimSpace(r); r != "" {
				if !validRoles[r] {
					failed++
					errors = append(errors, importErr{Row: i + 2, Reason: "role 无效: " + r})
					roleInvalid = true
					break
				}
				roles = append(roles, r)
			}
		}
		if roleInvalid {
			continue
		}
		if len(roles) == 0 {
			failed++
			errors = append(errors, importErr{Row: i + 2, Reason: "roles 不能为空"})
			continue
		}

		// Parse projects
		var projects []string
		if projectsStr != "" {
			for _, p := range strings.FieldsFunc(projectsStr, func(ch rune) bool { return ch == ';' || ch == '|' || ch == '，' || ch == ',' }) {
				if p = strings.TrimSpace(p); p != "" {
					projects = append(projects, p)
				}
			}
		}
		if projects == nil { projects = []string{} }

		hash, _ := bcrypt.GenerateFromPassword([]byte(defaultInitialPassword), bcrypt.DefaultCost)

		user := model.User{
			Username:     username,
			Email:        email,
			PasswordHash: string(hash),
			Role:         model.UserRole(roles[0]),
			Projects:     util.ToJSON(projects),
			Status:       status,
			MustChangePwd: true,
		}
		if err := database.DB.Create(&user).Error; err != nil {
			failed++
			errors = append(errors, importErr{Row: i + 2, Reason: "创建失败: " + err.Error()})
			continue
		}
		_ = database.UpsertUserIdentitySnapshot(database.DB, &user, nil)
		for _, role := range roles {
			database.DB.Create(&model.UserRoleBinding{UserID: user.ID, RoleName: role})
		}
		success++
	}

	response.OK(c, gin.H{
		"success": success, "failed": failed,
		"total":   success + failed, "errors": errors,
		"note":    "初始密码为: #PassW0rd，首次登录时将强制要求修改密码",
	})
}

// ResolveUserNames takes a list of user IDs and returns a map of ID -> display name.
func ResolveUserNames(ids []string) map[string]string {
	if len(ids) == 0 {
		return map[string]string{}
	}
	// Deduplicate
	unique := make(map[string]bool)
	for _, id := range ids {
		if id != "" {
			unique[id] = true
		}
	}
	deduped := make([]string, 0, len(unique))
	for id := range unique {
		deduped = append(deduped, id)
	}

	result := make(map[string]string, len(deduped))
	for _, id := range deduped {
		if id == "system" {
			result[id] = "系统"
		}
	}

	var snapshots []model.UserIdentitySnapshot
	database.DB.Select("user_id, username, email, deleted_at").Where("user_id IN ?", deduped).Find(&snapshots)
	for _, s := range snapshots {
		displayName := strings.TrimSpace(s.Username)
		if displayName == "" {
			displayName = strings.TrimSpace(s.Email)
		}
		if displayName == "" {
			displayName = "已删除用户"
		}
		result[s.UserID] = displayName
	}

	var users []model.User
	database.DB.Unscoped().Select("id, username, email, deleted_at").Where("id IN ?", deduped).Find(&users)
	for _, u := range users {
		if _, ok := result[u.ID]; ok {
			continue
		}
		displayName := u.Email
		if u.Username != "" {
			displayName = u.Username
		}
		if displayName == "" {
			displayName = "已删除用户"
		}
		result[u.ID] = displayName
	}
	for _, id := range deduped {
		if _, ok := result[id]; !ok {
			result[id] = "已删除用户"
		}
	}
	return result
}

