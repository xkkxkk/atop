package handler

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/pkg/response"
	"gorm.io/gorm"
)

type RoleHandler struct{}

// List returns all roles with user count.
func (h *RoleHandler) List(c *gin.Context) {
	var roles []model.Role
	database.DB.Order("is_builtin DESC, created_at ASC").Find(&roles)

	type roleCount struct {
		Role  string `gorm:"column:role"`
		Count int64  `gorm:"column:cnt"`
	}
	var counts []roleCount
	database.DB.Model(&model.User{}).
		Select("role, COUNT(*) as cnt").
		Group("role").Find(&counts)

	countMap := make(map[string]int64)
	for _, rc := range counts {
		countMap[rc.Role] = rc.Count
	}

	creatorIDs := []string{}
	for _, r := range roles {
		if r.CreatedBy != "" {
			creatorIDs = append(creatorIDs, r.CreatedBy)
		}
	}
	nameMap := ResolveUserNames(creatorIDs)

	type roleItem struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		DisplayName string `json:"displayName"`
		Description string `json:"description"`
		IsBuiltin   bool   `json:"isBuiltin"`
		UserCount   int64  `json:"userCount"`
		CreatedBy   string `json:"createdBy"`
		CreatorName string `json:"creatorName"`
		CreatedAt   string `json:"createdAt"`
	}

	items := make([]roleItem, 0, len(roles))
	for _, r := range roles {
		items = append(items, roleItem{
			ID:          r.ID,
			Name:        r.Name,
			DisplayName: r.DisplayName,
			Description: r.Description,
			IsBuiltin:   r.IsBuiltin,
			UserCount:   countMap[r.Name],
			CreatedBy:   r.CreatedBy,
			CreatorName: nameMap[r.CreatedBy],
			CreatedAt:   r.CreatedAt.Format("2006-01-02 15:04:05"),
		})
	}

	response.OK(c, items)
}

// Get returns a single role.
func (h *RoleHandler) Get(c *gin.Context) {
	var role model.Role
	if err := database.DB.First(&role, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Role not found")
		return
	}
	response.OK(c, role)
}

// Create creates a new role.
func (h *RoleHandler) Create(c *gin.Context) {
	var req struct {
		Name        string                     `json:"name" binding:"required"`
		DisplayName string                     `json:"displayName" binding:"required"`
		Description string                     `json:"description"`
		Perms       map[string]map[string]bool `json:"perms"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	var count int64
	database.DB.Model(&model.Role{}).Where("name = ?", req.Name).Count(&count)
	if count > 0 {
		response.Conflict(c, "ROLE_EXISTS", "Role name already exists")
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
		return nil
	}); err != nil {
		response.InternalError(c, "Failed to create role: "+err.Error())
		return
	}

	WriteAuditLogFromCtx(c, "create", "role", role.ID, role.DisplayName, nil)
	response.Created(c, role)
}

// Update updates a role's display name and description.
func (h *RoleHandler) Update(c *gin.Context) {
	var role model.Role
	if err := database.DB.First(&role, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Role not found")
		return
	}

	if role.Name == "super_admin" {
		response.BadRequest(c, "FORBIDDEN", "The super admin role cannot be edited")
		return
	}

	var req struct {
		DisplayName string `json:"displayName"`
		Description string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	updates := map[string]any{}
	if req.DisplayName != "" {
		updates["display_name"] = req.DisplayName
	}
	if req.Description != "" {
		updates["description"] = req.Description
	}
	if len(updates) == 0 {
		response.OK(c, gin.H{"ok": true})
		return
	}

	if err := database.DB.Model(&role).Updates(updates).Error; err != nil {
		response.InternalError(c, "Failed to update role")
		return
	}

	auditName := role.DisplayName
	if req.DisplayName != "" {
		auditName = req.DisplayName
	}
	WriteAuditLogFromCtx(c, "update", "role", role.ID, auditName, nil)
	response.OK(c, gin.H{"ok": true})
}

// Delete deletes a custom role. Built-in roles cannot be deleted.
func (h *RoleHandler) Delete(c *gin.Context) {
	var role model.Role
	if err := database.DB.First(&role, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Role not found")
		return
	}

	if role.IsBuiltin {
		response.BadRequest(c, "BUILTIN_ROLE", "Built-in roles cannot be deleted")
		return
	}

	var userCount int64
	database.DB.Model(&model.User{}).Where("role = ?", role.Name).Count(&userCount)
	if userCount > 0 {
		response.BadRequest(c, "ROLE_IN_USE", "This role is still assigned to one or more users")
		return
	}

	if err := database.DB.Transaction(func(tx *gorm.DB) error {
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

	WriteAuditLogFromCtx(c, "delete", "role", role.ID, role.DisplayName, map[string]any{"name": role.DisplayName})
	response.OK(c, gin.H{"ok": true})
}
