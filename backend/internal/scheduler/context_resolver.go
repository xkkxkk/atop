package scheduler

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/util"
)

const maxResolvedParamLength = 5000

var expressionPattern = regexp.MustCompile(`\$\{([^}]+)\}`)

func stringifyContextValue(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case json.Number:
		return x.String()
	case bool:
		if x {
			return "true"
		}
		return "false"
	default:
		b, err := json.Marshal(x)
		if err != nil {
			return fmt.Sprint(x)
		}
		return string(b)
	}
}

// CollectNodeOutputs returns outputs keyed by DAG node id.
func CollectNodeOutputs(runID string) map[string]map[string]string {
	outputs := make(map[string]map[string]string)
	var tasks []model.TaskRun
	database.DB.Select("dag_node_id, outputs_json").
		Where("pipeline_run_id = ? AND dag_node_id <> '' AND outputs_json <> ''", runID).
		Find(&tasks)

	for _, task := range tasks {
		var raw map[string]any
		if err := json.Unmarshal([]byte(task.OutputsJSON), &raw); err != nil {
			continue
		}
		nodeOutputs := make(map[string]string, len(raw))
		for key, value := range raw {
			key = strings.TrimSpace(key)
			if key == "" {
				continue
			}
			nodeOutputs[key] = stringifyContextValue(value)
		}
		outputs[task.DAGNodeID] = nodeOutputs
	}
	return outputs
}

// CollectNodeInputs returns resolved Jenkins params keyed by DAG node id.
func CollectNodeInputs(runID string) map[string]map[string]string {
	inputs := make(map[string]map[string]string)
	var tasks []model.TaskRun
	database.DB.Select("dag_node_id, global_vars_snapshot").
		Where("pipeline_run_id = ? AND dag_node_id <> '' AND global_vars_snapshot <> ''", runID).
		Find(&tasks)

	for _, task := range tasks {
		var raw map[string]any
		if err := json.Unmarshal([]byte(task.GlobalVarsSnapshot), &raw); err != nil {
			continue
		}
		nodeInputs := make(map[string]string, len(raw))
		for key, value := range raw {
			key = strings.TrimSpace(key)
			if key == "" || strings.HasPrefix(strings.ToUpper(key), "ATOP_") {
				continue
			}
			nodeInputs[key] = stringifyContextValue(value)
		}
		if len(nodeInputs) > 0 {
			inputs[task.DAGNodeID] = nodeInputs
		}
	}
	return inputs
}

// BuildExpressionContext exposes runtime params, node inputs and node outputs to DAG expressions.
// Supported forms:
//   ${tag}
//   ${runtime.tag}
//   ${nodes.<nodeId>.inputs.<key>}
//   ${<nodeId>.inputs.<key>}
//   ${nodes.<nodeId>.outputs.<key>}
//   ${<nodeId>.outputs.<key>}
func BuildExpressionContext(run *model.PipelineRun) map[string]string {
	context := make(map[string]string)
	if run == nil {
		return context
	}

	runtimeParams := util.FromJSONDefault[map[string]string](run.RuntimeParams, map[string]string{})
	for key, value := range runtimeParams {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		context[key] = value
		context["runtime."+key] = value
	}

	for nodeID, nodeInputs := range CollectNodeInputs(run.ID) {
		for key, value := range nodeInputs {
			context["nodes."+nodeID+".inputs."+key] = value
			context[nodeID+".inputs."+key] = value
		}
	}

	for nodeID, nodeOutputs := range CollectNodeOutputs(run.ID) {
		for key, value := range nodeOutputs {
			context["nodes."+nodeID+".outputs."+key] = value
			context[nodeID+".outputs."+key] = value
		}
	}
	return context
}

func ResolveExpressionString(template string, context map[string]string) (string, error) {
	template = strings.TrimSpace(template)
	if template == "" {
		return "", nil
	}
	if value, ok := context[template]; ok {
		return value, nil
	}

	var missing []string
	resolved := expressionPattern.ReplaceAllStringFunc(template, func(token string) string {
		matches := expressionPattern.FindStringSubmatch(token)
		if len(matches) != 2 {
			return token
		}
		key := strings.TrimSpace(matches[1])
		value, ok := context[key]
		if !ok {
			missing = append(missing, key)
			return token
		}
		return value
	})
	if len(missing) > 0 {
		return "", fmt.Errorf("unresolved DAG variable: %s", strings.Join(missing, ", "))
	}
	if utf8.RuneCountInString(resolved) > maxResolvedParamLength {
		return "", fmt.Errorf("resolved DAG variable value is too long, max %d characters", maxResolvedParamLength)
	}
	return resolved, nil
}

func ResolveInputMapping(mapping map[string]string, context map[string]string) (map[string]string, error) {
	resolved := make(map[string]string, len(mapping))
	for targetKey, expr := range mapping {
		targetKey = strings.TrimSpace(targetKey)
		if targetKey == "" {
			continue
		}
		value, err := ResolveExpressionString(expr, context)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", targetKey, err)
		}
		resolved[targetKey] = value
	}
	return resolved, nil
}

func RefreshRunContext(runID string) {
	var run model.PipelineRun
	if err := database.DB.First(&run, "id = ?", runID).Error; err != nil {
		return
	}
	context := BuildExpressionContext(&run)
	b, _ := json.Marshal(context)
	database.DB.Model(&model.PipelineRun{}).Where("id = ?", runID).Update("context_json", string(b))
}
