package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/scheduler"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/logger"
	"github.com/company/atop-backend/pkg/response"
)

type TaskRunHandler struct{}

// Abort aborts a single task run.
func (h *TaskRunHandler) Abort(c *gin.Context) {
	id := c.Param("id")
	var tr model.TaskRun
	if err := database.DB.First(&tr, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Task run not found")
		return
	}
	if tr.Status == "success" || tr.Status == "failed" || tr.Status == "aborted" || tr.Status == "error" {
		response.BadRequest(c, "ALREADY_FINISHED", "Task run is already finished")
		return
	}

	now := time.Now()
	database.DB.Model(&tr).Updates(map[string]any{
		"status":      "aborted",
		"finished_at": now,
	})

	WriteAuditLog(
		middleware.GetUserID(c),
		"",
		"abort",
		"task_run",
		tr.ID,
		tr.TestSetName,
		util.RealIP(c.GetHeader("X-Forwarded-For"), c.Request.RemoteAddr),
		nil,
	)
	response.OK(c, gin.H{"ok": true})
}

// GetStages returns Stage View data for a task run.
func (h *TaskRunHandler) GetStages(c *gin.Context) {
	id := c.Param("id")
	var tr model.TaskRun
	if err := database.DB.First(&tr, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Task run not found")
		return
	}

	if tr.StageSummaryJSON != "" {
		var stages any
		json.Unmarshal([]byte(tr.StageSummaryJSON), &stages)
		response.OK(c, stages)
		return
	}

	if tr.JenkinsBuildURL != "" && tr.JenkinsBuildID > 0 {
		stages, err := fetchStagesFromJenkins(&tr)
		if err == nil {
			response.OK(c, stages)
			return
		}
	}

	response.OK(c, []any{})
}

// CheckLog checks whether a task run's Jenkins log is still accessible.
func (h *TaskRunHandler) CheckLog(c *gin.Context) {
	id := c.Param("id")
	var tr model.TaskRun
	if err := database.DB.First(&tr, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Task run not found")
		return
	}

	if tr.LogCheckedAt != nil {
		cooldown := 5 * time.Minute
		remaining := int(cooldown.Seconds()) - int(time.Since(*tr.LogCheckedAt).Seconds())
		if remaining > 0 {
			response.TooManyRequests(c, fmt.Sprintf("Log check is cooling down, retry in %d seconds", remaining), remaining)
			return
		}
	}

	if tr.JenkinsBuildURL == "" {
		now := time.Now()
		database.DB.Model(&tr).Updates(map[string]any{
			"log_status":     "unknown",
			"log_checked_at": now,
		})
		response.OK(c, gin.H{"logStatus": "unknown", "logCheckedAt": now})
		return
	}

	logStatus := checkLogExists(tr.JenkinsBuildURL)
	now := time.Now()
	database.DB.Model(&tr).Updates(map[string]any{
		"log_status":     logStatus,
		"log_checked_at": now,
	})

	response.OK(c, gin.H{
		"logStatus":       logStatus,
		"logCheckedAt":    now,
		"jenkinsBuildUrl": tr.JenkinsBuildURL,
	})
}

// BatchCheckLog starts an async batch log check job.
func (h *TaskRunHandler) BatchCheckLog(c *gin.Context) {
	var body struct {
		TaskRunIDs []string `json:"taskRunIds"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.TaskRunIDs) == 0 {
		response.BadRequest(c, "INVALID_PARAMS", "taskRunIds is required")
		return
	}

	jobID := fmt.Sprintf("batch-check-%s", util.SHA256Hex(util.ToJSON(body.TaskRunIDs))[:8])

	go func() {
		for _, tid := range body.TaskRunIDs {
			var tr model.TaskRun
			if err := database.DB.First(&tr, "id = ?", tid).Error; err != nil {
				continue
			}
			if tr.LogCheckedAt != nil && time.Since(*tr.LogCheckedAt) < 5*time.Minute {
				continue
			}

			logStatus := "unknown"
			if tr.JenkinsBuildURL != "" {
				logStatus = checkLogExists(tr.JenkinsBuildURL)
			}
			now := time.Now()
			database.DB.Model(&tr).Updates(map[string]any{
				"log_status":     logStatus,
				"log_checked_at": now,
			})
			time.Sleep(200 * time.Millisecond)
		}
	}()

	response.OK(c, gin.H{"jobId": jobID, "total": len(body.TaskRunIDs)})
}

// verifyWebhookHMAC checks the X-Atop-Signature header.
func verifyWebhookHMAC(c *gin.Context, body []byte) bool {
	secret := os.Getenv("WEBHOOK_HMAC_SECRET")
	if secret == "" {
		if os.Getenv("APP_ENV") == "production" {
			logger.Warn("WEBHOOK_HMAC_SECRET not set - webhook endpoint is unauthenticated")
		}
		return true
	}

	sig := c.GetHeader("X-Atop-Signature")
	if sig == "" {
		sig = c.GetHeader("X-Hub-Signature-256")
	}
	if sig == "" {
		return false
	}
	if strings.HasPrefix(sig, "sha256=") {
		sig = strings.TrimPrefix(sig, "sha256=")
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(sig), []byte(expected))
}

func validWebhookStatus(status string) bool {
	switch status {
	case "running", "success", "failed", "error", "aborted":
		return true
	default:
		return false
	}
}

func pipelineRunTerminalStatus(status string) bool {
	switch status {
	case "success", "failed", "error", "aborted", "blocked":
		return true
	default:
		return false
	}
}

func normalizeWebhookOutputs(outputs map[string]any) (string, error) {
	if len(outputs) == 0 {
		return "", nil
	}
	if len(outputs) > 100 {
		return "", fmt.Errorf("outputs can contain at most 100 fields")
	}

	clean := make(map[string]any, len(outputs))
	for key, value := range outputs {
		key = strings.TrimSpace(key)
		if key == "" {
			return "", fmt.Errorf("outputs contains an empty field name")
		}
		if utf8.RuneCountInString(key) > 100 {
			return "", fmt.Errorf("outputs field %q exceeds 100 characters", key)
		}

		valueText := schedulerValuePreview(value)
		if utf8.RuneCountInString(valueText) > 5000 {
			return "", fmt.Errorf("outputs.%s exceeds 5000 characters", key)
		}
		clean[key] = value
	}

	b, err := json.Marshal(clean)
	if err != nil {
		return "", err
	}
	if len(b) > 50000 {
		return "", fmt.Errorf("outputs payload exceeds 50KB")
	}
	return string(b), nil
}

func schedulerValuePreview(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprint(v)
		}
		return string(b)
	}
}

// Webhook receives Jenkins callback results.
func (h *TaskRunHandler) Webhook(c *gin.Context) {
	taskID := c.Param("taskId")
	var tr model.TaskRun
	if err := database.DB.First(&tr, "id = ?", taskID).Error; err != nil {
		response.NotFound(c, "Task run not found")
		return
	}

	rawBody, _ := io.ReadAll(c.Request.Body)
	if !verifyWebhookHMAC(c, rawBody) {
		response.Unauthorized(c, "Webhook signature verification failed")
		return
	}
	c.Request.Body = io.NopCloser(strings.NewReader(string(rawBody)))

	terminal := map[string]bool{"success": true, "failed": true, "error": true, "aborted": true}
	if terminal[tr.Status] {
		response.OK(c, gin.H{"ok": true, "skipped": true})
		return
	}

	var body struct {
		TaskID          string         `json:"task_id"`
		Status          string         `json:"status"`
		Phase           string         `json:"phase"`
		NodeName        string         `json:"node_name"`
		DurationMs      int64          `json:"duration_ms"`
		PassRate        float64        `json:"pass_rate"`
		ErrorSummary    string         `json:"error_summary"`
		AbortReason     string         `json:"abort_reason"`
		JenkinsBuildID  int64          `json:"jenkins_build_id"`
		JenkinsBuildURL string         `json:"jenkins_build_url"`
		Outputs         map[string]any `json:"outputs"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}
	if body.Status != "" && !validWebhookStatus(body.Status) {
		response.BadRequest(c, "INVALID_STATUS", "status must be one of running/success/failed/error/aborted")
		return
	}

	outputsJSON, err := normalizeWebhookOutputs(body.Outputs)
	if err != nil {
		response.BadRequest(c, "INVALID_OUTPUTS", err.Error())
		return
	}

	if body.JenkinsBuildID > 0 {
		var run model.PipelineRun
		if err := database.DB.Select("id, pipeline_id").First(&run, "id = ?", tr.PipelineRunID).Error; err == nil {
			inst, jobName, resolveErr := scheduler.ResolveJenkinsJobForTaskRun(&tr, run.PipelineID)
			if resolveErr == nil && scheduler.JenkinsBuildIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, inst, jobName, body.JenkinsBuildID) {
				summary := fmt.Sprintf("Jenkins build #%d is already used by another task of the same Jenkins job", body.JenkinsBuildID)
				database.DB.Model(&tr).Updates(map[string]any{
					"status":        "submit_failed",
					"error_summary": summary,
				})
				response.BadRequest(c, "DUPLICATE_JENKINS_BUILD", summary)
				return
			}
		}
	}

	if body.Phase != "" && body.Status == "running" {
		updates := map[string]any{"phase": body.Phase}
		if body.NodeName != "" {
			updates["node_name"] = body.NodeName
		}
		if body.Status != "" {
			updates["status"] = body.Status
		}
		database.DB.Model(&tr).Updates(updates)
		response.OK(c, gin.H{"ok": true, "phase": body.Phase})
		return
	}
	if body.Status == "" {
		response.BadRequest(c, "INVALID_STATUS", "status cannot be empty")
		return
	}

	now := time.Now()
	updates := map[string]any{
		"status":            body.Status,
		"phase":             "completed",
		"duration_ms":       body.DurationMs,
		"pass_rate":         body.PassRate,
		"error_summary":     util.TruncateString(body.ErrorSummary, 2000),
		"jenkins_build_id":  body.JenkinsBuildID,
		"jenkins_build_url": body.JenkinsBuildURL,
		"log_status":        "available",
		"finished_at":       now,
	}
	if body.NodeName != "" {
		updates["node_name"] = body.NodeName
	}
	if body.AbortReason != "" {
		updates["abort_reason"] = body.AbortReason
	} else if body.Status == "aborted" && body.ErrorSummary != "" {
		errLower := strings.ToLower(body.ErrorSummary)
		if strings.Contains(errLower, "timeout") || strings.Contains(errLower, "timed out") {
			updates["abort_reason"] = "timeout"
		} else if strings.Contains(errLower, "aborted by") {
			updates["abort_reason"] = "user:" + body.ErrorSummary
		} else {
			updates["abort_reason"] = "jenkins:" + body.ErrorSummary
		}
	}
	if outputsJSON != "" {
		updates["outputs_json"] = outputsJSON
	}
	database.DB.Model(&tr).Updates(updates)
	if outputsJSON != "" {
		scheduler.RefreshRunContext(tr.PipelineRunID)
	}

	go func() {
		tr.JenkinsBuildURL = body.JenkinsBuildURL
		tr.JenkinsBuildID = body.JenkinsBuildID
		if stages, err := fetchStagesFromJenkins(&tr); err == nil {
			stagesJSON, _ := json.Marshal(stages)
			database.DB.Model(&model.TaskRun{}).Where("id = ?", taskID).
				Update("stage_summary_json", string(stagesJSON))
		}
	}()

	go updatePipelineRunCounters(tr.PipelineRunID)

	if body.Status == "failed" || body.Status == "error" {
		go scheduler.SendTaskNotification(tr.PipelineRunID, tr.ID, tr.TestSetName, body.Status)
	}

	if tr.DAGNodeID != "" {
		go AdvanceDAGRun(tr.PipelineRunID)
	}

	response.OK(c, gin.H{"ok": true})
}

func checkLogExists(buildURL string) string {
	client := &http.Client{Timeout: 8 * time.Second}
	req, err := http.NewRequest("HEAD", buildURL, nil)
	if err != nil {
		return "unknown"
	}
	resp, err := client.Do(req)
	if err != nil {
		return "unknown"
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return "available"
	}
	if resp.StatusCode == http.StatusNotFound {
		return "expired"
	}
	return "unknown"
}

func fetchStagesFromJenkins(tr *model.TaskRun) (any, error) {
	buildURL := tr.JenkinsBuildURL
	if strings.HasSuffix(buildURL, "/console") {
		buildURL = strings.TrimSuffix(buildURL, "/console")
	}
	wfapiURL := buildURL + "/wfapi/describe"

	var inst model.JenkinsInstance
	if err := database.DB.Where("is_default = ?", true).First(&inst).Error; err != nil {
		return nil, err
	}
	apiToken, _ := util.Decrypt(inst.APITokenEncrypted)

	client := &http.Client{Timeout: config.Global.Jenkins.RequestTimeout}
	req, _ := http.NewRequest("GET", wfapiURL, nil)
	req.SetBasicAuth(inst.Username, apiToken)

	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("wfapi unavailable")
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result any
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func updatePipelineRunCounters(runID string) {
	var currentRun model.PipelineRun
	if err := database.DB.Select("status, abort_reason").First(&currentRun, "id = ?", runID).Error; err != nil {
		return
	}
	userAborted := currentRun.Status == "aborted" && currentRun.AbortReason != ""

	type counts struct {
		Total         int64
		Success       int64
		Failed        int64
		Running       int64
		Blocked       int64
		Queued        int64
		JenkinsQueued int64
		Waiting       int64
		Aborted       int64
	}
	var c counts
	database.DB.Model(&model.TaskRun{}).Where("pipeline_run_id = ? AND dag_detached = ?", runID, false).
		Select("COUNT(*) as total," +
			"SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success," +
			"SUM(CASE WHEN status IN ('failed','error','submit_failed') THEN 1 ELSE 0 END) as failed," +
			"SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running," +
			"SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) as blocked," +
			"SUM(CASE WHEN status IN ('pending','submitting','queued_in_jenkins','waiting') THEN 1 ELSE 0 END) as queued," +
			"SUM(CASE WHEN status IN ('submitting','queued_in_jenkins') THEN 1 ELSE 0 END) as jenkins_queued," +
			"SUM(CASE WHEN status IN ('pending','waiting') THEN 1 ELSE 0 END) as waiting," +
			"SUM(CASE WHEN status='aborted' THEN 1 ELSE 0 END) as aborted").
		Scan(&c)

	passRate := 0.0
	done := c.Success + c.Failed
	if done > 0 {
		passRate = float64(c.Success) / float64(done) * 100
	}

	status := currentRun.Status
	if !userAborted {
		if c.Total == 0 {
			if status == "" {
				status = "running"
			}
		} else if c.Running > 0 {
			status = "running"
		} else if c.JenkinsQueued > 0 {
			status = "queued_in_jenkins"
		} else if c.Waiting > 0 {
			status = "waiting"
		} else if c.Aborted > 0 && c.Success == 0 && c.Failed == 0 {
			status = "aborted"
		} else if c.Failed > 0 || c.Blocked > 0 {
			status = "failed"
		} else if c.Aborted > 0 {
			status = "aborted"
		} else {
			status = "success"
		}
	}

	updates := map[string]any{
		"total_count":   c.Total,
		"success_count": c.Success,
		"failed_count":  c.Failed,
		"running_count": c.Running,
		"blocked_count": c.Blocked,
		"queued_count":  c.Queued,
		"pass_rate":     passRate,
		"status":        status,
	}
	if pipelineRunTerminalStatus(status) {
		updates["finished_at"] = time.Now()
	}
	database.DB.Model(&model.PipelineRun{}).Where("id = ?", runID).Updates(updates)

	if status == "success" || status == "failed" || status == "aborted" {
		var finalRun model.PipelineRun
		if err := database.DB.First(&finalRun, "id = ?", runID).Error; err == nil {
			if finalRun.ParentTaskID != "" {
				now := time.Now()
				parentOutputs, _ := json.Marshal(map[string]any{
					"childRunId": finalRun.ID,
					"status":     status,
				})
				database.DB.Model(&model.TaskRun{}).Where("id = ?", finalRun.ParentTaskID).Updates(map[string]any{
					"status":       status,
					"finished_at":  now,
					"duration_ms":  scheduler.CalcDurationMs(finalRun.StartedAt, now),
					"outputs_json": string(parentOutputs),
				})
				scheduler.RefreshRunContext(finalRun.ParentRunID)
				go AdvanceDAGRun(finalRun.ParentRunID)
			}
			go scheduler.SendPipelineNotifications(runID, finalRun.PipelineID, status)
		}
	}
}
