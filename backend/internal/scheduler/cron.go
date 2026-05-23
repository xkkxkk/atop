package scheduler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
	"go.uber.org/zap"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/logger"
)

var cronRunner *cron.Cron
var pipelineCronEntryIDs []cron.EntryID

type PipelineRunCreator func(p *model.Pipeline, triggerType, triggeredBy string, runtimeParams map[string]string, remark, _ string) (*model.PipelineRun, string, error)

var pipelineRunCreator PipelineRunCreator

type notificationKV struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type notificationChannelConfig struct {
	URL          string           `json:"url"`
	Method       string           `json:"method"`
	Headers      []notificationKV `json:"headers"`
	QueryParams  []notificationKV `json:"queryParams"`
	BodyTemplate string           `json:"bodyTemplate"`
}

type notificationTargets struct {
	UserIDs []string
	Emails  []string
}

func SetPipelineRunCreator(fn PipelineRunCreator) {
	pipelineRunCreator = fn
}

// StartCron starts all background cron jobs.
func StartCron() {
	cronRunner = cron.New(cron.WithParser(cron.NewParser(
		cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor,
	)))

	reloadPipelineCrons()

// Every 30s, sync Jenkins build status for running pipeline runs.
	cronRunner.AddFunc("*/30 * * * * *", syncJenkinsStatus)

// Daily at 03:00, check log status for finished tasks.
	cronRunner.AddFunc("0 0 3 * * *", dailyLogCheck)

// Daily at 03:30, purge old records.
	cronRunner.AddFunc("0 30 3 * * *", runScheduledCleanup)

// Every 5 minutes, re-sync cron schedules.
	cronRunner.AddFunc("0 */5 * * * *", reloadPipelineCrons)

	cronRunner.Start()
	logger.Info("cron scheduler started")
}

func StopCron() {
	if cronRunner != nil {
		cronRunner.Stop()
	}
}

func reloadPipelineCrons() {
	if cronRunner == nil {
		return
	}
	for _, entryID := range pipelineCronEntryIDs {
		cronRunner.Remove(entryID)
	}
	pipelineCronEntryIDs = nil

	var pipelines []model.Pipeline
	database.DB.Where("trigger_type = 'cron' AND cron_expr != ''").Find(&pipelines)
	for _, p := range pipelines {
		pl := p
		entryID, err := cronRunner.AddFunc(pl.CronExpr, func() {
			triggerCronPipeline(&pl)
		})
		if err != nil {
			logger.Warn("invalid cron expr",
				zap.String("pipeline", pl.Name),
				zap.String("expr", pl.CronExpr),
				zap.Error(err),
			)
			continue
		}
		pipelineCronEntryIDs = append(pipelineCronEntryIDs, entryID)
	}
	logger.Debug("cron schedules reloaded", zap.Int("count", len(pipelines)))
}

func triggerCronPipeline(p *model.Pipeline) {
	logger.Info("cron trigger", zap.String("pipeline", p.Name))
	unlockTrigger := LockPipelineTrigger(p.ID)
	defer unlockTrigger()
	if run, ok := FindPipelineRunAwaitingJenkinsBuild(database.DB, p.ID); ok {
		logger.Warn("cron trigger skipped: pipeline is awaiting Jenkins build id",
			zap.String("pipeline_id", p.ID),
			zap.String("run_id", run.ID),
		)
		return
	}

	if err := validateCronPipeline(p); err != nil {
		logger.Warn("cron trigger skipped: invalid pipeline",
			zap.String("pipeline_id", p.ID),
			zap.Error(err),
		)
		return
	}

	if pipelineRunCreator != nil {
		run, mode, err := pipelineRunCreator(p, "cron", "system", nil, "", "")
		if err != nil {
			logger.Error("cron trigger: create run failed",
				zap.String("pipeline_id", p.ID),
				zap.String("mode", mode),
				zap.Error(err),
			)
			return
		}
		if Global != nil {
			Global.DispatchRun(run.ID)
		}
		return
	}

	var testSets []model.TestSet
	database.DB.Where("project = ? AND status = 'enabled'", p.Project).
		Order("priority DESC, created_at ASC").Find(&testSets)

	now := time.Now()
	run := model.PipelineRun{
		PipelineID:   p.ID,
		PipelineName: p.Name,
		Status:       "pending",
		TriggerType:  "cron",
		TriggeredBy:  "system",
		PipelineSnapshotJSON: BuildPipelineConfigSnapshot(p),
		StartedAt:    &now,
		TotalCount:   len(testSets),
		QueuedCount:  len(testSets),
	}
	if err := database.DB.Create(&run).Error; err != nil {
		logger.Error("cron trigger: create run failed", zap.String("pipeline_id", p.ID), zap.Error(err))
		return
	}

	for _, ts := range testSets {
		tr := model.TaskRun{
			PipelineRunID: run.ID,
			TestSetID:     ts.ID,
			TestSetName:   ts.Name,
			Project:       ts.Project,
			AgentLabel:    ts.AgentLabel,
			Status:        "pending",
			LogStatus:     "unknown",
		}
		database.DB.Create(&tr)
	}

	if Global != nil {
		Global.DispatchRun(run.ID)
	}
}

func validateCronPipeline(p *model.Pipeline) error {
	if strings.TrimSpace(p.JenkinsBindings) == "" || strings.TrimSpace(p.JenkinsBindings) == "null" {
		return fmt.Errorf("jenkins instance is empty")
	}
	if strings.TrimSpace(p.DAGConfigJSON) != "" {
		var dagCfg model.DAGConfig
		if err := json.Unmarshal([]byte(p.DAGConfigJSON), &dagCfg); err == nil && len(dagCfg.Nodes) > 0 {
			for _, node := range dagCfg.Nodes {
				if node.Type != model.DAGNodeJenkins {
					continue
				}
				jobName := strings.TrimSpace(fmt.Sprint(node.Config["jobName"]))
				if jobName == "" {
					return fmt.Errorf("jenkins node %s job is empty", node.Label)
				}
			}
			return nil
		}
	}
	return nil
}

// syncJenkinsStatus checks running pipeline runs against Jenkins to detect
// builds that finished (success/failure/aborted) without webhook callback.
func syncJenkinsStatus() {
	syncPipelineRunJenkinsStatus()
	syncTaskRunJenkinsStatus()
}

func syncPipelineRunJenkinsStatus() {
	var runs []model.PipelineRun
	database.DB.Where("status IN ? AND (jenkins_build_id > 0 OR jenkins_queue_id > 0)", []string{"pending", "submitting", "queued_in_jenkins", "waiting", "running"}).Find(&runs)
	if len(runs) == 0 {
		return
	}

	for _, run := range runs {
		inst, jobName, err := ResolveJenkinsJobForPipelineRun(&run)
		if err != nil {
			continue
		}
		jc, err := NewJenkinsClient(inst)
		if err != nil {
			continue
		}

		if run.JenkinsBuildID > 0 {
			info, err := jc.GetBuildInfo(jobName, run.JenkinsBuildID)
			if err != nil {
				continue
			}

			building, _ := info["building"].(bool)
			if building {
				if run.Status != "running" {
					updates := map[string]any{"status": "running"}
					if run.StartedAt == nil {
						updates["started_at"] = time.Now()
					}
					database.DB.Model(&run).Updates(updates)
				}
				continue
			}

			result, _ := info["result"].(string)
			newStatus := statusFromJenkinsResult(result)
			logger.Info("jenkins sync: build finished",
				zap.String("run_id", run.ID),
				zap.String("jenkins_result", result),
				zap.String("new_status", newStatus),
			)

			now := time.Now()
			durationMs := CalcDurationMs(run.StartedAt, now)
			updates := map[string]any{
				"status":      newStatus,
				"finished_at": now,
				"duration_ms": durationMs,
			}
			if buildURL, _ := info["url"].(string); strings.TrimSpace(buildURL) != "" {
				updates["jenkins_build_url"] = buildURL
			}
			database.DB.Model(&run).Updates(updates)
			database.DB.Model(&model.TaskRun{}).
				Where("pipeline_run_id = ? AND status IN ('running','waiting','pending','submitting','queued_in_jenkins')", run.ID).
				Updates(map[string]any{
					"status":      newStatus,
					"finished_at": now,
					"duration_ms": durationMs,
				})
			UpdatePipelineCounters(run.ID)
			continue
		}

		build, err := findPipelineRunBuild(jc, jobName, run.JenkinsQueueID, run.ID)
		if err == nil && build != nil && build.Number > 0 {
			if JenkinsQueueIDUsedByAnotherRun(run.PipelineID, run.ID, run.JenkinsQueueID) {
				finishPipelineRunAfterQueueFailure(run.ID, fmt.Sprintf("Jenkins Queue %d is already used by another run or task of the same Jenkins Job", run.JenkinsQueueID))
				continue
			}
			if JenkinsBuildIDUsedByAnotherRun(run.PipelineID, run.ID, build.Number) {
				logger.Warn("ignore stale Jenkins build lookup",
					zap.String("run_id", run.ID),
					zap.Int64("queue_id", run.JenkinsQueueID),
					zap.Int64("build_id", build.Number),
				)
			} else {
				now := time.Now()
				updates := map[string]any{
					"jenkins_build_id":  build.Number,
					"jenkins_build_url": build.URL,
					"error_summary":     "",
				}
				if build.Building {
					updates["status"] = "running"
					if run.StartedAt == nil {
						updates["started_at"] = now
					}
				} else if build.Result != "" {
					newStatus := statusFromJenkinsResult(build.Result)
					updates["status"] = newStatus
					updates["finished_at"] = now
					updates["duration_ms"] = CalcDurationMs(run.StartedAt, now)
				}
				database.DB.Model(&run).Updates(updates)
				if build.Result != "" {
					database.DB.Model(&model.TaskRun{}).
						Where("pipeline_run_id = ? AND status IN ('running','waiting','pending','submitting','queued_in_jenkins')", run.ID).
						Updates(map[string]any{
							"status":        statusFromJenkinsResult(build.Result),
							"finished_at":   now,
							"duration_ms":   CalcDurationMs(run.StartedAt, now),
							"error_summary": "",
						})
					UpdatePipelineCounters(run.ID)
				}
				continue
			}
		}

		status, err := jc.CheckQueueItem(run.JenkinsQueueID)
		if err != nil {
			continue
		}
		if status.Cancelled {
			reason := strings.TrimSpace(status.Why)
			if reason == "" {
				reason = "Jenkins queue cancelled"
			}
			finishPipelineRunAfterQueueFailure(run.ID, reason)
			continue
		}
		if status.Stuck && strings.TrimSpace(status.Why) != "" {
			database.DB.Model(&run).Updates(map[string]any{
				"status":        "running",
				"error_summary": strings.TrimSpace(status.Why),
			})
			continue
		}
		if status.Executable != nil {
			if JenkinsQueueIDUsedByAnotherRun(run.PipelineID, run.ID, run.JenkinsQueueID) {
				finishPipelineRunAfterQueueFailure(run.ID, fmt.Sprintf("Jenkins Queue %d is already used by another run or task of the same Jenkins Job", run.JenkinsQueueID))
				continue
			}
			if JenkinsBuildIDUsedByAnotherRun(run.PipelineID, run.ID, status.Executable.Number) {
				finishPipelineRunAfterQueueFailure(run.ID, fmt.Sprintf("Jenkins Queue %d returned Build #%d already used by another run or task of the same Jenkins Job", run.JenkinsQueueID, status.Executable.Number))
				continue
			}
			buildURL := strings.TrimSpace(status.Executable.URL)
			if buildURL == "" {
				buildURL = fmt.Sprintf("%s%s/%d/console", jc.baseURL(), jobPath(jobName), status.Executable.Number)
			}
			updates := map[string]any{
				"status":            "running",
				"jenkins_build_id":  status.Executable.Number,
				"jenkins_build_url": buildURL,
				"error_summary":     "",
			}
			if run.StartedAt == nil {
				updates["started_at"] = time.Now()
			}
			database.DB.Model(&run).Updates(updates)
		}
	}
}

func syncTaskRunJenkinsStatus() {
	var tasks []model.TaskRun
	database.DB.Where(
		"status IN ? AND sub_pipeline_id = '' AND (jenkins_build_id > 0 OR jenkins_queue_id > 0)",
		[]string{"submitting", "queued_in_jenkins", "running"},
	).Find(&tasks)
	if len(tasks) == 0 {
		return
	}

	for i := range tasks {
		task := &tasks[i]

		var run model.PipelineRun
		if err := database.DB.Select("id, pipeline_id, pipeline_snapshot_json").First(&run, "id = ?", task.PipelineRunID).Error; err != nil {
			continue
		}

		var (
			inst    *model.JenkinsInstance
			jc      *JenkinsClient
			jobName string
			err     error
		)
		if task.TestSetID == "" {
			inst, jobName, err = ResolveJenkinsJobForTaskInRun(task, &run)
			if err == nil {
				jc, err = NewJenkinsClient(inst)
			}
		} else {
			var ts model.TestSet
			if err = database.DB.Select("id, project, os").First(&ts, "id = ?", task.TestSetID).Error; err == nil {
				runCfg, cfgErr := PipelineConfigForRun(&run)
				if cfgErr != nil {
					err = cfgErr
				} else {
					inst, jobName, err = resolveJenkinsJobFromBindings(runCfg.JenkinsBindings, ts.Project, ts.OS)
				}
				if err == nil {
					jc, err = NewJenkinsClient(inst)
				}
			}
		}
		if err != nil || jc == nil || strings.TrimSpace(jobName) == "" {
			continue
		}

		if task.JenkinsBuildID > 0 {
			if JenkinsBuildIDUsedByAnotherTask(task.PipelineRunID, task.ID, inst, jobName, task.JenkinsBuildID) {
				finishTaskAfterQueueFailure(task, "submit_failed", fmt.Sprintf("Jenkins Build #%d is already used by another task of the same Jenkins Job", task.JenkinsBuildID))
				continue
			}
			info, err := jc.GetBuildInfo(jobName, task.JenkinsBuildID)
			if err != nil {
				continue
			}
			building, _ := info["building"].(bool)
			if building {
				updates := map[string]any{}
				if task.Status != "running" {
					updates["status"] = "running"
				}
				if task.StartedAt == nil {
					updates["started_at"] = time.Now()
				}
				if buildURL, _ := info["url"].(string); strings.TrimSpace(buildURL) != "" {
					updates["jenkins_build_url"] = buildURL
				}
				if len(updates) > 0 {
					database.DB.Model(&model.TaskRun{}).Where("id = ?", task.ID).Updates(updates)
					UpdatePipelineCounters(task.PipelineRunID)
				}
				continue
			}

			now := time.Now()
			result, _ := info["result"].(string)
			res := database.DB.Model(&model.TaskRun{}).
				Where("id = ? AND status IN ?", task.ID, []string{"running", "queued_in_jenkins", "submitting"}).
				Updates(map[string]any{
					"status":      statusFromJenkinsResult(result),
					"phase":       "completed",
					"finished_at": now,
					"duration_ms": CalcDurationMs(task.StartedAt, now),
					"error_summary": "",
				})
			if res.RowsAffected > 0 {
				UpdatePipelineCounters(task.PipelineRunID)
				notifyDAGAdvance(task.PipelineRunID)
			}
			continue
		}

		build, err := findTaskBuild(jc, jobName, task.JenkinsQueueID, task.ID)
		if err == nil && build != nil && build.Number > 0 {
			if JenkinsQueueIDUsedByAnotherTask(task.PipelineRunID, task.ID, inst, jobName, task.JenkinsQueueID) {
				finishTaskAfterQueueFailure(task, "submit_failed", fmt.Sprintf("Jenkins Queue %d is already used by another task of the same Jenkins Job", task.JenkinsQueueID))
				continue
			}
			if JenkinsBuildIDUsedByAnotherTask(task.PipelineRunID, task.ID, inst, jobName, build.Number) {
				logger.Warn("ignore stale Jenkins build lookup",
					zap.String("task_id", task.ID),
					zap.Int64("queue_id", task.JenkinsQueueID),
					zap.Int64("build_id", build.Number),
				)
			} else {
				now := time.Now()
				updates := map[string]any{
					"jenkins_build_id":  build.Number,
					"jenkins_build_url": build.URL,
					"error_summary":     "",
				}
				if build.Building {
					updates["status"] = "running"
					if task.StartedAt == nil {
						updates["started_at"] = now
					}
				} else if build.Result != "" {
					updates["status"] = statusFromJenkinsResult(build.Result)
					updates["phase"] = "completed"
					updates["finished_at"] = now
					updates["duration_ms"] = CalcDurationMs(task.StartedAt, now)
				}
				database.DB.Model(&model.TaskRun{}).Where("id = ?", task.ID).Updates(updates)
				UpdatePipelineCounters(task.PipelineRunID)
				if build.Result != "" {
					notifyDAGAdvance(task.PipelineRunID)
				}
				continue
			}
		}

		status, err := jc.CheckQueueItem(task.JenkinsQueueID)
		if err != nil {
			continue
		}
		if status.Cancelled {
			reason := strings.TrimSpace(status.Why)
			if reason == "" {
				reason = "Jenkins queue cancelled"
			}
			finishTaskAfterQueueFailure(task, "aborted", reason)
			continue
		}
		queueReason := strings.TrimSpace(status.Why)
		if queueReason != "" {
			phase := truncateTaskPhase(queueReason)
			database.DB.Model(&model.TaskRun{}).
				Where("id = ? AND (phase = '' OR phase <> ?)", task.ID, phase).
				Updates(map[string]any{
					"status": "queued_in_jenkins",
					"phase":  phase,
				})
		}
		if build, lookupErr := findTaskBuild(jc, jobName, task.JenkinsQueueID, task.ID); lookupErr == nil && build != nil && build.Number > 0 {
			if JenkinsBuildIDUsedByAnotherTask(task.PipelineRunID, task.ID, inst, jobName, build.Number) {
				logger.Warn("ignore stale Jenkins build lookup",
					zap.String("task_id", task.ID),
					zap.Int64("queue_id", task.JenkinsQueueID),
					zap.Int64("build_id", build.Number),
				)
			} else {
				applyTaskBuildRef(task, build)
				continue
			}
		}
		if status.Executable != nil {
			if JenkinsQueueIDUsedByAnotherTask(task.PipelineRunID, task.ID, inst, jobName, task.JenkinsQueueID) {
				finishTaskAfterQueueFailure(task, "submit_failed", fmt.Sprintf("Jenkins Queue %d is already used by another task of the same Jenkins Job", task.JenkinsQueueID))
				continue
			}
			if JenkinsBuildIDUsedByAnotherTask(task.PipelineRunID, task.ID, inst, jobName, status.Executable.Number) {
				finishTaskAfterQueueFailure(task, "submit_failed", fmt.Sprintf("Jenkins Queue %d returned Build #%d already used by another task of the same Jenkins Job", task.JenkinsQueueID, status.Executable.Number))
				continue
			}
			buildURL := strings.TrimSpace(status.Executable.URL)
			if buildURL == "" {
				buildURL = fmt.Sprintf("%s%s/%d/console", jc.baseURL(), jobPath(jobName), status.Executable.Number)
			}
			updates := map[string]any{
				"status":            "running",
				"jenkins_build_id":  status.Executable.Number,
				"jenkins_build_url": buildURL,
				"error_summary":     "",
			}
			if task.StartedAt == nil {
				updates["started_at"] = time.Now()
			}
			database.DB.Model(&model.TaskRun{}).Where("id = ?", task.ID).Updates(updates)
			UpdatePipelineCounters(task.PipelineRunID)
		}
	}
}

func dailyLogCheck() {
	logger.Info("daily log check started")
	cutoff := time.Now().AddDate(0, 0, -30)
	var tasks []model.TaskRun
	database.DB.Where(
		"log_status = 'unknown' AND status IN ('success','failed','error') AND finished_at > ?",
		cutoff,
	).Limit(500).Find(&tasks)

	checked := 0
	httpClient := &http.Client{Timeout: 8 * time.Second}
	for _, tr := range tasks {
		if tr.JenkinsBuildURL == "" {
			continue
		}
		status := headCheck(httpClient, tr.JenkinsBuildURL)
		now := time.Now()
		database.DB.Model(&tr).Updates(map[string]any{
			"log_status": status, "log_checked_at": now,
		})
		checked++
		time.Sleep(100 * time.Millisecond)
	}
	logger.Info("daily log check done", zap.Int("checked", checked))
}

func dailyCleanup() {
	logger.Info("daily cleanup started")
	cutoffRuns   := time.Now().AddDate(0, 0, -180)
	cutoffAudits := time.Now().AddDate(0, 0, -365)

	r1 := database.DB.Where("created_at < ?", cutoffRuns).Delete(&model.TaskRun{})
	r2 := database.DB.Where("created_at < ?", cutoffRuns).Delete(&model.PipelineRun{})
	r3 := database.DB.Where("created_at < ?", cutoffAudits).Delete(&model.AuditLog{})
	database.DB.Where("expires_at < ?", time.Now()).Delete(&model.RefreshToken{})

	logger.Info("cleanup done",
		zap.Int64("task_runs", r1.RowsAffected),
		zap.Int64("pipeline_runs", r2.RowsAffected),
		zap.Int64("audit_logs", r3.RowsAffected),
	)
}

func headCheck(client *http.Client, rawURL string) string {
	req, err := http.NewRequest("HEAD", rawURL, nil)
	if err != nil {
		return "unknown"
	}
	resp, err := client.Do(req)
	if err != nil {
		return "unknown"
	}
	resp.Body.Close()
	switch resp.StatusCode {
	case 200:
		return "available"
	case 404:
		return "expired"
	default:
		return "unknown"
	}
}

// runScheduledCleanup reads cleanup config from DB and executes if auto-cleanup is enabled.
// Defined here to avoid import cycle with handler package.
func runScheduledCleanup() {
	var cfg model.CleanupConfig
	if err := database.DB.First(&cfg).Error; err != nil {
		// No config found, skip
		return
	}
	if !cfg.AutoEnabled {
		return
	}

	now := time.Now()

	// Cleanup by time
	if cfg.RunRetentionDays > 0 {
		cutoff := now.AddDate(0, 0, -cfg.RunRetentionDays)
		database.DB.Where("created_at < ?", cutoff).Delete(&model.TaskRun{})
	}
	if cfg.RunRetentionDays > 0 {
		cutoff := now.AddDate(0, 0, -cfg.RunRetentionDays)
		database.DB.Where("created_at < ?", cutoff).Delete(&model.PipelineRun{})
	}
	if cfg.AuditRetentionDays > 0 {
		cutoff := now.AddDate(0, 0, -cfg.AuditRetentionDays)
		database.DB.Where("created_at < ?", cutoff).Delete(&model.AuditLog{})
	}
	if cfg.NotiRetentionDays > 0 {
		cutoff := now.AddDate(0, 0, -cfg.NotiRetentionDays)
		database.DB.Where("created_at < ?", cutoff).Delete(&model.Notification{})
	}

	// Always clean expired tokens
	database.DB.Where("expires_at < ?", now).Delete(&model.RefreshToken{})

	logger.Info("scheduled cleanup done")
}

// SendPipelineNotifications checks notification rules and sends matching notifications.
func SendPipelineNotifications(runID, pipelineID, status string) {
	// Map status to event type
	eventMap := map[string]string{
		"success": model.NotiPipelineComplete,
		"failed":  model.NotiPipelineFailed,
		"aborted": model.NotiPipelineAborted,
		"error":   model.NotiPipelineFailed,
	}
	event := eventMap[status]
	if event == "" {
		return
	}

	// Load pipeline run for context
	var run model.PipelineRun
	if err := database.DB.First(&run, "id = ?", runID).Error; err != nil {
		return
	}
	var pipeline model.Pipeline
	database.DB.Select("id, project").First(&pipeline, "id = ?", pipelineID)

	statusLabel := map[string]string{
        "success": "Success", "failed": "Failed", "aborted": "Aborted", "error": "Error",
	}
    title := "Pipeline run " + statusLabel[status] + ": " + run.PipelineName
    body := "Pipeline " + run.PipelineName + " finished with status " + statusLabel[status]
	if run.ErrorSummary != "" && (status == "failed" || status == "error") {
        body += ", reason: " + run.ErrorSummary
	}
	if status == "aborted" && run.AbortReason != "" {
		if strings.HasPrefix(run.AbortReason, "user:") {
            body += " (aborted by " + strings.TrimPrefix(run.AbortReason, "user:") + ")"
		} else if run.AbortReason == "timeout" {
            body += " (aborted due to timeout)"
		}
	}
	if run.PassRate > 0 {
        body += ", pass rate " + fmt.Sprintf("%.1f%%", run.PassRate)
	}
	link := "/runs/" + runID
	detailURL := link
	if config.Global != nil && strings.TrimSpace(config.Global.App.ExternalURL) != "" {
		detailURL = strings.TrimRight(config.Global.App.ExternalURL, "/") + link
	}
	templateVars := map[string]string{
		"EVENT":         event,
		"STATUS":        statusLabel[status],
		"STATUS_CODE":   status,
		"PIPELINE_NAME": run.PipelineName,
		"PIPELINE_ID":   pipelineID,
		"RUN_ID":        runID,
		"PASS_RATE":     fmt.Sprintf("%.1f", run.PassRate),
		"FAILED_COUNT":  fmt.Sprintf("%d", run.FailedCount),
		"TOTAL_COUNT":   fmt.Sprintf("%d", run.TotalCount),
		"TRIGGERED_BY":  run.TriggeredBy,
		"DURATION":      formatNotificationDuration(run.DurationMs),
		"DETAIL_URL":    detailURL,
		"ERROR_SUMMARY": run.ErrorSummary,
		"TITLE":         title,
		"BODY":          body,
	}

	createInApp := func(uid, notiTitle, notiBody string) bool {
		uid = strings.TrimSpace(uid)
		if uid == "" || uid == "system" {
			return false
		}
		if !canCreateInAppNotification(uid, event) {
			return false
		}
		if notificationExists(uid, event, runID, "pipeline_run") {
			return false
		}
		noti := model.Notification{
			UserID: uid,
			Event:  event,
			Title:  notiTitle,
			Body:   notiBody,
			Link:   link,
			RefID:  runID,
			RefType: "pipeline_run",
		}
		database.DB.Create(&noti)
		return true
	}

	// Find matching notification rules
	var rules []model.NotificationRule
	database.DB.Where("enabled = ?", true).Find(&rules)

	for _, rule := range rules {
		// Check if event matches
		events := fromJSON[[]string](rule.EventsJSON)
		if !contains(events, event) {
			continue
		}
		if !notificationRuleMatchesProject(rule, pipeline.Project) {
			continue
		}

		// Check if pipeline matches (empty = all pipelines)
		pipelineIDs := fromJSON[[]string](rule.PipelineIDsJSON)
		if len(pipelineIDs) > 0 && !contains(pipelineIDs, pipelineID) {
			continue
		}

		channels := fromJSON[[]string](rule.ChannelsJSON)
		if len(channels) == 0 {
			channels = []string{"inapp"}
		}
		ruleTitle := renderNotificationTemplate(rule.TitleTemplate, templateVars, title)
		ruleBody := renderNotificationTemplate(rule.BodyTemplate, templateVars, body)
		ruleVars := map[string]string{}
		for key, value := range templateVars {
			ruleVars[key] = value
		}
		ruleVars["TITLE"] = ruleTitle
		ruleVars["BODY"] = ruleBody
		targets := resolveNotificationTargets(rule, &run, pipeline.Project)

		// Create in-app notifications
		if contains(channels, "inapp") {
			for _, uid := range targets.UserIDs {
				createInApp(uid, ruleTitle, ruleBody)
			}
		}
		if contains(channels, "email") {
			go sendRuleEmail(rule, targets, event, ruleTitle, ruleBody, link)
		}
		for _, channel := range []string{"dingtalk", "feishu", "webhook"} {
			if contains(channels, channel) {
				cfg := notificationChannelConfigFor(rule, channel)
				go sendRuleWebhook(rule, channel, cfg, event, ruleTitle, ruleBody, ruleVars)
			}
		}

		logger.Info("notification sent",
			zap.String("rule", rule.Name),
			zap.String("event", event),
			zap.Int("recipients", len(targets.UserIDs)),
			zap.Int("emails", len(targets.Emails)),
		)
	}

	// Baseline behavior: the trigger user should see their own terminal run result
	// even when no custom notification rule has been configured.
	createInApp(run.TriggeredBy, title, body)
	sendUserPreferenceEmailNotifications([]string{run.TriggeredBy}, event, title, body, link)
}

// SendTaskNotification is kept for compatibility with older task-run code.
// Test-set/task notifications are disabled while that module is hidden.
func SendTaskNotification(_, _, _, _ string) {
}

func fromJSON[T any](s string) T {
	var v T
	if s != "" {
		json.Unmarshal([]byte(s), &v)
	}
	return v
}

func contains(arr []string, val string) bool {
	for _, a := range arr {
		if a == val {
			return true
		}
	}
	return false
}

func formatNotificationDuration(ms int64) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	if ms < 60000 {
		return fmt.Sprintf("%.1fs", float64(ms)/1000)
	}
	return fmt.Sprintf("%dm%ds", ms/60000, (ms%60000)/1000)
}

func notificationRuleMatchesProject(rule model.NotificationRule, project string) bool {
	if strings.TrimSpace(rule.Scope) != "project" {
		return true
	}
	projectIDs := fromJSON[[]string](rule.ProjectIDsJSON)
	if len(projectIDs) == 0 {
		return false
	}
	return contains(projectIDs, project)
}

func renderNotificationTemplate(tpl string, vars map[string]string, fallback string) string {
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

func notificationChannelConfigFor(rule model.NotificationRule, channel string) notificationChannelConfig {
	configs := fromJSON[map[string]notificationChannelConfig](rule.ChannelConfigsJSON)
	cfg := configs[channel]
	if strings.TrimSpace(cfg.URL) == "" {
		cfg.URL = strings.TrimSpace(rule.WebhookURL)
	}
	return cfg
}

func uniqueStrings(values []string) []string {
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

func addUsersByRole(targets *notificationTargets, seen map[string]bool, roles []string, project string) {
	roles = uniqueStrings(roles)
	if len(roles) == 0 {
		return
	}
	var users []model.User
	database.DB.Where("status = 'active' AND role IN ?", roles).Find(&users)
	for _, user := range users {
		if project == "" || user.Role == "super_admin" || user.Projects == "" {
			if !seen[user.ID] {
				seen[user.ID] = true
				targets.UserIDs = append(targets.UserIDs, user.ID)
			}
			continue
		}
		projects := fromJSON[[]string](user.Projects)
		if contains(projects, project) && !seen[user.ID] {
			seen[user.ID] = true
			targets.UserIDs = append(targets.UserIDs, user.ID)
		}
	}

	var bindings []model.UserRoleBinding
	database.DB.Where("role_name IN ?", roles).Find(&bindings)
	var bindingUserIDs []string
	for _, binding := range bindings {
		bindingUserIDs = append(bindingUserIDs, binding.UserID)
	}
	bindingUserIDs = uniqueStrings(bindingUserIDs)
	if len(bindingUserIDs) == 0 {
		return
	}
	var roleUsers []model.User
	database.DB.Where("id IN ? AND status = 'active'", bindingUserIDs).Find(&roleUsers)
	for _, user := range roleUsers {
		if project == "" || user.Role == "super_admin" || user.Projects == "" || contains(fromJSON[[]string](user.Projects), project) {
			if !seen[user.ID] {
				seen[user.ID] = true
				targets.UserIDs = append(targets.UserIDs, user.ID)
			}
		}
	}
}

func resolveNotificationTargets(rule model.NotificationRule, run *model.PipelineRun, project string) notificationTargets {
	targets := notificationTargets{}
	seenUsers := map[string]bool{}
	addUser := func(id string) {
		id = strings.TrimSpace(id)
		if id != "" && id != "system" && !seenUsers[id] {
			seenUsers[id] = true
			targets.UserIDs = append(targets.UserIDs, id)
		}
	}

	recipients := fromJSON[map[string]any](rule.RecipientsJSON)
	recipientType, _ := recipients["type"].(string)
	switch recipientType {
	case "users":
		if ids, ok := recipients["userIds"].([]any); ok {
			for _, id := range ids {
				if s, ok := id.(string); ok {
					addUser(s)
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
		addUsersByRole(&targets, seenUsers, roles, project)
	case "role_pm":
		addUsersByRole(&targets, seenUsers, []string{"project_manager", "super_admin"}, project)
	case "all_members":
		var users []model.User
		database.DB.Where("status = 'active'").Find(&users)
		for _, user := range users {
			addUser(user.ID)
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
		if run != nil {
			addUser(run.TriggeredBy)
		}
	}
	targets.Emails = uniqueStrings(targets.Emails)
	return targets
}

func notificationEmailsForTargets(targets notificationTargets) []string {
	emails := append([]string{}, targets.Emails...)
	if len(targets.UserIDs) > 0 {
		var users []model.User
		database.DB.Select("id, email").Where("id IN ? AND status = 'active'", targets.UserIDs).Find(&users)
		for _, user := range users {
			emails = append(emails, user.Email)
		}
	}
	return uniqueStrings(emails)
}

func sendUserPreferenceEmailNotifications(userIDs []string, event, title, body, link string) {
	if config.Global == nil || !config.Global.SMTP.Enabled {
		return
	}

	userIDs = uniqueStrings(userIDs)
	if len(userIDs) == 0 {
		return
	}

	var users []model.User
	database.DB.Select("id, username, email").Where("id IN ? AND status = 'active'", userIDs).Find(&users)
	if len(users) == 0 {
		return
	}

	prefs := map[string]model.NotificationPreference{}
	var prefRows []model.NotificationPreference
	database.DB.Where("user_id IN ?", userIDs).Find(&prefRows)
	for _, pref := range prefRows {
		prefs[pref.UserID] = pref
	}

	subject := fmt.Sprintf("[ATOP] %s", title)
	detailURL := link
	if strings.TrimSpace(config.Global.App.ExternalURL) != "" {
		detailURL = strings.TrimRight(config.Global.App.ExternalURL, "/") + link
	}
	htmlBody := fmt.Sprintf(`<html><body style="font-family:'PingFang SC','Microsoft YaHei',Arial,sans-serif">
<h3>%s</h3><p>%s</p><p><a href="%s">View details</a></p><p style="color:#8c8c8c;font-size:12px">Event: %s</p>
</body></html>`, title, body, detailURL, event)
	cfg := config.Global.SMTP

	for _, user := range users {
		pref, ok := prefs[user.ID]
		if !ok || !pref.EmailEnabled || !notificationEventEnabled(pref.EventSwitches, event) || strings.TrimSpace(user.Email) == "" {
			continue
		}
		to := user.Email
		go func() {
			if err := util.SendEmail(cfg.Host, cfg.Port, cfg.Username, cfg.Password, cfg.From, to, subject, htmlBody, cfg.Security); err != nil {
				logger.Warn("user preference notification email failed", zap.String("email", to), zap.Error(err))
			}
		}()
	}
}

func sendRuleEmail(rule model.NotificationRule, targets notificationTargets, event, title, body, link string) {
	if config.Global == nil || !config.Global.SMTP.Enabled {
		return
	}
	emails := notificationEmailsForTargets(targets)
	if len(emails) == 0 {
		return
	}
	subject := fmt.Sprintf("[ATOP] %s", title)
	detailURL := link
	if strings.TrimSpace(config.Global.App.ExternalURL) != "" {
		detailURL = strings.TrimRight(config.Global.App.ExternalURL, "/") + link
	}
	htmlBody := fmt.Sprintf(`<html><body style="font-family:'PingFang SC','Microsoft YaHei',Arial,sans-serif">
<h3>%s</h3><p>%s</p><p><a href="%s">View details</a></p><p style="color:#8c8c8c;font-size:12px">Event: %s, Rule: %s</p>
</body></html>`, title, body, detailURL, event, rule.Name)
	cfg := config.Global.SMTP
	for _, email := range emails {
		to := email
		go func() {
			if err := util.SendEmail(cfg.Host, cfg.Port, cfg.Username, cfg.Password, cfg.From, to, subject, htmlBody, cfg.Security); err != nil {
				logger.Warn("notification rule email failed", zap.String("rule", rule.Name), zap.String("email", to), zap.Error(err))
			}
		}()
	}
}

func appendQueryParams(rawURL string, params []notificationKV, vars map[string]string) string {
	if strings.TrimSpace(rawURL) == "" || len(params) == 0 {
		return rawURL
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	query := parsed.Query()
	for _, item := range params {
		key := strings.TrimSpace(renderNotificationTemplate(item.Key, vars, item.Key))
		if key == "" {
			continue
		}
		query.Set(key, renderNotificationTemplate(item.Value, vars, item.Value))
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func defaultWebhookBody(channel, event, title, body string, vars map[string]string) []byte {
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
			"event":       event,
			"title":       title,
			"body":        body,
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

func sendRuleWebhook(rule model.NotificationRule, channel string, cfg notificationChannelConfig, event, title, body string, vars map[string]string) {
	rawURL := strings.TrimSpace(cfg.URL)
	if rawURL == "" {
		return
	}
	method := strings.ToUpper(strings.TrimSpace(cfg.Method))
	if method == "" {
		method = http.MethodPost
	}
	endpoint := appendQueryParams(rawURL, cfg.QueryParams, vars)

	var bodyReader *bytes.Reader
	if method == http.MethodGet && strings.TrimSpace(cfg.BodyTemplate) == "" {
		bodyReader = bytes.NewReader(nil)
	} else if strings.TrimSpace(cfg.BodyTemplate) != "" {
		bodyReader = bytes.NewReader([]byte(renderNotificationTemplate(cfg.BodyTemplate, vars, cfg.BodyTemplate)))
	} else {
		bodyReader = bytes.NewReader(defaultWebhookBody(channel, event, title, body, vars))
	}
	req, err := http.NewRequest(method, endpoint, bodyReader)
	if err != nil {
		logger.Warn("notification rule webhook request invalid", zap.String("rule", rule.Name), zap.String("channel", channel), zap.Error(err))
		return
	}
	hasContentType := false
	for _, header := range cfg.Headers {
		key := strings.TrimSpace(renderNotificationTemplate(header.Key, vars, header.Key))
		if key == "" {
			continue
		}
		if strings.EqualFold(key, "content-type") {
			hasContentType = true
		}
		req.Header.Set(key, renderNotificationTemplate(header.Value, vars, header.Value))
	}
	if !hasContentType && method != http.MethodGet {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-ATOP-Event", event)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		logger.Warn("notification rule webhook failed", zap.String("rule", rule.Name), zap.String("channel", channel), zap.Error(err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		logger.Warn("notification rule webhook returned error", zap.String("rule", rule.Name), zap.String("channel", channel), zap.Int("status", resp.StatusCode))
	}
}

func canCreateInAppNotification(userID, event string) bool {
	if event == model.NotiTaskFailed {
		return false
	}
	var pref model.NotificationPreference
	if err := database.DB.Where("user_id = ?", userID).First(&pref).Error; err != nil {
		return defaultNotificationEventEnabled(event)
	}
	if !pref.InAppEnabled {
		return false
	}
	return notificationEventEnabled(pref.EventSwitches, event)
}

func defaultNotificationEventEnabled(event string) bool {
	switch event {
	case model.NotiPipelineComplete, model.NotiPipelineFailed, model.NotiPipelineAborted,
		model.NotiUserDisabled, model.NotiPasswordReset:
		return true
	case model.NotiTaskFailed:
		return false
	default:
		return true
	}
}

func notificationEventEnabled(switchesJSON, event string) bool {
	if switchesJSON == "" {
		return defaultNotificationEventEnabled(event)
	}
	var switches map[string]bool
	if err := json.Unmarshal([]byte(switchesJSON), &switches); err != nil {
		return defaultNotificationEventEnabled(event)
	}
	if val, ok := switches[event]; ok {
		return val
	}
	return defaultNotificationEventEnabled(event)
}

func notificationExists(userID, event, refID, refType string) bool {
	var count int64
	database.DB.Model(&model.Notification{}).
		Where("user_id = ? AND event = ? AND ref_id = ? AND ref_type = ?", userID, event, refID, refType).
		Count(&count)
	return count > 0
}
