package handler

import (
	"fmt"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/pkg/response"
)

type CleanupHandler struct{}

const defaultCleanupID = "default"

func getOrCreateConfig() model.CleanupConfig {
	var cfg model.CleanupConfig
	if err := database.DB.First(&cfg, "id = ?", defaultCleanupID).Error; err != nil {
		cfg = model.CleanupConfig{
			ID:                 defaultCleanupID,
			RunRetentionDays:   180,
			AuditRetentionDays: 365,
			NotiRetentionDays:  90,
			MaxRunsPerPipeline: 0,
			MaxAuditLogs:       0,
			AutoEnabled:        true,
		}
		database.DB.Create(&cfg)
	}
	return cfg
}

func (h *CleanupHandler) GetConfig(c *gin.Context) {
	cfg := getOrCreateConfig()
	var runCount, auditCount, notiCount int64
	database.DB.Model(&model.PipelineRun{}).Count(&runCount)
	database.DB.Model(&model.AuditLog{}).Count(&auditCount)
	database.DB.Model(&model.Notification{}).Count(&notiCount)

	response.OK(c, gin.H{
		"config": cfg,
		"stats": gin.H{
			"pipelineRuns":  runCount,
			"auditLogs":     auditCount,
			"notifications": notiCount,
		},
	})
}

func (h *CleanupHandler) UpdateConfig(c *gin.Context) {
	var body model.CleanupConfig
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}
	if body.RunRetentionDays < 0 || body.AuditRetentionDays < 0 || body.NotiRetentionDays < 0 {
		response.BadRequest(c, "INVALID_PARAMS", "Retention days cannot be negative")
		return
	}

	cfg := getOrCreateConfig()
	now := time.Now()
	database.DB.Model(&cfg).Updates(map[string]any{
		"run_retention_days":    body.RunRetentionDays,
		"audit_retention_days":  body.AuditRetentionDays,
		"noti_retention_days":   body.NotiRetentionDays,
		"max_runs_per_pipeline": body.MaxRunsPerPipeline,
		"max_audit_logs":        body.MaxAuditLogs,
		"auto_enabled":          body.AutoEnabled,
		"updated_at":            now,
		"updated_by":            middleware.GetUserID(c),
	})

	WriteAuditLogFromCtx(c, "update", "cleanup", defaultCleanupID, "cleanup config", body)
	response.OK(c, gin.H{"ok": true})
}

func (h *CleanupHandler) DryRun(c *gin.Context) {
	cfg := getOrCreateConfig()
	result := computeCleanupPreview(cfg)
	response.OK(c, result)
}

func (h *CleanupHandler) Execute(c *gin.Context) {
	cfg := getOrCreateConfig()
	result := runCleanup(cfg)
	WriteAuditLogFromCtx(c, "execute", "cleanup", defaultCleanupID, "manual cleanup", result)
	response.OK(c, result)
}

type CleanupResult struct {
	PipelineRunsDeleted  int64  `json:"pipelineRunsDeleted"`
	TaskRunsDeleted      int64  `json:"taskRunsDeleted"`
	AuditLogsDeleted     int64  `json:"auditLogsDeleted"`
	NotificationsDeleted int64  `json:"notificationsDeleted"`
	SnapshotsCleared     int64  `json:"snapshotsCleared"`
	Duration             string `json:"duration"`
	DryRun               bool   `json:"dryRun"`
}

func computeCleanupPreview(cfg model.CleanupConfig) CleanupResult {
	result := CleanupResult{DryRun: true}

	if cfg.RunRetentionDays > 0 {
		cutoff := time.Now().AddDate(0, 0, -cfg.RunRetentionDays)
		var c1, c2 int64
		database.DB.Model(&model.PipelineRun{}).Where("created_at < ?", cutoff).Count(&c1)
		database.DB.Model(&model.TaskRun{}).Where("created_at < ?", cutoff).Count(&c2)
		result.PipelineRunsDeleted = c1
		result.TaskRunsDeleted = c2
	}

	if cfg.MaxRunsPerPipeline > 0 {
		type row struct {
			PipelineID string
			Cnt        int64
		}
		var rows []row
		database.DB.Model(&model.PipelineRun{}).
			Select("pipeline_id, count(*) as cnt").
			Group("pipeline_id").
			Having("cnt > ?", cfg.MaxRunsPerPipeline).
			Scan(&rows)
		for _, r := range rows {
			result.PipelineRunsDeleted += r.Cnt - int64(cfg.MaxRunsPerPipeline)
		}
	}

	if cfg.AuditRetentionDays > 0 {
		cutoff := time.Now().AddDate(0, 0, -cfg.AuditRetentionDays)
		var c int64
		database.DB.Model(&model.AuditLog{}).Where("created_at < ?", cutoff).Count(&c)
		result.AuditLogsDeleted = c
	}

	if cfg.MaxAuditLogs > 0 {
		var total int64
		database.DB.Model(&model.AuditLog{}).Count(&total)
		if excess := total - int64(cfg.MaxAuditLogs); excess > 0 {
			result.AuditLogsDeleted += excess
		}
	}

	if cfg.NotiRetentionDays > 0 {
		cutoff := time.Now().AddDate(0, 0, -cfg.NotiRetentionDays)
		var c int64
		database.DB.Model(&model.Notification{}).Where("created_at < ?", cutoff).Count(&c)
		result.NotificationsDeleted = c
	}

	if cfg.SnapshotRetentionDays > 0 {
		cutoff := time.Now().AddDate(0, 0, -cfg.SnapshotRetentionDays)
		var c int64
		database.DB.Model(&model.TaskRun{}).
			Where("created_at < ? AND (config_snapshot_json != '' OR global_vars_snapshot != '')", cutoff).
			Count(&c)
		result.SnapshotsCleared = c
	}

	return result
}

func runCleanup(cfg model.CleanupConfig) CleanupResult {
	start := time.Now()
	result := CleanupResult{DryRun: false}

	if cfg.RunRetentionDays > 0 {
		cutoff := time.Now().AddDate(0, 0, -cfg.RunRetentionDays)
		r1 := database.DB.Where("created_at < ?", cutoff).Delete(&model.TaskRun{})
		r2 := database.DB.Where("created_at < ?", cutoff).Delete(&model.PipelineRun{})
		result.TaskRunsDeleted += r1.RowsAffected
		result.PipelineRunsDeleted += r2.RowsAffected
	}

	if cfg.MaxRunsPerPipeline > 0 {
		var pipelineIDs []string
		database.DB.Model(&model.PipelineRun{}).
			Distinct("pipeline_id").Pluck("pipeline_id", &pipelineIDs)
		for _, pid := range pipelineIDs {
			var ids []string
			database.DB.Model(&model.PipelineRun{}).
				Where("pipeline_id = ?", pid).
				Order("created_at DESC").
				Offset(cfg.MaxRunsPerPipeline).
				Pluck("id", &ids)
			if len(ids) > 0 {
				r := database.DB.Where("pipeline_run_id IN ?", ids).Delete(&model.TaskRun{})
				result.TaskRunsDeleted += r.RowsAffected
				r2 := database.DB.Where("id IN ?", ids).Delete(&model.PipelineRun{})
				result.PipelineRunsDeleted += r2.RowsAffected
			}
		}
	}

	if cfg.AuditRetentionDays > 0 {
		cutoff := time.Now().AddDate(0, 0, -cfg.AuditRetentionDays)
		r := database.DB.Where("created_at < ?", cutoff).Delete(&model.AuditLog{})
		result.AuditLogsDeleted += r.RowsAffected
	}

	if cfg.MaxAuditLogs > 0 {
		var ids []string
		database.DB.Model(&model.AuditLog{}).
			Order("created_at DESC").
			Offset(cfg.MaxAuditLogs).
			Pluck("id", &ids)
		if len(ids) > 0 {
			r := database.DB.Where("id IN ?", ids).Delete(&model.AuditLog{})
			result.AuditLogsDeleted += r.RowsAffected
		}
	}

	if cfg.NotiRetentionDays > 0 {
		cutoff := time.Now().AddDate(0, 0, -cfg.NotiRetentionDays)
		r := database.DB.Where("created_at < ?", cutoff).Delete(&model.Notification{})
		result.NotificationsDeleted += r.RowsAffected
	}

	if cfg.SnapshotRetentionDays > 0 {
		cutoff := time.Now().AddDate(0, 0, -cfg.SnapshotRetentionDays)
		r := database.DB.Model(&model.TaskRun{}).
			Where("created_at < ? AND (config_snapshot_json != '' OR global_vars_snapshot != '')", cutoff).
			Updates(map[string]any{
				"config_snapshot_json": "",
				"global_vars_snapshot": "",
			})
		result.SnapshotsCleared = r.RowsAffected
	}

	database.DB.Where("expires_at < ?", time.Now()).Delete(&model.RefreshToken{})

	result.Duration = fmt.Sprintf("%.2fs", time.Since(start).Seconds())
	return result
}

func RunScheduledCleanup() {
	cfg := getOrCreateConfig()
	if !cfg.AutoEnabled {
		return
	}
	runCleanup(cfg)
}
