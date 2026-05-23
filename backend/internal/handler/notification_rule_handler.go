package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/response"
)

type NotificationRuleHandler struct{}

func NewNotificationRuleHandler() *NotificationRuleHandler { return &NotificationRuleHandler{} }

type notificationRuleKV struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type notificationRuleChannelConfig struct {
	URL          string               `json:"url"`
	Method       string               `json:"method"`
	Headers      []notificationRuleKV `json:"headers"`
	QueryParams  []notificationRuleKV `json:"queryParams"`
	BodyTemplate string               `json:"bodyTemplate"`
}

type notificationRuleTestResult struct {
	Channel    string `json:"channel"`
	OK         bool   `json:"ok"`
	StatusCode int    `json:"statusCode,omitempty"`
	Message    string `json:"message,omitempty"`
}

type notificationRuleTargets struct {
	UserIDs []string
	Emails  []string
}

var notificationRuleEventLabels = map[string]string{
	"pipeline_complete": "Pipeline completed",
	"pipeline_failed":   "Pipeline failed",
	"pipeline_aborted":  "Pipeline aborted",
}

var notificationRuleChannelLabels = map[string]string{
	"inapp":    "In-app",
	"email":    "Email",
	"dingtalk": "DingTalk webhook",
	"feishu":   "Feishu webhook",
	"webhook":  "Custom webhook",
}

func notificationRuleAuditName(rule model.NotificationRule) string {
	if name := strings.TrimSpace(rule.Name); name != "" {
		return name
	}
	return rule.ID
}

func notificationRuleJSONList(raw string) []string {
	var values []string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func notificationRuleJSONMap[T any](raw string) T {
	var value T
	if strings.TrimSpace(raw) == "" {
		return value
	}
	_ = json.Unmarshal([]byte(raw), &value)
	return value
}

func notificationRuleUniqueStrings(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func renderNotificationRuleTemplate(tpl string, vars map[string]string, fallback string) string {
	tpl = strings.TrimSpace(tpl)
	if tpl == "" {
		return fallback
	}
	out := tpl
	for key, value := range vars {
		out = strings.ReplaceAll(out, "${"+key+"}", value)
	}
	return out
}

func notificationRuleChannelConfigFor(rule model.NotificationRule, channel string) notificationRuleChannelConfig {
	configs := notificationRuleJSONMap[map[string]notificationRuleChannelConfig](rule.ChannelConfigsJSON)
	cfg := configs[channel]
	if strings.TrimSpace(cfg.URL) == "" {
		cfg.URL = strings.TrimSpace(rule.WebhookURL)
	}
	return cfg
}

func appendNotificationRuleQueryParams(rawURL string, params []notificationRuleKV, vars map[string]string) string {
	if strings.TrimSpace(rawURL) == "" || len(params) == 0 {
		return rawURL
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	query := parsed.Query()
	for _, item := range params {
		key := strings.TrimSpace(renderNotificationRuleTemplate(item.Key, vars, item.Key))
		if key == "" {
			continue
		}
		query.Set(key, renderNotificationRuleTemplate(item.Value, vars, item.Value))
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func defaultNotificationRuleWebhookBody(channel, event, title, body string, vars map[string]string) []byte {
	switch channel {
	case "dingtalk":
		b, _ := json.Marshal(map[string]any{
			"msgtype": "text",
			"text":    map[string]any{"content": title + "\n" + body},
		})
		return b
	case "feishu":
		b, _ := json.Marshal(map[string]any{
			"msg_type": "text",
			"content":  map[string]any{"text": title + "\n" + body},
		})
		return b
	default:
		b, _ := json.Marshal(map[string]any{
			"event":        event,
			"title":        title,
			"body":         body,
			"pipelineName": vars["PIPELINE_NAME"],
			"pipelineId":   vars["PIPELINE_ID"],
			"runId":        vars["RUN_ID"],
			"status":       vars["STATUS_CODE"],
			"passRate":     vars["PASS_RATE"],
			"detailUrl":    vars["DETAIL_URL"],
			"time":         time.Now().Format(time.RFC3339),
		})
		return b
	}
}

func notificationRuleOverlapMessage(candidate model.NotificationRule, excludeID string) (string, bool) {
	events := notificationRuleJSONList(candidate.EventsJSON)
	channels := notificationRuleJSONList(candidate.ChannelsJSON)
	if len(events) == 0 || len(channels) == 0 {
		return "", false
	}

	eventSet := map[string]bool{}
	channelSet := map[string]bool{}
	for _, event := range events {
		eventSet[event] = true
	}
	for _, channel := range channels {
		channelSet[channel] = true
	}

	var rules []model.NotificationRule
	db := database.DB.Select("id, name, events_json, channels_json")
	if excludeID != "" {
		db = db.Where("id <> ?", excludeID)
	}
	if err := db.Find(&rules).Error; err != nil {
		return "", false
	}

	for _, rule := range rules {
		for _, event := range notificationRuleJSONList(rule.EventsJSON) {
			if !eventSet[event] {
				continue
			}
			for _, channel := range notificationRuleJSONList(rule.ChannelsJSON) {
				if !channelSet[channel] {
					continue
				}
				name := notificationRuleAuditName(rule)
				eventLabel := notificationRuleEventLabels[event]
				if eventLabel == "" {
					eventLabel = event
				}
				channelLabel := notificationRuleChannelLabels[channel]
				if channelLabel == "" {
					channelLabel = channel
				}
				return fmt.Sprintf(
					"A notification rule with the same event and channel already exists: %s (%s / %s)",
					name,
					eventLabel,
					channelLabel,
				), true
			}
		}
	}

	return "", false
}

func notificationRuleAnyProjectMatch(userProjects string, projects []string) bool {
	if len(projects) == 0 {
		return true
	}
	userProjectValues := notificationRuleJSONList(userProjects)
	if len(userProjectValues) == 0 {
		return true
	}
	projectSet := map[string]bool{}
	for _, project := range projects {
		projectSet[project] = true
	}
	for _, project := range userProjectValues {
		if projectSet[project] {
			return true
		}
	}
	return false
}

func addNotificationRuleTargetUser(targets *notificationRuleTargets, seen map[string]bool, id string) {
	id = strings.TrimSpace(id)
	if id == "" || id == "system" || seen[id] {
		return
	}
	seen[id] = true
	targets.UserIDs = append(targets.UserIDs, id)
}

func addNotificationRuleUsersByRole(targets *notificationRuleTargets, seen map[string]bool, roles []string, projects []string) {
	roles = notificationRuleUniqueStrings(roles)
	if len(roles) == 0 {
		return
	}

	var users []model.User
	database.DB.Where("status = 'active' AND role IN ?", roles).Find(&users)
	for _, user := range users {
		if user.Role == model.RoleSuperAdmin || notificationRuleAnyProjectMatch(user.Projects, projects) {
			addNotificationRuleTargetUser(targets, seen, user.ID)
		}
	}

	var bindings []model.UserRoleBinding
	database.DB.Where("role_name IN ?", roles).Find(&bindings)
	var bindingUserIDs []string
	for _, binding := range bindings {
		bindingUserIDs = append(bindingUserIDs, binding.UserID)
	}
	bindingUserIDs = notificationRuleUniqueStrings(bindingUserIDs)
	if len(bindingUserIDs) == 0 {
		return
	}

	var roleUsers []model.User
	database.DB.Where("id IN ? AND status = 'active'", bindingUserIDs).Find(&roleUsers)
	for _, user := range roleUsers {
		if user.Role == model.RoleSuperAdmin || notificationRuleAnyProjectMatch(user.Projects, projects) {
			addNotificationRuleTargetUser(targets, seen, user.ID)
		}
	}
}

func resolveNotificationRuleTestTargets(rule model.NotificationRule, operatorID string) notificationRuleTargets {
	targets := notificationRuleTargets{}
	seenUsers := map[string]bool{}
	recipients := notificationRuleJSONMap[map[string]any](rule.RecipientsJSON)
	recipientType, _ := recipients["type"].(string)
	projects := notificationRuleJSONList(rule.ProjectIDsJSON)

	switch recipientType {
	case "users":
		if ids, ok := recipients["userIds"].([]any); ok {
			for _, id := range ids {
				if s, ok := id.(string); ok {
					addNotificationRuleTargetUser(&targets, seenUsers, s)
				}
			}
		}
	case "roles":
		var roles []string
		if rawRoles, ok := recipients["roles"].([]any); ok {
			for _, role := range rawRoles {
				if s, ok := role.(string); ok {
					roles = append(roles, s)
				}
			}
		}
		addNotificationRuleUsersByRole(&targets, seenUsers, roles, projects)
	case "role_pm":
		addNotificationRuleUsersByRole(&targets, seenUsers, []string{"project_manager", "super_admin"}, projects)
	case "all_members":
		var users []model.User
		database.DB.Where("status = 'active'").Find(&users)
		for _, user := range users {
			if user.Role == model.RoleSuperAdmin || notificationRuleAnyProjectMatch(user.Projects, projects) {
				addNotificationRuleTargetUser(&targets, seenUsers, user.ID)
			}
		}
	case "custom":
		if emails, ok := recipients["emails"].([]any); ok {
			for _, email := range emails {
				if s, ok := email.(string); ok {
					targets.Emails = append(targets.Emails, s)
				}
			}
		}
	default:
		addNotificationRuleTargetUser(&targets, seenUsers, operatorID)
	}

	targets.Emails = notificationRuleUniqueStrings(targets.Emails)
	return targets
}

func notificationRuleTargetEmails(targets notificationRuleTargets) []string {
	emails := append([]string{}, targets.Emails...)
	if len(targets.UserIDs) > 0 {
		var users []model.User
		database.DB.Select("id, email").Where("id IN ? AND status = 'active'", targets.UserIDs).Find(&users)
		for _, user := range users {
			emails = append(emails, user.Email)
		}
	}
	return notificationRuleUniqueStrings(emails)
}

// GET /notifications/rules
func (h *NotificationRuleHandler) List(c *gin.Context) {
	var rules []model.NotificationRule
	db := database.DB
	if scope := c.Query("scope"); scope != "" {
		db = db.Where("scope = ?", scope)
	}
	if err := db.Order("created_at desc").Find(&rules).Error; err != nil {
		response.InternalError(c, "Failed to list notification rules")
		return
	}
	response.OK(c, gin.H{"items": rules, "total": len(rules)})
}

// POST /notifications/rules
func (h *NotificationRuleHandler) Create(c *gin.Context) {
	var rule model.NotificationRule
	if err := c.ShouldBindJSON(&rule); err != nil {
		response.BadRequest(c, "ERROR", err.Error())
		return
	}
	if uid, ok := c.Get("userID"); ok {
		rule.CreatedBy = uid.(string)
	}
	if rule.EventsJSON == "" {
		rule.EventsJSON = "[]"
	}
	if rule.ChannelsJSON == "" {
		rule.ChannelsJSON = "[\"inapp\"]"
	}
	if msg, ok := notificationRuleOverlapMessage(rule, ""); ok {
		response.Conflict(c, "DUPLICATE_NOTIFICATION_RULE", msg)
		return
	}
	if err := database.DB.Create(&rule).Error; err != nil {
		response.InternalError(c, "Failed to create notification rule")
		return
	}
	WriteAuditLogFromCtx(c, "create", "notification_rule", rule.ID, notificationRuleAuditName(rule), nil)
	response.OK(c, rule)
}

// GET /notifications/rules/:id
func (h *NotificationRuleHandler) Get(c *gin.Context) {
	var rule model.NotificationRule
	if err := database.DB.First(&rule, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Rule not found")
		return
	}
	response.OK(c, rule)
}

// PUT /notifications/rules/:id
func (h *NotificationRuleHandler) Update(c *gin.Context) {
	var rule model.NotificationRule
	if err := database.DB.First(&rule, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Rule not found")
		return
	}

	var req model.NotificationRule
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "ERROR", err.Error())
		return
	}
	if req.EventsJSON == "" {
		req.EventsJSON = "[]"
	}
	if req.ChannelsJSON == "" {
		req.ChannelsJSON = "[\"inapp\"]"
	}
	if msg, ok := notificationRuleOverlapMessage(req, rule.ID); ok {
		response.Conflict(c, "DUPLICATE_NOTIFICATION_RULE", msg)
		return
	}

	updates := map[string]any{
		"name":                 req.Name,
		"enabled":              req.Enabled,
		"events_json":          req.EventsJSON,
		"scope":                req.Scope,
		"project_ids_json":     req.ProjectIDsJSON,
		"pipeline_ids_json":    req.PipelineIDsJSON,
		"channels_json":        req.ChannelsJSON,
		"recipients_json":      req.RecipientsJSON,
		"webhook_url":          req.WebhookURL,
		"channel_configs_json": req.ChannelConfigsJSON,
		"title_template":       req.TitleTemplate,
		"body_template":        req.BodyTemplate,
	}
	if err := database.DB.Model(&rule).Updates(updates).Error; err != nil {
		response.InternalError(c, "Failed to update notification rule")
		return
	}

	database.DB.First(&rule, "id = ?", c.Param("id"))
	WriteAuditLogFromCtx(c, "update", "notification_rule", rule.ID, notificationRuleAuditName(rule), nil)
	response.OK(c, rule)
}

// DELETE /notifications/rules/:id
func (h *NotificationRuleHandler) Delete(c *gin.Context) {
	var rule model.NotificationRule
	if err := database.DB.First(&rule, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Rule not found")
		return
	}

	if err := database.DB.Delete(&model.NotificationRule{}, "id = ?", c.Param("id")).Error; err != nil {
		response.InternalError(c, "Failed to delete notification rule")
		return
	}

	WriteAuditLogFromCtx(c, "delete", "notification_rule", c.Param("id"), notificationRuleAuditName(rule), nil)
	response.OK(c, nil)
}

// PUT /notifications/rules/:id/toggle
func (h *NotificationRuleHandler) Toggle(c *gin.Context) {
	var rule model.NotificationRule
	if err := database.DB.First(&rule, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Rule not found")
		return
	}

	rule.Enabled = !rule.Enabled
	if err := database.DB.Save(&rule).Error; err != nil {
		response.InternalError(c, "Failed to update notification rule status")
		return
	}

	action := "disable"
	if rule.Enabled {
		action = "enable"
	}
	WriteAuditLogFromCtx(c, action, "notification_rule", rule.ID, notificationRuleAuditName(rule), nil)
	response.OK(c, gin.H{"enabled": rule.Enabled})
}

// Test sends a real test notification using the rule's configured recipients.
func (h *NotificationRuleHandler) Test(c *gin.Context) {
	userID := middleware.GetUserID(c)
	var rule model.NotificationRule
	if err := database.DB.First(&rule, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Rule not found")
		return
	}

	event := model.NotiPipelineFailed
	if events := notificationRuleJSONList(rule.EventsJSON); len(events) > 0 {
		event = events[0]
	}
	detailURL := "/notifications"
	if config.Global != nil && strings.TrimSpace(config.Global.App.ExternalURL) != "" {
		detailURL = strings.TrimRight(config.Global.App.ExternalURL, "/") + detailURL
	}
	vars := map[string]string{
		"EVENT":         event,
		"TITLE":         "ATOP 通知规则测试",
		"BODY":          fmt.Sprintf("这是一条来自通知规则「%s」的测试消息。", notificationRuleAuditName(rule)),
		"PIPELINE_NAME": "notification-rule-test",
		"PIPELINE_ID":   "test-pipeline",
		"RUN_ID":        "test-run",
		"STATUS_CODE":   "failed",
		"PASS_RATE":     "0",
		"DETAIL_URL":    detailURL,
	}
	title := renderNotificationRuleTemplate(rule.TitleTemplate, vars, vars["TITLE"])
	body := renderNotificationRuleTemplate(rule.BodyTemplate, vars, vars["BODY"])
	vars["TITLE"] = title
	vars["BODY"] = body

	channels := notificationRuleJSONList(rule.ChannelsJSON)
	if len(channels) == 0 {
		channels = []string{"inapp"}
	}

	targets := resolveNotificationRuleTestTargets(rule, userID)
	results := make([]notificationRuleTestResult, 0, len(channels))
	recipientCount := 0
	emailCount := 0
	for _, channel := range channels {
		switch channel {
		case "inapp":
			if len(targets.UserIDs) == 0 {
				results = append(results, notificationRuleTestResult{Channel: channel, OK: false, Message: "当前接收人配置没有可发送站内消息的用户"})
				break
			}
			notifications := make([]model.Notification, 0, len(targets.UserIDs))
			for _, targetUserID := range targets.UserIDs {
				notifications = append(notifications, model.Notification{
					UserID:  targetUserID,
					Event:   event,
					Title:   title,
					Body:    body,
					Link:    "/notifications",
					IsRead:  false,
					RefID:   rule.ID,
					RefType: "notification_rule_test",
				})
			}
			if err := database.DB.Create(&notifications).Error; err != nil {
				results = append(results, notificationRuleTestResult{Channel: channel, OK: false, Message: "站内消息写入失败"})
			} else {
				recipientCount = len(targets.UserIDs)
				results = append(results, notificationRuleTestResult{Channel: channel, OK: true, Message: fmt.Sprintf("已发送给 %d 个用户", len(targets.UserIDs))})
			}
		case "email":
			result := testNotificationRuleEmail(targets, title, body, event, detailURL)
			if result.OK {
				emailCount = len(notificationRuleTargetEmails(targets))
			}
			results = append(results, result)
		case "dingtalk", "feishu", "webhook":
			results = append(results, testNotificationRuleWebhook(rule, channel, event, title, body, vars))
		default:
			results = append(results, notificationRuleTestResult{Channel: channel, OK: false, Message: "不支持的通知渠道"})
		}
	}

	ok := true
	for _, item := range results {
		if !item.OK {
			ok = false
			break
		}
	}
	WriteAuditLogFromCtx(c, "test", "notification_rule", rule.ID, notificationRuleAuditName(rule), gin.H{"ok": ok, "results": results, "recipients": recipientCount, "emails": emailCount})
	response.OK(c, gin.H{"ok": ok, "results": results, "recipientCount": recipientCount, "emailCount": emailCount})
}

func testNotificationRuleEmail(targets notificationRuleTargets, title, body, event, detailURL string) notificationRuleTestResult {
	if config.Global == nil || !config.Global.SMTP.Enabled {
		return notificationRuleTestResult{Channel: "email", OK: false, Message: "SMTP 未启用"}
	}
	emails := notificationRuleTargetEmails(targets)
	if len(emails) == 0 {
		return notificationRuleTestResult{Channel: "email", OK: false, Message: "当前接收人配置没有可用邮箱"}
	}
	htmlBody := fmt.Sprintf(`<html><body style="font-family:'PingFang SC','Microsoft YaHei',Arial,sans-serif">
<h3>%s</h3><p>%s</p><p><a href="%s">查看 ATOP</a></p><p style="color:#8c8c8c;font-size:12px">Event: %s</p>
</body></html>`, title, body, detailURL, event)
	cfg := config.Global.SMTP
	for _, email := range emails {
		if err := util.SendEmail(cfg.Host, cfg.Port, cfg.Username, cfg.Password, cfg.From, email, "[ATOP] "+title, htmlBody, cfg.Security); err != nil {
			return notificationRuleTestResult{Channel: "email", OK: false, Message: fmt.Sprintf("%s：%s", email, err.Error())}
		}
	}
	return notificationRuleTestResult{Channel: "email", OK: true, Message: fmt.Sprintf("已发送给 %d 个邮箱", len(emails))}
}

func testNotificationRuleWebhook(rule model.NotificationRule, channel, event, title, body string, vars map[string]string) notificationRuleTestResult {
	cfg := notificationRuleChannelConfigFor(rule, channel)
	rawURL := strings.TrimSpace(cfg.URL)
	if rawURL == "" {
		return notificationRuleTestResult{Channel: channel, OK: false, Message: "未配置 Webhook URL"}
	}
	method := strings.ToUpper(strings.TrimSpace(cfg.Method))
	if method == "" {
		method = http.MethodPost
	}
	endpoint := appendNotificationRuleQueryParams(rawURL, cfg.QueryParams, vars)

	var bodyReader *bytes.Reader
	if method == http.MethodGet && strings.TrimSpace(cfg.BodyTemplate) == "" {
		bodyReader = bytes.NewReader(nil)
	} else if strings.TrimSpace(cfg.BodyTemplate) != "" {
		bodyReader = bytes.NewReader([]byte(renderNotificationRuleTemplate(cfg.BodyTemplate, vars, cfg.BodyTemplate)))
	} else {
		bodyReader = bytes.NewReader(defaultNotificationRuleWebhookBody(channel, event, title, body, vars))
	}

	req, err := http.NewRequest(method, endpoint, bodyReader)
	if err != nil {
		return notificationRuleTestResult{Channel: channel, OK: false, Message: err.Error()}
	}
	hasContentType := false
	for _, header := range cfg.Headers {
		key := strings.TrimSpace(renderNotificationRuleTemplate(header.Key, vars, header.Key))
		if key == "" {
			continue
		}
		if strings.EqualFold(key, "content-type") {
			hasContentType = true
		}
		req.Header.Set(key, renderNotificationRuleTemplate(header.Value, vars, header.Value))
	}
	if !hasContentType && method != http.MethodGet {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-ATOP-Event", event)

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return notificationRuleTestResult{Channel: channel, OK: false, Message: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return notificationRuleTestResult{Channel: channel, OK: false, StatusCode: resp.StatusCode, Message: fmt.Sprintf("Webhook 返回 HTTP %d", resp.StatusCode)}
	}
	return notificationRuleTestResult{Channel: channel, OK: true, StatusCode: resp.StatusCode, Message: "Webhook 已发送"}
}
