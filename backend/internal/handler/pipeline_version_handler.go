package handler

import (
	"encoding/json"
	"reflect"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/pkg/response"
)

// snapshotPipelineVersion saves a snapshot of the pipeline state.
// Call this inside pipeline Create/Update after save succeeds.
func snapshotPipelineVersion(p *model.Pipeline, changedBy, changedByName, summary string) {
	var maxVer int
	database.DB.Model(&model.PipelineVersion{}).
		Where("pipeline_id = ?", p.ID).
		Select("COALESCE(MAX(version), 0)").
		Scan(&maxVer)

	database.DB.Create(&model.PipelineVersion{
		PipelineID:      p.ID,
		Version:         maxVer + 1,
		Name:            p.Name,
		StageConfigJSON: p.StageConfigJSON,
		DAGConfigJSON:   p.DAGConfigJSON,
		Params:          p.Params,
		JenkinsBindings: p.JenkinsBindings,
		ChangeSummary:   summary,
		ChangedBy:       changedBy,
		ChangedByName:   changedByName,
	})

	var oldest []model.PipelineVersion
	database.DB.Where("pipeline_id = ?", p.ID).
		Order("version asc").
		Find(&oldest)
	if len(oldest) > 50 {
		for _, v := range oldest[:len(oldest)-50] {
			database.DB.Delete(&v)
		}
	}
}

type PipelineVersionHandler struct{}

func NewPipelineVersionHandler() *PipelineVersionHandler { return &PipelineVersionHandler{} }

// GET /pipelines/:id/versions
func (h *PipelineVersionHandler) List(c *gin.Context) {
	var versions []model.PipelineVersion
	database.DB.Where("pipeline_id = ?", c.Param("id")).
		Order("version desc").
		Limit(50).
		Find(&versions)
	response.OK(c, gin.H{"items": versions, "total": len(versions)})
}

// GET /pipelines/:id/versions/:ver
func (h *PipelineVersionHandler) Get(c *gin.Context) {
	var ver model.PipelineVersion
	if err := database.DB.Where("pipeline_id = ? AND version = ?", c.Param("id"), c.Param("ver")).
		First(&ver).Error; err != nil {
		response.NotFound(c, "Version not found")
		return
	}
	response.OK(c, ver)
}

// GET /pipelines/:id/versions/:ver/diff?base=N
func (h *PipelineVersionHandler) Diff(c *gin.Context) {
	headVerNum := c.Param("ver")
	baseVerNum := c.Query("base")

	var head model.PipelineVersion
	if err := database.DB.Where("pipeline_id = ? AND version = ?", c.Param("id"), headVerNum).
		First(&head).Error; err != nil {
		response.NotFound(c, "Target version not found")
		return
	}

	var base model.PipelineVersion
	if baseVerNum != "" {
		if err := database.DB.Where("pipeline_id = ? AND version = ?", c.Param("id"), baseVerNum).
			First(&base).Error; err != nil {
			response.NotFound(c, "Base version not found")
			return
		}
	} else {
		database.DB.Where("pipeline_id = ? AND version = ?", c.Param("id"), head.Version-1).First(&base)
	}

	diff := computePipelineDiff(&base, &head)
	response.OK(c, diff)
}

// POST /pipelines/:id/versions/:ver/restore
func (h *PipelineVersionHandler) Restore(c *gin.Context) {
	var ver model.PipelineVersion
	if err := database.DB.Where("pipeline_id = ? AND version = ?", c.Param("id"), c.Param("ver")).
		First(&ver).Error; err != nil {
		response.NotFound(c, "Version not found")
		return
	}

	uid, uname := "", ""
	if u, ok := c.Get("userID"); ok {
		uid = u.(string)
	}
	if u, ok := c.Get("username"); ok {
		uname = u.(string)
	}

	result := database.DB.Model(&model.Pipeline{}).Where("id = ?", c.Param("id")).
		Updates(map[string]any{
			"stage_config_json": ver.StageConfigJSON,
			"dag_config_json":   ver.DAGConfigJSON,
			"params":            ver.Params,
			"jenkins_bindings":  ver.JenkinsBindings,
			"updated_by":        uid,
		})
	if result.Error != nil {
		response.InternalError(c, "Failed to restore pipeline version")
		return
	}

	var p model.Pipeline
	database.DB.First(&p, "id = ?", c.Param("id"))
	snapshotPipelineVersion(&p, uid, uname, "Restored from v"+c.Param("ver"))

	WriteAuditLogFromCtx(c, "restore", "pipeline_version", c.Param("id"), ver.Name+" v"+c.Param("ver"), nil)
	response.OK(c, gin.H{"message": "Restored to v" + c.Param("ver")})
}

type DiffSection struct {
	Field   string     `json:"field"`
	Label   string     `json:"label"`
	BaseVal string     `json:"baseVal"`
	HeadVal string     `json:"headVal"`
	Changed bool       `json:"changed"`
	Lines   []DiffLine `json:"lines,omitempty"`
}

type DiffLine struct {
	Type    string `json:"type"`
	Content string `json:"content"`
	LineNo  int    `json:"lineNo"`
}

type PipelineDiff struct {
	BaseVersion int           `json:"baseVersion"`
	HeadVersion int           `json:"headVersion"`
	HasChanges  bool          `json:"hasChanges"`
	Sections    []DiffSection `json:"sections"`
}

func computePipelineDiff(base, head *model.PipelineVersion) *PipelineDiff {
	diff := &PipelineDiff{
		BaseVersion: base.Version,
		HeadVersion: head.Version,
	}

	fields := []struct {
		key    string
		label  string
		bVal   string
		hVal   string
		isJSON bool
	}{
		{"name", "Pipeline name", base.Name, head.Name, false},
		{"params", "Parameters", base.Params, head.Params, true},
		{"jenkinsBindings", "Jenkins bindings", base.JenkinsBindings, head.JenkinsBindings, true},
		{"stageConfigJson", "Stage config", base.StageConfigJSON, head.StageConfigJSON, true},
		{"dagConfigJson", "DAG config", base.DAGConfigJSON, head.DAGConfigJSON, true},
	}

	for _, f := range fields {
		sec := DiffSection{
			Field:   f.key,
			Label:   f.label,
			BaseVal: f.bVal,
			HeadVal: f.hVal,
		}
		if f.bVal != f.hVal {
			sec.Changed = true
			diff.HasChanges = true
			if f.isJSON {
				sec.Lines = lineDiff(prettyJSON(f.bVal), prettyJSON(f.hVal))
			}
		}
		diff.Sections = append(diff.Sections, sec)
	}

	return diff
}

func prettyJSON(s string) string {
	if s == "" {
		return ""
	}
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return s
	}
	b, _ := json.MarshalIndent(v, "", "  ")
	return string(b)
}

func lineDiff(base, head string) []DiffLine {
	baseLines := strings.Split(base, "\n")
	headLines := strings.Split(head, "\n")

	m, n := len(baseLines), len(headLines)
	dp := make([][]int, m+1)
	for i := range dp {
		dp[i] = make([]int, n+1)
	}
	for i := 1; i <= m; i++ {
		for j := 1; j <= n; j++ {
			if baseLines[i-1] == headLines[j-1] {
				dp[i][j] = dp[i-1][j-1] + 1
			} else if dp[i-1][j] > dp[i][j-1] {
				dp[i][j] = dp[i-1][j]
			} else {
				dp[i][j] = dp[i][j-1]
			}
		}
	}

	var result []DiffLine
	i, j := m, n
	var ops []DiffLine
	for i > 0 || j > 0 {
		if i > 0 && j > 0 && baseLines[i-1] == headLines[j-1] {
			ops = append(ops, DiffLine{Type: "equal", Content: baseLines[i-1]})
			i--
			j--
		} else if j > 0 && (i == 0 || dp[i][j-1] >= dp[i-1][j]) {
			ops = append(ops, DiffLine{Type: "add", Content: headLines[j-1]})
			j--
		} else {
			ops = append(ops, DiffLine{Type: "remove", Content: baseLines[i-1]})
			i--
		}
	}

	for k := len(ops) - 1; k >= 0; k-- {
		ops[k].LineNo = len(result) + 1
		result = append(result, ops[k])
	}

	_ = reflect.TypeOf(result)
	return result
}
