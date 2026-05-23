package handler

import (
	"github.com/gin-gonic/gin"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/pkg/response"
)

type DimensionHandler struct{}

var validDimensions = map[string]bool{
	"project": true, "environment": true, "product": true,
	"silicon": true, "os": true, "run_type": true,
}

func dimensionAuditName(item model.DimensionItem) string {
	if item.DisplayName != "" {
		return item.DisplayName
	}
	return item.Value
}

func (h *DimensionHandler) List(c *gin.Context) {
	dim := c.Query("dimension")
	db := database.DB.Model(&model.DimensionItem{}).Order("dimension, sort_order ASC")
	if dim != "" {
		db = db.Where("dimension = ?", dim)
	}
	var items []model.DimensionItem
	db.Find(&items)
	response.OK(c, items)
}

func (h *DimensionHandler) Create(c *gin.Context) {
	var item model.DimensionItem
	if err := c.ShouldBindJSON(&item); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}
	if !validDimensions[item.Dimension] {
		response.BadRequest(c, "INVALID_DIMENSION", "Invalid dimension type")
		return
	}
	if item.Value == "" {
		response.BadRequest(c, "INVALID_PARAMS", "value is required")
		return
	}
	var count int64
	database.DB.Model(&model.DimensionItem{}).
		Where("dimension = ? AND value = ?", item.Dimension, item.Value).Count(&count)
	if count > 0 {
		response.Conflict(c, "DUPLICATE_VALUE", "Duplicate value under the same dimension")
		return
	}

	if err := database.DB.Create(&item).Error; err != nil {
		response.InternalError(c, "Create failed")
		return
	}
	WriteAuditLogFromCtx(c, "create", "dimension_dict", item.ID, dimensionAuditName(item),
		map[string]any{"dimension": item.Dimension, "value": item.Value})
	response.Created(c, item)
}

func (h *DimensionHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var item model.DimensionItem
	if err := database.DB.First(&item, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Item not found")
		return
	}
	var body struct {
		DisplayName string `json:"displayName"`
		SortOrder   *int   `json:"sortOrder"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}
	updates := map[string]any{"display_name": body.DisplayName}
	if body.SortOrder != nil {
		updates["sort_order"] = *body.SortOrder
	}
	database.DB.Model(&item).Updates(updates)
	database.DB.First(&item, "id = ?", id)
	WriteAuditLogFromCtx(c, "update", "dimension_dict", item.ID, dimensionAuditName(item),
		map[string]any{"dimension": item.Dimension, "value": item.Value})
	response.OK(c, item)
}

func (h *DimensionHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	var item model.DimensionItem
	if err := database.DB.First(&item, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Item not found")
		return
	}
	var count int64
	col := map[string]string{
		"project": "project", "environment": "environment", "product": "product",
		"silicon": "silicon", "os": "os", "run_type": "run_type",
	}[item.Dimension]
	if col != "" {
		database.DB.Model(&model.TestSet{}).Where(col+" = ?", item.Value).Count(&count)
		if count > 0 {
			response.Unprocessable(c, "IN_USE", "Value is used by test sets and cannot be deleted")
			return
		}
	}
	database.DB.Delete(&item)
	WriteAuditLogFromCtx(c, "delete", "dimension_dict", item.ID, dimensionAuditName(item),
		map[string]any{"dimension": item.Dimension, "value": item.Value})
	response.OK(c, gin.H{"ok": true})
}
