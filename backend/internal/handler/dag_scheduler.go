package handler

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/scheduler"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/logger"
)

type dagRelations struct {
	triggerDeps map[string][]string
	edgeTypes   map[string]model.DAGEdgeType
	detached    map[string]bool
}

type DAGTopologySummary struct {
	StartNodes    []string `json:"startNodes"`
	EndNodes      []string `json:"endNodes"`
	WaitEdges     int      `json:"waitEdges"`
	DetachedEdges int      `json:"detachedEdges"`
}

func normalizeEdgeType(t model.DAGEdgeType) model.DAGEdgeType {
	if t == model.DAGEdgeDetached {
		return model.DAGEdgeDetached
	}
	return model.DAGEdgeWait
}

func normalizeJoinPolicy(policy string) string {
	if strings.TrimSpace(policy) == model.DAGJoinAny {
		return model.DAGJoinAny
	}
	return model.DAGJoinAll
}

func normalizeFailurePolicy(policy string) string {
	if strings.TrimSpace(policy) == model.DAGFailureContinue {
		return model.DAGFailureContinue
	}
	return model.DAGFailureBlock
}

func edgeKey(source, target string) string {
	return source + "->" + target
}

func appendUnique(values []string, value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return values
	}
	for _, item := range values {
		if item == value {
			return values
		}
	}
	return append(values, value)
}

func nodeIDSet(nodes []model.DAGNode) map[string]bool {
	set := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		if strings.TrimSpace(n.ID) != "" {
			set[n.ID] = true
		}
	}
	return set
}

func normalizedDAGEdges(cfg model.DAGConfig) []model.DAGEdge {
	nodes := nodeIDSet(cfg.Nodes)
	seen := make(map[string]bool)
	edges := make([]model.DAGEdge, 0, len(cfg.Edges))

	for _, edge := range cfg.Edges {
		edge.Source = strings.TrimSpace(edge.Source)
		edge.Target = strings.TrimSpace(edge.Target)
		if edge.Source == "" || edge.Target == "" || edge.Source == edge.Target {
			continue
		}
		if !nodes[edge.Source] || !nodes[edge.Target] {
			continue
		}
		key := edgeKey(edge.Source, edge.Target)
		if seen[key] {
			continue
		}
		edge.Type = normalizeEdgeType(edge.Type)
		edges = append(edges, edge)
		seen[key] = true
	}

	// Backward compatibility: old configs only stored node.dependsOn.
	for _, node := range cfg.Nodes {
		for _, dep := range node.DependsOn {
			dep = strings.TrimSpace(dep)
			if dep == "" || dep == node.ID || !nodes[dep] {
				continue
			}
			key := edgeKey(dep, node.ID)
			if seen[key] {
				continue
			}
			edges = append(edges, model.DAGEdge{
				Source: dep,
				Target: node.ID,
				Type:   model.DAGEdgeWait,
			})
			seen[key] = true
		}
	}

	return edges
}

func buildDAGRelations(cfg model.DAGConfig) dagRelations {
	relations := dagRelations{
		triggerDeps: make(map[string][]string, len(cfg.Nodes)),
		edgeTypes:   make(map[string]model.DAGEdgeType),
		detached:    make(map[string]bool, len(cfg.Nodes)),
	}
	for _, node := range cfg.Nodes {
		relations.triggerDeps[node.ID] = []string{}
	}

	for _, edge := range normalizedDAGEdges(cfg) {
		relations.triggerDeps[edge.Target] = appendUnique(relations.triggerDeps[edge.Target], edge.Source)
		relations.edgeTypes[edgeKey(edge.Source, edge.Target)] = normalizeEdgeType(edge.Type)
	}

	changed := true
	for changed {
		changed = false
		for _, node := range cfg.Nodes {
			if relations.detached[node.ID] {
				continue
			}
			deps := relations.triggerDeps[node.ID]
			if len(deps) == 0 {
				continue
			}
			allDetached := true
			hasDetachedSignal := false
			for _, dep := range deps {
				t := relations.edgeTypes[edgeKey(dep, node.ID)]
				if t == model.DAGEdgeDetached || relations.detached[dep] {
					hasDetachedSignal = true
				}
				if t != model.DAGEdgeDetached && !relations.detached[dep] {
					allDetached = false
					break
				}
			}
			if hasDetachedSignal && allDetached {
				relations.detached[node.ID] = true
				changed = true
			}
		}
	}

	return relations
}

func HasDAGCycle(cfg model.DAGConfig) bool {
	nodes := nodeIDSet(cfg.Nodes)
	adj := make(map[string][]string, len(nodes))
	for id := range nodes {
		adj[id] = []string{}
	}
	for _, edge := range normalizedDAGEdges(cfg) {
		adj[edge.Source] = append(adj[edge.Source], edge.Target)
	}

	visited := make(map[string]bool)
	inStack := make(map[string]bool)
	var dfs func(id string) bool
	dfs = func(id string) bool {
		if inStack[id] {
			return true
		}
		if visited[id] {
			return false
		}
		visited[id] = true
		inStack[id] = true
		for _, next := range adj[id] {
			if nodes[next] && dfs(next) {
				return true
			}
		}
		inStack[id] = false
		return false
	}

	for id := range nodes {
		if !visited[id] && dfs(id) {
			return true
		}
	}
	return false
}

func HasCycle(nodes []model.DAGNode) bool {
	return HasDAGCycle(model.DAGConfig{Nodes: nodes})
}

func TopologicalSortConfig(cfg model.DAGConfig) ([]model.DAGNode, error) {
	nodes := nodeIDSet(cfg.Nodes)
	inDegree := make(map[string]int, len(cfg.Nodes))
	byID := make(map[string]model.DAGNode, len(cfg.Nodes))
	adj := make(map[string][]string, len(cfg.Nodes))
	for _, node := range cfg.Nodes {
		inDegree[node.ID] = 0
		byID[node.ID] = node
		adj[node.ID] = []string{}
	}
	for _, edge := range normalizedDAGEdges(cfg) {
		if !nodes[edge.Source] || !nodes[edge.Target] {
			continue
		}
		adj[edge.Source] = append(adj[edge.Source], edge.Target)
		inDegree[edge.Target]++
	}

	queue := make([]model.DAGNode, 0)
	for _, node := range cfg.Nodes {
		if inDegree[node.ID] == 0 {
			queue = append(queue, node)
		}
	}

	sorted := make([]model.DAGNode, 0, len(cfg.Nodes))
	for len(queue) > 0 {
		node := queue[0]
		queue = queue[1:]
		sorted = append(sorted, node)
		for _, target := range adj[node.ID] {
			inDegree[target]--
			if inDegree[target] == 0 {
				queue = append(queue, byID[target])
			}
		}
	}
	if len(sorted) != len(cfg.Nodes) {
		return nil, fmt.Errorf("DAG contains a cyclic dependency")
	}
	return sorted, nil
}

func TopologicalSort(nodes []model.DAGNode) ([]model.DAGNode, error) {
	return TopologicalSortConfig(model.DAGConfig{Nodes: nodes})
}

func nodeDisplayName(n model.DAGNode) string {
	label := strings.TrimSpace(n.Label)
	if label == "" {
		label = strings.TrimSpace(n.ID)
	}
	if label == "" {
        return "Unnamed component"
	}
	return label
}

func ValidateDAGTopology(cfg model.DAGConfig) (*DAGTopologySummary, error) {
	if len(cfg.Nodes) == 0 {
        return nil, fmt.Errorf("Please add at least one executable component")
	}

	ids := make(map[string]bool, len(cfg.Nodes))
	labels := make(map[string]string, len(cfg.Nodes))
	inDegree := make(map[string]int, len(cfg.Nodes))
	outDegree := make(map[string]int, len(cfg.Nodes))
	for _, node := range cfg.Nodes {
		id := strings.TrimSpace(node.ID)
		if id == "" {
			return nil, fmt.Errorf("A component is missing its ID; please recreate that component")
		}
		if ids[id] {
			return nil, fmt.Errorf("Duplicate component ID: %s", id)
		}
		ids[id] = true
		labels[id] = nodeDisplayName(node)
		inDegree[id] = 0
		outDegree[id] = 0

		switch node.Type {
		case model.DAGNodeJenkins, model.DAGNodePipeline, model.DAGNodeGate, model.DAGNodeTestSet:
		default:
			return nil, fmt.Errorf("Component %q has an unsupported type", labels[id])
		}
	}

	edges := normalizedDAGEdges(cfg)
	for _, edge := range edges {
		if !ids[edge.Source] || !ids[edge.Target] {
            return nil, fmt.Errorf("An edge references a component that does not exist")
		}
		outDegree[edge.Source]++
		inDegree[edge.Target]++
	}
	summary := &DAGTopologySummary{
		StartNodes: make([]string, 0),
		EndNodes:   make([]string, 0),
	}
	for _, edge := range edges {
		if normalizeEdgeType(edge.Type) == model.DAGEdgeDetached {
			summary.DetachedEdges++
		} else {
			summary.WaitEdges++
		}
	}

	for _, node := range cfg.Nodes {
		id := strings.TrimSpace(node.ID)
		if len(edges) > 0 && inDegree[id] == 0 && outDegree[id] == 0 {
			return nil, fmt.Errorf("Component %q has no edges. Connect it to a branch or keep only valid parallel components", labels[id])
		}
		switch node.Type {
		case model.DAGNodeGate:
			if inDegree[id] < 2 {
                return nil, fmt.Errorf("Gate component %q must have at least two upstream branches", labels[id])
			}
			if outDegree[id] == 0 {
				return nil, fmt.Errorf("Gate component %q must connect to a downstream component", labels[id])
			}
		case model.DAGNodePipeline:
			if strings.TrimSpace(node.RefID) == "" {
                return nil, fmt.Errorf("Sub-pipeline component %q does not have a selected pipeline", labels[id])
			}
		}

		if inDegree[id] == 0 {
			summary.StartNodes = append(summary.StartNodes, id)
		}
		if outDegree[id] == 0 {
			summary.EndNodes = append(summary.EndNodes, id)
		}
	}

	if len(summary.StartNodes) == 0 {
		return nil, fmt.Errorf("DAG is missing a start component")
	}
	for _, id := range summary.StartNodes {
		var nodeType model.DAGNodeType
		for _, node := range cfg.Nodes {
			if node.ID == id {
				nodeType = node.Type
				break
			}
		}
		if nodeType == model.DAGNodeGate {
            return nil, fmt.Errorf("Gate component %q cannot be the start node", labels[id])
		}
	}

	return summary, nil
}

func defaultDAGNodeLabel(t model.DAGNodeType) string {
	switch t {
	case model.DAGNodeJenkins:
		return "Jenkins component"
	default:
		return "Run component"
	}
}

func CreateDAGTaskRuns(run *model.PipelineRun, cfg model.DAGConfig,
	runtimeParams map[string]string, _ string) error {

	if HasDAGCycle(cfg) {
	return fmt.Errorf("DAG contains a cyclic dependency")
	}
	if _, err := ValidateDAGTopology(cfg); err != nil {
		return err
	}

	relations := buildDAGRelations(cfg)
	for _, node := range cfg.Nodes {
		var tr model.TaskRun
		switch node.Type {
		case model.DAGNodeTestSet:
			var ts model.TestSet
			if err := database.DB.First(&ts, "id = ?", node.RefID).Error; err != nil {
                return fmt.Errorf("DAG node %s references a test set that does not exist", node.Label)
			}
			tr = model.TaskRun{
				PipelineRunID:    run.ID,
				TestSetID:        ts.ID,
				TestSetName:      ts.Name,
				Project:          ts.Project,
				AgentLabel:       ts.AgentLabel,
				Status:           "waiting",
				LogStatus:        "unknown",
				DAGNodeID:        node.ID,
				DAGNodeType:      string(node.Type),
				DAGDetached:      relations.detached[node.ID],
				DAGJoinPolicy:    normalizeJoinPolicy(node.JoinPolicy),
				DAGFailurePolicy: normalizeFailurePolicy(node.FailurePolicy),
			}

		case model.DAGNodeJenkins:
			label := strings.TrimSpace(node.Label)
			if label == "" {
				label = defaultDAGNodeLabel(node.Type)
			}
			tr = model.TaskRun{
				PipelineRunID:    run.ID,
				TestSetID:        "",
				TestSetName:      label,
				Status:           "waiting",
				LogStatus:        "unknown",
				DAGNodeID:        node.ID,
				DAGNodeType:      string(node.Type),
				DAGDetached:      relations.detached[node.ID],
				DAGJoinPolicy:    normalizeJoinPolicy(node.JoinPolicy),
				DAGFailurePolicy: normalizeFailurePolicy(node.FailurePolicy),
			}

		case model.DAGNodeGate:
			label := strings.TrimSpace(node.Label)
			if label == "" {
		label = "Wait and merge"
			}
			tr = model.TaskRun{
				PipelineRunID:    run.ID,
				TestSetID:        "",
				TestSetName:      label,
				Status:           "waiting",
				LogStatus:        "unknown",
				DAGNodeID:        node.ID,
				DAGNodeType:      string(node.Type),
				DAGDetached:      relations.detached[node.ID],
				DAGJoinPolicy:    normalizeJoinPolicy(node.JoinPolicy),
				DAGFailurePolicy: normalizeFailurePolicy(node.FailurePolicy),
			}

		case model.DAGNodePipeline:
			if strings.TrimSpace(node.RefID) == "" {
				return fmt.Errorf("DAG node %s is missing a sub-pipeline reference", node.Label)
			}
			tr = model.TaskRun{
				PipelineRunID:    run.ID,
				TestSetID:        "",
				TestSetName:      node.Label,
				Status:           "waiting",
				LogStatus:        "unknown",
				DAGNodeID:        node.ID,
				DAGNodeType:      string(node.Type),
				SubPipelineID:    node.RefID,
				DAGDetached:      relations.detached[node.ID],
				DAGJoinPolicy:    normalizeJoinPolicy(node.JoinPolicy),
				DAGFailurePolicy: normalizeFailurePolicy(node.FailurePolicy),
			}
			if len(node.ParamMapping) > 0 {
				b, _ := json.Marshal(node.ParamMapping)
				tr.ParamMappingJSON = string(b)
			}

		default:
            return fmt.Errorf("DAG node %s has an unsupported type", node.Label)
		}

		if len(node.InputMapping) > 0 {
			b, _ := json.Marshal(node.InputMapping)
			tr.NodeInputJSON = string(b)
		}
		if len(node.Config) > 0 {
			b, _ := json.Marshal(node.Config)
			tr.NodeConfigJSON = string(b)
		}

		deps := relations.triggerDeps[node.ID]
		if len(deps) > 0 {
			b, _ := json.Marshal(deps)
			tr.DAGDepsJSON = string(b)
		} else {
			if tr.SubPipelineID == "" {
				tr.Status = "pending"
			}
		}

		tr.ID = uuid.New().String()
		if err := database.DB.Create(&tr).Error; err != nil {
			return err
		}
	}

	if runtimeParams == nil {
		runtimeParams = map[string]string{}
	}
	scheduler.RefreshRunContext(run.ID)
	AdvanceDAGRun(run.ID)
	return nil
}

func terminalStatus(status string) bool {
	switch status {
	case "success", "failed", "error", "aborted", "blocked", "submit_failed":
		return true
	default:
		return false
	}
}

func failedStatus(status string) bool {
	switch status {
	case "failed", "error", "aborted", "blocked", "submit_failed":
		return true
	default:
		return false
	}
}

func dependencyFailureCanContinue(current model.TaskRun, dependency model.TaskRun) bool {
	return normalizeFailurePolicy(current.DAGFailurePolicy) == model.DAGFailureContinue ||
		normalizeFailurePolicy(dependency.DAGFailurePolicy) == model.DAGFailureContinue
}

func dagReady(t model.TaskRun, deps []string, tasksByNode map[string]model.TaskRun) (ready bool, blocked bool, reason string) {
	if len(deps) == 0 {
		return true, false, ""
	}

	finishedCount := 0
	satisfiedCount := 0
	blockingFailedCount := 0
	missingCount := 0
	for _, dep := range deps {
		task, ok := tasksByNode[dep]
		if !ok {
			missingCount++
			continue
		}
		if terminalStatus(task.Status) {
			finishedCount++
		}
		if task.Status == "success" {
			satisfiedCount++
			continue
		}
		if failedStatus(task.Status) {
			if dependencyFailureCanContinue(t, task) {
				satisfiedCount++
			} else {
				blockingFailedCount++
			}
		}
	}

	if missingCount > 0 {
		return false, false, ""
	}

	joinPolicy := normalizeJoinPolicy(t.DAGJoinPolicy)
	if joinPolicy == model.DAGJoinAny {
		if satisfiedCount > 0 {
			return true, false, ""
		}
		if finishedCount == len(deps) {
			if blockingFailedCount > 0 {
                return false, true, "All upstream dependencies are unsatisfied, current node is blocked"
			}
            return false, true, "All upstream dependencies are unsuccessful"
		}
		return false, false, ""
	}

	if blockingFailedCount > 0 {
		return false, true, "An upstream dependency failed and the current node is blocked"
	}
	return satisfiedCount == len(deps), false, ""
}

func blockTask(task model.TaskRun, reason string) {
	now := time.Now()
	database.DB.Model(&model.TaskRun{}).Where("id = ? AND status = 'waiting'", task.ID).Updates(map[string]any{
		"status":        "blocked",
		"error_summary": reason,
		"finished_at":   now,
	})
}

func completePendingGateTasks(pipelineRunID string) bool {
	var gates []model.TaskRun
	database.DB.Where("pipeline_run_id = ? AND status = 'pending' AND dag_node_type = ?", pipelineRunID, string(model.DAGNodeGate)).Find(&gates)
	if len(gates) == 0 {
		return false
	}
	now := time.Now()
	for _, gate := range gates {
		outputs, _ := json.Marshal(map[string]any{
			"gate":   gate.DAGNodeID,
			"status": "success",
		})
		database.DB.Model(&model.TaskRun{}).Where("id = ? AND status = 'pending'", gate.ID).Updates(map[string]any{
			"status":       "success",
			"started_at":   now,
			"finished_at":  now,
			"duration_ms":  int64(0),
			"outputs_json": string(outputs),
		})
	}
	scheduler.RefreshRunContext(pipelineRunID)
	return true
}

func AdvanceDAGRun(pipelineRunID string) {
	if completePendingGateTasks(pipelineRunID) {
		updatePipelineRunCounters(pipelineRunID)
	}

	var allTasks []model.TaskRun
	database.DB.Where("pipeline_run_id = ?", pipelineRunID).Find(&allTasks)
	if len(allTasks) == 0 {
		return
	}

	tasksByNode := make(map[string]model.TaskRun, len(allTasks))
	for _, task := range allTasks {
		if task.DAGNodeID != "" {
			tasksByNode[task.DAGNodeID] = task
		}
	}

	changed := false
	shouldDispatch := false
	for _, task := range allTasks {
		if task.Status != "waiting" && !(task.Status == "pending" && task.SubPipelineID != "") {
			continue
		}
		var deps []string
		if task.DAGDepsJSON != "" {
			_ = json.Unmarshal([]byte(task.DAGDepsJSON), &deps)
		}
		ready, blocked, reason := dagReady(task, deps, tasksByNode)
		if blocked {
			blockTask(task, reason)
			changed = true
			continue
		}
		if !ready {
			continue
		}

		if task.Status == "waiting" {
			res := database.DB.Model(&model.TaskRun{}).
				Where("id = ? AND status = 'waiting'", task.ID).
				Update("status", "pending")
			if res.RowsAffected == 0 {
				continue
			}
			task.Status = "pending"
			changed = true
		}
		if task.DAGNodeType == string(model.DAGNodeGate) {
			if completePendingGateTasks(pipelineRunID) {
				changed = true
			}
		} else if task.SubPipelineID != "" {
			go triggerSubPipeline(&task, pipelineRunID)
		} else {
			shouldDispatch = true
		}
	}

	if changed {
		updatePipelineRunCounters(pipelineRunID)
	}
	if shouldDispatch && scheduler.Global != nil {
		go scheduler.Global.DispatchRun(pipelineRunID)
	}
}

func triggerSubPipeline(parentTask *model.TaskRun, parentRunID string) {
	res := database.DB.Model(&model.TaskRun{}).
		Where("id = ? AND status IN ?", parentTask.ID, []string{"pending", "waiting"}).
		Update("status", "running")
	if res.RowsAffected == 0 {
		return
	}

	var parentRun model.PipelineRun
	if err := database.DB.First(&parentRun, "id = ?", parentRunID).Error; err != nil {
		return
	}

	var subPipeline model.Pipeline
	if err := database.DB.First(&subPipeline, "id = ?", parentTask.SubPipelineID).Error; err != nil {
		markTaskFailed(parentTask.ID, "Sub-pipeline not found: "+err.Error())
		return
	}

	parentParams := util.FromJSONDefault[map[string]string](parentRun.RuntimeParams, map[string]string{})
	childParams := make(map[string]string)
	var mapping map[string]string
	if parentTask.ParamMappingJSON != "" {
		_ = json.Unmarshal([]byte(parentTask.ParamMappingJSON), &mapping)
	}
	if len(mapping) == 0 {
		for k, v := range parentParams {
			childParams[k] = v
		}
	} else {
		for parentKey, childKey := range mapping {
			if v, ok := parentParams[parentKey]; ok {
				childParams[childKey] = v
			}
		}
	}

	nodeInputs := util.FromJSONDefault[map[string]string](parentTask.NodeInputJSON, nil)
	if len(nodeInputs) > 0 {
		resolved, err := scheduler.ResolveInputMapping(nodeInputs, scheduler.BuildExpressionContext(&parentRun))
		if err != nil {
		markTaskFailed(parentTask.ID, "Failed to parse sub-pipeline parameters: "+err.Error())
			return
		}
		for k, v := range resolved {
			childParams[k] = v
		}
	}

	childParamsJSON, _ := json.Marshal(childParams)
	now := time.Now()
	childRun := model.PipelineRun{
		PipelineID:    subPipeline.ID,
		PipelineName:  subPipeline.Name,
		Status:        "pending",
		TriggerType:   "dag",
		TriggeredBy:   parentRun.TriggeredBy,
		RuntimeParams:  string(childParamsJSON),
		PipelineSnapshotJSON: scheduler.BuildPipelineConfigSnapshot(&subPipeline),
        Remark:         fmt.Sprintf("Triggered automatically by pipeline %q", parentRun.PipelineName),
		StartedAt:     &now,
		ParentRunID:   parentRunID,
		ParentTaskID:  parentTask.ID,
	}
	if err := database.DB.Create(&childRun).Error; err != nil {
		markTaskFailed(parentTask.ID, "Failed to create sub-pipeline run: "+err.Error())
		return
	}

	database.DB.Model(&model.TaskRun{}).Where("id = ?", parentTask.ID).Updates(map[string]any{
		"sub_run_id": childRun.ID,
		"started_at": now,
	})

	var dag model.DAGConfig
	if subPipeline.DAGConfigJSON != "" {
		_ = json.Unmarshal([]byte(subPipeline.DAGConfigJSON), &dag)
	}
	if len(dag.Nodes) == 0 {
        markTaskFailed(parentTask.ID, "Sub-pipeline does not have a DAG configuration and cannot run as a component")
		database.DB.Model(&childRun).Updates(map[string]any{
			"status":        "failed",
			"finished_at":   time.Now(),
            "error_summary": "Sub-pipeline does not have a DAG configuration",
		})
		return
	}
	if err := CreateDAGTaskRuns(&childRun, dag, childParams, ""); err != nil {
		markTaskFailed(parentTask.ID, "Failed to create sub-pipeline tasks: "+err.Error())
		return
	}
	if scheduler.Global != nil {
		go scheduler.Global.DispatchRun(childRun.ID)
	}
}

func markTaskFailed(taskID string, reason string) {
	now := time.Now()
	database.DB.Model(&model.TaskRun{}).Where("id = ?", taskID).Updates(map[string]any{
		"status":        "failed",
		"error_summary": util.TruncateString(reason, 2000),
		"finished_at":   now,
	})
	var task model.TaskRun
	if err := database.DB.First(&task, "id = ?", taskID).Error; err == nil {
		updatePipelineRunCounters(task.PipelineRunID)
		go AdvanceDAGRun(task.PipelineRunID)
	}
	logger.Warn("DAG task failed", zap.String("task_id", taskID), zap.String("reason", reason))
}

func init() {
	scheduler.SetDAGAdvanceCallback(AdvanceDAGRun)
}
