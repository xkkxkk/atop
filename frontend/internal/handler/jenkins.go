package handler

import (
	"fmt"
	"net/http"
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
	}
	var result []resp
	for _, j := range items {
		bindings := util.FromJSONDefault[[]string](j.ProjectBindings, []string{})
		result = append(result, resp{
			JenkinsInstance: j,
			HasAPIToken:     j.APITokenEncrypted != "",
			HasViewerToken:  j.ViewerTokenEncrypted != "",
			ProjectBindings: bindings,
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
		return false, latency, fmt.Errorf("Jenkins 返回 %d，请检查账号权限", resp.StatusCode)
	}
	return true, latency, nil
}

func (h *JenkinsHandler) Create(c *gin.Context) {
	var req jenkinsReq
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}
	var apiEnc, viewerEnc string
	if req.APIToken != "" {
		enc, err := util.Encrypt(req.APIToken)
		if err != nil { response.InternalError(c, "加密失败"); return }
		apiEnc = enc
	}
	if req.ViewerToken != "" {
		enc, err := util.Encrypt(req.ViewerToken)
		if err != nil { response.InternalError(c, "加密失败"); return }
		viewerEnc = enc
	}
	if req.IsDefault {
		database.DB.Model(&model.JenkinsInstance{}).Where("is_default = ?", true).Update("is_default", false)
	}
	// Ping check before saving
	ok, latency, pingErr := pingCheck(req.URL, req.Username, req.APIToken)
	if !ok {
		errMsg := "无法连接到 Jenkins，请检查地址和凭证"
		if pingErr != nil {
			errMsg = "连接失败：" + pingErr.Error()
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
		Status:               "ok",
		CreatedBy:            middleware.GetUserID(c),
		UpdatedBy:            middleware.GetUserID(c),
	}
	now := time.Now()
	inst.LastPingAt = &now
	database.DB.Create(&inst)
	response.Created(c, gin.H{"id": inst.ID, "name": inst.Name, "status": "ok", "latencyMs": latency})
}

func (h *JenkinsHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var inst model.JenkinsInstance
	if err := database.DB.First(&inst, "id = ?", id).Error; err != nil {
		response.NotFound(c, "实例不存在"); return
	}
	var req jenkinsReq
	c.ShouldBindJSON(&req)

	updates := map[string]any{
		"name": req.Name, "url": req.URL, "username": req.Username,
		"is_default": req.IsDefault,
		"project_bindings": util.ToJSON(req.ProjectBindings),
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
			errMsg := "无法连接到 Jenkins，请检查地址和凭证"
			if pingErr != nil {
				errMsg = "连接失败：" + pingErr.Error()
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
	response.OK(c, gin.H{"ok": true})
}

func (h *JenkinsHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	database.DB.Where("id = ?", id).Delete(&model.JenkinsInstance{})
	response.OK(c, gin.H{"ok": true})
}

// Ping tests connectivity to a Jenkins instance.
func (h *JenkinsHandler) Ping(c *gin.Context) {
	id := c.Param("id")
	var inst model.JenkinsInstance
	if err := database.DB.First(&inst, "id = ?", id).Error; err != nil {
		response.NotFound(c, "实例不存在"); return
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
		response.NotFound(c, "实例不存在"); return
	}

	jc, err := scheduler.NewJenkinsClient(&inst)
	if err != nil {
		response.InternalError(c, "初始化 Jenkins 客户端失败: "+err.Error()); return
	}

	nodes, err := jc.SyncNodes()
	if err != nil {
		response.InternalError(c, "同步失败: "+err.Error()); return
	}

	// Build label → nodes map
	labelMap := make(map[string][]map[string]any)
	for _, node := range nodes {
		name, _ := node["displayName"].(string)
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
		for _, label := range labels {
			labelMap[label] = append(labelMap[label], map[string]any{
				"name": name, "offline": offline,
			})
		}
	}

	// Upsert agent_labels
	now := time.Now()
	synced := 0
	for label, nodeList := range labelMap {
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
			if err := database.DB.Where("node_id = ? AND jenkins_instance_id = ?", nodeName, id).
				First(&an).Error; err != nil {
				an = model.AgentNode{
					NodeID:            nodeName,
					Name:              nodeName,
					LabelID:           ag.ID,
					JenkinsInstanceID: id,
					Online:            onl,
					LastSyncAt:        &now,
				}
				database.DB.Create(&an)
			} else {
				database.DB.Model(&an).Updates(map[string]any{
					"online":       onl,
					"last_sync_at": now,
				})
			}
		}
		synced++
	}

	response.OK(c, gin.H{"synced": synced, "totalNodes": len(nodes)})
}

func (h *JenkinsHandler) ListLabels(c *gin.Context) {
	instanceID := c.Query("instanceId")
	db := database.DB.Model(&model.AgentLabel{})
	if instanceID != "" {
		db = db.Where("jenkins_instance_id = ?", instanceID)
	}
	var labels []model.AgentLabel
	db.Find(&labels)
	if labels == nil { labels = []model.AgentLabel{} }
	response.OK(c, labels)
}

// ListNodes returns agent nodes for a given label.
func (h *JenkinsHandler) ListNodes(c *gin.Context) {
	labelID := c.Param("labelId")
	var nodes []model.AgentNode
	database.DB.Where("label_id = ?", labelID).Order("online DESC, name ASC").Find(&nodes)
	if nodes == nil { nodes = []model.AgentNode{} }
	response.OK(c, nodes)
}

// ── Global Vars ───────────────────────────────────────────────────────────

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
	if item.Key == "" { response.BadRequest(c, "MISSING_KEY", "key 不能为空"); return }
	
	// 重复检查：变量名全局唯一
	var existing model.GlobalVar
	if err := database.DB.Where("key = ?", item.Key).First(&existing).Error; err == nil {
		response.BadRequest(c, "DUPLICATE_KEY", fmt.Sprintf("变量「%s」已存在", item.Key)); return
	}
	
	item.CreatedBy = middleware.GetUserID(c)
	item.UpdatedBy = middleware.GetUserID(c)
	database.DB.Create(&item)
	response.Created(c, item)
}

func (h *VarsHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var item model.GlobalVar
	if err := database.DB.First(&item, "id = ?", id).Error; err != nil {
		response.NotFound(c, "变量不存在"); return
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
			"message":       fmt.Sprintf("变量「%s」当前为全局变量，约有 %d 个测试集可能引用了它。修改为项目级后，其他项目的测试集将无法读取此变量，可能导致运行时失败。", item.Key, affectedCount),
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
	response.OK(c, item)
}

func (h *VarsHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	database.DB.Where("id = ?", id).Delete(&model.GlobalVar{})
	response.OK(c, gin.H{"ok": true})
}

// ── Shared Libs ───────────────────────────────────────────────────────────

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
		response.NotFound(c, "函数库不存在"); return
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
	response.Created(c, lib)
}

func (h *LibsHandler) Update(c *gin.Context) {
	id := c.Param("id")
	var lib model.SharedLib
	if err := database.DB.First(&lib, "id = ?", id).Error; err != nil {
		response.NotFound(c, "函数库不存在"); return
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
	response.OK(c, lib)
}

func (h *LibsHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	var lib model.SharedLib
	if err := database.DB.First(&lib, "id = ?", id).Error; err != nil {
		response.NotFound(c, "函数库不存在"); return
	}
	if lib.RefCount > 0 {
		response.Unprocessable(c, "IN_USE", fmt.Sprintf("被 %d 个测试集引用，无法删除", lib.RefCount))
		return
	}
	database.DB.Where("lib_id = ?", id).Delete(&model.SharedLibVersion{})
	database.DB.Delete(&lib)
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
		response.NotFound(c, "版本不存在"); return
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
	response.OK(c, gin.H{"ok": true, "newVersion": lib.Version + 1})
}
