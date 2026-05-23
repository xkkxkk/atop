package handler

import (
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/database"
	"gorm.io/gorm"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/pkg/response"
)

var cstZone = time.FixedZone("CST", 8*3600)

type PermissionHandler struct{}

// GetPermissionMatrix returns full resource/action matrix with labels (for UI).
func (h *PermissionHandler) GetPermissionMatrix(c *gin.Context) {
	type ActionItem struct {
		Action string `json:"action"`
		Label  string `json:"label"`
	}
	type ResourceItem struct {
		Resource string       `json:"resource"`
		Label    string       `json:"label"`
		Actions  []ActionItem `json:"actions"`
	}

	var matrix []ResourceItem
	for _, res := range AllResources {
		actions := ResourceActions[res]
		var acts []ActionItem
		for _, act := range actions {
			acts = append(acts, ActionItem{Action: act, Label: ActionLabels[act]})
		}
		matrix = append(matrix, ResourceItem{
			Resource: res,
			Label:    ResourceLabels[res],
			Actions:  acts,
		})
	}
	response.OK(c, matrix)
}

// GetRolePermissions returns all permissions for a role.
func (h *PermissionHandler) GetRolePermissions(c *gin.Context) {
	role := c.Param("role")
	if role == "super_admin" {
		// Super admin always has all permissions
		perms := GetUserPermissions("", []string{"super_admin"})
		response.OK(c, perms)
		return
	}

	var perms []model.RolePermission
	database.DB.Where("role = ?", role).Find(&perms)
	result := make(map[string]map[string]bool)
	for _, p := range perms {
		if result[p.Resource] == nil {
			result[p.Resource] = make(map[string]bool)
		}
		result[p.Resource][p.Action] = p.Allow
	}
	response.OK(c, result)
}

// UpdateRolePermissions replaces all permissions for a role.
func (h *PermissionHandler) UpdateRolePermissions(c *gin.Context) {
	role := c.Param("role")
	if role == "super_admin" {
        response.BadRequest(c, "FORBIDDEN", "Super admin permissions cannot be edited")
		return
	}

	// Body: { "test_set": { "view": true, "create": false }, ... }
	var body map[string]map[string]bool
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	// Compute diff for audit log: compare old vs new
	var oldPerms []model.RolePermission
	database.DB.Where("role = ?", role).Find(&oldPerms)
	oldMap := make(map[string]bool)
	for _, p := range oldPerms {
		if p.Allow {
			oldMap[p.Resource+"."+p.Action] = true
		}
	}

	// Replace all role perms in transaction
	if err := database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("role = ?", role).Delete(&model.RolePermission{}).Error; err != nil {
			return err
		}
		for res, actions := range body {
			for act, allow := range actions {
				if !IsKnownPermission(res, act) {
					continue
				}
				row := model.RolePermission{
					ID:       uuid.New().String(),
					Role:     role,
					Resource: res,
					Action:   act,
					Allow:    allow,
				}
				// Use Select so false values are still written explicitly.
				if err := tx.Select("ID", "Role", "Resource", "Action", "Allow").Create(&row).Error; err != nil {
					return err
				}
			}
		}
		return nil
	}); err != nil {
        response.InternalError(c, "Failed to save permissions")
		return
	}

	// Build diff text: + added, - removed
	newMap := make(map[string]bool)
	for res, actions := range body {
		for act, allow := range actions {
			if !IsKnownPermission(res, act) {
				continue
			}
			if allow {
				newMap[res+"."+act] = true
			}
		}
	}
	added := []string{}
	removed := []string{}
	for k := range newMap {
		if !oldMap[k] {
			added = append(added, k)
		}
	}
	for k := range oldMap {
		if !newMap[k] {
			removed = append(removed, k)
		}
	}
	diffText := "更新权限："
	if len(added) > 0 {
		names := make([]string, 0, len(added))
		for _, a := range added {
			names = append(names, "+ "+permLabel(a))
		}
        diffText += strings.Join(names, ", ")
	}
	if len(removed) > 0 {
		if len(added) > 0 {
			diffText += "，"
		}
		names := make([]string, 0, len(removed))
		for _, r := range removed {
			names = append(names, "- "+permLabel(r))
		}
        diffText += strings.Join(names, ", ")
	}
	if len(added) == 0 && len(removed) == 0 {
		diffText = "更新权限（无变化）"
	}

	// Resolve role display name
	var roleObj model.Role
	database.DB.Where("name = ?", role).First(&roleObj)
	roleID := roleObj.ID
	if roleID == "" {
		roleID = role
	}

	WriteAuditLogFromCtx(c, "update_permissions", "role", roleID, roleObj.DisplayName,
		map[string]any{"added": added, "removed": removed, "summary": diffText})
	response.OK(c, gin.H{"ok": true})
}

// GetUserPermissionOverrides returns user-specific permission overrides.
func (h *PermissionHandler) GetUserPermissionOverrides(c *gin.Context) {
	userID := c.Param("userId")
	var perms []model.UserPermission
	database.DB.Where("user_id = ?", userID).Find(&perms)

	result := make(map[string]map[string]bool)
	for _, p := range perms {
		if result[p.Resource] == nil {
			result[p.Resource] = make(map[string]bool)
		}
		result[p.Resource][p.Action] = p.Allow
	}
	response.OK(c, result)
}

// UpdateUserPermissionOverrides replaces user-specific overrides.
func (h *PermissionHandler) UpdateUserPermissionOverrides(c *gin.Context) {
	userID := c.Param("userId")

	var body map[string]map[string]bool
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	if err := database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userID).Delete(&model.UserPermission{}).Error; err != nil {
			return err
		}
		for res, actions := range body {
			for act, allow := range actions {
				if !IsKnownPermission(res, act) {
					continue
				}
				row := model.UserPermission{
					ID:       uuid.New().String(),
					UserID:   userID,
					Resource: res,
					Action:   act,
					Allow:    allow,
				}
				// Use Select so false values are still written explicitly.
				if err := tx.Select("ID", "UserID", "Resource", "Action", "Allow").Create(&row).Error; err != nil {
					return err
				}
			}
		}
		return nil
	}); err != nil {
		response.InternalError(c, "Failed to save permissions")
		return
	}

	userName := userID
	if names := ResolveUserNames([]string{userID}); names[userID] != "" {
		userName = names[userID]
	}
	WriteAuditLogFromCtx(c, "update_permissions", "user", userID, userName,
		map[string]any{"userId": userID, "perms": body})
	response.OK(c, gin.H{"ok": true})
}

// GetMyPermissions returns the effective permission set for the current user.
func (h *PermissionHandler) GetMyPermissions(c *gin.Context) {
	userID := middleware.GetUserID(c)
	roles  := middleware.GetUserRoles(c)
	perms  := GetUserPermissions(userID, roles)
	response.OK(c, perms)
}

// ListRolesLite returns all roles for dropdown selectors (lightweight, no extra permission).
func (h *PermissionHandler) ListRolesLite(c *gin.Context) {
	var roles []model.Role
	database.DB.Select("id, name, display_name, is_builtin, status").
		Order("is_builtin DESC, created_at ASC").Find(&roles)

	type roleItem struct {
		Name        string `json:"name"`
		DisplayName string `json:"displayName"`
		IsBuiltin   bool   `json:"isBuiltin"`
		Status      string `json:"status"`
	}
	items := make([]roleItem, 0, len(roles))
	for _, r := range roles {
		status := r.Status
		if status == "" { status = "active" }
		items = append(items, roleItem{
			Name:        r.Name,
			DisplayName: r.DisplayName,
			IsBuiltin:   r.IsBuiltin,
			Status:      status,
		})
	}
	response.OK(c, items)
}

// Role Management

// ListRoles returns all roles with user count.
func (h *PermissionHandler) ListRoles(c *gin.Context) {
	var roles []model.Role
	database.DB.Order("is_builtin DESC, created_at ASC").Find(&roles)

	// Count users per role via bindings
	type rc struct {
		RoleName string `gorm:"column:role_name"`
		Count    int64  `gorm:"column:cnt"`
	}
	var counts []rc
	database.DB.Model(&model.UserRoleBinding{}).
		Select("role_name, COUNT(DISTINCT user_id) as cnt").
		Group("role_name").Find(&counts)
	countMap := make(map[string]int64)
	for _, cnt := range counts {
		countMap[cnt.RoleName] = cnt.Count
	}

	// Resolve creator names
	creatorIDs := []string{}
	for _, r := range roles {
		if r.CreatedBy != "" {
			creatorIDs = append(creatorIDs, r.CreatedBy)
		}
	}
	nameMap := ResolveUserNames(creatorIDs)

	type roleResp struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		DisplayName string `json:"displayName"`
		Description string `json:"description"`
		IsBuiltin   bool   `json:"isBuiltin"`
		Status      string `json:"status"`
		UserCount   int64  `json:"userCount"`
		CreatedBy   string `json:"createdBy"`
		CreatorName string `json:"creatorName"`
		CreatedAt   string `json:"createdAt"`
	}
	result := make([]roleResp, 0, len(roles))
	for _, r := range roles {
		status := r.Status
		if status == "" {
			status = "active"
		}
		result = append(result, roleResp{
			ID:          r.ID,
			Name:        r.Name,
			DisplayName: r.DisplayName,
			Description: r.Description,
			IsBuiltin:   r.IsBuiltin,
			Status:      status,
			UserCount:   countMap[r.Name],
			CreatedBy:   r.CreatedBy,
			CreatorName: nameMap[r.CreatedBy],
			CreatedAt:   r.CreatedAt.In(cstZone).Format("2006-01-02 15:04:05"),
		})
	}
	response.OK(c, result)
}

// GetRole returns a single role by ID.
func (h *PermissionHandler) GetRole(c *gin.Context) {
	id := c.Param("id")
	var role model.Role
	if err := database.DB.First(&role, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Role not found")
		return
	}
	response.OK(c, role)
}

// CreateRole creates a new custom role.
func (h *PermissionHandler) CreateRole(c *gin.Context) {
	var req struct {
		Name        string                     `json:"name" binding:"required"`
		DisplayName string                     `json:"displayName" binding:"required"`
		Description string                     `json:"description"`
		Perms       map[string]map[string]bool `json:"perms"`
		CloneFrom   string                     `json:"cloneFrom"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	var existing model.Role
	if err := database.DB.Where("name = ?", req.Name).First(&existing).Error; err == nil {
        response.BadRequest(c, "DUPLICATE", "Role name already exists: "+req.Name)
		return
	}

	role := model.Role{
		Name:        req.Name,
		DisplayName: req.DisplayName,
		Description: req.Description,
		IsBuiltin:   false,
		CreatedBy:   middleware.GetUserID(c),
	}

	if err := database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&role).Error; err != nil {
			return err
		}
		if len(req.Perms) > 0 {
			for res, actions := range req.Perms {
				for act, allow := range actions {
					row := model.RolePermission{
						ID:       uuid.New().String(),
						Role:     req.Name,
						Resource: res,
						Action:   act,
						Allow:    allow,
					}
					if err := tx.Select("ID", "Role", "Resource", "Action", "Allow").Create(&row).Error; err != nil {
						return err
					}
				}
			}
		}
		return nil
	}); err != nil {
        response.InternalError(c, "Failed to create role")
		return
	}

    actionText := "Created role"
	if req.CloneFrom != "" {
        actionText = "Cloned from " + req.CloneFrom
	}
    WriteAuditLogFromCtx(c, "create", "role", role.ID, role.DisplayName,
		map[string]any{"name": req.Name, "displayName": req.DisplayName, "cloneFrom": req.CloneFrom, "summary": actionText})
	response.OK(c, role)
}

func (h *PermissionHandler) UpdateRole(c *gin.Context) {
	id := c.Param("id")
	var role model.Role
	if err := database.DB.First(&role, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Role not found")
		return
	}

	oldName := role.DisplayName
	oldDesc := role.Description

	var req struct {
		DisplayName string `json:"displayName" binding:"required"`
		Description string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	role.DisplayName = req.DisplayName
	role.Description = req.Description
	database.DB.Save(&role)

	changes := []string{}
	if oldName != req.DisplayName {
        changes = append(changes, "Name: "+oldName+" -> "+req.DisplayName)
	}
	if oldDesc != req.Description {
        changes = append(changes, "Description updated")
	}
    actionText := "Updated role details"
	if len(changes) > 0 {
        actionText = "Updated role details: " + strings.Join(changes, ", ")
	}

    WriteAuditLogFromCtx(c, "update", "role", role.ID, role.DisplayName,
		map[string]any{"displayName": req.DisplayName, "oldName": oldName, "summary": actionText})
	response.OK(c, role)
}

// DeleteRole deletes a custom role (builtin roles cannot be deleted).
func (h *PermissionHandler) DeleteRole(c *gin.Context) {
	id := c.Param("id")
	var role model.Role
	if err := database.DB.First(&role, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Role not found")
		return
	}
	if role.IsBuiltin {
		response.BadRequest(c, "FORBIDDEN", "Built-in roles cannot be deleted")
		return
	}

	// Count users in this role via bindings
	var count int64
	database.DB.Model(&model.UserRoleBinding{}).Where("role_name = ?", role.Name).Count(&count)

	// Resolve user names for audit
	var affectedUsers []model.User
	if count > 0 {
		var userIDs []string
		database.DB.Model(&model.UserRoleBinding{}).Where("role_name = ?", role.Name).Pluck("user_id", &userIDs)
		database.DB.Where("id IN ?", userIDs).Select("id, username").Find(&affectedUsers)
	}

	// Transaction: remove bindings, delete permissions, delete role
	if err := database.DB.Transaction(func(tx *gorm.DB) error {
		if count > 0 {
			if err := tx.Where("role_name = ?", role.Name).Delete(&model.UserRoleBinding{}).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("role = ?", role.Name).Delete(&model.RolePermission{}).Error; err != nil {
			return err
		}
		if err := tx.Unscoped().Delete(&role).Error; err != nil {
			return err
		}
		return nil
	}); err != nil {
        response.InternalError(c, "Failed to delete role")
		return
	}

	// Build audit text
    actionText := "Deleted role"
	if count > 0 {
		names := make([]string, 0, len(affectedUsers))
		for _, u := range affectedUsers {
			names = append(names, u.Username)
		}
        actionText = "Deleted role and removed users: " + strings.Join(names, ", ")
	}

    WriteAuditLogFromCtx(c, "delete", "role", role.ID, role.DisplayName,
		map[string]any{"summary": actionText, "migratedUsers": count})
	response.OK(c, gin.H{"ok": true, "migratedUsers": count})
}

// ToggleRoleStatus enables or disables a role.
// Disabled roles: users stay in role but lose all role-level permissions.
func (h *PermissionHandler) ToggleRoleStatus(c *gin.Context) {
	id := c.Param("id")
	var role model.Role
	if err := database.DB.First(&role, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Role not found")
		return
	}
	if role.IsBuiltin {
		response.BadRequest(c, "FORBIDDEN", "Built-in roles cannot be disabled")
		return
	}

	var req struct {
		Status string `json:"status" binding:"required"` // active | disabled
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}
	if req.Status != "active" && req.Status != "disabled" {
        response.BadRequest(c, "INVALID_STATUS", "status must be active or disabled")
		return
	}

	database.DB.Model(&role).Update("status", req.Status)

    actionText := "Enabled role"
	if req.Status == "disabled" {
        actionText = "Disabled role while keeping user assignments"
	}

    action := "enable"
	if req.Status == "disabled" {
        action = "disable"
	}
    WriteAuditLogFromCtx(c, action, "role", role.ID, role.DisplayName,
		map[string]any{"status": req.Status, "summary": actionText})
	response.OK(c, gin.H{"ok": true, "status": req.Status})
}

// GetRoleUsers returns users assigned to a specific role.
func (h *PermissionHandler) GetRoleUsers(c *gin.Context) {
	roleName := c.Param("roleName")

	// Get user IDs from bindings
	var bindings []model.UserRoleBinding
	database.DB.Where("role_name = ?", roleName).Find(&bindings)
	userIDs := make([]string, 0, len(bindings))
	for _, b := range bindings {
		userIDs = append(userIDs, b.UserID)
	}

	// Also include legacy users with role field (only if they have NO bindings at all)
	idSet := make(map[string]bool)
	for _, id := range userIDs { idSet[id] = true }
	var legacyUsers []model.User
	database.DB.Where("role = ?", roleName).Select("id").Find(&legacyUsers)
	for _, lu := range legacyUsers {
		if idSet[lu.ID] {
			continue // already in bindings
		}
		// Check if this user has ANY bindings
		var bindingCount int64
		database.DB.Model(&model.UserRoleBinding{}).Where("user_id = ?", lu.ID).Count(&bindingCount)
		if bindingCount == 0 {
			// No bindings at all, so fall back to the legacy role field.
			userIDs = append(userIDs, lu.ID)
		}
	}

	var users []model.User
	if len(userIDs) > 0 {
		database.DB.Where("id IN ?", userIDs).
			Select("id, username, email, status, avatar_url, created_at, last_login_at").
			Order("last_login_at DESC").
			Find(&users)
	}

	type userItem struct {
		ID          string `json:"id"`
		Username    string `json:"username"`
		Email       string `json:"email"`
		Status      string `json:"status"`
		AvatarURL   string `json:"avatarUrl,omitempty"`
		LastLoginAt string `json:"lastLoginAt"`
		Protected   bool   `json:"protected"` // true = cannot be removed from this role
	}
	adminEmail := config.Global.App.AdminEmail
	items := make([]userItem, 0, len(users))
	for _, u := range users {
		login := ""
		if u.LastLoginAt != nil {
			login = u.LastLoginAt.In(cstZone).Format("2006-01-02 15:04")
		}
		// admin@atop.local on super_admin role is protected
		isProtected := roleName == "super_admin" && u.Email == adminEmail
		items = append(items, userItem{
			ID:          u.ID,
			Username:    u.Username,
			Email:       u.Email,
			Status:      u.Status,
			AvatarURL:   u.AvatarURL,
			LastLoginAt: login,
			Protected:   isProtected,
		})
	}
	response.OK(c, items)
}

// AssignUsersToRole assigns one or more users to the given role.
func (h *PermissionHandler) AssignUsersToRole(c *gin.Context) {
	roleName := c.Param("roleName")
	// Verify role exists
	var role model.Role
	if err := database.DB.Where("name = ?", roleName).First(&role).Error; err != nil {
        response.NotFound(c, "Role not found")
		return
	}

	var req struct {
		UserIDs []string `json:"userIds" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	// Create role bindings (idempotent)
	for _, uid := range req.UserIDs {
		var existing model.UserRoleBinding
		if err := database.DB.Where("user_id = ? AND role_name = ?", uid, roleName).
			First(&existing).Error; err != nil {
			// Not found, create
			binding := model.UserRoleBinding{UserID: uid, RoleName: roleName}
			database.DB.Create(&binding)
		}
	}

	// Resolve user names for audit
	nameMap := ResolveUserNames(req.UserIDs)
	names := make([]string, 0, len(req.UserIDs))
	for _, uid := range req.UserIDs {
		if n, ok := nameMap[uid]; ok {
			names = append(names, n)
		}
	}
    actionText := "Assigned users: " + strings.Join(names, ", ")

    WriteAuditLogFromCtx(c, "assign_users", "role", role.ID, role.DisplayName,
		map[string]any{"userIds": req.UserIDs, "userNames": names, "summary": actionText})
	response.OK(c, gin.H{"ok": true})
}

// RemoveUserFromRole removes a user from the given role (resets to member).
func (h *PermissionHandler) RemoveUserFromRole(c *gin.Context) {
	roleName := c.Param("roleName")
	userID := c.Param("userId")

	// Get role for audit logging
	var role model.Role
	if err := database.DB.Where("name = ?", roleName).First(&role).Error; err != nil {
        response.NotFound(c, "Role not found")
		return
	}

	var user model.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
        response.NotFound(c, "User not found")
		return
	}

	// Check if binding exists
	var binding model.UserRoleBinding
	if err := database.DB.Where("user_id = ? AND role_name = ?", userID, roleName).
		First(&binding).Error; err != nil {
        response.BadRequest(c, "NOT_IN_ROLE", "The user is not assigned to this role")
		return
	}

	// Protect system admin's super_admin role
	if roleName == "super_admin" && user.Email == config.Global.App.AdminEmail {
        response.BadRequest(c, "PROTECTED", "The built-in super admin user cannot be removed from this role")
		return
	}

	// Remove binding
	database.DB.Delete(&binding)

	// Also clear legacy User.Role field if it matches this role
	if string(user.Role) == roleName {
		// Set legacy role to the user's next remaining role, or empty
		var nextBinding model.UserRoleBinding
		if err := database.DB.Where("user_id = ? AND role_name != ?", userID, roleName).
			First(&nextBinding).Error; err == nil {
			database.DB.Model(&user).Update("role", nextBinding.RoleName)
		} else {
			database.DB.Model(&user).Update("role", "")
		}
	}

    WriteAuditLogFromCtx(c, "remove_user", "role", role.ID, role.DisplayName,
		map[string]any{"userId": user.ID, "userName": user.Username})
	response.OK(c, gin.H{"ok": true})
}

// GetRoleHistory returns audit logs related to a specific role.
func (h *PermissionHandler) GetRoleHistory(c *gin.Context) {
	roleID := c.Param("id")
	var role model.Role
	if err := database.DB.First(&role, "id = ?", roleID).Error; err != nil {
        response.NotFound(c, "Role not found")
		return
	}

	var logs []model.AuditLog
	database.DB.Where(
		"(resource_type IN ? AND (resource_id = ? OR resource_name = ? OR resource_name = ?))",
		[]string{"role", "permission", "role_permission"}, role.ID, role.DisplayName, role.Name,
	).Order("created_at DESC").Limit(50).Find(&logs)

	type logItem struct {
		Action    string `json:"action"`
		UserEmail string `json:"userEmail"`
		CreatedAt string `json:"createdAt"`
	}
	items := make([]logItem, 0, len(logs))
	for _, l := range logs {
		items = append(items, logItem{
			Action:    l.Action,
			UserEmail: l.Username,
			CreatedAt: l.CreatedAt.In(cstZone).Format("2006-01-02 15:04"),
		})
	}
	response.OK(c, items)
}

// permLabel converts "resource.action" to a readable label.
func permLabel(key string) string {
	parts := strings.SplitN(key, ".", 2)
	if len(parts) != 2 {
		return key
	}
	resLabels := map[string]string{
		"pipeline": "流水线", "jenkins": "Jenkins 实例", "vars": "公共变量池",
		"dimensions": "数据字典", "users": "用户管理", "roles": "角色管理",
		"audit": "审计日志", "notification_rule": "通知规则",
		"permission": "权限配置", "cleanup": "数据清理",
	}
	actLabels := map[string]string{
		"view": "查看", "create": "新建", "edit": "编辑", "delete": "删除",
		"trigger": "触发", "import": "导入", "clone": "复制", "ping": "连通",
		"sync": "同步", "reset_pwd": "重置密码", "disable": "禁用", "fullscreen": "全屏",
	}
	res := resLabels[parts[0]]
	if res == "" {
		res = parts[0]
	}
	act := actLabels[parts[1]]
	if act == "" {
		act = parts[1]
	}
	return act + "（" + res + "）"
}

// GetUserHistory returns audit logs related to a specific user.
func (h *PermissionHandler) GetUserHistory(c *gin.Context) {
	userID := c.Param("id")

	var user model.User
	if err := database.DB.Select("id, username, email").First(&user, "id = ?", userID).Error; err != nil {
        response.NotFound(c, "User not found")
		return
	}

	var logs []model.AuditLog
	// Only match:
	// 1. This user's own login records (user_id matches AND action is login)
	// 2. Actions performed on this user by anyone (resource_type=user and resource_id matches)
	database.DB.Where(
        "(user_id = ? AND action IN ?) OR (resource_type IN ? AND resource_id = ?)",
		userID, []string{"login", "sign_in"}, []string{"user", "user_account"}, userID,
	).Order("created_at DESC").Limit(50).Find(&logs)

	type logItem struct {
		Action    string `json:"action"`
		UserEmail string `json:"userEmail"`
		CreatedAt string `json:"createdAt"`
	}
	items := make([]logItem, 0, len(logs))
	for _, l := range logs {
		items = append(items, logItem{
			Action:    l.Action,
			UserEmail: l.Username,
			CreatedAt: l.CreatedAt.In(cstZone).Format("2006-01-02 15:04"),
		})
	}
	response.OK(c, items)
}
