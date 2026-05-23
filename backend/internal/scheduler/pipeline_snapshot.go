package scheduler

import (
	"encoding/json"
	"fmt"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
)

type PipelineConfigSnapshot struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Project         string `json:"project"`
	Environment     string `json:"environment"`
	Product         string `json:"product"`
	OS              string `json:"os"`
	RunType         string `json:"runType"`
	TriggerType     string `json:"triggerType"`
	CronExpr        string `json:"cronExpr"`
	JenkinsBindings string `json:"jenkinsBindings"`
	Params          string `json:"params"`
	StageConfigJSON string `json:"stageConfigJson"`
	DAGConfigJSON   string `json:"dagConfigJson"`
}

func BuildPipelineConfigSnapshot(p *model.Pipeline) string {
	if p == nil {
		return ""
	}
	snapshot := PipelineConfigSnapshot{
		ID:              p.ID,
		Name:            p.Name,
		Project:         p.Project,
		Environment:     p.Environment,
		Product:         p.Product,
		OS:              p.OS,
		RunType:         p.RunType,
		TriggerType:     p.TriggerType,
		CronExpr:        p.CronExpr,
		JenkinsBindings: p.JenkinsBindings,
		Params:          p.Params,
		StageConfigJSON: p.StageConfigJSON,
		DAGConfigJSON:   p.DAGConfigJSON,
	}
	b, _ := json.Marshal(snapshot)
	return string(b)
}

func PipelineConfigForRun(run *model.PipelineRun) (*PipelineConfigSnapshot, error) {
	if run == nil {
		return nil, fmt.Errorf("pipeline run is nil")
	}
	if run.PipelineSnapshotJSON != "" {
		var snapshot PipelineConfigSnapshot
		if err := json.Unmarshal([]byte(run.PipelineSnapshotJSON), &snapshot); err == nil {
			if snapshot.ID == "" {
				snapshot.ID = run.PipelineID
			}
			if snapshot.Name == "" {
				snapshot.Name = run.PipelineName
			}
			return &snapshot, nil
		}
	}

	var p model.Pipeline
	if err := database.DB.First(&p, "id = ?", run.PipelineID).Error; err != nil {
		return nil, fmt.Errorf("pipeline not found")
	}
	snapshot := &PipelineConfigSnapshot{
		ID:              p.ID,
		Name:            p.Name,
		Project:         p.Project,
		Environment:     p.Environment,
		Product:         p.Product,
		OS:              p.OS,
		RunType:         p.RunType,
		TriggerType:     p.TriggerType,
		CronExpr:        p.CronExpr,
		JenkinsBindings: p.JenkinsBindings,
		Params:          p.Params,
		StageConfigJSON: p.StageConfigJSON,
		DAGConfigJSON:   p.DAGConfigJSON,
	}
	if run.ID != "" {
		b, _ := json.Marshal(snapshot)
		database.DB.Model(&model.PipelineRun{}).
			Where("id = ? AND (pipeline_snapshot_json IS NULL OR pipeline_snapshot_json = '')", run.ID).
			Update("pipeline_snapshot_json", string(b))
	}
	return snapshot, nil
}
