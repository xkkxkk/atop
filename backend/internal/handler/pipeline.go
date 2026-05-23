package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/scheduler"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/response"
)

type PipelineHandler struct{}

type pipelineReq struct {
	Name            string `json:"name"`
	Project         string `json:"project"`
	Environment     string `json:"environment"`
	Product         string `json:"product"`
	OS              string `json:"os"`
	RunType         string `json:"runType"`
	TriggerType     string `json:"triggerType"`
	CronExpr        string `json:"cronExpr"`
	JenkinsBindings any    `json:"jenkinsBindings"`
	Params          any    `json:"params"`
	StageConfigJSON any    `json:"stageConfigJson"`
	DAGConfigJSON   any    `json:"dagConfigJson"`
}

type triggerReq struct {
	FilterType   string            `json:"filterType"` // all|tags|specific
	Projects     []string          `json:"projects"`
	Tags         []string          `json:"tags"`
	TestSetIDs   []string          `json:"testSetIds"`
	RuntimeParams map[string]string `json:"runtimeParams"`
	Remark       string            `json:"remark"`
}

type externalTriggerReq struct {
	RuntimeParams map[string]string `json:"runtimeParams"`
	Remark        string            `json:"remark"`
}

type jenkinsJobBindingReq struct {
	JenkinsInstanceID string `json:"jenkinsInstanceId"`
	JobName           string `json:"jobName"`
	MatchProject      string `json:"matchProject"`
	MatchOs           string `json:"matchOs"`
}

func hasMatchingJenkinsBinding(bindings []jenkinsJobBindingReq, project, os string) bool {
	project = strings.TrimSpace(project)
	os = strings.TrimSpace(os)
	for _, b := range bindings {
		if strings.TrimSpace(b.JenkinsInstanceID) == "" && strings.TrimSpace(b.JobName) == "" {
			continue
		}
		matchProject := strings.TrimSpace(b.MatchProject)
		matchOs := strings.TrimSpace(b.MatchOs)
		if matchProject == project && matchOs == os {
			return true
		}
		if matchProject == project && matchOs == "" {
			return true
		}
		if matchProject == "" && matchOs == os && os != "" {
			return true
		}
		if matchProject == "" && matchOs == "" {
			return true
		}
	}
	return false
}

func validateJenkinsJobBindings(bindingsJSON string, required bool, project, os string) error {
	if bindingsJSON == "" || bindingsJSON == "null" {
		if required {
            return fmt.Errorf("At least one Jenkins job binding is required")
		}
		return nil
	}
	var bindings []jenkinsJobBindingReq
	if err := json.Unmarshal([]byte(bindingsJSON), &bindings); err != nil {
        return fmt.Errorf("Invalid Jenkins job binding format")
	}
	validCount := 0
	for i, b := range bindings {
		instanceID := strings.TrimSpace(b.JenkinsInstanceID)
		jobName := strings.TrimSpace(b.JobName)
		if instanceID == "" && jobName == "" {
			continue
		}
		validCount++
		if instanceID == "" || jobName == "" {
            return fmt.Errorf("Binding #%d is missing a Jenkins instance or job name", i+1)
		}
		var inst model.JenkinsInstance
		if err := database.DB.First(&inst, "id = ?", instanceID).Error; err != nil {
            return fmt.Errorf("Binding #%d references a Jenkins instance that does not exist", i+1)
		}
		jc, err := scheduler.NewJenkinsClient(&inst)
		if err != nil {
            return fmt.Errorf("Failed to decrypt token for Jenkins instance %q: %v", inst.Name, err)
		}
		if err := jc.JobExists(jobName); err != nil {
            return jenkinsJobCheckError(fmt.Sprintf("Jenkins job binding #%d", i+1), inst.Name, err)
		}
	}
	if required && validCount == 0 {
        return fmt.Errorf("At least one Jenkins job binding is required")
	}
	if required && !hasMatchingJenkinsBinding(bindings, project, os) {
        return fmt.Errorf("No Jenkins job binding matches the current project/OS; add a default job or a matching project/OS binding")
	}
	return nil
}

func validatePipelineJenkinsInstance(bindingsJSON string, required bool) error {
	if bindingsJSON == "" || bindingsJSON == "null" {
		if required {
            return fmt.Errorf("Please select a Jenkins instance in the pipeline settings")
		}
		return nil
	}
	var bindings []jenkinsJobBindingReq
	if err := json.Unmarshal([]byte(bindingsJSON), &bindings); err != nil {
        return fmt.Errorf("Invalid Jenkins instance binding format")
	}
	for i, b := range bindings {
		instanceID := strings.TrimSpace(b.JenkinsInstanceID)
		if instanceID == "" {
			continue
		}
		var inst model.JenkinsInstance
		if err := database.DB.First(&inst, "id = ?", instanceID).Error; err != nil {
            return fmt.Errorf("Binding #%d references a Jenkins instance that does not exist", i+1)
		}
		if _, err := scheduler.NewJenkinsClient(&inst); err != nil {
            return fmt.Errorf("Failed to decrypt token for Jenkins instance %q: %v", inst.Name, err)
		}
		return nil
	}
	if required {
        return fmt.Errorf("Please select a Jenkins instance in the pipeline settings")
	}
	return nil
}

func dagConfigString(config map[string]any, key string) string {
	if config == nil {
		return ""
	}
	value, ok := config[key]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func jenkinsJobCheckError(scope, instanceName string, err error) error {
	msg := strings.TrimSpace(err.Error())
	if msg == "" {
        msg = "unknown error"
	}
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "dial tcp") ||
		strings.Contains(lower, "no such host") ||
		strings.Contains(lower, "connection refused") ||
		strings.Contains(lower, "i/o timeout") ||
		strings.Contains(lower, "timeout") ||
		strings.Contains(lower, "context deadline exceeded") ||
		strings.Contains(lower, "tls") ||
		strings.Contains(lower, "certificate") {
        return fmt.Errorf("%s validation failed: Jenkins instance %q is unreachable. Please check the URL, network path, firewall, proxy, certificate, and token. Original error: %s", scope, instanceName, msg)
	}
    return fmt.Errorf("%s validation failed: Jenkins instance %q returned an error: %s", scope, instanceName, msg)
}

func validateDAGJenkinsJobs(dagCfg model.DAGConfig, bindingsJSON string) error {
	if len(dagCfg.Nodes) == 0 {
		return nil
	}
	var bindings []jenkinsJobBindingReq
	if err := json.Unmarshal([]byte(bindingsJSON), &bindings); err != nil || len(bindings) == 0 {
        return fmt.Errorf("Please select a Jenkins instance in the pipeline settings")
	}
	instanceID := strings.TrimSpace(bindings[0].JenkinsInstanceID)
	if instanceID == "" {
        return fmt.Errorf("Please select a Jenkins instance in the pipeline settings")
	}
	var inst model.JenkinsInstance
	if err := database.DB.First(&inst, "id = ?", instanceID).Error; err != nil {
        return fmt.Errorf("Jenkins instance not found")
	}
	jc, err := scheduler.NewJenkinsClient(&inst)
	if err != nil {
        return fmt.Errorf("Failed to decrypt token for Jenkins instance %q: %v", inst.Name, err)
	}
	for _, node := range dagCfg.Nodes {
		if node.Type != model.DAGNodeJenkins {
			continue
		}
		jobName := dagConfigString(node.Config, "jobName")
		if jobName == "" {
            return fmt.Errorf("Jenkins component %q is missing a job name", node.Label)
		}
		if err := jc.JobExists(jobName); err != nil {
            return jenkinsJobCheckError(fmt.Sprintf("Jenkins component %q", node.Label), inst.Name, err)
		}
	}
	return nil
}

func validateSavedDAGJenkinsJobs(p *model.Pipeline) error {
	if strings.TrimSpace(p.DAGConfigJSON) == "" {
		return nil
	}
	var dagCfg model.DAGConfig
	if err := json.Unmarshal([]byte(p.DAGConfigJSON), &dagCfg); err != nil || len(dagCfg.Nodes) == 0 {
		return nil
	}
	return validateDAGJenkinsJobs(dagCfg, p.JenkinsBindings)
}

func validateSavedDAGConfig(p *model.Pipeline) error {
	if strings.TrimSpace(p.DAGConfigJSON) == "" {
		return nil
	}
	var dagCfg model.DAGConfig
	if err := json.Unmarshal([]byte(p.DAGConfigJSON), &dagCfg); err != nil || len(dagCfg.Nodes) == 0 {
		return nil
	}
	if HasDAGCycle(dagCfg) {
        return fmt.Errorf("DAG contains a cycle; please review the node connections")
	}
	if _, err := ValidateDAGTopology(dagCfg); err != nil {
		return err
	}
	return nil
}

func countJenkinsJobBindings(bindingsJSON string) int {
	if bindingsJSON == "" || bindingsJSON == "null" {
		return 0
	}
	var bindings []jenkinsJobBindingReq
	if err := json.Unmarshal([]byte(bindingsJSON), &bindings); err != nil {
		return 0
	}
	count := 0
	for _, b := range bindings {
		if strings.TrimSpace(b.JenkinsInstanceID) != "" || strings.TrimSpace(b.JobName) != "" {
			count++
		}
	}
	return count
}

// Pipeline access control

type accessEntry struct {
	Type   string `json:"type"`   // "user" or "role" (default "user" for backward compat)
	UserID string `json:"userId,omitempty"`
	RoleID string `json:"roleId,omitempty"` // role name (e.g. "member", "tester")
	Role   string `json:"role"`             // pipeline role: operator | viewer
}

// getPipelineRole returns the user's role: "owner", "operator", "viewer", or "" (no access).
// Owner = creator. Empty ACL = only creator can access.
// Checks both direct user entries and role-based entries.
func getPipelineRole(pipeline *model.Pipeline, userID string) string {
	if pipeline.CreatedBy == userID {
		return "owner"
	}
	if pipeline.AccessControlJSON == "" {
	// No ACL is set, so only the creator has access.
		return ""
	}
	var entries []accessEntry
	json.Unmarshal([]byte(pipeline.AccessControlJSON), &entries)

	// Get user's system roles for role-based matching
	var userRoleBindings []model.UserRoleBinding
	database.DB.Where("user_id = ?", userID).Find(&userRoleBindings)
	userRoles := make(map[string]bool)
	for _, b := range userRoleBindings {
		userRoles[b.RoleName] = true
	}
	// Fallback to legacy role field
	if len(userRoles) == 0 {
		var user model.User
		if err := database.DB.Select("role").First(&user, "id = ?", userID).Error; err == nil {
			if string(user.Role) != "" {
				userRoles[string(user.Role)] = true
			}
		}
	}

	bestRole := ""
	for _, e := range entries {
		entryType := e.Type
		if entryType == "" {
			entryType = "user" // backward compat
		}
		matched := false
		if entryType == "user" && e.UserID == userID {
			matched = true
		} else if entryType == "role" && userRoles[e.RoleID] {
			matched = true
		}
		if matched {
			// Use the highest privilege: owner > operator > viewer
			if e.Role == "operator" && bestRole != "operator" {
				bestRole = "operator"
			} else if e.Role == "viewer" && bestRole == "" {
				bestRole = "viewer"
			}
		}
	}
	return bestRole
}

// canEditPipeline returns true if user can edit (owner or admin)
func canEditPipeline(pipeline *model.Pipeline, userID string, isAdmin bool) bool {
	if isAdmin {
		return true
	}
	return getPipelineRole(pipeline, userID) == "owner"
}

// canTriggerPipeline returns true if user can trigger runs
func canTriggerPipeline(pipeline *model.Pipeline, userID string, isAdmin bool) bool {
	if isAdmin {
		return true
	}
	role := getPipelineRole(pipeline, userID)
	return role == "owner" || role == "operator"
}

func isAdminUser(c *gin.Context) bool {
	return middleware.IsSuperAdmin(c)
}

func isProjectManagerFor(c *gin.Context, project string) bool {
	role := middleware.GetUserRole(c)
	if role != "project_manager" {
		return false
	}
	// Check if user manages this project
	projects, _ := c.Get("projects")
	if projList, ok := projects.([]string); ok {
		for _, p := range projList {
			if p == project {
				return true
			}
		}
	}
	return false
}

func (h *PipelineHandler) List(c *gin.Context) {
	page, size, offset := util.PageParams(c.Query("page"), c.Query("pageSize"))
	currentUserID := middleware.GetUserID(c)
	isAdmin := isAdminUser(c)

	db := database.DB.Model(&model.Pipeline{}).Order("updated_at DESC")
	if v := strings.TrimSpace(c.Query("keyword")); v != "" {
		db = db.Where("name LIKE ?", "%"+v+"%")
	}
	if v := strings.TrimSpace(c.Query("project")); v != "" { db = db.Where("project = ?", v) }
	if v := strings.TrimSpace(c.Query("environment")); v != "" { db = db.Where("environment = ?", v) }
	if v := strings.TrimSpace(c.Query("product")); v != "" { db = db.Where("product = ?", v) }
	if v := strings.TrimSpace(c.Query("os")); v != "" { db = db.Where("os = ?", v) }
	if v := strings.TrimSpace(c.Query("runType")); v != "" { db = db.Where("run_type = ?", v) }
	if v := strings.TrimSpace(c.Query("triggerType")); v != "" { db = db.Where("trigger_type = ?", v) }
	if v := strings.TrimSpace(c.Query("lastRunStatus")); v != "" {
		db = db.Where(`(
			SELECT pr.status FROM pipeline_runs pr
			WHERE pr.pipeline_id = pipelines.id
			ORDER BY COALESCE(pr.started_at, pr.created_at) DESC
			LIMIT 1
		) = ?`, v)
	}

	// Access control filter
	if !isAdmin {
		role := middleware.GetUserRole(c)
		if role == "project_manager" {
			// Project managers see: own + their projects + ACL
			projects, _ := c.Get("projects")
			projList, _ := projects.([]string)
			if len(projList) > 0 {
				db = db.Where(
					"created_by = ? OR project IN ? OR access_control_json LIKE ?",
					currentUserID, projList, "%"+currentUserID+"%",
				)
			} else {
				db = db.Where(
					"created_by = ? OR access_control_json LIKE ?",
					currentUserID, "%"+currentUserID+"%",
				)
			}
		} else {
			// Regular users: own + ACL
			db = db.Where(
				"created_by = ? OR access_control_json LIKE ?",
				currentUserID, "%"+currentUserID+"%",
			)
		}
	}

	var total int64
	db.Count(&total)
	var items []model.Pipeline
	db.Limit(size).Offset(offset).Find(&items)

	// Enrich with last run info
	type pipelineResp struct {
		model.Pipeline
		JenkinsBindings any       `json:"jenkinsBindings"`
		Params          any       `json:"params"`
		DAGConfigJSON   string    `json:"dagConfigJson"`
		LastRunStatus   string    `json:"lastRunStatus,omitempty"`
		LastRunAt       *time.Time `json:"lastRunAt,omitempty"`
		CurrentRole     string `json:"currentRole,omitempty"`
		CanEdit         bool   `json:"canEdit"`
		CanTrigger      bool   `json:"canTrigger"`
		CreatedByName   string `json:"createdByName,omitempty"`
		UpdatedByName   string `json:"updatedByName,omitempty"`
	}

	// Batch resolve creator/updater names, including deleted users.
	var userIDs []string
	for _, p := range items {
		if p.CreatedBy != "" {
			userIDs = append(userIDs, p.CreatedBy)
		}
		if p.UpdatedBy != "" {
			userIDs = append(userIDs, p.UpdatedBy)
		}
	}
	nameMap := ResolveUserNames(userIDs)

	var result []pipelineResp
	for _, p := range items {
		var bindings, params any
		json.Unmarshal([]byte(p.JenkinsBindings), &bindings)
		json.Unmarshal([]byte(p.Params), &params)

		// Last run
		var lastRun model.PipelineRun
		var lastStatus string
		var lastAt *time.Time
		if err := database.DB.Where("pipeline_id = ?", p.ID).Order("created_at DESC").First(&lastRun).Error; err == nil {
			lastStatus = lastRun.Status
			lastAt = lastRun.StartedAt
		}

		result = append(result, pipelineResp{
			Pipeline:        p,
			JenkinsBindings: bindings,
			Params:          params,
			DAGConfigJSON:   p.DAGConfigJSON,
			LastRunStatus:   lastStatus,
			LastRunAt:       lastAt,
			CurrentRole:     getPipelineRole(&p, currentUserID),
			CanEdit:         canEditPipeline(&p, currentUserID, isAdmin),
			CanTrigger:      canTriggerPipeline(&p, currentUserID, isAdmin),
			CreatedByName:   nameMap[p.CreatedBy],
			UpdatedByName:   nameMap[p.UpdatedBy],
		})
	}
	if result == nil { result = []pipelineResp{} }
	response.Page(c, result, total, page, size)
}

func (h *PipelineHandler) Get(c *gin.Context) {
	id := c.Param("id")
	var p model.Pipeline
	if err := database.DB.First(&p, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Pipeline not found"); return
	}
	var bindings, params any
	json.Unmarshal([]byte(p.JenkinsBindings), &bindings)
	json.Unmarshal([]byte(p.Params), &params)

	var tsCount int64
	database.DB.Model(&model.TestSet{}).Where("project = ? AND status = 'enabled'", p.Project).Count(&tsCount)

	currentUserID := middleware.GetUserID(c)
	currentRole := getPipelineRole(&p, currentUserID)

	response.OK(c, gin.H{
		"id": p.ID, "name": p.Name, "project": p.Project,
		"environment": p.Environment, "product": p.Product,
		"os": p.OS, "runType": p.RunType,
		"triggerType": p.TriggerType, "cronExpr": p.CronExpr,
		"jenkinsBindings": bindings, "params": params,
		"dagConfigJson": p.DAGConfigJSON,
		"testSetCount": tsCount,
		"createdBy": p.CreatedBy, "createdAt": p.CreatedAt, "updatedAt": p.UpdatedAt,
		"currentRole":  currentRole,
		"canEdit":      canEditPipeline(&p, currentUserID, isAdminUser(c)),
		"canTrigger":   canTriggerPipeline(&p, currentUserID, isAdminUser(c)),
	})
}

func (h *PipelineHandler) Create(c *gin.Context) {
	var req pipelineReq
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error()); return
	}
	if req.Name == "" || req.Project == "" {
        response.BadRequest(c, "MISSING_FIELDS", "name and project are required"); return
	}

	bindingsJSON, _ := json.Marshal(req.JenkinsBindings)
	paramsJSON, _ := json.Marshal(req.Params)
	stageJSON, _ := json.Marshal(req.StageConfigJSON)
	if err := validatePipelineJenkinsInstance(string(bindingsJSON), true); err != nil {
		response.Unprocessable(c, "JENKINS_JOB_INVALID", err.Error())
		return
	}

	p := model.Pipeline{
		Name: req.Name, Project: req.Project,
		Environment: req.Environment, Product: req.Product,
		OS: req.OS, RunType: req.RunType,
		TriggerType:     req.TriggerType,
		CronExpr:        req.CronExpr,
		JenkinsBindings: string(bindingsJSON),
		Params:          string(paramsJSON),
		StageConfigJSON: string(stageJSON),
		CreatedBy:       middleware.GetUserID(c),
		UpdatedBy:       middleware.GetUserID(c),
	}
	// Validate and save DAG config
	if req.DAGConfigJSON != nil {
		dagJSON, _ := json.Marshal(req.DAGConfigJSON)
		var dagCfg model.DAGConfig
		if err := json.Unmarshal(dagJSON, &dagCfg); err == nil {
			if HasDAGCycle(dagCfg) {
                response.BadRequest(c, "DAG_CYCLE", "DAG contains a cycle; please review the node connections"); return
			}
			if _, err := ValidateDAGTopology(dagCfg); err != nil {
				response.BadRequest(c, "DAG_INVALID", err.Error()); return
			}
			if err := validateDAGJenkinsJobs(dagCfg, string(bindingsJSON)); err != nil {
				response.Unprocessable(c, "JENKINS_JOB_INVALID", err.Error())
				return
			}
			p.DAGConfigJSON = string(dagJSON)
		}
	}
	database.DB.Create(&p)
    snapshotPipelineVersion(&p, middleware.GetUserID(c), middleware.GetUserEmail(c), "Initial create")
    WriteAuditLogFromCtx(c, "create", "pipeline", p.ID, p.Name, nil)
	response.Created(c, gin.H{"id": p.ID, "name": p.Name})
}

func (h *PipelineHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var p model.Pipeline
	if err := database.DB.First(&p, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Pipeline not found"); return
	}
	// Access control check
	if !canEditPipeline(&p, middleware.GetUserID(c), isAdminUser(c)) {
		response.Forbidden(c, "You do not have permission to edit this pipeline")
		return
	}
	var req pipelineReq
	c.ShouldBindJSON(&req)

	bindingsJSON, _ := json.Marshal(req.JenkinsBindings)
	paramsJSON, _ := json.Marshal(req.Params)
	if err := validatePipelineJenkinsInstance(string(bindingsJSON), true); err != nil {
		response.Unprocessable(c, "JENKINS_JOB_INVALID", err.Error())
		return
	}

	database.DB.Model(&p).Updates(map[string]any{
		"name": req.Name, "project": req.Project,
		"environment": req.Environment, "product": req.Product,
		"os": req.OS, "run_type": req.RunType,
		"trigger_type": req.TriggerType, "cron_expr": req.CronExpr,
		"jenkins_bindings": string(bindingsJSON),
		"params":           string(paramsJSON),
		"updated_by":       middleware.GetUserID(c),
	})
	// Update DAG config if provided
	if req.DAGConfigJSON != nil {
		dagJSON, _ := json.Marshal(req.DAGConfigJSON)
		var dagCfg model.DAGConfig
		if err := json.Unmarshal(dagJSON, &dagCfg); err == nil {
			if HasDAGCycle(dagCfg) {
                response.BadRequest(c, "DAG_CYCLE", "DAG contains a cycle; please review the node connections"); return
			}
			if _, err := ValidateDAGTopology(dagCfg); err != nil {
				response.BadRequest(c, "DAG_INVALID", err.Error()); return
			}
			if err := validateDAGJenkinsJobs(dagCfg, string(bindingsJSON)); err != nil {
				response.Unprocessable(c, "JENKINS_JOB_INVALID", err.Error())
				return
			}
			database.DB.Model(&p).Update("dag_config_json", string(dagJSON))
		}
	}
	// Snapshot version after update
	database.DB.First(&p, "id = ?", c.Param("id"))
    snapshotPipelineVersion(&p, middleware.GetUserID(c), middleware.GetUserEmail(c), "Configuration updated")
    WriteAuditLogFromCtx(c, "update", "pipeline", p.ID, p.Name, nil)
	response.OK(c, gin.H{"ok": true})
}

func (h *PipelineHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	var p model.Pipeline
	if err := database.DB.First(&p, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Pipeline not found"); return
	}
	if !canEditPipeline(&p, middleware.GetUserID(c), isAdminUser(c)) {
		response.Forbidden(c, "You do not have permission to delete this pipeline")
		return
	}
	database.DB.Where("id = ?", id).Delete(&model.Pipeline{})
    WriteAuditLogFromCtx(c, "delete", "pipeline", id, p.Name,
		map[string]any{"name": p.Name, "project": p.Project})
	response.OK(c, gin.H{"ok": true})
}

func rejectPipelineRunAwaitingJenkinsBuild(c *gin.Context, pipelineID string) bool {
	if run, ok := scheduler.FindPipelineRunAwaitingJenkinsBuild(database.DB, pipelineID); ok {
		response.Conflict(c, "PIPELINE_TRIGGER_IN_PROGRESS", scheduler.PipelineRunAwaitingBuildMessage(run))
		return true
	}
	return false
}

func pipelineRunIsActive(status string) bool {
	switch status {
	case "pending", "submitting", "queued_in_jenkins", "waiting", "running":
		return true
	default:
		return false
	}
}

func createPipelineRun(p *model.Pipeline, triggerType, triggeredBy string, runtimeParams map[string]string, remark, _ string) (*model.PipelineRun, string, error) {
	if runtimeParams == nil {
		runtimeParams = map[string]string{}
	}

	var testSets []model.TestSet
	database.DB.Model(&model.TestSet{}).
		Where("status = 'enabled' AND project = ?", p.Project).
		Order("priority DESC, created_at ASC").
		Find(&testSets)

	now := time.Now()
	paramsJSON, _ := json.Marshal(runtimeParams)
	run := model.PipelineRun{
		PipelineID:     p.ID,
		PipelineName:   p.Name,
		Status:         "pending",
		TriggerType:    triggerType,
		TriggeredBy:    triggeredBy,
		RuntimeParams:  string(paramsJSON),
		PipelineSnapshotJSON: scheduler.BuildPipelineConfigSnapshot(p),
		Remark:         remark,
		StartedAt:      &now,
		TotalCount:     len(testSets),
		QueuedCount:    len(testSets),
	}

	if strings.TrimSpace(p.DAGConfigJSON) != "" {
		var dagCfg model.DAGConfig
		if err := json.Unmarshal([]byte(p.DAGConfigJSON), &dagCfg); err == nil && len(dagCfg.Nodes) > 0 {
			run.TotalCount = len(dagCfg.Nodes)
			run.QueuedCount = len(dagCfg.Nodes)
			if err := database.DB.Create(&run).Error; err != nil {
				return nil, "", fmt.Errorf("failed to create pipeline run")
			}
			if err := CreateDAGTaskRuns(&run, dagCfg, runtimeParams, ""); err != nil {
				finishedAt := time.Now()
				database.DB.Model(&run).Updates(map[string]any{
					"status":        "failed",
					"finished_at":   finishedAt,
					"duration_ms":   scheduler.CalcDurationMs(run.StartedAt, finishedAt),
					"error_summary": "Failed to create DAG tasks: " + err.Error(),
				})
				go scheduler.SendPipelineNotifications(run.ID, p.ID, "failed")
				return &run, "dag", fmt.Errorf("failed to create DAG tasks: %w", err)
			}
			return &run, "dag", nil
		}
	}

	if err := database.DB.Create(&run).Error; err != nil {
		return nil, "", fmt.Errorf("failed to create pipeline run")
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
	return &run, "flat", nil
}

func pipelineFromSnapshot(snapshot *scheduler.PipelineConfigSnapshot) *model.Pipeline {
	if snapshot == nil {
		return nil
	}
	return &model.Pipeline{
		Base:            model.Base{ID: snapshot.ID},
		Name:            snapshot.Name,
		Project:         snapshot.Project,
		Environment:     snapshot.Environment,
		Product:         snapshot.Product,
		OS:              snapshot.OS,
		RunType:         snapshot.RunType,
		TriggerType:     snapshot.TriggerType,
		CronExpr:        snapshot.CronExpr,
		JenkinsBindings: snapshot.JenkinsBindings,
		Params:          snapshot.Params,
		StageConfigJSON: snapshot.StageConfigJSON,
		DAGConfigJSON:   snapshot.DAGConfigJSON,
	}
}

func createPipelineRunFromSnapshot(snapshot *scheduler.PipelineConfigSnapshot, triggerType, triggeredBy string, runtimeParams map[string]string, remark string) (*model.PipelineRun, string, error) {
	p := pipelineFromSnapshot(snapshot)
	if p == nil || strings.TrimSpace(p.ID) == "" {
	return nil, "", fmt.Errorf("pipeline snapshot is missing pipeline ID")
	}
	if strings.TrimSpace(p.Name) == "" {
		p.Name = p.ID
	}
	if strings.TrimSpace(triggerType) == "" {
		triggerType = p.TriggerType
	}
	if strings.TrimSpace(triggerType) == "" {
		triggerType = "manual"
	}
	if err := validatePipelineRunnable(p); err != nil {
		return nil, "", err
	}
	return createPipelineRun(p, triggerType, triggeredBy, runtimeParams, remark, "")
}

func RegisterPipelineRunCreator() {
	scheduler.SetPipelineRunCreator(createValidatedPipelineRun)
}

func createValidatedPipelineRun(p *model.Pipeline, triggerType, triggeredBy string, runtimeParams map[string]string, remark, _ string) (*model.PipelineRun, string, error) {
	if err := validatePipelineRunnable(p); err != nil {
		return nil, "", err
	}
	return createPipelineRun(p, triggerType, triggeredBy, runtimeParams, remark, "")
}

func validatePipelineRunnable(p *model.Pipeline) error {
	if err := validatePipelineJenkinsInstance(p.JenkinsBindings, true); err != nil {
		return err
	}
	if err := validateSavedDAGConfig(p); err != nil {
		return err
	}
	if err := validateSavedDAGJenkinsJobs(p); err != nil {
		return err
	}
	return nil
}

func (h *PipelineHandler) ValidateRun(c *gin.Context) {
	id := c.Param("id")
	var p model.Pipeline
	if err := database.DB.First(&p, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Pipeline not found"); return
	}
	if !canTriggerPipeline(&p, middleware.GetUserID(c), isAdminUser(c)) {
		response.Forbidden(c, "You do not have permission to trigger this pipeline")
		return
	}
	if rejectPipelineRunAwaitingJenkinsBuild(c, p.ID) {
		return
	}
	if err := validatePipelineRunnable(&p); err != nil {
		response.Unprocessable(c, "JENKINS_JOB_INVALID", err.Error())
		return
	}
	response.OK(c, gin.H{
		"ok":           true,
		"bindingCount": countJenkinsJobBindings(p.JenkinsBindings),
		"checkedAt":    time.Now(),
	})
}

func (h *PipelineHandler) TriggerRun(c *gin.Context) {
	id := c.Param("id")
	var p model.Pipeline
	if err := database.DB.First(&p, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Pipeline not found"); return
	}
	if !canTriggerPipeline(&p, middleware.GetUserID(c), isAdminUser(c)) {
		response.Forbidden(c, "You do not have permission to trigger this pipeline")
		return
	}
	var req triggerReq
	c.ShouldBindJSON(&req)

	if err := validatePipelineRunnable(&p); err != nil {
		response.Unprocessable(c, "JENKINS_JOB_INVALID", err.Error())
		return
	}
	unlockTrigger := scheduler.LockPipelineTrigger(p.ID)
	defer unlockTrigger()
	if rejectPipelineRunAwaitingJenkinsBuild(c, p.ID) {
		return
	}

	run, mode, err := createPipelineRun(&p, p.TriggerType, middleware.GetUserID(c), req.RuntimeParams, req.Remark, "")
	if err != nil {
		response.InternalError(c, err.Error())
		return
	}

    WriteAuditLogFromCtx(c, "trigger_run", "pipeline", p.ID, p.Name,
		map[string]any{"remark": req.Remark, "mode": mode})
	if scheduler.Global != nil {
		go scheduler.Global.DispatchRun(run.ID)
	}

	response.Created(c, gin.H{"runId": run.ID, "totalCount": run.TotalCount, "mode": mode})
}

func (h *PipelineHandler) WebhookTrigger(c *gin.Context) {
	id := c.Param("id")
	var p model.Pipeline
	if err := database.DB.First(&p, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Pipeline not found"); return
	}
	if p.TriggerType != "webhook" {
		response.BadRequest(c, "TRIGGER_TYPE_INVALID", "This pipeline is not configured for webhook triggering")
		return
	}
	if err := validatePipelineRunnable(&p); err != nil {
		response.Unprocessable(c, "JENKINS_JOB_INVALID", err.Error())
		return
	}

	rawBody, _ := io.ReadAll(c.Request.Body)
	if !verifyWebhookHMAC(c, rawBody) {
		response.Unauthorized(c, "Webhook signature verification failed")
		return
	}
	var req externalTriggerReq
	if strings.TrimSpace(string(rawBody)) != "" {
		c.Request.Body = io.NopCloser(strings.NewReader(string(rawBody)))
		if err := c.ShouldBindJSON(&req); err != nil {
			response.BadRequest(c, "INVALID_PARAMS", err.Error())
			return
		}
	}
	unlockTrigger := scheduler.LockPipelineTrigger(p.ID)
	defer unlockTrigger()
	if run, ok := scheduler.FindPipelineRunAwaitingJenkinsBuild(database.DB, p.ID); ok {
		response.Conflict(c, "PIPELINE_TRIGGER_IN_PROGRESS", scheduler.PipelineRunAwaitingBuildMessage(run))
		return
	}

	run, mode, err := createPipelineRun(&p, "webhook", "webhook", req.RuntimeParams, req.Remark, "")
	if err != nil {
		response.InternalError(c, err.Error())
		return
	}
    WriteAuditLog("webhook", "", "external_trigger", "pipeline", p.ID, p.Name,
		util.RealIP(c.GetHeader("X-Forwarded-For"), c.Request.RemoteAddr),
		map[string]any{"remark": req.Remark, "mode": mode})
	if scheduler.Global != nil {
		go scheduler.Global.DispatchRun(run.ID)
	}
	response.Created(c, gin.H{"runId": run.ID, "totalCount": run.TotalCount, "mode": mode})
}

// Pipeline Runs

type RunHandler struct{}

// DashboardStats returns overall dashboard metrics.
// GET /pipeline-runs/dashboard-stats
func (h *RunHandler) DashboardStats(c *gin.Context) {
	now := time.Now()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())

	// Today's run count
	var todayCount int64
	database.DB.Model(&model.PipelineRun{}).
		Where("started_at >= ?", todayStart).Count(&todayCount)

	// All-time stats
	var total, successCount, failedCount, abortedCount, runningCount int64
	database.DB.Model(&model.PipelineRun{}).Count(&total)
	database.DB.Model(&model.PipelineRun{}).Where("status = 'success'").Count(&successCount)
	database.DB.Model(&model.PipelineRun{}).Where("status IN ('failed','error')").Count(&failedCount)
	database.DB.Model(&model.PipelineRun{}).Where("status = 'aborted'").Count(&abortedCount)
	database.DB.Model(&model.PipelineRun{}).Where("status IN ('running','pending')").Count(&runningCount)
	var avgDuration float64
	database.DB.Model(&model.PipelineRun{}).
		Where("status IN ?", []string{"success", "failed", "aborted", "error"}).
		Select(`AVG(CASE
			WHEN duration_ms > 0 THEN duration_ms
			WHEN started_at IS NOT NULL AND finished_at IS NOT NULL THEN TIMESTAMPDIFF(MICROSECOND, started_at, finished_at) / 1000
			ELSE NULL
		END)`).Scan(&avgDuration)

	successRate := 0.0
	terminal := successCount + failedCount + abortedCount
	if terminal > 0 {
		successRate = float64(successCount) / float64(terminal) * 100
	}

	response.OK(c, gin.H{
		"todayRuns":    todayCount,
		"totalRuns":    total,
		"successCount": successCount,
		"failedCount":  failedCount,
		"abortedCount": abortedCount,
		"runningCount": runningCount,
		"successRate":  successRate,
		"avgDuration":  int64(avgDuration),
	})
}

func (h *RunHandler) List(c *gin.Context) {
	page, size, offset := util.PageParams(c.Query("page"), c.Query("pageSize"))
	db := database.DB.Model(&model.PipelineRun{}).Order("started_at DESC")
	if v := c.Query("pipelineId"); v != "" { db = db.Where("pipeline_id = ?", v) }
	if v := c.Query("status"); v != "" {
		var statuses []string
		for _, part := range strings.Split(v, ",") {
			if s := strings.TrimSpace(part); s != "" {
				statuses = append(statuses, s)
			}
		}
		if len(statuses) == 1 {
			db = db.Where("status = ?", statuses[0])
		} else if len(statuses) > 1 {
			db = db.Where("status IN ?", statuses)
		}
	}
	if v := c.Query("keyword"); v != "" { db = db.Where("pipeline_name LIKE ?", "%"+v+"%") }
	if v := c.Query("startedBeforeMinutes"); v != "" {
		if minutes, err := strconv.Atoi(v); err == nil && minutes > 0 {
			cutoff := time.Now().Add(-time.Duration(minutes) * time.Minute)
			db = db.Where("COALESCE(started_at, created_at) <= ?", cutoff)
		}
	}

	var total int64
	db.Count(&total)
	var items []model.PipelineRun
	db.Limit(size).Offset(offset).Find(&items)
	if items == nil { items = []model.PipelineRun{} }

	// Resolve user names
	var userIDs []string
	for _, r := range items {
		if r.TriggeredBy != "" {
			userIDs = append(userIDs, r.TriggeredBy)
		}
	}
	nameMap := ResolveUserNames(userIDs)

	type runResp struct {
		model.PipelineRun
		TriggeredByName string `json:"triggeredByName"`
	}
	result := make([]runResp, 0, len(items))
	for _, r := range items {
		result = append(result, runResp{
			PipelineRun:     r,
			TriggeredByName: nameMap[r.TriggeredBy],
		})
	}
	response.Page(c, result, total, page, size)
}

func (h *RunHandler) Rebuild(c *gin.Context) {
	id := c.Param("id")
	var oldRun model.PipelineRun
	if err := database.DB.First(&oldRun, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Run record not found"); return
	}

	var p model.Pipeline
	if err := database.DB.First(&p, "id = ?", oldRun.PipelineID).Error; err != nil {
		response.NotFound(c, "Pipeline not found"); return
	}
	if !canTriggerPipeline(&p, middleware.GetUserID(c), isAdminUser(c)) {
		response.Forbidden(c, "You do not have permission to rebuild this pipeline run")
		return
	}
	if pipelineRunIsActive(oldRun.Status) {
		response.Conflict(c, "PIPELINE_RUN_ACTIVE", "This run is still active. Wait for it to finish before rebuilding")
		return
	}
	if strings.TrimSpace(oldRun.PipelineSnapshotJSON) == "" {
        response.Unprocessable(c, "PIPELINE_SNAPSHOT_MISSING", "This run has no pipeline snapshot, so a safe rebuild cannot be guaranteed")
		return
	}
	snapshot, err := scheduler.PipelineConfigForRun(&oldRun)
	if err != nil {
		response.Unprocessable(c, "PIPELINE_SNAPSHOT_INVALID", err.Error())
		return
	}
	unlockTrigger := scheduler.LockPipelineTrigger(oldRun.PipelineID)
	defer unlockTrigger()
	if rejectPipelineRunAwaitingJenkinsBuild(c, oldRun.PipelineID) {
		return
	}

	runtimeParams := map[string]string{}
	if strings.TrimSpace(oldRun.RuntimeParams) != "" {
		_ = json.Unmarshal([]byte(oldRun.RuntimeParams), &runtimeParams)
	}
	triggerType := snapshot.TriggerType
	if strings.TrimSpace(triggerType) == "" {
		triggerType = oldRun.TriggerType
	}
	run, mode, err := createPipelineRunFromSnapshot(snapshot, triggerType, middleware.GetUserID(c), runtimeParams, "Rebuild from run "+oldRun.ID)
	if err != nil {
		response.Unprocessable(c, "JENKINS_JOB_INVALID", err.Error())
		return
	}

    WriteAuditLogFromCtx(c, "rebuild", "pipeline", p.ID, p.Name,
		map[string]any{"fromRunId": oldRun.ID, "mode": mode, "snapshot": true})
	if scheduler.Global != nil {
		go scheduler.Global.DispatchRun(run.ID)
	}

	response.Created(c, gin.H{"runId": run.ID, "totalCount": run.TotalCount, "mode": mode, "fromRunId": oldRun.ID, "snapshot": true})
}

func (h *RunHandler) Get(c *gin.Context) {
	id := c.Param("id")
	var run model.PipelineRun
	if err := database.DB.First(&run, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Run record not found"); return
	}
	nameMap := ResolveUserNames([]string{run.TriggeredBy})
	triggeredByName := nameMap[run.TriggeredBy]

	// Project group aggregation
	type projectGroup struct {
		Project      string  `json:"project"`
		TotalCount   int64   `json:"totalCount"`
		DoneCount    int64   `json:"doneCount"`
		FailedCount  int64   `json:"failedCount"`
		RunningCount int64   `json:"runningCount"`
		PassRate     float64 `json:"passRate"`
	}
	var groups []struct {
		Project string
		Total   int64
		Done    int64
		Failed  int64
		Running int64
	}
	database.DB.Model(&model.TaskRun{}).
		Select("project, COUNT(*) as total, "+
			"SUM(CASE WHEN status IN ('success','failed','error','aborted','blocked') THEN 1 ELSE 0 END) as done, "+
			"SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed, "+
			"SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running").
		Where("pipeline_run_id = ?", id).
		Group("project").Scan(&groups)

	var pGroups []projectGroup
	for _, g := range groups {
		passRate := 0.0
		if g.Done > 0 { passRate = float64(g.Done-g.Failed) / float64(g.Done) * 100 }
		status := "pending"
		if g.Running > 0 { status = "running" } else if g.Done == g.Total { status = "success" }
		if g.Failed > 0 && g.Done == g.Total { status = "failed" }
		_ = status
		pGroups = append(pGroups, projectGroup{
			Project: g.Project, TotalCount: g.Total,
			DoneCount: g.Done, FailedCount: g.Failed, RunningCount: g.Running,
			PassRate: passRate,
		})
	}

	durationMs := run.DurationMs
	if durationMs == 0 && run.StartedAt != nil && run.FinishedAt != nil {
		durationMs = run.FinishedAt.Sub(*run.StartedAt).Milliseconds()
		if durationMs < 0 {
			durationMs = 0
		}
	}

	response.OK(c, gin.H{
		"id": run.ID, "pipelineId": run.PipelineID, "pipelineName": run.PipelineName,
		"status": run.Status, "triggeredBy": run.TriggeredBy, "triggeredByName": triggeredByName, "triggerType": run.TriggerType,
		"startedAt": run.StartedAt, "finishedAt": run.FinishedAt, "durationMs": durationMs,
		"jenkinsBuildId": run.JenkinsBuildID, "jenkinsQueueId": run.JenkinsQueueID, "jenkinsBuildUrl": run.JenkinsBuildURL,
		"totalCount": run.TotalCount, "successCount": run.SuccessCount, "failedCount": run.FailedCount,
		"runningCount": run.RunningCount, "blockedCount": run.BlockedCount, "queuedCount": run.QueuedCount,
		"passRate": run.PassRate, "remark": run.Remark, "errorSummary": run.ErrorSummary, "projectGroups": pGroups,
	})
}

func (h *RunHandler) Abort(c *gin.Context) {
	id := c.Param("id")
	var run model.PipelineRun
	if err := database.DB.First(&run, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Run record not found"); return
	}

	// Already finished
	terminal := map[string]bool{"success": true, "failed": true, "aborted": true, "error": true}
	if terminal[run.Status] {
		response.OK(c, gin.H{"ok": true, "alreadyFinished": true, "status": run.Status})
		return
	}

	// Try to abort Jenkins build
	if run.JenkinsBuildID > 0 {
		inst, jobName, err := scheduler.ResolveJenkinsJobForPipelineRun(&run)
		if err == nil {
			jc, err := scheduler.NewJenkinsClient(inst)
			if err == nil {
				info, err := jc.GetBuildInfo(jobName, run.JenkinsBuildID)
				if err == nil {
					building, _ := info["building"].(bool)
					if !building {
		// Jenkins already finished, so sync the status.
						result, _ := info["result"].(string)
						var newStatus string
						switch result {
						case "SUCCESS":
							newStatus = "success"
						case "FAILURE":
							newStatus = "failed"
						case "ABORTED":
							newStatus = "aborted"
						default:
							newStatus = "error"
						}
						now := time.Now()
						durationMs := scheduler.CalcDurationMs(run.StartedAt, now)
						database.DB.Model(&run).Updates(map[string]any{"status": newStatus, "finished_at": now, "duration_ms": durationMs})
						database.DB.Model(&model.TaskRun{}).
							Where("pipeline_run_id = ? AND status IN ('pending','submitting','queued_in_jenkins','running','waiting')", id).
							Updates(map[string]any{"status": newStatus, "finished_at": now, "duration_ms": durationMs})
						go scheduler.SendPipelineNotifications(run.ID, run.PipelineID, newStatus)
						response.OK(c, gin.H{"ok": true, "alreadyFinished": true, "status": newStatus})
						return
					}
		// Still building, so abort it.
					jc.AbortBuild(jobName, run.JenkinsBuildID)
				}
			}
		}
	}

	now := time.Now()
	// Resolve who aborted
	abortUserID := middleware.GetUserID(c)
	nameMap := ResolveUserNames([]string{abortUserID})
	abortName := nameMap[abortUserID]
	if abortName == "" {
		abortName = abortUserID
	}
	abortReason := "user:" + abortName
	durationMs := scheduler.CalcDurationMs(run.StartedAt, now)

	database.DB.Model(&model.TaskRun{}).
		Where("pipeline_run_id = ? AND status IN ('pending','submitting','queued_in_jenkins','running','waiting')", id).
		Updates(map[string]any{"status": "aborted", "finished_at": now, "abort_reason": abortReason, "duration_ms": durationMs})
	database.DB.Model(&run).Updates(map[string]any{"status": "aborted", "finished_at": now, "abort_reason": abortReason, "duration_ms": durationMs})
	go scheduler.SendPipelineNotifications(run.ID, run.PipelineID, "aborted")

	response.OK(c, gin.H{"ok": true})
}

func (h *RunHandler) GetTaskRuns(c *gin.Context) {
	runID := c.Param("id")
	page, size, offset := util.PageParams(c.Query("page"), c.Query("pageSize"))
	db := database.DB.Model(&model.TaskRun{}).Where("pipeline_run_id = ?", runID)
	if v := c.Query("project"); v != "" { db = db.Where("project = ?", v) }
	if v := c.Query("status"); v != "" { db = db.Where("status = ?", v) }

	var total int64
	db.Count(&total)
	var items []model.TaskRun
	db.Order("created_at ASC").Limit(size).Offset(offset).Find(&items)
	if items == nil { items = []model.TaskRun{} }

	// Parse stage summary for each task
	type taskResp struct {
		model.TaskRun
		StageSummary any `json:"stageSummaryJson"`
		Outputs      any `json:"outputs"`
	}
	var result []taskResp
	for _, tr := range items {
		var stages any
		if tr.StageSummaryJSON != "" {
			json.Unmarshal([]byte(tr.StageSummaryJSON), &stages)
		}
		var outputs any
		if tr.OutputsJSON != "" {
			json.Unmarshal([]byte(tr.OutputsJSON), &outputs)
		}
		result = append(result, taskResp{TaskRun: tr, StageSummary: stages, Outputs: outputs})
	}
	if result == nil { result = []taskResp{} }
	response.Page(c, result, total, page, size)
}

// DispatchConfig returns the full execution config for all tasks in a pipeline run.
// Jenkins fetches this once at the start of execution to get all task configs.
// Response is gzip-compressed for large payloads.
func (h *RunHandler) DispatchConfig(c *gin.Context) {
	runID := c.Param("id")

	var run model.PipelineRun
	if err := database.DB.First(&run, "id = ?", runID).Error; err != nil {
        response.NotFound(c, "Run record not found")
		return
	}

	// Fetch all task runs for this pipeline run
	var taskRuns []model.TaskRun
	database.DB.Where("pipeline_run_id = ?", runID).
		Order("created_at ASC").Find(&taskRuns)

	if len(taskRuns) == 0 {
		response.OK(c, gin.H{"runId": runID, "tasks": []any{}})
		return
	}

	// Collect all test set IDs
	tsIDs := make([]string, 0, len(taskRuns))
	for _, tr := range taskRuns {
		tsIDs = append(tsIDs, tr.TestSetID)
	}

	// Batch fetch test sets
	var testSets []model.TestSet
	database.DB.Where("id IN ?", tsIDs).Find(&testSets)
	tsMap := make(map[string]*model.TestSet, len(testSets))
	for i := range testSets {
		tsMap[testSets[i].ID] = &testSets[i]
	}

	// Collect unique projects for global vars
	projectSet := make(map[string]bool)
	for _, ts := range testSets {
		projectSet[ts.Project] = true
	}
	projects := make([]string, 0, len(projectSet))
	for p := range projectSet {
		projects = append(projects, p)
	}

	// Fetch global vars (system + all relevant projects)
	var vars []model.GlobalVar
	database.DB.Where("scope = 'system' OR project_id IN ?", projects).Find(&vars)
	globalEnvMap := make(map[string]string, len(vars))
	for _, v := range vars {
		globalEnvMap[v.Key] = v.Value
	}

	// Parse runtime params from pipeline run
	runtimeParams := util.FromJSONDefault[map[string]string](run.RuntimeParams, nil)
	for k, v := range runtimeParams {
		globalEnvMap[k] = v // runtime params override global vars
	}

	// Build task list
	type TaskConfig struct {
		TaskID       string         `json:"taskId"`
		TestSetID    string         `json:"testSetId"`
		TestSetName  string         `json:"testSetName"`
		Project      string         `json:"project"`
		AgentLabel   string         `json:"agentLabel"`
		Priority     int            `json:"priority"`
		StageNum     int            `json:"stageNum"`
		CpuLock      bool           `json:"cpulock"`
		CpuLockScript string        `json:"cpulockScript,omitempty"`
		WebhookURL   string         `json:"webhookUrl"`
		Config       any            `json:"config"`
		EnvVars      map[string]string `json:"envVars"`
	}

	baseURL := c.GetHeader("X-Forwarded-Proto")
	if baseURL == "" { baseURL = "http" }
	baseURL += "://" + c.Request.Host

	tasks := make([]TaskConfig, 0, len(taskRuns))
	for _, tr := range taskRuns {
		ts := tsMap[tr.TestSetID]
		if ts == nil {
			continue
		}

		var cfg any
		json.Unmarshal([]byte(ts.ConfigJSON), &cfg)

		// Merge global vars with task-level env vars
		taskEnv := make(map[string]string, len(globalEnvMap))
		for k, v := range globalEnvMap {
			taskEnv[k] = v
		}

		tasks = append(tasks, TaskConfig{
			TaskID:        tr.ID,
			TestSetID:     ts.ID,
			TestSetName:   ts.Name,
			Project:       ts.Project,
			AgentLabel:    ts.AgentLabel,
			Priority:      ts.Priority,
			StageNum:      ts.StageNum,
			CpuLock:       ts.CpuLock,
			CpuLockScript: ts.CpuLockScript,
			WebhookURL:    baseURL + "/api/webhook/task/" + tr.ID,
			Config:        cfg,
			EnvVars:       taskEnv,
		})
	}

	response.OK(c, gin.H{
		"runId":      runID,
		"pipelineId": run.PipelineID,
		"totalTasks": len(tasks),
		"tasks":      tasks,
	})
}

// ValidateDAG checks a DAG config for cycles and returns node order.
// GetAccess returns the pipeline's access control list.
// GET /pipelines/:id/access
func (h *PipelineHandler) GetAccess(c *gin.Context) {
	id := c.Param("id")
	var p model.Pipeline
	if err := database.DB.First(&p, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Pipeline not found"); return
	}
	var entries []accessEntry
	if p.AccessControlJSON != "" {
		json.Unmarshal([]byte(p.AccessControlJSON), &entries)
	}
	if entries == nil { entries = []accessEntry{} }

	// Resolve user names for user-type entries
	userIDs := []string{p.CreatedBy}
	for _, e := range entries {
		if e.UserID != "" {
			userIDs = append(userIDs, e.UserID)
		}
	}
	nameMap := ResolveUserNames(userIDs)

	// Resolve role display names for role-type entries
	var allRoles []model.Role
	database.DB.Select("name, display_name").Find(&allRoles)
	roleDisplayMap := make(map[string]string)
	for _, r := range allRoles {
		roleDisplayMap[r.Name] = r.DisplayName
	}

	type entryWithName struct {
		Type     string `json:"type"`
		UserID   string `json:"userId,omitempty"`
		UserName string `json:"userName,omitempty"`
		RoleID   string `json:"roleId,omitempty"`
		RoleName string `json:"roleName,omitempty"`
		Role     string `json:"role"`
	}
	result := make([]entryWithName, 0, len(entries))
	for _, e := range entries {
		entryType := e.Type
		if entryType == "" {
			entryType = "user"
		}
		item := entryWithName{Type: entryType, Role: e.Role}
		if entryType == "user" {
			item.UserID = e.UserID
			item.UserName = nameMap[e.UserID]
		} else {
			item.RoleID = e.RoleID
			item.RoleName = roleDisplayMap[e.RoleID]
		}
		result = append(result, item)
	}

	currentUserID := middleware.GetUserID(c)
	response.OK(c, gin.H{
		"ownerId":      p.CreatedBy,
		"ownerName":    nameMap[p.CreatedBy],
		"entries":      result,
		"currentRole":  getPipelineRole(&p, currentUserID),
		"canManage":    canEditPipeline(&p, currentUserID, isAdminUser(c)),
	})
}

// UpdateAccess updates the pipeline's access control list.
// PUT /pipelines/:id/access
func (h *PipelineHandler) UpdateAccess(c *gin.Context) {
	id := c.Param("id")
	var p model.Pipeline
	if err := database.DB.First(&p, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Pipeline not found"); return
	}
	// Only owner or admin can manage access
	currentUserID := middleware.GetUserID(c)
	if !canEditPipeline(&p, currentUserID, isAdminUser(c)) {
		response.Forbidden(c, "Only the pipeline owner or an admin can manage pipeline access")
		return
	}

	var req struct {
		Entries []accessEntry `json:"entries"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	// Validate entries
	for _, e := range req.Entries {
		if e.Role != "operator" && e.Role != "viewer" {
			response.BadRequest(c, "INVALID_ROLE", "role must be operator or viewer")
			return
		}
		entryType := e.Type
		if entryType == "" {
			entryType = "user"
		}
		if entryType == "user" {
			// Can't set creator as non-owner
			if e.UserID == p.CreatedBy {
				response.BadRequest(c, "INVALID_USER", "The pipeline owner does not need an explicit role assignment")
				return
			}
		} else if entryType == "role" {
			if e.RoleID == "" {
				response.BadRequest(c, "INVALID_PARAMS", "roleId is required for role-based access entries")
				return
			}
			// Can't assign super_admin as pipeline role
			if e.RoleID == "super_admin" {
                response.BadRequest(c, "INVALID_ROLE", "super_admin does not need pipeline-level role assignment")
				return
			}
		} else {
			response.BadRequest(c, "INVALID_TYPE", "type must be user or role")
			return
		}
	}

	jsonBytes, _ := json.Marshal(req.Entries)
	database.DB.Model(&p).Update("access_control_json", string(jsonBytes))

    WriteAuditLogFromCtx(c, "update_permissions", "pipeline", p.ID, p.Name,
		map[string]any{"count": len(req.Entries)})

	response.OK(c, gin.H{"ok": true, "count": len(req.Entries)})
}

func (h *PipelineHandler) ValidateDAG(c *gin.Context) {
	var body model.DAGConfig
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error()); return
	}

	if HasDAGCycle(body) {
        response.BadRequest(c, "DAG_CYCLE", "DAG contains a cycle; please review the node connections")
		return
	}
	topology, err := ValidateDAGTopology(body)
	if err != nil {
		response.BadRequest(c, "DAG_INVALID", err.Error()); return
	}

	sorted, err := TopologicalSortConfig(body)
	if err != nil {
		response.BadRequest(c, "DAG_INVALID", err.Error()); return
	}
	layerMap := make(map[string]int)
	for i, n := range sorted {
		layerMap[n.ID] = i
	}
	response.OK(c, gin.H{
		"valid":      true,
		"nodeCount":  len(body.Nodes),
		"layerMap":   layerMap,
		"topology":   topology,
	})
}

// GetChildRuns returns direct child pipeline runs for a given run ID (recursive tree).
func (h *PipelineHandler) GetChildRuns(c *gin.Context) {
	runID := c.Param("id")
	var children []model.PipelineRun
	if err := database.DB.Where("parent_run_id = ?", runID).
		Order("started_at asc").Find(&children).Error; err != nil {
		response.InternalError(c, "Failed to query pipeline trends")
		return
	}
	// Recursively attach children
	type runNode = model.PipelineRun
	var buildTree func(runs []runNode) []map[string]interface{}
	buildTree = func(runs []runNode) []map[string]interface{} {
		result := make([]map[string]interface{}, 0, len(runs))
		for _, r := range runs {
			node := map[string]interface{}{
				"id":           r.ID,
				"pipelineId":   r.PipelineID,
				"pipelineName": r.PipelineName,
				"project":      r.PipelineName,
				"status":       r.Status,
				"passRate":     r.PassRate,
				"totalCount":   r.TotalCount,
				"successCount": r.SuccessCount,
				"failedCount":  r.FailedCount,
				"blockedCount": r.BlockedCount,
				"durationMs":   r.DurationMs,
				"startedAt":    r.StartedAt,
				"parentRunId":  r.ParentRunID,
				"depth":        r.ParentTaskID, // reuse field as proxy depth indicator
			}
			var grandChildren []runNode
			database.DB.Where("parent_run_id = ?", r.ID).Order("started_at asc").Find(&grandChildren)
			if len(grandChildren) > 0 {
				node["children"] = buildTree(grandChildren)
			}
			result = append(result, node)
		}
		return result
	}
	response.OK(c, buildTree(children))
}
