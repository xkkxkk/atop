package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/logger"
	"go.uber.org/zap"
)


// ── External URL auto-detection ───────────────────────────────────────────
// getExternalURL returns the platform base URL for email links.
// Priority: 1) EXTERNAL_URL env var, 2) auto-detected from middleware cache
func getExternalURL() string {
	if u := config.Global.App.ExternalURL; u != "" {
		return u
	}
	return middleware.GetCachedExternalURL()
}

// NotificationPayload carries all data needed to dispatch a notification.
type NotificationPayload struct {
	Event    string // model.NotiXxx constant
	Title    string
	Body     string
	Link     string // optional deep link e.g. /dashboard/runs/xxx
	RefID    string // pipeline_run / task_run ID
	RefType  string // "pipeline_run" | "task_run"
	// Target: if UserIDs is empty, notify all relevant users based on event
	UserIDs  []string
}

// SendNotification dispatches a notification to all relevant users.
// Delivery is async (email/webhook in goroutines) to not block callers.
func SendNotification(p NotificationPayload) {
	if len(p.UserIDs) == 0 {
		return
	}

	for _, userID := range p.UserIDs {
		uid := userID // capture
		go dispatchToUser(p, uid)
	}
}

func dispatchToUser(p NotificationPayload, userID string) {
	// Load user
	var user model.User
	if err := database.DB.First(&user, "id = ?", userID).Error; err != nil {
		return
	}

	// Load preferences
	var pref model.NotificationPreference
	if err := database.DB.Where("user_id = ?", userID).First(&pref).Error; err != nil {
		// Use defaults if no preference set
		pref = model.NotificationPreference{
			UserID:       userID,
			InAppEnabled: true,
			EmailEnabled: false,
		}
	}

	// Check event switch
	if !isEventEnabled(pref.EventSwitches, p.Event) {
		return
	}

	// 1. In-app notification
	if pref.InAppEnabled {
		noti := model.Notification{
			UserID:  userID,
			Event:   p.Event,
			Title:   p.Title,
			Body:    p.Body,
			Link:    p.Link,
			IsRead:  false,
			RefID:   p.RefID,
			RefType: p.RefType,
		}
		noti.ID = uuid.New().String()
		database.DB.Create(&noti)
	}

	// 2. Email notification
	if pref.EmailEnabled && user.Email != "" {
		cfg := config.Global.SMTP
		if cfg.Enabled {
			go func() {
				subject := fmt.Sprintf("【ATOP】%s", p.Title)
				body    := buildEmailBody(user.Username, p)
				if err := util.SendEmail(cfg.Host, cfg.Port, cfg.Username,
					cfg.Password, cfg.From, user.Email, subject, body, cfg.Security); err != nil {
					logger.Error("notification email failed",
						zap.String("user", user.Email), zap.Error(err))
				}
			}()
		}
	}

	// 3. Webhook notification
	if pref.WebhookEnabled && pref.WebhookURL != "" {
		go func() {
			payload := map[string]any{
				"event":    p.Event,
				"title":    p.Title,
				"body":     p.Body,
				"link":     p.Link,
				"refId":    p.RefID,
				"refType":  p.RefType,
				"time":     time.Now().Format(time.RFC3339),
				"user":     user.Username,
			}
			b, _ := json.Marshal(payload)
			req, err := http.NewRequest("POST", pref.WebhookURL, bytes.NewReader(b))
			if err != nil {
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-ATOP-Event", p.Event)
			client := &http.Client{Timeout: 10 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				logger.Warn("notification webhook failed",
					zap.String("url", pref.WebhookURL), zap.Error(err))
				return
			}
			resp.Body.Close()
		}()
	}
}

// isEventEnabled checks if the user has enabled this event type.
// Defaults to true if not configured.
func isEventEnabled(switchesJSON, event string) bool {
	if event == model.NotiTaskFailed {
		return false
	}
	if switchesJSON == "" {
		return defaultEventEnabled(event)
	}
	var switches map[string]bool
	if err := json.Unmarshal([]byte(switchesJSON), &switches); err != nil {
		return defaultEventEnabled(event)
	}
	if val, ok := switches[event]; ok {
		return val
	}
	return defaultEventEnabled(event)
}

func defaultEventEnabled(event string) bool {
	switch event {
	case model.NotiTaskFailed:
		return false
	default:
		return true
	}
}

// buildEmailBody generates HTML email for a notification.
func buildEmailBody(username string, p NotificationPayload) string {
	eventEmoji := map[string]string{
		model.NotiPipelineComplete: "✅",
		model.NotiPipelineFailed:   "❌",
		model.NotiPipelineAborted:  "⚠️",
		model.NotiTaskFailed:       "🔴",
		model.NotiUserDisabled:     "🔒",
		model.NotiPasswordReset:    "🔑",
	}
	emoji := eventEmoji[p.Event]
	if emoji == "" {
		emoji = "🔔"
	}

	linkHTML := ""
	if p.Link != "" {
		baseURL := config.Global.App.ExternalURL
		if baseURL == "" {
			baseURL = "http://localhost:8888"
		}
		fullURL := baseURL + p.Link
		linkHTML = fmt.Sprintf(`<div style="text-align:center;margin:20px 0">
			<a href="%s" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600">查看详情</a>
		</div>`, fullURL)
	}

	return fmt.Sprintf(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:'PingFang SC','Microsoft YaHei',sans-serif;background:#f5f5f4;margin:0;padding:24px">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:linear-gradient(135deg,#1a3a6b,#2563EB);padding:24px 36px;text-align:center">
    <div style="font-size:22px;font-weight:800;color:#fff">ATOP 平台通知</div>
  </div>
  <div style="padding:28px 36px">
    <p style="font-size:15px;color:#1A1A18;margin:0 0 8px">你好，<strong>%s</strong></p>
    <div style="background:#F8F9FA;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #2563EB">
      <div style="font-size:18px;margin-bottom:6px">%s %s</div>
      <div style="font-size:13px;color:#5F5E5A;line-height:1.7">%s</div>
    </div>
    %s
    <hr style="border:none;border-top:1px solid #f0f0f0;margin:20px 0">
    <p style="font-size:12px;color:#9C9A92;margin:0">此邮件由 ATOP 自动发送，请勿直接回复。</p>
  </div>
</div>
</body></html>`, username, emoji, p.Title, p.Body, linkHTML)
}

// ── High-level helpers called from handlers ───────────────────────────────

// NotifyPipelineRun sends notifications for a pipeline run result.
func NotifyPipelineRun(run *model.PipelineRun, triggerUserID string) {
	if run == nil {
		return
	}

	var event, title, body string
	switch run.Status {
	case "success":
		event = model.NotiPipelineComplete
		title = fmt.Sprintf("流水线「%s」运行完成", run.PipelineName)
		body  = fmt.Sprintf("通过率 %.1f%%，共 %d 个任务，耗时 %s",
			run.PassRate, run.TotalCount, formatDuration(run.DurationMs))
	case "failed":
		event = model.NotiPipelineFailed
		title = fmt.Sprintf("流水线「%s」运行失败", run.PipelineName)
		body  = fmt.Sprintf("失败 %d 个任务，通过率 %.1f%%，请及时处理",
			run.FailedCount, run.PassRate)
	case "aborted":
		event = model.NotiPipelineAborted
		title = fmt.Sprintf("流水线「%s」已中止", run.PipelineName)
		body  = "流水线运行被手动中止"
	default:
		return
	}

	// Notify the trigger user + project managers
	userIDs := collectNotifyUsers(run.PipelineName, triggerUserID)

	SendNotification(NotificationPayload{
		Event:   event,
		Title:   title,
		Body:    body,
		Link:    fmt.Sprintf("/dashboard/runs/%s", run.ID),
		RefID:   run.ID,
		RefType: "pipeline_run",
		UserIDs: userIDs,
	})
}

// NotifyUserEvent sends account-level notifications.
func NotifyUserEvent(targetUserID, event, title, body string) {
	SendNotification(NotificationPayload{
		Event:   event,
		Title:   title,
		Body:    body,
		UserIDs: []string{targetUserID},
	})
}

// NotifyUserInAppEvent writes account-level in-app notifications without email/webhook fanout.
func NotifyUserInAppEvent(targetUserID, event, title, body string) {
	if strings.TrimSpace(targetUserID) == "" {
		return
	}

	noti := model.Notification{
		UserID:  targetUserID,
		Event:   event,
		Title:   title,
		Body:    body,
		IsRead:  false,
		RefID:   "",
		RefType: "account",
	}
	noti.ID = uuid.New().String()
	database.DB.Create(&noti)
}

// collectNotifyUsers returns user IDs that should be notified for a project event.
func collectNotifyUsers(project, triggerUserID string) []string {
	seen := map[string]bool{}
	var ids []string

	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}

	// Always notify the trigger user
	add(triggerUserID)

	// Notify project managers of the project
	var managers []model.User
	database.DB.Where("role IN ? AND status = 'active'",
		[]string{"super_admin", "project_manager"}).Find(&managers)
	for _, m := range managers {
		projects := util.FromJSONDefault[[]string](m.Projects, []string{})
		if m.Role == "super_admin" || len(projects) == 0 {
			add(m.ID)
		} else {
			for _, p := range projects {
				if p == project {
					add(m.ID)
					break
				}
			}
		}
	}

	return ids
}

func formatDuration(ms int64) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	if ms < 60000 {
		return fmt.Sprintf("%.1fs", float64(ms)/1000)
	}
	return fmt.Sprintf("%dm%ds", ms/60000, (ms%60000)/1000)
}

