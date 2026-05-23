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

type UserPreferenceHandler struct{}

func NewUserPreferenceHandler() *UserPreferenceHandler { return &UserPreferenceHandler{} }

func normalizePreferenceKey(key string) string {
	return strings.TrimSpace(key)
}

func (h *UserPreferenceHandler) Get(c *gin.Context) {
	userID := middleware.GetUserID(c)
	key := normalizePreferenceKey(c.Param("key"))
	if key == "" {
		response.BadRequest(c, "INVALID_KEY", "偏好键不能为空")
		return
	}

	var row model.UserPreference
	if err := database.DB.Where("user_id = ? AND pref_key = ?", userID, key).First(&row).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			response.OK(c, gin.H{"key": key, "value": nil})
			return
		}
		response.InternalError(c, "读取用户偏好失败")
		return
	}
	raw := json.RawMessage(row.ValueJSON)
	if !json.Valid(raw) {
		raw = json.RawMessage(`null`)
	}
	response.OK(c, gin.H{"key": key, "value": raw})
}

func (h *UserPreferenceHandler) Save(c *gin.Context) {
	userID := middleware.GetUserID(c)
	key := normalizePreferenceKey(c.Param("key"))
	if key == "" || len(key) > 100 {
		response.BadRequest(c, "INVALID_KEY", "偏好键不合法")
		return
	}

	var body struct {
		Value json.RawMessage `json:"value"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.Value) == 0 || !json.Valid(body.Value) {
		response.BadRequest(c, "INVALID_VALUE", "偏好值必须是合法 JSON")
		return
	}

	var row model.UserPreference
	err := database.DB.Where("user_id = ? AND pref_key = ?", userID, key).First(&row).Error
	if err != nil && err != gorm.ErrRecordNotFound {
		response.InternalError(c, "保存用户偏好失败")
		return
	}
	if err == gorm.ErrRecordNotFound {
		row = model.UserPreference{UserID: userID, PrefKey: key, ValueJSON: string(body.Value)}
		if err := database.DB.Create(&row).Error; err != nil {
			response.InternalError(c, "保存用户偏好失败")
			return
		}
	} else {
		row.ValueJSON = string(body.Value)
		if err := database.DB.Save(&row).Error; err != nil {
			response.InternalError(c, "保存用户偏好失败")
			return
		}
	}

	response.OK(c, gin.H{"key": key, "value": body.Value})
}
