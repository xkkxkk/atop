package handler

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/internal/scheduler"
	"github.com/company/atop-backend/pkg/response"
)

type JenkinsHandler struct{}

type jenkinsReq struct {
	Name             string   `json:"name"`
	URL              string   `json:"url"`
	Username         string   `json:"username"`
	APIToken         string   `json:"apiToken"`
	ViewerToken      string   `json:"viewerToken"`
	IsDefault        bool     `json:"isDefault"`
	ProjectBindings  []string `json:"projectBindings"`
	AgentSyncMode    string   `json:"agentSyncMode"` // all | bound_only | fixed
	FixedNodes       []string `json:"fixedNodes"`
}

func (h *JenkinsHandler) List(c *gin.Context) {
	var items []model.JenkinsInstance
	database.DB.Order("created_at DESC").Find(&items)
	// Mask tokens in response
	type resp struct {
		model.JenkinsInstance
		HasAPIToken    bool `json:"hasApiToken"`
		HasViewerToken bool `json:"hasViewerToken"`
		ProjectBindings []string `json:"projectBindings"`
		FixedNodes      []string `json:"fixedNodes"`
	}
	var result []resp
	for _, j := range items {
		bindings := util.FromJSONDefault[[]string](j.ProjectBindings, []string{})
		fixedNodes := util.FromJSONDefault[[]string](j.FixedNodes, []string{})
		result = append(result, resp{
			JenkinsInstance: j,
			HasAPIToken:     j.APITokenEncrypted != "",
			HasViewerToken:  j.ViewerTokenEncrypted != "",
			ProjectBindings: bindings,
			FixedNodes:      fixedNodes,
		})
	}
	if result == nil { result = []resp{} }
	response.OK(c, result)
}


// pingCheck tests Jenkins connectivity with provided credentials (before saving).
func pingCheck(rawURL, username, apiToken string) (bool, int64, error) {
	client := &http.Client{Timeout: config.Global.Jenkins.RequestTimeout}
	req, err := http.NewRequest("GET", rawURL+"/api/json", nil)
	if err != nil {
		return false, 0, err
	}
	req.SetBasicAuth(username, apiToken)
	start := time.Now()
	resp, err := client.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return false, latency, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
        return false, latency, fmt.Errorf("Jenkins returned status %d; please verify the account permissions", resp.StatusCode)
	}
	return true, latency, nil
}

func (h *JenkinsHandler) Create(c *gin.Context) {
	var req jenkinsReq
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}
	if req.AgentSyncMode == "" {
		req.AgentSyncMode = "all"
	}
	var apiEnc, viewerEnc string
	if req.APIToken != "" {
		enc, err := util.Encrypt(req.APIToken)
		if err != nil { response.InternalError(c, "Failed to encrypt API token"); return }
		apiEnc = enc
	}
	if req.ViewerToken != "" {
		enc, err := util.Encrypt(req.ViewerToken)
		if err != nil { response.InternalError(c, "Failed to encrypt viewer token"); return }
		viewerEnc = enc
	}
	if req.IsDefault {
		database.DB.Model(&model.JenkinsInstance{}).Where("is_default = ?", true).Update("is_default", false)
	}
	// Trim trailing slash from URL
	req.URL = strings.TrimRight(req.URL, "/")
	// Ping check before saving
	ok, latency, pingErr := pingCheck(req.URL, req.Username, req.APIToken)
	if !ok {
        errMsg := "Unable to connect to Jenkins; please verify the URL and credentials"
		if pingErr != nil {
            errMsg = "Connection failed: " + pingErr.Error()
		}
		response.BadRequest(c, "JENKINS_UNREACHABLE", errMsg)
		return
	}

	inst := model.JenkinsInstance{
		Name: req.Name, URL: req.URL, Username: req.Username,
		APITokenEncrypted:    apiEnc,
		ViewerTokenEncrypted: viewerEnc,
		IsDefault:            req.IsDefault,
		ProjectBindings:      util.ToJSON(req.ProjectBindings),
		AgentSyncMode:        req.AgentSyncMode,
		FixedNodes:           util.ToJSON(req.FixedNodes),
		Status:               "ok",
		CreatedBy:            middleware.GetUserID(c),
		UpdatedBy:            middleware.GetUserID(c),
	}
	now := time.Now()
	inst.LastPingAt = &now
	database.DB.Create(&inst)
    WriteAuditLogFromCtx(c, "create", "jenkins_instance", inst.ID, inst.Name, nil)
	response.Created(c, gin.H{"id": inst.ID, "name": inst.Name, "status": "ok", "latencyMs": latency})
}

func (h *JenkinsHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var inst model.JenkinsInstance
	if err := database.DB.First(&inst, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Instance not found"); return
	}
	var req jenkinsReq
	c.ShouldBindJSON(&req)
	if req.AgentSyncMode == "" {
		req.AgentSyncMode = "all"
	}

	// Trim trailing slash from URL
	req.URL = strings.TrimRight(req.URL, "/")

	updates := map[string]any{
		"name": req.Name, "url": req.URL, "username": req.Username,
		"is_default": req.IsDefault,
		"agent_sync_mode": req.AgentSyncMode,
		"project_bindings": util.ToJSON(req.ProjectBindings),
		"fixed_nodes": util.ToJSON(req.FixedNodes),
		"updated_by": middleware.GetUserID(c),
	}
	if req.APIToken != "" {
		enc, _ := util.Encrypt(req.APIToken)
		updates["api_token_encrypted"] = enc
	}
	if req.ViewerToken != "" {
		enc, _ := util.Encrypt(req.ViewerToken)
		updates["viewer_token_encrypted"] = enc
	}
	if req.IsDefault {
		database.DB.Model(&model.JenkinsInstance{}).Where("id != ? AND is_default = ?", id, true).Update("is_default", false)
	}
	// Ping check if credentials or URL changed
	if req.URL != "" && req.APIToken != "" {
		tokenToTest := req.APIToken
		ok, latency, pingErr := pingCheck(req.URL, req.Username, tokenToTest)
		if !ok {
            errMsg := "Unable to connect to Jenkins; please verify the URL and credentials"
			if pingErr != nil {
                errMsg = "Connection failed: " + pingErr.Error()
			}
			response.BadRequest(c, "JENKINS_UNREACHABLE", errMsg)
			return
		}
		now := time.Now()
		updates["status"] = "ok"
		updates["last_ping_at"] = now
		_ = latency
	}
	database.DB.Model(&inst).Updates(updates)
	database.DB.First(&inst, "id = ?", id)
    WriteAuditLogFromCtx(c, "update", "jenkins_instance", inst.ID, inst.Name, nil)
	response.OK(c, gin.H{"ok": true})
}

func (h *JenkinsHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	var inst model.JenkinsInstance
	if err := database.DB.First(&inst, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Instance not found"); return
	}

	// Check if any pipeline is using this instance
	var pipelines []model.Pipeline
	database.DB.Where("jenkins_bindings LIKE ?", "%"+id+"%").Find(&pipelines)
	if len(pipelines) > 0 {
		names := make([]string, 0, len(pipelines))
		for _, p := range pipelines {
			names = append(names, p.Name)
		}
		response.Unprocessable(c, "INSTANCE_IN_USE",
            fmt.Sprintf("This instance is used by %d pipelines: %s. Update those Jenkins bindings before deleting it",
                len(pipelines), strings.Join(names, ", ")))
		return
	}

	database.DB.Where("id = ?", id).Delete(&model.JenkinsInstance{})
    WriteAuditLogFromCtx(c, "delete", "jenkins_instance", inst.ID, inst.Name,
		map[string]any{"name": inst.Name, "url": inst.URL})
	response.OK(c, gin.H{"ok": true})
}

// Ping tests connectivity to a Jenkins instance.
func (h *JenkinsHandler) Ping(c *gin.Context) {
	id := c.Param("id")
	var inst model.JenkinsInstance
	if err := database.DB.First(&inst, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Instance not found"); return
	}

	apiToken, _ := util.Decrypt(inst.APITokenEncrypted)
	url := inst.URL + "/api/json"

	client := &http.Client{Timeout: config.Global.Jenkins.RequestTimeout}
	req, _ := http.NewRequest("GET", url, nil)
	req.SetBasicAuth(inst.Username, apiToken)

	start := time.Now()
	resp, err := client.Do(req)
	latency := time.Since(start).Milliseconds()

	status := "unreachable"
	if err == nil && resp.StatusCode < 400 {
		status = "ok"
		resp.Body.Close()
	}

	now := time.Now()
	database.DB.Model(&inst).Updates(map[string]any{
		"status": status, "last_ping_at": now,
	})

	response.OK(c, gin.H{"status": status, "latencyMs": latency})
}

// SyncAgents pulls agent/node list from Jenkins and updates DB.
func (h *JenkinsHandler) SyncAgents(c *gin.Context) {
	id := c.Param("id")
	var inst model.JenkinsInstance
	if err := database.DB.First(&inst, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Instance not found"); return
	}

	jc, err := scheduler.NewJenkinsClient(&inst)
	if err != nil {
		response.InternalError(c, "Failed to initialize Jenkins client: "+err.Error()); return
	}

	nodes, err := jc.SyncNodes()
	if err != nil {
		response.InternalError(c, "Failed to sync agents: "+err.Error()); return
	}

	// Build the label-to-nodes map.
	now := time.Now()
	labelMap := make(map[string][]map[string]any)
	nodeLabels := make(map[string][]string)
	nodeOffline := make(map[string]bool)
	nodeOS := make(map[string]string)
	allowedNodes := map[string]bool{}
	if inst.AgentSyncMode == "fixed" {
		for _, nodeName := range util.FromJSONDefault[[]string](inst.FixedNodes, []string{}) {
			if name := strings.TrimSpace(nodeName); name != "" {
				allowedNodes[name] = true
			}
		}
	}
	for _, node := range nodes {
		name, _ := node["displayName"].(string)
		if name == "" {
			continue
		}
		if inst.AgentSyncMode == "fixed" && !allowedNodes[name] {
			continue
		}
		offline, _ := node["offline"].(bool)
		var labels []string
		if al, ok := node["assignedLabels"].([]any); ok {
			for _, l := range al {
				if lm, ok := l.(map[string]any); ok {
					if lname, ok := lm["name"].(string); ok && lname != "" && lname != name {
						labels = append(labels, lname)
					}
				}
			}
		}
		if len(labels) == 0 {
			labels = []string{name}
		}
		nodeLabels[name] = labels
		nodeOffline[name] = offline
		if md, ok := node["monitorData"].(map[string]any); ok {
			if arch, ok := md["hudson.node_monitors.ArchitectureMonitor"].(string); ok {
				nodeOS[name] = arch
			}
		}
		for _, label := range labels {
			labelMap[label] = append(labelMap[label], map[string]any{
				"name": name, "offline": offline,
			})
		}
	}
	if inst.AgentSyncMode == "fixed" {
		for nodeName := range allowedNodes {
			if _, exists := nodeLabels[nodeName]; exists {
				continue
			}
			nodeLabels[nodeName] = []string{nodeName}
			nodeOffline[nodeName] = true
			labelMap[nodeName] = append(labelMap[nodeName], map[string]any{
				"name": nodeName, "offline": true,
			})
		}
	}

	for nodeName, labels := range nodeLabels {
		var an model.AgentNode
		if err := database.DB.Where("node_id = ? AND jenkins_instance_id = ?", nodeName, id).First(&an).Error; err != nil {
			an = model.AgentNode{
				NodeID:            nodeName,
				Name:              nodeName,
				LabelID:           "",
				JenkinsInstanceID: id,
				Online:            !nodeOffline[nodeName],
				OS:                nodeOS[nodeName],
				LabelsJSON:        util.ToJSON(labels),
				LastSyncAt:        &now,
			}
			database.DB.Create(&an)
		} else {
			database.DB.Model(&an).Updates(map[string]any{
				"name":         nodeName,
				"online":       !nodeOffline[nodeName],
				"os":           nodeOS[nodeName],
				"labels_json":  util.ToJSON(labels),
				"last_sync_at": now,
			})
		}
	}

	// Upsert agent_labels
	synced := 0

	// If bound_only mode, only sync labels that are used by test sets
	var allowedLabels map[string]bool
	if inst.AgentSyncMode == "bound_only" {
		allowedLabels = make(map[string]bool)
		var usedLabels []string
		database.DB.Model(&model.TestSet{}).Distinct("agent_label").
			Where("agent_label != ''").Pluck("agent_label", &usedLabels)
		for _, l := range usedLabels {
			allowedLabels[l] = true
		}
	}

	for label, nodeList := range labelMap {
		// Skip if bound_only mode and label not used by any test set
		if allowedLabels != nil && !allowedLabels[label] {
			continue
		}
		online := 0
		for _, n := range nodeList {
			if !n["offline"].(bool) { online++ }
		}

		var ag model.AgentLabel
		if err := database.DB.Where("label = ? AND jenkins_instance_id = ?", label, id).
			First(&ag).Error; err != nil {
			// Create
			ag = model.AgentLabel{
				Label:             label,
				JenkinsInstanceID: id,
				OnlineCount:       online,
				TotalCount:        len(nodeList),
				LastSyncAt:        &now,
			}
			database.DB.Create(&ag)
		} else {
			database.DB.Model(&ag).Updates(map[string]any{
				"online_count": online,
				"total_count":  len(nodeList),
				"last_sync_at": now,
			})
		}

		// Upsert agent_nodes
		for _, n := range nodeList {
			nodeName := n["name"].(string)
			onl := !n["offline"].(bool)
			var an model.AgentNode
			updates := map[string]any{
				"name":         nodeName,
				"label_id":     ag.ID,
				"online":       onl,
				"os":           nodeOS[nodeName],
				"labels_json":  util.ToJSON(nodeLabels[nodeName]),
				"last_sync_at": now,
			}
			if err := database.DB.Where("node_id = ? AND jenkins_instance_id = ?", nodeName, id).
				First(&an).Error; err != nil {
				an = model.AgentNode{
					NodeID:            nodeName,
					Name:              nodeName,
					LabelID:           ag.ID,
					JenkinsInstanceID: id,
					Online:            onl,
					OS:                nodeOS[nodeName],
					LabelsJSON:        util.ToJSON(nodeLabels[nodeName]),
					LastSyncAt:        &now,
				}
				database.DB.Create(&an)
			} else {
				database.DB.Model(&an).Updates(updates)
			}
		}
		synced++
	}

	if inst.AgentSyncMode == "fixed" {
		fixedNodeNames := make([]string, 0, len(nodeLabels))
		for nodeName := range nodeLabels {
			fixedNodeNames = append(fixedNodeNames, nodeName)
		}
		if len(fixedNodeNames) > 0 {
			database.DB.Where("jenkins_instance_id = ? AND node_id NOT IN ?", id, fixedNodeNames).
				Delete(&model.AgentNode{})
		} else {
			database.DB.Where("jenkins_instance_id = ?", id).Delete(&model.AgentNode{})
		}

		activeLabels := make([]string, 0, len(labelMap))
		for label := range labelMap {
			if allowedLabels == nil || allowedLabels[label] {
				activeLabels = append(activeLabels, label)
			}
		}
		if len(activeLabels) > 0 {
			database.DB.Where("jenkins_instance_id = ? AND label NOT IN ?", id, activeLabels).
				Delete(&model.AgentLabel{})
		} else {
			database.DB.Where("jenkins_instance_id = ?", id).Delete(&model.AgentLabel{})
		}
	}

	WriteAuditLogFromCtx(c, "sync", "jenkins_instance", inst.ID, inst.Name,
		map[string]any{"labels": synced, "nodes": len(nodeLabels)})
	response.OK(c, gin.H{"synced": synced, "totalNodes": len(nodeLabels)})
}

func (h *JenkinsHandler) ListLabels(c *gin.Context) {
	instanceID := c.Query("instanceId")
	db := database.DB.Model(&model.AgentLabel{})
	if instanceID != "" {
		db = db.Where("jenkins_instance_id = ?", instanceID)
	}
	var labels []model.AgentLabel
	db.Order("jenkins_instance_id ASC, label ASC").Find(&labels)
	if labels == nil { labels = []model.AgentLabel{} }

	var instanceIDs []string
	for _, label := range labels {
		if label.JenkinsInstanceID != "" {
			instanceIDs = append(instanceIDs, label.JenkinsInstanceID)
		}
	}
	instanceNameMap := map[string]string{}
	if len(instanceIDs) > 0 {
		var instances []model.JenkinsInstance
		database.DB.Where("id IN ?", instanceIDs).Find(&instances)
		for _, inst := range instances {
			instanceNameMap[inst.ID] = inst.Name
		}
	}

	type labelResp struct {
		model.AgentLabel
		JenkinsInstanceName string `json:"jenkinsInstanceName"`
	}
	result := make([]labelResp, 0, len(labels))
	for _, label := range labels {
		result = append(result, labelResp{
			AgentLabel:          label,
			JenkinsInstanceName: instanceNameMap[label.JenkinsInstanceID],
		})
	}
	response.OK(c, result)
}

func (h *JenkinsHandler) ListInstanceNodes(c *gin.Context) {
	instanceID := c.Query("instanceId")
	keyword := strings.TrimSpace(c.Query("keyword"))
	db := database.DB.Model(&model.AgentNode{})
	if instanceID != "" {
		db = db.Where("jenkins_instance_id = ?", instanceID)
	}
	if keyword != "" {
		like := "%" + keyword + "%"
		db = db.Where("name LIKE ? OR node_id LIKE ? OR labels_json LIKE ?", like, like, like)
	}
	var nodes []model.AgentNode
	db.Order("online DESC, name ASC").Find(&nodes)
	if nodes == nil { nodes = []model.AgentNode{} }

	type nodeResp struct {
		model.AgentNode
		Labels []string `json:"labels"`
	}
	result := make([]nodeResp, 0, len(nodes))
	for _, node := range nodes {
		result = append(result, nodeResp{
			AgentNode: node,
			Labels:    util.FromJSONDefault[[]string](node.LabelsJSON, []string{}),
		})
	}
	response.OK(c, result)
}

// ListNodes returns agent nodes for a given label.
func (h *JenkinsHandler) ListNodes(c *gin.Context) {
	labelID := c.Param("labelId")
	var label model.AgentLabel
	if err := database.DB.First(&label, "id = ?", labelID).Error; err != nil {
        response.NotFound(c, "Agent label not found"); return
	}

	var nodes []model.AgentNode
	database.DB.Where("jenkins_instance_id = ?", label.JenkinsInstanceID).
		Order("online DESC, name ASC").Find(&nodes)
	if nodes == nil { nodes = []model.AgentNode{} }

	type nodeResp struct {
		model.AgentNode
		Labels []string `json:"labels"`
	}
	result := make([]nodeResp, 0, len(nodes))
	for _, node := range nodes {
		labels := util.FromJSONDefault[[]string](node.LabelsJSON, []string{})
		matched := node.LabelID == labelID
		for _, item := range labels {
			if item == label.Label {
				matched = true
				break
			}
		}
		if matched {
			result = append(result, nodeResp{
				AgentNode: node,
				Labels:    labels,
			})
		}
	}
	response.OK(c, result)
}

// Global Vars

type VarsHandler struct{}

func (h *VarsHandler) List(c *gin.Context) {
	scope := c.Query("scope")
	projectID := c.Query("projectId")
	db := database.DB.Model(&model.GlobalVar{}).Order("updated_at DESC")
	if scope != "" { db = db.Where("scope = ?", scope) }
	if projectID != "" { db = db.Where("project_id = ?", projectID) }
	var items []model.GlobalVar
	db.Find(&items)
	if items == nil { items = []model.GlobalVar{} }
	response.OK(c, items)
}

func (h *VarsHandler) Create(c *gin.Context) {
	var item model.GlobalVar
	if err := c.ShouldBindJSON(&item); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error()); return
	}
	if item.Key == "" { response.BadRequest(c, "MISSING_KEY", "key cannot be empty"); return }

	// Check duplicates. `key` is reserved in MySQL, so keep it quoted in the query.
	var existing model.GlobalVar
	if err := database.DB.Where("`key` = ?", item.Key).First(&existing).Error; err == nil {
		response.BadRequest(c, "DUPLICATE_KEY", fmt.Sprintf("Variable %q already exists", item.Key)); return
	}

	item.CreatedBy = middleware.GetUserID(c)
	item.UpdatedBy = middleware.GetUserID(c)
	database.DB.Create(&item)
	WriteAuditLogFromCtx(c, "create", "shared_variable", item.ID, item.Key, nil)
	response.Created(c, item)
}

func (h *VarsHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var item model.GlobalVar
	if err := database.DB.First(&item, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Variable not found"); return
	}
	var body struct {
		Value     string `json:"value"`
		Scope     string `json:"scope"`
		ProjectID string `json:"projectId"`
		Force     bool   `json:"force"` // skip reference check
	}
	c.ShouldBindJSON(&body)

	// Scope narrowing check: system -> project
	if item.Scope == "system" && body.Scope == "project" && !body.Force {
		// Count test sets that reference this var key in their config
		var affectedCount int64
		database.DB.Model(&model.TestSet{}).
			Where("config_json LIKE ?", "%"+item.Key+"%").
			Count(&affectedCount)
		response.OK(c, gin.H{
			"needConfirm":   true,
			"affectedCount": affectedCount,
			"key":           item.Key,
            "message":       fmt.Sprintf("Variable %q is currently global and may be referenced by about %d test sets. If you change it to project scope, other projects may no longer be able to read it.", item.Key, affectedCount),
		})
		return
	}

	updates := map[string]any{"value": body.Value, "updated_by": middleware.GetUserID(c)}
	if body.Scope != "" { updates["scope"] = body.Scope }
	if body.Scope == "project" && body.ProjectID != "" {
		updates["project_id"] = body.ProjectID
	} else if body.Scope == "system" {
		updates["project_id"] = ""
	}
	database.DB.Model(&item).Updates(updates)
	database.DB.First(&item, "id = ?", id)
    WriteAuditLogFromCtx(c, "update", "shared_variable", item.ID, item.Key, nil)
	response.OK(c, item)
}

func (h *VarsHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	var item model.GlobalVar
	if err := database.DB.First(&item, "id = ?", id).Error; err != nil {
        response.NotFound(c, "Variable not found"); return
	}
	database.DB.Where("id = ?", id).Delete(&model.GlobalVar{})
    WriteAuditLogFromCtx(c, "delete", "shared_variable", item.ID, item.Key,
		map[string]any{"key": item.Key, "scope": item.Scope})
	response.OK(c, gin.H{"ok": true})
}

// Shared Libs

type LibsHandler struct{}

func (h *LibsHandler) List(c *gin.Context) {
	db := database.DB.Model(&model.SharedLib{}).Order("updated_at DESC")
	if v := c.Query("scope"); v != "" { db = db.Where("scope = ?", v) }
	if v := c.Query("lang");  v != "" { db = db.Where("lang = ?", v) }
	if v := c.Query("keyword"); v != "" { db = db.Where("name LIKE ? OR description LIKE ?", "%"+v+"%", "%"+v+"%") }
	var items []model.SharedLib
	db.Find(&items)
	if items == nil { items = []model.SharedLib{} }
	response.OK(c, items)
}

func (h *LibsHandler) Get(c *gin.Context) {
	id := c.Param("id")
	var lib model.SharedLib
	if err := database.DB.First(&lib, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Library not found"); return
	}
	response.OK(c, lib)
}

func (h *LibsHandler) Create(c *gin.Context) {
	var lib model.SharedLib
	if err := c.ShouldBindJSON(&lib); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error()); return
	}
	lib.ContentHash = util.SHA256Hex(lib.Content)
	lib.Version = 1
	lib.CreatedBy = middleware.GetUserID(c)
	lib.UpdatedBy = middleware.GetUserID(c)
	database.DB.Create(&lib)
    WriteAuditLogFromCtx(c, "create", "shared_library", lib.ID, lib.Name, nil)
	response.Created(c, lib)
}

func (h *LibsHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var lib model.SharedLib
	if err := database.DB.First(&lib, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Library not found"); return
	}
	var body struct {
		Content     string `json:"content"`
		Description string `json:"description"`
	}
	c.ShouldBindJSON(&body)

	// Save old version
	oldVer := model.SharedLibVersion{
		LibID: lib.ID, Version: lib.Version,
		Content: lib.Content, ChangedBy: middleware.GetUserID(c),
	}
	database.DB.Create(&oldVer)

	// Cap at 50 versions
	var verCount int64
	database.DB.Model(&model.SharedLibVersion{}).Where("lib_id = ?", id).Count(&verCount)
	if verCount > 50 {
		var oldest model.SharedLibVersion
		database.DB.Where("lib_id = ?", id).Order("version ASC").First(&oldest)
		database.DB.Delete(&oldest)
	}

	database.DB.Model(&lib).Updates(map[string]any{
		"content":      body.Content,
		"content_hash": util.SHA256Hex(body.Content),
		"description":  body.Description,
		"version":      lib.Version + 1,
		"updated_by":   middleware.GetUserID(c),
	})
	database.DB.First(&lib, "id = ?", id)
    WriteAuditLogFromCtx(c, "update", "shared_library", lib.ID, lib.Name,
		map[string]any{"version": lib.Version})
	response.OK(c, lib)
}

func (h *LibsHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	var lib model.SharedLib
	if err := database.DB.First(&lib, "id = ?", id).Error; err != nil {
		response.NotFound(c, "Library not found"); return
	}
	if lib.RefCount > 0 {
        response.Unprocessable(c, "IN_USE", fmt.Sprintf("Referenced by %d test sets and cannot be deleted", lib.RefCount))
		return
	}
	database.DB.Where("lib_id = ?", id).Delete(&model.SharedLibVersion{})
	database.DB.Delete(&lib)
    WriteAuditLogFromCtx(c, "delete", "shared_library", lib.ID, lib.Name,
		map[string]any{"name": lib.Name, "version": lib.Version})
	response.OK(c, gin.H{"ok": true})
}

func (h *LibsHandler) ListVersions(c *gin.Context) {
	id := c.Param("id")
	var versions []model.SharedLibVersion
	database.DB.Where("lib_id = ?", id).Order("version DESC").Find(&versions)
	if versions == nil { versions = []model.SharedLibVersion{} }
	response.OK(c, versions)
}

func (h *LibsHandler) Rollback(c *gin.Context) {
	id := c.Param("id")
	var body struct{ Version int `json:"version"` }
	c.ShouldBindJSON(&body)

	var ver model.SharedLibVersion
	if err := database.DB.Where("lib_id = ? AND version = ?", id, body.Version).First(&ver).Error; err != nil {
        response.NotFound(c, "Version not found"); return
	}

	var lib model.SharedLib
	database.DB.First(&lib, "id = ?", id)

	// Save current as old version
	oldVer := model.SharedLibVersion{
		LibID: lib.ID, Version: lib.Version,
		Content: lib.Content, ChangedBy: middleware.GetUserID(c),
	}
	database.DB.Create(&oldVer)

	database.DB.Model(&lib).Updates(map[string]any{
		"content": ver.Content, "content_hash": util.SHA256Hex(ver.Content),
		"version": lib.Version + 1, "updated_by": middleware.GetUserID(c),
	})
    WriteAuditLogFromCtx(c, "restore", "shared_library", lib.ID, lib.Name,
		map[string]any{"version": body.Version, "newVersion": lib.Version + 1})
	response.OK(c, gin.H{"ok": true, "newVersion": lib.Version + 1})
}
