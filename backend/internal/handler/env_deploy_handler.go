package handler

import (
	"crypto/md5"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/pkg/response"
)

type EnvDeployHandler struct{}

func NewEnvDeployHandler() *EnvDeployHandler { return &EnvDeployHandler{} }

func envProfileAuditName(p model.EnvProfile) string {
	if name := strings.TrimSpace(p.Name); name != "" {
		return name
	}
	return p.ID
}

func (h *EnvDeployHandler) ListProfiles(c *gin.Context) {
	var profiles []model.EnvProfile
	db := database.DB
	if proj := c.Query("project"); proj != "" {
		db = db.Where("project = ?", proj)
	}
	db.Order("created_at desc").Find(&profiles)
	response.OK(c, gin.H{"items": profiles, "total": len(profiles)})
}

func (h *EnvDeployHandler) CreateProfile(c *gin.Context) {
	var p model.EnvProfile
	if err := c.ShouldBindJSON(&p); err != nil {
		response.BadRequest(c, "ERROR", err.Error())
		return
	}
	if uid, ok := c.Get("userID"); ok {
		p.CreatedBy = uid.(string)
	}
	if p.DeployScript != "" {
		p.ScriptHash = fmt.Sprintf("%x", md5.Sum([]byte(p.DeployScript)))
	}
	if err := database.DB.Create(&p).Error; err != nil {
		response.InternalError(c, "Create failed")
		return
	}
	WriteAuditLogFromCtx(c, "create", "env_profile", p.ID, envProfileAuditName(p), nil)
	response.OK(c, p)
}

func (h *EnvDeployHandler) GetProfile(c *gin.Context) {
	var p model.EnvProfile
	if err := database.DB.First(&p, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Profile not found")
		return
	}
	response.OK(c, p)
}

func (h *EnvDeployHandler) UpdateProfile(c *gin.Context) {
	var p model.EnvProfile
	if err := database.DB.First(&p, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Profile not found")
		return
	}
	old := p
	if err := c.ShouldBindJSON(&p); err != nil {
		response.BadRequest(c, "ERROR", err.Error())
		return
	}
	p.ID = c.Param("id")
	newHash := fmt.Sprintf("%x", md5.Sum([]byte(p.DeployScript)))
	if newHash != old.ScriptHash {
		p.ScriptHash = newHash
		database.DB.Model(&model.AgentDeployRecord{}).
			Where("profile_id = ? AND status = ?", p.ID, model.DeployStatusSuccess).
			Update("status", model.DeployStatusOutdated)
	}
	database.DB.Save(&p)
	WriteAuditLogFromCtx(c, "update", "env_profile", p.ID, envProfileAuditName(p), &old)
	response.OK(c, p)
}

func (h *EnvDeployHandler) DeleteProfile(c *gin.Context) {
	var p model.EnvProfile
	database.DB.First(&p, "id = ?", c.Param("id"))
	name := envProfileAuditName(p)
	if name == "" {
		name = c.Param("id")
	}
	database.DB.Delete(&model.EnvProfile{}, "id = ?", c.Param("id"))
	database.DB.Delete(&model.AgentDeployRecord{}, "profile_id = ?", c.Param("id"))
	WriteAuditLogFromCtx(c, "delete", "env_profile", c.Param("id"), name, nil)
	response.OK(c, nil)
}

func (h *EnvDeployHandler) ListRecords(c *gin.Context) {
	var records []model.AgentDeployRecord
	database.DB.Where("profile_id = ?", c.Param("id")).
		Order("node_label asc").Find(&records)

	var prof model.EnvProfile
	if err := database.DB.First(&prof, "id = ?", c.Param("id")).Error; err == nil {
		for i := range records {
			if records[i].Status == model.DeployStatusSuccess &&
				records[i].DeployHash != prof.ScriptHash {
				records[i].Status = model.DeployStatusOutdated
			}
		}
	}
	response.OK(c, gin.H{"items": records, "total": len(records)})
}

func (h *EnvDeployHandler) ListNodes(c *gin.Context) {
	var prof model.EnvProfile
	if err := database.DB.First(&prof, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Profile not found")
		return
	}

	var nodes []model.AgentNode
	database.DB.Where("label = ?", prof.AgentLabel).Find(&nodes)

	var records []model.AgentDeployRecord
	database.DB.Where("profile_id = ?", prof.ID).Find(&records)
	recMap := make(map[string]model.AgentDeployRecord)
	for _, r := range records {
		recMap[r.NodeID] = r
	}

	type nodeRow struct {
		NodeID    string                   `json:"nodeId"`
		NodeLabel string                   `json:"nodeLabel"`
		Online    bool                     `json:"online"`
		Record    *model.AgentDeployRecord `json:"record"`
	}
	rows := make([]nodeRow, 0, len(nodes))
	for _, n := range nodes {
		var rec *model.AgentDeployRecord
		if r, ok := recMap[n.NodeID]; ok {
			if r.Status == model.DeployStatusSuccess && r.DeployHash != prof.ScriptHash {
				r.Status = model.DeployStatusOutdated
			}
			rec = &r
		}
		rows = append(rows, nodeRow{
			NodeID: n.NodeID, NodeLabel: n.NodeID, Online: n.Online, Record: rec,
		})
	}
	response.OK(c, gin.H{"items": rows, "total": len(rows), "profile": prof})
}

func (h *EnvDeployHandler) TriggerDeploy(c *gin.Context) {
	var req struct {
		NodeIDs []string `json:"nodeIds"`
		All     bool     `json:"all"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "ERROR", err.Error())
		return
	}

	var prof model.EnvProfile
	if err := database.DB.First(&prof, "id = ?", c.Param("id")).Error; err != nil {
		response.NotFound(c, "Profile not found")
		return
	}

	uid := ""
	if u, ok := c.Get("userID"); ok {
		uid = u.(string)
	}

	if req.All {
		var nodes []model.AgentNode
		database.DB.Where("label = ?", prof.AgentLabel).Find(&nodes)
		for _, n := range nodes {
			req.NodeIDs = append(req.NodeIDs, n.NodeID)
		}
	}

	now := time.Now()
	var created []string
	for _, nodeID := range req.NodeIDs {
		var rec model.AgentDeployRecord
		result := database.DB.Where("profile_id = ? AND node_id = ?", prof.ID, nodeID).First(&rec)
		if result.Error != nil {
			rec = model.AgentDeployRecord{
				ProfileID:  prof.ID,
				NodeID:     nodeID,
				NodeLabel:  prof.AgentLabel,
				DeployHash: prof.ScriptHash,
				Status:     model.DeployStatusPending,
				DeployedBy: uid,
				DeployedAt: &now,
			}
			database.DB.Create(&rec)
		} else {
			database.DB.Model(&rec).Updates(map[string]any{
				"status":      model.DeployStatusPending,
				"deploy_hash": prof.ScriptHash,
				"deployed_by": uid,
				"deployed_at": &now,
			})
		}
		created = append(created, nodeID)
	}

	WriteAuditLogFromCtx(c, "deploy", "env_profile", prof.ID, envProfileAuditName(prof), nil)
	response.OK(c, gin.H{
		"triggered": len(created),
		"nodeIds":   created,
		"message":   fmt.Sprintf("Created %d deploy tasks", len(created)),
	})
}

func (h *EnvDeployHandler) UpdateRecordStatus(c *gin.Context) {
	var req struct {
		Status     string `json:"status"`
		LastOutput string `json:"lastOutput"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "ERROR", err.Error())
		return
	}
	now := time.Now()
	database.DB.Model(&model.AgentDeployRecord{}).
		Where("profile_id = ? AND node_id = ?", c.Param("id"), c.Param("nodeId")).
		Updates(map[string]any{
			"status":      req.Status,
			"last_output": req.LastOutput,
			"deployed_at": &now,
		})
	response.OK(c, nil)
}

func (h *EnvDeployHandler) SyncNewNodes() {
	var profiles []model.EnvProfile
	database.DB.Find(&profiles)

	for _, prof := range profiles {
		var nodes []model.AgentNode
		database.DB.Where("label = ?", prof.AgentLabel).Find(&nodes)

		for _, node := range nodes {
			var rec model.AgentDeployRecord
			err := database.DB.Where("profile_id = ? AND node_id = ?", prof.ID, node.NodeID).First(&rec).Error
			if err != nil {
				database.DB.Create(&model.AgentDeployRecord{
					ProfileID: prof.ID,
					NodeID:    node.NodeID,
					NodeLabel: node.NodeID,
					Status:    model.DeployStatusPending,
				})

				if prof.AutoDeploy {
					_ = prof.DeployScript
				}
			}
		}
	}
}
