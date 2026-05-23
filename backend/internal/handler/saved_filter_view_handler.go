package handler

import (
	"encoding/json"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/pkg/response"
)

type SavedFilterViewHandler struct{}

func NewSavedFilterViewHandler() *SavedFilterViewHandler { return &SavedFilterViewHandler{} }

type savedFilterViewResp struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Filters   json.RawMessage `json:"filters"`
	CreatedAt any             `json:"createdAt"`
	UpdatedAt any             `json:"updatedAt"`
}

func savedFilterViewResponse(row model.SavedFilterView) savedFilterViewResp {
	raw := json.RawMessage(row.FiltersJSON)
	if !json.Valid(raw) {
		raw = json.RawMessage(`{}`)
	}
	return savedFilterViewResp{
		ID:        row.ID,
		Name:      row.Name,
		Filters:   raw,
		CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt,
	}
}

func normalizeFilterScope(scope string) string {
	return strings.TrimSpace(scope)
}

// List returns saved filter views for the current user and one page/workbench.
func (h *SavedFilterViewHandler) List(c *gin.Context) {
	userID := middleware.GetUserID(c)
	scopeKey := normalizeFilterScope(c.Query("scopeKey"))
	if scopeKey == "" {
		response.BadRequest(c, "INVALID_SCOPE", "scopeKey 不能为空")
		return
	}

	var rows []model.SavedFilterView
	if err := database.DB.
		Where("user_id = ? AND scope_key = ?", userID, scopeKey).
		Order("updated_at DESC").
		Find(&rows).Error; err != nil {
		response.InternalError(c, "读取筛选视图失败")
		return
	}

	items := make([]savedFilterViewResp, 0, len(rows))
	for _, row := range rows {
		items = append(items, savedFilterViewResponse(row))
	}
	response.OK(c, gin.H{"items": items})
}

// Save creates or replaces one named filter view for the current user.
func (h *SavedFilterViewHandler) Save(c *gin.Context) {
	userID := middleware.GetUserID(c)
	var body struct {
		ScopeKey string          `json:"scopeKey"`
		Name     string          `json:"name"`
		Filters  json.RawMessage `json:"filters"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", "参数不完整")
		return
	}

	scopeKey := normalizeFilterScope(body.ScopeKey)
	name := strings.TrimSpace(body.Name)
	if scopeKey == "" || len(scopeKey) > 100 {
		response.BadRequest(c, "INVALID_SCOPE", "scopeKey 不合法")
		return
	}
	if name == "" || len([]rune(name)) > 40 {
		response.BadRequest(c, "INVALID_NAME", "视图名称不能为空且不能超过 40 个字符")
		return
	}
	if len(body.Filters) == 0 || !json.Valid(body.Filters) {
		response.BadRequest(c, "INVALID_FILTERS", "筛选条件必须是合法 JSON")
		return
	}

	var row model.SavedFilterView
	err := database.DB.Where("user_id = ? AND scope_key = ? AND name = ?", userID, scopeKey, name).First(&row).Error
	if err != nil && err != gorm.ErrRecordNotFound {
		response.InternalError(c, "保存筛选视图失败")
		return
	}

	if err == gorm.ErrRecordNotFound {
		row = model.SavedFilterView{
			UserID:      userID,
			ScopeKey:    scopeKey,
			Name:        name,
			FiltersJSON: string(body.Filters),
		}
		if err := database.DB.Create(&row).Error; err != nil {
			response.InternalError(c, "保存筛选视图失败")
			return
		}
	} else {
		row.FiltersJSON = string(body.Filters)
		if err := database.DB.Save(&row).Error; err != nil {
			response.InternalError(c, "保存筛选视图失败")
			return
		}
	}

	// Keep the newest 30 views per user and page to prevent unbounded growth.
	var keepIDs []string
	database.DB.Model(&model.SavedFilterView{}).
		Where("user_id = ? AND scope_key = ?", userID, scopeKey).
		Order("updated_at DESC").
		Limit(30).
		Pluck("id", &keepIDs)
	if len(keepIDs) > 0 {
		database.DB.Where("user_id = ? AND scope_key = ? AND id NOT IN ?", userID, scopeKey, keepIDs).
			Delete(&model.SavedFilterView{})
	}

	response.OK(c, savedFilterViewResponse(row))
}

// Delete removes one saved filter view belonging to the current user.
func (h *SavedFilterViewHandler) Delete(c *gin.Context) {
	userID := middleware.GetUserID(c)
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		response.BadRequest(c, "INVALID_ID", "视图不存在")
		return
	}
	database.DB.Where("id = ? AND user_id = ?", id, userID).Delete(&model.SavedFilterView{})
	response.OK(c, gin.H{"ok": true})
}
