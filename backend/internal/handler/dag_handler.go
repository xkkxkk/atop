package handler

import (
	"encoding/json"
	"fmt"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/pkg/response"
)

type DAGHandler struct{}

type DAGData struct {
	Nodes []model.PipelineNode `json:"nodes"`
	Edges []model.PipelineEdge `json:"edges"`
}

func (h *DAGHandler) GetDAG(c *gin.Context) {
	pipelineID := c.Param("id")

	var nodes []model.PipelineNode
	var edges []model.PipelineEdge
	database.DB.Where("pipeline_id = ?", pipelineID).Find(&nodes)
	database.DB.Where("pipeline_id = ?", pipelineID).Find(&edges)

	if nodes == nil {
		nodes = []model.PipelineNode{}
	}
	if edges == nil {
		edges = []model.PipelineEdge{}
	}

	response.OK(c, DAGData{Nodes: nodes, Edges: edges})
}

func (h *DAGHandler) SaveDAG(c *gin.Context) {
	pipelineID := c.Param("id")

	var pipeline model.Pipeline
	if err := database.DB.First(&pipeline, "id = ?", pipelineID).Error; err != nil {
		response.NotFound(c, "Pipeline not found")
		return
	}

	var body DAGData
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "INVALID_PARAMS", err.Error())
		return
	}

	for _, e := range body.Edges {
		if e.SourceID == e.TargetID {
			response.BadRequest(c, "SELF_LOOP", fmt.Sprintf("Node %s cannot depend on itself", e.SourceID))
			return
		}
	}

	if err := detectCycle(body.Nodes, body.Edges); err != nil {
		response.BadRequest(c, "CYCLE_DETECTED", err.Error())
		return
	}

	for _, node := range body.Nodes {
		if node.NodeType == "pipeline" {
			if err := detectNestingCycle(pipelineID, node.RefID, []string{pipelineID}); err != nil {
				response.BadRequest(c, "NESTING_CYCLE", err.Error())
				return
			}
		}
	}

	if err := database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("pipeline_id = ?", pipelineID).Delete(&model.PipelineNode{}).Error; err != nil {
			return err
		}
		if err := tx.Where("pipeline_id = ?", pipelineID).Delete(&model.PipelineEdge{}).Error; err != nil {
			return err
		}
		for i := range body.Nodes {
			if body.Nodes[i].ID == "" {
				body.Nodes[i].ID = uuid.New().String()
			}
			body.Nodes[i].PipelineID = pipelineID
			if err := tx.Create(&body.Nodes[i]).Error; err != nil {
				return err
			}
		}
		for i := range body.Edges {
			if body.Edges[i].ID == "" {
				body.Edges[i].ID = uuid.New().String()
			}
			body.Edges[i].PipelineID = pipelineID
			if err := tx.Create(&body.Edges[i]).Error; err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		response.InternalError(c, "Save DAG failed")
		return
	}

	WriteAuditLogFromCtx(c, "save_dag", "pipeline", pipelineID, pipeline.Name, map[string]any{
		"nodes": len(body.Nodes), "edges": len(body.Edges),
	})
	response.OK(c, gin.H{"ok": true, "nodes": len(body.Nodes), "edges": len(body.Edges)})
}

func (h *DAGHandler) GetAvailablePipelines(c *gin.Context) {
	pipelineID := c.Param("id")
	excluded := getAncestorPipelines(pipelineID)
	excluded[pipelineID] = true

	var pipelines []model.Pipeline
	database.DB.Select("id, name, project").Find(&pipelines)

	var available []gin.H
	for _, p := range pipelines {
		if !excluded[p.ID] {
			available = append(available, gin.H{
				"id": p.ID, "name": p.Name, "project": p.Project,
			})
		}
	}
	if available == nil {
		available = []gin.H{}
	}
	response.OK(c, available)
}

func detectCycle(nodes []model.PipelineNode, edges []model.PipelineEdge) error {
	adj := make(map[string][]string)
	nodeSet := make(map[string]bool)
	for _, n := range nodes {
		nodeSet[n.ID] = true
		adj[n.ID] = []string{}
	}
	for _, e := range edges {
		adj[e.SourceID] = append(adj[e.SourceID], e.TargetID)
	}

	color := make(map[string]int)
	var dfs func(id string) error
	dfs = func(id string) error {
		color[id] = 1
		for _, next := range adj[id] {
			if color[next] == 1 {
				return fmt.Errorf("Cycle detected in DAG dependencies")
			}
			if color[next] == 0 {
				if err := dfs(next); err != nil {
					return err
				}
			}
		}
		color[id] = 2
		return nil
	}

	for id := range nodeSet {
		if color[id] == 0 {
			if err := dfs(id); err != nil {
				return err
			}
		}
	}
	return nil
}

func detectNestingCycle(parentID, subPipelineID string, visited []string) error {
	var subNodes []model.PipelineNode
	database.DB.Where("pipeline_id = ? AND node_type = 'pipeline'", subPipelineID).Find(&subNodes)

	for _, node := range subNodes {
		for _, v := range visited {
			if node.RefID == v {
				return fmt.Errorf("Nested cycle detected for pipeline %s", subPipelineID)
			}
		}
		if err := detectNestingCycle(parentID, node.RefID, append(visited, subPipelineID)); err != nil {
			return err
		}
	}
	return nil
}

func getAncestorPipelines(pipelineID string) map[string]bool {
	result := make(map[string]bool)
	var queue []string

	var nodes []model.PipelineNode
	database.DB.Where("node_type = 'pipeline' AND ref_id = ?", pipelineID).Find(&nodes)
	for _, n := range nodes {
		if !result[n.PipelineID] {
			result[n.PipelineID] = true
			queue = append(queue, n.PipelineID)
		}
	}

	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]
		var parents []model.PipelineNode
		database.DB.Where("node_type = 'pipeline' AND ref_id = ?", curr).Find(&parents)
		for _, p := range parents {
			if !result[p.PipelineID] {
				result[p.PipelineID] = true
				queue = append(queue, p.PipelineID)
			}
		}
	}
	return result
}

func (h *DAGHandler) GetDAGExecutionPlan(c *gin.Context) {
	pipelineID := c.Param("id")

	var pipeline model.Pipeline
	if err := database.DB.First(&pipeline, "id = ?", pipelineID).Error; err != nil {
		response.NotFound(c, "Pipeline not found")
		return
	}

	if pipeline.DAGConfigJSON == "" {
		response.OK(c, []any{})
		return
	}

	var dagCfg model.DAGConfig
	if err := json.Unmarshal([]byte(pipeline.DAGConfigJSON), &dagCfg); err != nil {
		response.BadRequest(c, "INVALID_DAG", "Failed to parse DAG config")
		return
	}

	sorted, err := TopologicalSortConfig(dagCfg)
	if err != nil {
		response.BadRequest(c, "INVALID_DAG", err.Error())
		return
	}

	layerMap := make(map[string]int)
	for i, n := range sorted {
		layerMap[n.ID] = i
	}

	type NodeInfo struct {
		Layer  int    `json:"layer"`
		NodeID string `json:"nodeId"`
		Label  string `json:"label"`
		Type   string `json:"type"`
	}
	var plan []NodeInfo
	for _, n := range sorted {
		plan = append(plan, NodeInfo{
			Layer:  layerMap[n.ID],
			NodeID: n.ID,
			Label:  n.Label,
			Type:   string(n.Type),
		})
	}
	response.OK(c, plan)
}

func parseParamOverrides(node model.DAGNode) map[string]string {
	if "" == "" {
		return nil
	}
	var result map[string]string
	json.Unmarshal([]byte(""), &result)
	return result
}
