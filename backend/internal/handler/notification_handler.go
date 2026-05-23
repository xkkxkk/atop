package handler

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/pkg/response"
)

type NotificationHandler struct{}

func notificationPageParams(c *gin.Context, defaultSize int) (int, int) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", strconv.Itoa(defaultSize)))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = defaultSize
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}

func isInAppPreferenceEnabled(userID string) bool {
	var pref model.NotificationPreference
	if err := database.DB.Where("user_id = ?", userID).First(&pref).Error; err != nil {
		return true
	}
	return pref.InAppEnabled
}

func enabledInAppEvents(userID string) []string {
	switches := defaultNotificationSwitches()
	var pref model.NotificationPreference
	if err := database.DB.Where("user_id = ?", userID).First(&pref).Error; err == nil && pref.EventSwitches != "" {
		var stored map[string]bool
		json.Unmarshal([]byte(pref.EventSwitches), &stored)
		for event, enabled := range stored {
			if event != model.NotiTaskFailed {
				switches[event] = enabled
			}
		}
	}
	events := make([]string, 0, len(switches))
	for event, enabled := range switches {
		if enabled {
			events = append(events, event)
		}
	}
	return events
}

func defaultNotificationSwitches() map[string]bool {
	return map[string]bool{
		model.NotiPipelineComplete: true,
		model.NotiPipelineFailed:   true,
		model.NotiPipelineAborted:  true,
		model.NotiUserDisabled:     true,
		model.NotiPasswordReset:    true,
	}
}

// List returns the current user's notifications (paginated).
func (h *NotificationHandler) List(c *gin.Context) {
	userID   := middleware.GetUserID(c)
	page, pageSize := notificationPageParams(c, 20)
	onlyUnread := c.Query("unread") == "true"
	status := strings.ToLower(strings.TrimSpace(c.Query("status")))

	var total int64
	db := database.DB.Model(&model.Notification{}).Where("user_id = ?", userID)
	if onlyUnread || status == "unread" {
		db = db.Where("is_read = false")
	} else if status == "read" {
		db = db.Where("is_read = true")
	}
	db.Count(&total)

	var items []model.Notification
	db.Order("created_at DESC").Limit(pageSize).Offset((page - 1) * pageSize).Find(&items)
	if items == nil {
		items = []model.Notification{}
	}

	// Unread count (always compute separately)
	var unreadCount int64
	database.DB.Model(&model.Notification{}).
		Where("user_id = ? AND is_read = false", userID).Count(&unreadCount)

	response.OK(c, gin.H{
		"items":       items,
		"total":       total,
		"unreadCount": unreadCount,
		"page":        page,
		"pageSize":    pageSize,
	})
}

// Recent returns the latest 10 notifications for the header bell.
func (h *NotificationHandler) Recent(c *gin.Context) {
	userID := middleware.GetUserID(c)
	var items []model.Notification
	database.DB.Where("user_id = ?", userID).
		Order("created_at DESC").
		Limit(10).
		Find(&items)
	if items == nil {
		items = []model.Notification{}
	}

	var unreadCount int64
	database.DB.Model(&model.Notification{}).
		Where("user_id = ? AND is_read = false", userID).Count(&unreadCount)

	response.OK(c, gin.H{
		"items":       items,
		"unreadCount": unreadCount,
	})
}

// Get returns one notification belonging to the current user.
func (h *NotificationHandler) Get(c *gin.Context) {
	userID := middleware.GetUserID(c)
	var item model.Notification
	if err := database.DB.Where("id = ? AND user_id = ?", c.Param("id"), userID).First(&item).Error; err != nil {
		response.NotFound(c, "消息不存在")
		return
	}
	response.OK(c, item)
}

// UnreadCount returns only the unread count (for polling).
func (h *NotificationHandler) UnreadCount(c *gin.Context) {
	userID := middleware.GetUserID(c)
	var count int64
	database.DB.Model(&model.Notification{}).
		Where("user_id = ? AND is_read = false", userID).Count(&count)
	response.OK(c, gin.H{"count": count})
}

// MarkRead marks one or all notifications as read.
func (h *NotificationHandler) MarkRead(c *gin.Context) {
	userID := middleware.GetUserID(c)
	id     := c.Param("id")

	database.DB.Model(&model.Notification{}).
		Where("id = ? AND user_id = ?", id, userID).
		Update("is_read", true)
	response.OK(c, gin.H{"ok": true})
}

// MarkAllRead marks all current user's unread notifications as read.
func (h *NotificationHandler) MarkAllRead(c *gin.Context) {
	userID := middleware.GetUserID(c)
	database.DB.Model(&model.Notification{}).
		Where("user_id = ? AND is_read = false", userID).
		Update("is_read", true)
	response.OK(c, gin.H{"ok": true})
}

// BatchUpdate updates read state for selected notifications.
func (h *NotificationHandler) BatchUpdate(c *gin.Context) {
	userID := middleware.GetUserID(c)
	var body struct {
		Ids    []string `json:"ids"`
		IsRead bool     `json:"isRead"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", "参数不完整")
		return
	}
	if len(body.Ids) == 0 {
		response.BadRequest(c, "EMPTY_SELECTION", "请选择消息")
		return
	}
	database.DB.Model(&model.Notification{}).
		Where("user_id = ? AND id IN ?", userID, body.Ids).
		Update("is_read", body.IsRead)
	response.OK(c, gin.H{"ok": true})
}

// BatchDelete removes selected notifications.
func (h *NotificationHandler) BatchDelete(c *gin.Context) {
	userID := middleware.GetUserID(c)
	var body struct {
		Ids []string `json:"ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.Ids) == 0 {
		response.BadRequest(c, "EMPTY_SELECTION", "请选择消息")
		return
	}
	database.DB.Where("user_id = ? AND id IN ?", userID, body.Ids).Delete(&model.Notification{})
	response.OK(c, gin.H{"ok": true})
}

// Delete removes a notification.
func (h *NotificationHandler) Delete(c *gin.Context) {
	userID := middleware.GetUserID(c)
	id     := c.Param("id")
	database.DB.Where("id = ? AND user_id = ?", id, userID).
		Delete(&model.Notification{})
	response.OK(c, gin.H{"ok": true})
}

// GetPreference returns the current user's notification preferences.
func (h *NotificationHandler) GetPreference(c *gin.Context) {
	userID := middleware.GetUserID(c)
	var pref model.NotificationPreference

	if err := database.DB.Where("user_id = ?", userID).First(&pref).Error; err != nil {
		// Return defaults if not set
		pref = model.NotificationPreference{
			UserID:       userID,
			InAppEnabled: true,
			EmailEnabled: false,
			EventSwitches: `{
				"pipeline_complete": true,
				"pipeline_failed":   true,
				"pipeline_aborted":  true,
				"user_disabled":     true,
				"password_reset":    true
			}`,
		}
	}

	switches := defaultNotificationSwitches()

	// Parse event switches for the response
	if pref.EventSwitches != "" {
		var stored map[string]bool
		json.Unmarshal([]byte(pref.EventSwitches), &stored)
		for event, enabled := range stored {
			if event != model.NotiTaskFailed {
				switches[event] = enabled
			}
		}
	}

	response.OK(c, gin.H{
		"inAppEnabled":   pref.InAppEnabled,
		"emailEnabled":   pref.EmailEnabled,
		"webhookEnabled": pref.WebhookEnabled,
		"webhookUrl":     pref.WebhookURL,
		"eventSwitches":  switches,
	})
}

// UpdatePreference saves the current user's notification preferences.
func (h *NotificationHandler) UpdatePreference(c *gin.Context) {
	userID := middleware.GetUserID(c)

	var body struct {
		InAppEnabled   bool            `json:"inAppEnabled"`
		EmailEnabled   bool            `json:"emailEnabled"`
		WebhookEnabled bool            `json:"webhookEnabled"`
		WebhookURL     string          `json:"webhookUrl"`
		EventSwitches  map[string]bool `json:"eventSwitches"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	delete(body.EventSwitches, model.NotiTaskFailed)
	switchesJSON, _ := json.Marshal(body.EventSwitches)

	var pref model.NotificationPreference
	if err := database.DB.Where("user_id = ?", userID).First(&pref).Error; err != nil {
		// Create
		pref = model.NotificationPreference{
			UserID:         userID,
			InAppEnabled:   body.InAppEnabled,
			EmailEnabled:   body.EmailEnabled,
			WebhookEnabled: body.WebhookEnabled,
			WebhookURL:     body.WebhookURL,
			EventSwitches:  string(switchesJSON),
		}
		database.DB.Create(&pref)
	} else {
		database.DB.Model(&pref).Updates(map[string]any{
			"in_app_enabled":   body.InAppEnabled,
			"email_enabled":    body.EmailEnabled,
			"webhook_enabled":  body.WebhookEnabled,
			"webhook_url":      body.WebhookURL,
			"event_switches":   string(switchesJSON),
		})
	}

	response.OK(c, gin.H{"ok": true})
}
