package scheduler

import (
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/util"
)

// BuildPayload constructs the JSON payload sent to Jenkins for a task run.
func BuildPayload(tr *model.TaskRun, ts *model.TestSet, run *model.PipelineRun, webhookBaseURL string) (map[string]any, error) {
	// Parse test set config
	var config map[string]any
	if err := json.Unmarshal([]byte(ts.ConfigJSON), &config); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	// Collect global vars (system + project)
	var vars []model.GlobalVar
	database.DB.Where("scope = 'system' OR project_id = ?", ts.Project).Find(&vars)
	envMap := make(map[string]string)
	for _, v := range vars {
		envMap[v.Key] = v.Value
	}

	// Inject runtime params from pipeline run
	runtimeParams := util.FromJSONDefault[map[string]string](run.RuntimeParams, nil)
	for k, v := range runtimeParams {
		envMap[k] = v
	}

	contextMap := BuildExpressionContext(run)
	nodeInputs := util.FromJSONDefault[map[string]string](tr.NodeInputJSON, nil)
	if len(nodeInputs) > 0 {
		resolvedInputs, err := ResolveInputMapping(nodeInputs, contextMap)
		if err != nil {
			return nil, err
		}
		for k, v := range resolvedInputs {
			envMap[k] = v
		}
	}
	if tr.DAGNodeID != "" {
		envMap["ATOP_DAG_NODE_ID"] = tr.DAGNodeID
	}
	envMap["ATOP_RUN_ID"] = run.ID
	envMap["ATOP_TASK_ID"] = tr.ID

	// Build shared_libs map: path → base64 content
	sharedLibs := make(map[string]string)
	// (libs are referenced by name in configJson.execCmds — fetch if needed)
	// For now, collect all system-scoped sh libs
	var libs []model.SharedLib
	database.DB.Where("scope = 'system'").Find(&libs)
	for _, lib := range libs {
		ext := ".sh"
		if lib.Lang == "py" {
			ext = ".py"
		}
		path := fmt.Sprintf("%s/system/%s%s", lib.Lang, lib.Name, ext)
		encoded := base64.StdEncoding.EncodeToString([]byte(lib.Content))
		sharedLibs[path] = encoded
	}

	// Snapshot config + global vars for auditing
	snapshotJSON, _ := json.Marshal(config)
	globalVarJSON, _ := json.Marshal(envMap)
	database.DB.Model(tr).Updates(map[string]any{
		"config_snapshot_json": string(snapshotJSON),
		"global_vars_snapshot": string(globalVarJSON),
	})

	payload := map[string]any{
		"task_id":              tr.ID,
		"platform_webhook_url": fmt.Sprintf("%s/api/webhook/task/%s", webhookBaseURL, tr.ID),
		"agent_label":          ts.AgentLabel,
		"timeout_minutes":      ts.Timeout,
		"setup":                config["setup"],
		"exec":                 config["execCmds"],
		"shared_libs":          sharedLibs,
		"teardown":             config["teardown"],
		"env_vars":             envMap,
		"stage_num":            ts.StageNum,
		"cpulock":              ts.CpuLock,
		"cpulock_script":       ts.CpuLockScript,
		"priority":             ts.Priority,
	}

	return payload, nil
}

func BuildGenericPayload(tr *model.TaskRun, run *model.PipelineRun, webhookBaseURL string) (map[string]any, error) {
	pipeline, err := PipelineConfigForRun(run)
	if err != nil {
		return nil, fmt.Errorf("pipeline snapshot: %w", err)
	}

	envMap := make(map[string]string)
	var vars []model.GlobalVar
	database.DB.Where("scope = 'system' OR project_id = ?", pipeline.Project).Find(&vars)
	for _, v := range vars {
		envMap[v.Key] = v.Value
	}

	runtimeParams := util.FromJSONDefault[map[string]string](run.RuntimeParams, nil)
	for k, v := range runtimeParams {
		envMap[k] = v
	}

	nodeInputs := util.FromJSONDefault[map[string]string](tr.NodeInputJSON, nil)
	if len(nodeInputs) > 0 {
		resolvedInputs, err := ResolveInputMapping(nodeInputs, BuildExpressionContext(run))
		if err != nil {
			return nil, err
		}
		for k, v := range resolvedInputs {
			envMap[k] = v
		}
	}
	envMap["ATOP_RUN_ID"] = run.ID
	envMap["ATOP_TASK_ID"] = tr.ID
	if tr.DAGNodeID != "" {
		envMap["ATOP_DAG_NODE_ID"] = tr.DAGNodeID
	}

	nodeConfig := util.FromJSONDefault[map[string]any](tr.NodeConfigJSON, map[string]any{})
	globalVarJSON, _ := json.Marshal(envMap)
	configJSON, _ := json.Marshal(nodeConfig)
	database.DB.Model(tr).Updates(map[string]any{
		"config_snapshot_json": string(configJSON),
		"global_vars_snapshot": string(globalVarJSON),
	})

	payload := map[string]any{
		"task_id":              tr.ID,
		"platform_webhook_url": fmt.Sprintf("%s/api/webhook/task/%s", webhookBaseURL, tr.ID),
		"component_type":       tr.DAGNodeType,
		"component_label":      tr.TestSetName,
		"component_config":     nodeConfig,
		"env_vars":             envMap,
	}
	return payload, nil
}
