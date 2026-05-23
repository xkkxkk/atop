package handler

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/response"
)

type TestSetHandler struct{}

type testSetReq struct {
	Name           string   `json:"name"`
	Project        string   `json:"project"`
	Environment    string   `json:"environment"`
	Product        string   `json:"product"`
	Silicon        string   `json:"silicon"`
	OS             string   `json:"os"`
	RunType        string   `json:"runType"`
	Branch         string   `json:"branch"`
	Status         string   `json:"status"`
	AgentLabel     string   `json:"agentLabel"`
	Tags           []string `json:"tags"`
	Unit           string   `json:"unit"`
	Priority       int      `json:"priority"`
	Timeout        int      `json:"timeout"`
	StageNum       int      `json:"stageNum"`
	CpuLock        bool     `json:"cpulock"`
	CpuLockScript  string   `json:"cpulockScript"`
	DependsOn      []string `json:"dependsOn"`
	SkipOnDepFail  bool     `json:"skipOnDepFailure"`
	ConfigJSON     any      `json:"configJson"`
	ArtifactOutput string   `json:"artifactOutput"`
	ArtifactInput  string   `json:"artifactInput"`
	OperatorName   string   `json:"operatorName"`
	OperatorID     string   `json:"operatorId"`
	LeaderName     string   `json:"leaderName"`
	LeaderID       string   `json:"leaderId"`
	Remark         string   `json:"remark"`
}

func (h *TestSetHandler) List(c *gin.Context) {
	page, size, offset := util.PageParams(c.Query("page"), c.Query("pageSize"))
	db := database.DB.Model(&model.TestSet{})
	if v := c.Query("project"); v != "" {
		db = db.Where("project = ?", v)
	}
	if v := c.Query("environment"); v != "" {
		db = db.Where("environment = ?", v)
	}
	if v := c.Query("product"); v != "" {
		db = db.Where("product = ?", v)
	}
	if v := c.Query("silicon"); v != "" {
		db = db.Where("silicon = ?", v)
	}
	if v := c.Query("os"); v != "" {
		db = db.Where("os = ?", v)
	}
	if v := c.Query("runType"); v != "" {
		db = db.Where("run_type = ?", v)
	}
	if v := c.Query("status"); v != "" {
		db = db.Where("status = ?", v)
	}
	if v := c.Query("keyword"); v != "" {
		db = db.Where("name LIKE ?", "%"+v+"%")
	}

	var total int64
	db.Count(&total)
	var items []model.TestSet
	db.Order("updated_at DESC").Limit(size).Offset(offset).Find(&items)

	type itemResp struct {
		model.TestSet
		Tags          []string `json:"tags"`
		ConfigJSON    any      `json:"configJson"`
		CreatedByName string   `json:"createdByName,omitempty"`
		UpdatedByName string   `json:"updatedByName,omitempty"`
	}

	var userIDs []string
	for _, ts := range items {
		userIDs = append(userIDs, ts.CreatedBy, ts.UpdatedBy)
	}
	nameMap := ResolveUserNames(userIDs)

	var result []itemResp
	for _, ts := range items {
		tags := util.FromJSONDefault[[]string](ts.Tags, []string{})
		if tags == nil {
			tags = []string{}
		}
		var cfg any
		json.Unmarshal([]byte(ts.ConfigJSON), &cfg)
		result = append(result, itemResp{
			TestSet:       ts,
			Tags:          tags,
			ConfigJSON:    cfg,
			CreatedByName: nameMap[ts.CreatedBy],
			UpdatedByName: nameMap[ts.UpdatedBy],
		})
	}
	if result == nil {
		result = []itemResp{}
	}
	response.Page(c, result, total, page, size)
}

func (h *TestSetHandler) Get(c *gin.Context) {
	var ts model.TestSet
	if err := database.DB.First(&ts, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Test set not found")
		return
	}
	response.OK(c, h.toResponse(&ts))
}

func (h *TestSetHandler) Create(c *gin.Context) {
	var req testSetReq
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}
	if req.Name == "" || req.Project == "" || req.AgentLabel == "" {
		response.BadRequest(c, "MISSING_FIELDS", "name, project, and agentLabel are required")
		return
	}

	var dupCount int64
	database.DB.Model(&model.TestSet{}).Where(
		"name = ? AND project = ? AND environment = ? AND product = ? AND os = ? AND run_type = ?",
		req.Name, req.Project, req.Environment, req.Product, req.OS, req.RunType,
	).Count(&dupCount)
	if dupCount > 0 {
		response.Unprocessable(
			c,
			"DUPLICATE_TESTSET",
			fmt.Sprintf(
				"Test set %q already exists for %s/%s/%s/%s/%s",
				req.Name,
				req.Project,
				req.Environment,
				req.Product,
				req.OS,
				req.RunType,
			),
		)
		return
	}

	configBytes, _ := json.Marshal(req.ConfigJSON)
	if req.Status == "" {
		req.Status = "enabled"
	}
	if req.StageNum == 0 {
		req.StageNum = 1
	}

	userID := middleware.GetUserID(c)
	ts := model.TestSet{
		Name:           req.Name,
		Project:        req.Project,
		Environment:    req.Environment,
		Product:        req.Product,
		Silicon:        req.Silicon,
		OS:             req.OS,
		RunType:        req.RunType,
		Branch:         req.Branch,
		Status:         req.Status,
		AgentLabel:     req.AgentLabel,
		Tags:           util.ToJSON(req.Tags),
		Unit:           req.Unit,
		Priority:       req.Priority,
		Timeout:        req.Timeout,
		StageNum:       req.StageNum,
		CpuLock:        req.CpuLock,
		CpuLockScript:  req.CpuLockScript,
		DependsOn:      util.ToJSON(req.DependsOn),
		SkipOnDepFail:  req.SkipOnDepFail,
		ConfigJSON:     string(configBytes),
		ArtifactOutput: req.ArtifactOutput,
		ArtifactInput:  req.ArtifactInput,
		OperatorName:   req.OperatorName,
		OperatorID:     req.OperatorID,
		LeaderName:     req.LeaderName,
		LeaderID:       req.LeaderID,
		Remark:         req.Remark,
		CreatedBy:      userID,
		UpdatedBy:      userID,
	}
	if err := database.DB.Create(&ts).Error; err != nil {
		response.InternalError(c, "Failed to create test set")
		return
	}

	WriteAuditLogFromCtx(c, "create", "test_set", ts.ID, ts.Name, nil)
	response.Created(c, h.toResponse(&ts))
}

func (h *TestSetHandler) Update(c *gin.Context) {
	var ts model.TestSet
	if err := database.DB.First(&ts, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Test set not found")
		return
	}

	var req testSetReq
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	configBytes, _ := json.Marshal(req.ConfigJSON)
	if err := database.DB.Model(&ts).Updates(map[string]any{
		"name":             req.Name,
		"project":          req.Project,
		"environment":      req.Environment,
		"product":          req.Product,
		"silicon":          req.Silicon,
		"os":               req.OS,
		"run_type":         req.RunType,
		"branch":           req.Branch,
		"status":           req.Status,
		"agent_label":      req.AgentLabel,
		"tags":             util.ToJSON(req.Tags),
		"unit":             req.Unit,
		"priority":         req.Priority,
		"timeout":          req.Timeout,
		"stage_num":        req.StageNum,
		"cpu_lock":         req.CpuLock,
		"cpu_lock_script":  req.CpuLockScript,
		"depends_on":       util.ToJSON(req.DependsOn),
		"skip_on_dep_fail": req.SkipOnDepFail,
		"config_json":      string(configBytes),
		"artifact_output":  req.ArtifactOutput,
		"artifact_input":   req.ArtifactInput,
		"operator_name":    req.OperatorName,
		"operator_id":      req.OperatorID,
		"leader_name":      req.LeaderName,
		"leader_id":        req.LeaderID,
		"remark":           req.Remark,
		"updated_by":       middleware.GetUserID(c),
	}).Error; err != nil {
		response.InternalError(c, "Failed to update test set")
		return
	}

	database.DB.First(&ts, "id = ?", c.Param("id"))
	WriteAuditLogFromCtx(c, "update", "test_set", ts.ID, ts.Name, nil)
	response.OK(c, h.toResponse(&ts))
}

// Clone copies a test set with a new name. Cloned set starts as disabled.
func (h *TestSetHandler) Clone(c *gin.Context) {
	var src model.TestSet
	if err := database.DB.First(&src, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Test set not found")
		return
	}

	var body struct {
		Name string `json:"name"`
	}
	c.ShouldBindJSON(&body)
	newName := body.Name
	if newName == "" {
		newName = src.Name + "_copy"
	}

	var count int64
	base := newName
	for i := 1; i <= 99; i++ {
		database.DB.Model(&model.TestSet{}).
			Where("name = ? AND project = ?", newName, src.Project).
			Count(&count)
		if count == 0 {
			break
		}
		newName = fmt.Sprintf("%s_%d", base, i)
	}

	userID := middleware.GetUserID(c)
	clone := model.TestSet{
		Name:           newName,
		Project:        src.Project,
		Environment:    src.Environment,
		Product:        src.Product,
		Silicon:        src.Silicon,
		OS:             src.OS,
		RunType:        src.RunType,
		Branch:         src.Branch,
		Status:         "disabled",
		AgentLabel:     src.AgentLabel,
		Tags:           src.Tags,
		Unit:           src.Unit,
		Priority:       src.Priority,
		StageNum:       src.StageNum,
		CpuLock:        src.CpuLock,
		CpuLockScript:  src.CpuLockScript,
		DependsOn:      src.DependsOn,
		SkipOnDepFail:  src.SkipOnDepFail,
		ConfigJSON:     src.ConfigJSON,
		ArtifactOutput: src.ArtifactOutput,
		ArtifactInput:  src.ArtifactInput,
		OperatorName:   src.OperatorName,
		OperatorID:     src.OperatorID,
		LeaderName:     src.LeaderName,
		LeaderID:       src.LeaderID,
		Remark:         src.Remark,
		CreatedBy:      userID,
		UpdatedBy:      userID,
	}
	if err := database.DB.Create(&clone).Error; err != nil {
		response.InternalError(c, "Failed to clone test set")
		return
	}

	WriteAuditLogFromCtx(c, "create", "test_set", clone.ID, clone.Name, map[string]any{
		"sourceId":   src.ID,
		"sourceName": src.Name,
	})
	response.Created(c, h.toResponse(&clone))
}

func (h *TestSetHandler) UpdateStatus(c *gin.Context) {
	var body struct {
		Status string `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || (body.Status != "enabled" && body.Status != "disabled") {
		response.BadRequest(c, "INVALID_STATUS", "status must be enabled or disabled")
		return
	}

	var ts model.TestSet
	if err := database.DB.First(&ts, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Test set not found")
		return
	}
	database.DB.Model(&ts).Update("status", body.Status)

	action := "enable"
	if body.Status == "disabled" {
		action = "disable"
	}
	WriteAuditLogFromCtx(c, action, "test_set", ts.ID, ts.Name, map[string]any{"status": body.Status})
	response.OK(c, gin.H{"status": body.Status})
}

func (h *TestSetHandler) Delete(c *gin.Context) {
	var ts model.TestSet
	if err := database.DB.First(&ts, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Test set not found")
		return
	}
	database.DB.Delete(&ts)
	WriteAuditLogFromCtx(c, "delete", "test_set", ts.ID, ts.Name, map[string]any{
		"name":    ts.Name,
		"project": ts.Project,
	})
	response.OK(c, gin.H{"ok": true})
}

func (h *TestSetHandler) PreviewJSON(c *gin.Context) {
	var ts model.TestSet
	if err := database.DB.First(&ts, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Test set not found")
		return
	}

	var configObj any
	json.Unmarshal([]byte(ts.ConfigJSON), &configObj)
	var vars []model.GlobalVar
	database.DB.Where("scope = 'system' OR project_id = ?", ts.Project).Find(&vars)
	envMap := make(map[string]string)
	for _, v := range vars {
		envMap[v.Key] = v.Value
	}
	response.OK(c, gin.H{
		"task_id":              "preview-task-id",
		"platform_webhook_url": "http://atop.internal:8080/api/webhook/task/...",
		"agent_label":          ts.AgentLabel,
		"timeout_minutes":      120,
		"config":               configObj,
		"global_vars":          envMap,
	})
}

// MatchPipelines returns pipelines whose coordinates match the given test sets.
func (h *TestSetHandler) MatchPipelines(c *gin.Context) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.IDs) == 0 {
		response.BadRequest(c, "INVALID_PARAMS", "ids is required")
		return
	}

	var testSets []model.TestSet
	database.DB.Where("id IN ?", body.IDs).Find(&testSets)
	if len(testSets) == 0 {
		response.NotFound(c, "Test sets not found")
		return
	}

	projectSet := map[string]bool{}
	for _, ts := range testSets {
		projectSet[ts.Project] = true
	}
	if len(projectSet) > 1 {
		projects := make([]string, 0, len(projectSet))
		for p := range projectSet {
			projects = append(projects, p)
		}
		response.Unprocessable(c, "CROSS_PROJECT", "Selected test sets belong to multiple projects: "+strings.Join(projects, ", "))
		return
	}

	ref := testSets[0]
	db := database.DB.Model(&model.Pipeline{}).
		Where("project = ?", ref.Project).
		Where("pipeline_type = 'test' OR pipeline_type = '' OR pipeline_type IS NULL")
	if ref.Environment != "" {
		db = db.Where("environment = ? OR environment = ''", ref.Environment)
	}
	if ref.OS != "" {
		db = db.Where("os = ? OR os = ''", ref.OS)
	}

	var pipelines []model.Pipeline
	db.Order("updated_at DESC").Find(&pipelines)

	items := make([]gin.H, 0, len(pipelines))
	for _, p := range pipelines {
		items = append(items, gin.H{
			"id":          p.ID,
			"name":        p.Name,
			"project":     p.Project,
			"environment": p.Environment,
			"product":     p.Product,
			"os":          p.OS,
			"runType":     p.RunType,
			"triggerType": p.TriggerType,
		})
	}

	response.OK(c, gin.H{"items": items, "total": len(items)})
}

func (h *TestSetHandler) BatchUpdateStatus(c *gin.Context) {
	var body struct {
		IDs    []string `json:"ids"`
		Status string   `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.IDs) == 0 {
		response.BadRequest(c, "INVALID_PARAMS", "ids is required")
		return
	}
	if body.Status != "enabled" && body.Status != "disabled" {
		response.BadRequest(c, "INVALID_STATUS", "status must be enabled or disabled")
		return
	}

	result := database.DB.Model(&model.TestSet{}).
		Where("id IN ? AND status != ?", body.IDs, body.Status).
		Update("status", body.Status)
	skipped := int64(len(body.IDs)) - result.RowsAffected
	response.OK(c, gin.H{
		"updated": result.RowsAffected,
		"skipped": skipped,
		"total":   len(body.IDs),
	})
}

func (h *TestSetHandler) toResponse(ts *model.TestSet) gin.H {
	var config any
	json.Unmarshal([]byte(ts.ConfigJSON), &config)
	tags := util.FromJSONDefault[[]string](ts.Tags, []string{})
	if tags == nil {
		tags = []string{}
	}
	dependsOn := util.FromJSONDefault[[]string](ts.DependsOn, []string{})
	if dependsOn == nil {
		dependsOn = []string{}
	}
	return gin.H{
		"id":               ts.ID,
		"name":             ts.Name,
		"project":          ts.Project,
		"environment":      ts.Environment,
		"product":          ts.Product,
		"silicon":          ts.Silicon,
		"os":               ts.OS,
		"runType":          ts.RunType,
		"branch":           ts.Branch,
		"status":           ts.Status,
		"agentLabel":       ts.AgentLabel,
		"tags":             tags,
		"unit":             ts.Unit,
		"priority":         ts.Priority,
		"stageNum":         ts.StageNum,
		"cpulock":          ts.CpuLock,
		"cpulockScript":    ts.CpuLockScript,
		"dependsOn":        dependsOn,
		"skipOnDepFailure": ts.SkipOnDepFail,
		"configJson":       config,
		"artifactOutput":   ts.ArtifactOutput,
		"artifactInput":    ts.ArtifactInput,
		"operatorName":     ts.OperatorName,
		"operatorId":       ts.OperatorID,
		"leaderName":       ts.LeaderName,
		"leaderId":         ts.LeaderID,
		"remark":           ts.Remark,
		"createdBy":        ts.CreatedBy,
		"updatedBy":        ts.UpdatedBy,
		"createdAt":        ts.CreatedAt,
		"updatedAt":        ts.UpdatedAt,
	}
}

// GetTags returns all distinct tags used by test sets.
func (h *TestSetHandler) GetTags(c *gin.Context) {
	var testSets []model.TestSet
	db := database.DB.Select("tags")
	if proj := c.Query("project"); proj != "" {
		db = db.Where("project = ?", proj)
	}
	db.Where("tags IS NOT NULL AND tags != '' AND tags != '[]'").Find(&testSets)

	seen := map[string]bool{}
	var tags []string
	for _, ts := range testSets {
		var list []string
		if err := json.Unmarshal([]byte(ts.Tags), &list); err == nil {
			for _, t := range list {
				if t != "" && !seen[t] {
					seen[t] = true
					tags = append(tags, t)
				}
			}
		}
	}
	if tags == nil {
		tags = []string{}
	}
	response.OK(c, tags)
}
