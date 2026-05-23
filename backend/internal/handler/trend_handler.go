package handler

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/response"
	"gorm.io/gorm"
)

type TrendHandler struct{}

func NewTrendHandler() *TrendHandler { return &TrendHandler{} }

// TrendPoint is one data point in the trend chart.
type TrendPoint struct {
	Date         string  `json:"date"`
	PassRate     float64 `json:"passRate"`
	DurationMs   int64   `json:"durationMs"`
	FailedCount  int     `json:"failedCount"`
	AbortedCount int     `json:"abortedCount"`
	TotalCount   int     `json:"totalCount"`
	RunCount     int     `json:"runCount"`
}

// GET /stats/trends?pipelineId=&project=&days=30&groupBy=day
func (h *TrendHandler) PipelineTrends(c *gin.Context) {
	pipelineID := c.Query("pipelineId")
	project    := c.Query("project")
	daysStr    := c.DefaultQuery("days", "30")
	groupBy    := c.DefaultQuery("groupBy", "day") // day | week

	var days int
	switch daysStr {
	case "7":  days = 7
	case "30": days = 30
	case "90": days = 90
	default:   days = 30
	}

	since := time.Now().AddDate(0, 0, -days)
	terminalStatuses := []string{"success", "failed", "aborted", "error"}

	db := database.DB.Table("pipeline_runs AS pr").
		Joins("LEFT JOIN pipelines p ON p.id = pr.pipeline_id").
		Where("pr.started_at >= ?", since).
		Where("pr.status IN ?", terminalStatuses).
		Where("pr.parent_run_id IS NULL OR pr.parent_run_id = ''") // root runs only

	if pipelineID != "" {
		db = db.Where("pr.pipeline_id = ?", pipelineID)
	}
	if project != "" {
		db = db.Where("p.project = ?", project)
	}

	// Group by date
	var dateFmt string
	if groupBy == "week" {
		dateFmt = "%Y-W%u"
	} else {
		dateFmt = "%Y-%m-%d"
	}

	type row struct {
		DateStr    string  `gorm:"column:date_str"`
		AvgPassRate float64 `gorm:"column:avg_pass_rate"`
		AvgDuration float64 `gorm:"column:avg_duration"`
		TotalFailed int     `gorm:"column:total_failed"`
		TotalAborted int    `gorm:"column:total_aborted"`
		TotalCount  int     `gorm:"column:total_count"`
		RunCount    int     `gorm:"column:run_count"`
	}
	var rows []row
	db.Select(`
		DATE_FORMAT(pr.started_at, ?) AS date_str,
		ROUND(SUM(CASE WHEN pr.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS avg_pass_rate,
		AVG(CASE
			WHEN pr.duration_ms > 0 THEN pr.duration_ms
			WHEN pr.started_at IS NOT NULL AND pr.finished_at IS NOT NULL THEN TIMESTAMPDIFF(MICROSECOND, pr.started_at, pr.finished_at) / 1000
			ELSE NULL
		END) AS avg_duration,
		SUM(CASE WHEN pr.status IN ('failed','error') THEN 1 ELSE 0 END) AS total_failed,
		SUM(CASE WHEN pr.status = 'aborted' THEN 1 ELSE 0 END) AS total_aborted,
		COUNT(*) AS total_count,
		COUNT(*) AS run_count
	`, dateFmt).
		Group("date_str").
		Order("date_str asc").
		Scan(&rows)

	points := make([]TrendPoint, 0, len(rows))
	for _, r := range rows {
		points = append(points, TrendPoint{
			Date:        r.DateStr,
			PassRate:    r.AvgPassRate,
			DurationMs:  int64(math.Round(r.AvgDuration)),
			FailedCount: r.TotalFailed,
			AbortedCount: r.TotalAborted,
			TotalCount:  r.TotalCount,
			RunCount:    r.RunCount,
		})
	}

	response.OK(c, gin.H{"points": points, "days": days, "groupBy": groupBy})
}

// GET /stats/summary?project=&days=30
func (h *TrendHandler) Summary(c *gin.Context) {
	project := c.Query("project")
	daysStr := c.DefaultQuery("days", "30")
	var days int
	switch daysStr {
	case "7": days = 7
	case "90": days = 90
	default: days = 30
	}
	since := time.Now().AddDate(0, 0, -days)
	terminalStatuses := []string{"success", "failed", "aborted", "error"}

	db := database.DB.Table("pipeline_runs AS pr").
		Joins("LEFT JOIN pipelines p ON p.id = pr.pipeline_id").
		Where("pr.started_at >= ?", since).
		Where("pr.status IN ?", terminalStatuses).
		Where("pr.parent_run_id IS NULL OR pr.parent_run_id = ''")
	if project != "" {
		db = db.Where("p.project = ?", project)
	}

	var summary struct {
		TotalRuns    int     `gorm:"column:total_runs"`
		AvgPassRate  float64 `gorm:"column:avg_pass_rate"`
		AvgDuration  float64 `gorm:"column:avg_duration"`
		TotalFailed  int     `gorm:"column:total_failed"`
		TotalAborted int     `gorm:"column:total_aborted"`
		ActivePipelines int  `gorm:"column:active_pipeline_count"`
		UnstablePipelines int `gorm:"column:unstable_pipeline_count"`
	}
	db.Select(`
		COUNT(*) AS total_runs,
		ROUND(SUM(CASE WHEN pr.status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS avg_pass_rate,
		AVG(CASE
			WHEN pr.duration_ms > 0 THEN pr.duration_ms
			WHEN pr.started_at IS NOT NULL AND pr.finished_at IS NOT NULL THEN TIMESTAMPDIFF(MICROSECOND, pr.started_at, pr.finished_at) / 1000
			ELSE NULL
		END) AS avg_duration,
		SUM(CASE WHEN pr.status IN ('failed','error') THEN 1 ELSE 0 END) AS total_failed,
		SUM(CASE WHEN pr.status = 'aborted' THEN 1 ELSE 0 END) AS total_aborted,
		COUNT(DISTINCT pr.pipeline_id) AS active_pipeline_count,
		COUNT(DISTINCT CASE WHEN pr.status IN ('failed','error','aborted') THEN pr.pipeline_id END) AS unstable_pipeline_count
	`).Scan(&summary)

	// Top failing pipelines
	type failRow struct {
		PipelineName string  `gorm:"column:pipeline_name" json:"pipelineName"`
		PipelineID   string  `gorm:"column:pipeline_id" json:"pipelineId"`
		RunCount     int     `gorm:"column:run_count" json:"runCount"`
		FailedRuns   int     `gorm:"column:failed_runs" json:"failedRuns"`
		AbortedRuns  int     `gorm:"column:aborted_runs" json:"abortedRuns"`
		ExceptionRuns int    `gorm:"column:exception_runs" json:"exceptionRuns"`
		FailureRate  float64 `gorm:"column:failure_rate" json:"failureRate"`
		ExceptionRate float64 `gorm:"column:exception_rate" json:"exceptionRate"`
		AvgPassRate  float64 `gorm:"column:avg_pass_rate" json:"avgPassRate"`
	}
	var topFailing []failRow
	baseDB := database.DB.Table("pipeline_runs AS pr").
		Joins("LEFT JOIN pipelines p ON p.id = pr.pipeline_id").
		Where("pr.started_at >= ? AND pr.status IN ? AND (pr.parent_run_id IS NULL OR pr.parent_run_id = '')",
			since, terminalStatuses)
	if project != "" {
		baseDB = baseDB.Where("p.project = ?", project)
	}
	baseDB.Select(`
		COALESCE(NULLIF(pr.pipeline_name, ''), p.name) AS pipeline_name,
		pr.pipeline_id,
		COUNT(*) AS run_count,
		SUM(CASE WHEN pr.status IN ('failed','error') THEN 1 ELSE 0 END) AS failed_runs,
		SUM(CASE WHEN pr.status = 'aborted' THEN 1 ELSE 0 END) AS aborted_runs,
		SUM(CASE WHEN pr.status IN ('failed','error','aborted') THEN 1 ELSE 0 END) AS exception_runs,
		ROUND(SUM(CASE WHEN pr.status IN ('failed','error') THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS failure_rate,
		ROUND(SUM(CASE WHEN pr.status IN ('failed','error','aborted') THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS exception_rate,
		ROUND(SUM(CASE WHEN pr.status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS avg_pass_rate
	`).Group("pr.pipeline_id, COALESCE(NULLIF(pr.pipeline_name, ''), p.name)").
		Having("exception_runs > 0").
		Order("exception_rate desc, exception_runs desc, run_count desc").
		Limit(5).
		Scan(&topFailing)

	if topFailing == nil { topFailing = []failRow{} }
	exceptionRate := 0.0
	if summary.TotalRuns > 0 {
		exceptionRate = math.Round(float64(summary.TotalFailed+summary.TotalAborted)*1000/float64(summary.TotalRuns)) / 10
	}

	response.OK(c, gin.H{
		"totalRuns":   summary.TotalRuns,
		"avgPassRate": summary.AvgPassRate,
		"avgDuration": int64(math.Round(summary.AvgDuration)),
		"totalFailed": summary.TotalFailed,
		"totalAborted": summary.TotalAborted,
		"exceptionRate": exceptionRate,
		"activePipelineCount": summary.ActivePipelines,
		"unstablePipelineCount": summary.UnstablePipelines,
		"avgRunsPerDay": math.Round(float64(summary.TotalRuns)*10/float64(days)) / 10,
		"topFailing":  topFailing,
		"days":        days,
	})
}

// GET /stats/pipelines?project=&days=30  — per-pipeline breakdown
func (h *TrendHandler) PipelineBreakdown(c *gin.Context) {
	project := c.Query("project")
	daysStr := c.DefaultQuery("days", "30")
	var days int
	switch daysStr {
	case "7": days = 7
	case "90": days = 90
	default: days = 30
	}
	since := time.Now().AddDate(0, 0, -days)
	terminalStatuses := []string{"success", "failed", "aborted", "error"}
	page, size, offset := util.PageParams(c.Query("page"), c.Query("pageSize"))
	if v := c.Query("limit"); v != "" && c.Query("pageSize") == "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			size = n
			page = 1
			offset = 0
		}
	}
	if size > 100 {
		size = 100
		offset = (page - 1) * size
	}
	keyword := c.Query("keyword")
	nameExpr := "COALESCE(NULLIF(pr.pipeline_name, ''), p.name)"
	baseQuery := func() *gorm.DB {
		db := database.DB.Table("pipeline_runs AS pr").
			Joins("LEFT JOIN pipelines p ON p.id = pr.pipeline_id").
			Where("pr.started_at >= ? AND pr.status IN ? AND (pr.parent_run_id IS NULL OR pr.parent_run_id = '')",
				since, terminalStatuses)
		if project != "" {
			db = db.Where("p.project = ?", project)
		}
		if keyword != "" {
			db = db.Where(nameExpr+" LIKE ?", "%"+keyword+"%")
		}
		return db
	}

	type pipeRow struct {
		PipelineID   string  `gorm:"column:pipeline_id"   json:"pipelineId"`
		PipelineName string  `gorm:"column:pipeline_name" json:"pipelineName"`
		RunCount     int     `gorm:"column:run_count"     json:"runCount"`
		AvgPassRate  float64 `gorm:"column:avg_pass_rate" json:"avgPassRate"`
		AvgDuration  float64 `gorm:"column:avg_duration"  json:"avgDuration"`
		FailedRuns   int     `gorm:"column:failed_runs"   json:"failedRuns"`
		AbortedRuns  int     `gorm:"column:aborted_runs"  json:"abortedRuns"`
		ExceptionRuns int    `gorm:"column:exception_runs" json:"exceptionRuns"`
		ExceptionRate float64 `gorm:"column:exception_rate" json:"exceptionRate"`
		LastRunAt    *time.Time `gorm:"column:last_run_at" json:"lastRunAt"`
	}
	var rows []pipeRow

	var total int64
	totalQuery := baseQuery().
		Select("pr.pipeline_id, "+nameExpr+" AS pipeline_name").
		Group("pr.pipeline_id, " + nameExpr)
	if err := database.DB.Table("(?) AS pipeline_stat_groups", totalQuery).
		Count(&total).Error; err != nil {
		response.InternalError(c, "query pipeline statistics total failed")
		return
	}

	if err := baseQuery().Select(`
		pr.pipeline_id,
		`+nameExpr+` AS pipeline_name,
		COUNT(*) AS run_count,
		ROUND(SUM(CASE WHEN pr.status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS avg_pass_rate,
		AVG(CASE
			WHEN pr.duration_ms > 0 THEN pr.duration_ms
			WHEN pr.started_at IS NOT NULL AND pr.finished_at IS NOT NULL THEN TIMESTAMPDIFF(MICROSECOND, pr.started_at, pr.finished_at) / 1000
			ELSE NULL
		END) AS avg_duration,
		SUM(CASE WHEN pr.status IN ('failed','error') THEN 1 ELSE 0 END) AS failed_runs,
		SUM(CASE WHEN pr.status = 'aborted' THEN 1 ELSE 0 END) AS aborted_runs,
		SUM(CASE WHEN pr.status IN ('failed','error','aborted') THEN 1 ELSE 0 END) AS exception_runs,
		ROUND(SUM(CASE WHEN pr.status IN ('failed','error','aborted') THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS exception_rate,
		MAX(pr.started_at) AS last_run_at
	`).Group("pr.pipeline_id, " + nameExpr).
		Order("run_count desc").
		Limit(size).
		Offset(offset).
		Scan(&rows).Error; err != nil {
		response.InternalError(c, "query pipeline statistics detail failed")
		return
	}

	if rows == nil { rows = []pipeRow{} }
	response.OK(c, gin.H{"items": rows, "total": total, "page": page, "pageSize": size, "days": days})
}

// guard unused imports
var _ = http.StatusOK
