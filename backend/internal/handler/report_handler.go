package handler

import (
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/scheduler"
	"github.com/company/atop-backend/pkg/response"
)

type ReportHandler struct{}

// ReportPipeline receives pipeline run status from Jenkins.
// POST /api/report/pipeline (public, no JWT)
func (h *ReportHandler) ReportPipeline(c *gin.Context) {
	var body struct {
		PipelineKey   string `json:"pipelineKey" binding:"required"`
		PipelineName  string `json:"pipelineName"`
		PipelineRunID string `json:"pipelineRunId"`
		BuildID       int64  `json:"buildId"`
		BuildURL      string `json:"buildUrl"`
		Status        string `json:"status" binding:"required"`
		TriggeredBy   string `json:"triggeredBy"`
		StartedAt     string `json:"startedAt"`
		FinishedAt    string `json:"finishedAt"`
		ErrorSummary  string `json:"errorSummary"`
		Stages        []struct {
			StageKey     string `json:"stageKey" binding:"required"`
			StageName    string `json:"stageName"`
			Status       string `json:"status"`
			NodeName     string `json:"nodeName"`
			StartedAt    string `json:"startedAt"`
			FinishedAt   string `json:"finishedAt"`
			DurationMs   int64  `json:"durationMs"`
			ErrorSummary string `json:"errorSummary"`
		} `json:"stages"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	if body.PipelineName == "" {
		body.PipelineName = body.PipelineKey
	}

	var startedAt, finishedAt *time.Time
	if body.StartedAt != "" {
		if t, err := time.Parse(time.RFC3339, body.StartedAt); err == nil {
			startedAt = &t
		}
	}
	if body.FinishedAt != "" {
		if t, err := time.Parse(time.RFC3339, body.FinishedAt); err == nil {
			finishedAt = &t
		}
	}

	if body.PipelineRunID == "" {
		body.PipelineRunID = c.GetHeader("X-ATOP-Run-ID")
	}

	var run model.ReportedPipelineRun
	findCond := database.DB
	if body.PipelineRunID != "" {
		findCond = database.DB.Where("pipeline_run_id = ?", body.PipelineRunID)
	} else if strings.TrimSpace(body.BuildURL) != "" {
		findCond = database.DB.Where("pipeline_key = ? AND build_url = ?", body.PipelineKey, body.BuildURL)
	} else if body.BuildID > 0 {
		findCond = database.DB.Where("pipeline_key = ? AND build_id = ?", body.PipelineKey, body.BuildID)
	} else {
		response.BadRequest(c, "MISSING_JENKINS_BUILD_ID", "pipelineRunId, buildUrl, or buildId is required for matching")
		return
	}

	if err := findCond.First(&run).Error; err != nil {
		if startedAt == nil {
			now := time.Now()
			startedAt = &now
		}
		run = model.ReportedPipelineRun{
			PipelineKey:   body.PipelineKey,
			PipelineName:  body.PipelineName,
			BuildID:       body.BuildID,
			BuildURL:      body.BuildURL,
			Status:        body.Status,
			TriggeredBy:   body.TriggeredBy,
			StartedAt:     startedAt,
			FinishedAt:    finishedAt,
			ErrorSummary:  body.ErrorSummary,
			Source:        "jenkins_report",
			PipelineRunID: body.PipelineRunID,
		}
		if run.FinishedAt != nil && run.StartedAt != nil {
			run.DurationMs = run.FinishedAt.Sub(*run.StartedAt).Milliseconds()
		}
		database.DB.Create(&run)
	} else {
		updates := map[string]any{
			"status":        body.Status,
			"pipeline_name": body.PipelineName,
		}
		if body.BuildID > 0 {
			updates["build_id"] = body.BuildID
		}
		if body.BuildURL != "" {
			updates["build_url"] = body.BuildURL
		}
		if body.PipelineRunID != "" {
			updates["pipeline_run_id"] = body.PipelineRunID
		}
		if body.ErrorSummary != "" {
			updates["error_summary"] = body.ErrorSummary
		}
		if finishedAt != nil {
			updates["finished_at"] = finishedAt
			if run.StartedAt != nil {
				updates["duration_ms"] = finishedAt.Sub(*run.StartedAt).Milliseconds()
			}
		}
		database.DB.Model(&run).Updates(updates)
	}

	if body.PipelineRunID != "" {
		var platformRun model.PipelineRun
		platformRunLoaded := database.DB.First(&platformRun, "id = ?", body.PipelineRunID).Error == nil
		platformUpdates := map[string]any{"status": body.Status}
		if body.BuildID > 0 {
			if platformRunLoaded && scheduler.JenkinsBuildIDUsedByAnotherRun(platformRun.PipelineID, platformRun.ID, body.BuildID) {
				platformUpdates["error_summary"] = fmt.Sprintf(
					"Jenkins build id %d is already used by another run of the same pipeline",
					body.BuildID,
				)
			} else {
				platformUpdates["jenkins_build_id"] = body.BuildID
			}
		}
		if body.BuildURL != "" {
			platformUpdates["jenkins_build_url"] = body.BuildURL
		}
		if body.ErrorSummary != "" {
			platformUpdates["error_summary"] = body.ErrorSummary
		}
		if startedAt != nil {
			platformUpdates["started_at"] = startedAt
		}
		if finishedAt != nil {
			platformUpdates["finished_at"] = finishedAt
			if platformRunLoaded {
				durationMs := scheduler.CalcDurationMs(platformRun.StartedAt, *finishedAt)
				if durationMs == 0 && startedAt != nil {
					durationMs = scheduler.CalcDurationMs(startedAt, *finishedAt)
				}
				platformUpdates["duration_ms"] = durationMs
			}
		}
		database.DB.Model(&model.PipelineRun{}).Where("id = ?", body.PipelineRunID).Updates(platformUpdates)
		if body.Status == "success" || body.Status == "failed" || body.Status == "aborted" || body.Status == "error" {
			var refreshedRun model.PipelineRun
			if err := database.DB.First(&refreshedRun, "id = ?", body.PipelineRunID).Error; err == nil {
				go scheduler.SendPipelineNotifications(refreshedRun.ID, refreshedRun.PipelineID, body.Status)
			}
		}
	}

	for _, s := range body.Stages {
		var sStartedAt, sFinishedAt *time.Time
		if s.StartedAt != "" {
			if t, err := time.Parse(time.RFC3339, s.StartedAt); err == nil {
				sStartedAt = &t
			}
		}
		if s.FinishedAt != "" {
			if t, err := time.Parse(time.RFC3339, s.FinishedAt); err == nil {
				sFinishedAt = &t
			}
		}

		stageName := s.StageName
		if stageName == "" {
			stageName = s.StageKey
		}

		var stage model.ReportedStageRun
		if err := database.DB.Where("reported_pipeline_run_id = ? AND stage_key = ?", run.ID, s.StageKey).
			First(&stage).Error; err != nil {
			stage = model.ReportedStageRun{
				ReportedPipelineRunID: run.ID,
				StageKey:              s.StageKey,
				StageName:             stageName,
				Status:                s.Status,
				NodeName:              s.NodeName,
				StartedAt:             sStartedAt,
				FinishedAt:            sFinishedAt,
				DurationMs:            s.DurationMs,
				ErrorSummary:          s.ErrorSummary,
			}
			if stage.Status == "" {
				stage.Status = "pending"
			}
			database.DB.Create(&stage)
		} else {
			stageUpdates := map[string]any{
				"stage_name": stageName,
			}
			if s.Status != "" {
				stageUpdates["status"] = s.Status
			}
			if s.NodeName != "" {
				stageUpdates["node_name"] = s.NodeName
			}
			if sStartedAt != nil {
				stageUpdates["started_at"] = sStartedAt
			}
			if sFinishedAt != nil {
				stageUpdates["finished_at"] = sFinishedAt
				if stage.StartedAt != nil {
					stageUpdates["duration_ms"] = sFinishedAt.Sub(*stage.StartedAt).Milliseconds()
				} else if s.DurationMs > 0 {
					stageUpdates["duration_ms"] = s.DurationMs
				}
			}
			if s.ErrorSummary != "" {
				stageUpdates["error_summary"] = s.ErrorSummary
			}
			database.DB.Model(&stage).Updates(stageUpdates)
		}
	}

	response.OK(c, gin.H{
		"runId":  run.ID,
		"status": body.Status,
		"stages": len(body.Stages),
	})
}

// ListReportedRuns returns reported pipeline runs.
func (h *ReportHandler) ListReportedRuns(c *gin.Context) {
	page, size, offset := parsePageParams(c)
	db := database.DB.Model(&model.ReportedPipelineRun{}).Order("created_at DESC")

	if v := c.Query("pipelineKey"); v != "" {
		db = db.Where("pipeline_key = ?", v)
	}
	if v := c.Query("status"); v != "" {
		db = db.Where("status = ?", v)
	}
	if v := c.Query("keyword"); v != "" {
		db = db.Where("pipeline_name LIKE ? OR pipeline_key LIKE ?", "%"+v+"%", "%"+v+"%")
	}

	var total int64
	db.Count(&total)
	var items []model.ReportedPipelineRun
	db.Limit(size).Offset(offset).Find(&items)
	if items == nil {
		items = []model.ReportedPipelineRun{}
	}
	response.OK(c, gin.H{"items": items, "total": total, "page": page, "pageSize": size})
}

// GetReportedRun returns a single reported run with its stages.
func (h *ReportHandler) GetReportedRun(c *gin.Context) {
	id := c.Param("id")
	var run model.ReportedPipelineRun
	if err := database.DB.First(&run, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Reported run not found")
		return
	}

	var stages []model.ReportedStageRun
	database.DB.Where("reported_pipeline_run_id = ?", id).Order("created_at ASC").Find(&stages)
	if stages == nil {
		stages = []model.ReportedStageRun{}
	}

	response.OK(c, gin.H{
		"run":    run,
		"stages": stages,
	})
}

// GetByPipelineRunID finds reported data for a platform-triggered run.
func (h *ReportHandler) GetByPipelineRunID(c *gin.Context) {
	pipelineRunID := c.Param("pipelineRunId")
	var run model.ReportedPipelineRun
	if err := database.DB.Where("pipeline_run_id = ?", pipelineRunID).First(&run).Error; err != nil {
		response.OK(c, gin.H{"found": false, "stages": []any{}})
		return
	}

	var stages []model.ReportedStageRun
	database.DB.Where("reported_pipeline_run_id = ?", run.ID).Order("created_at ASC").Find(&stages)
	if stages == nil {
		stages = []model.ReportedStageRun{}
	}

	response.OK(c, gin.H{
		"found":  true,
		"run":    run,
		"stages": stages,
	})
}

func parsePageParams(c *gin.Context) (int, int, int) {
	page := 1
	size := 20
	if v := c.Query("page"); v != "" {
		if p, err := parseInt(v); err == nil && p > 0 {
			page = p
		}
	}
	if v := c.Query("pageSize"); v != "" {
		if s, err := parseInt(v); err == nil && s > 0 && s <= 100 {
			size = s
		}
	}
	return page, size, (page-1)*size
}

func parseInt(s string) (int, error) {
	var v int
	_, err := fmt.Sscanf(s, "%d", &v)
	return v, err
}
