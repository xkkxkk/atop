package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/middleware"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/logger"
	"github.com/company/atop-backend/pkg/response"
	"go.uber.org/zap"
)

// ImportResult summarises a batch import.
type ImportResult struct {
	Total    int              `json:"total"`
	Success  int              `json:"success"`
	Failed   int              `json:"failed"`
	Skipped  int              `json:"skipped"` // duplicates skipped when mode=skip
	Errors   []importRowError `json:"errors"`
	Duration string           `json:"duration"`
}

type importRowError struct {
	Index  int    `json:"index"`  // 0-based
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// BatchImport handles POST /test-sets/import
// Accepts: JSON array, single JSON object, or JSON lines (one object per line).
// Supports two modes: mode=upsert (update if name+project match) | mode=skip (default).
func (h *TestSetHandler) BatchImport(c *gin.Context) {
	mode := c.DefaultQuery("mode", "skip") // skip | upsert
	if mode != "skip" && mode != "upsert" {
		mode = "skip"
	}

	file, _, err := c.Request.FormFile("file")
	if err != nil {
		// Also accept raw JSON body
		bodyBytes, readErr := io.ReadAll(c.Request.Body)
		if readErr != nil || len(bodyBytes) == 0 {
			response.BadRequest(c, "MISSING_FILE", "请上传 JSON 文件或在请求体中传入 JSON 数据")
			return
		}
		h.processImport(c, bodyBytes, mode)
		return
	}
	defer file.Close()
	h.processImportFile(c, file, mode)
}

func (h *TestSetHandler) processImportFile(c *gin.Context, file multipart.File, mode string) {
	data, err := io.ReadAll(file)
	if err != nil {
		response.InternalError(c, "文件读取失败")
		return
	}
	h.processImport(c, data, mode)
}

func (h *TestSetHandler) processImport(c *gin.Context, data []byte, mode string) {
	start := time.Now()

	// Parse: array / single object / JSON lines
	records, parseErr := parseImportJSON(data)
	if parseErr != nil {
		response.BadRequest(c, "INVALID_JSON", "JSON 解析失败: "+parseErr.Error())
		return
	}
	if len(records) == 0 {
		response.BadRequest(c, "EMPTY_DATA", "JSON 数据为空")
		return
	}

	result := ImportResult{Total: len(records)}
	userID := middleware.GetUserID(c)

	for i, raw := range records {
		ts, err := convertToTestSet(raw)
		if err != nil {
			result.Failed++
			result.Errors = append(result.Errors, importRowError{
				Index:  i,
				Name:   raw["name"],
				Reason: err.Error(),
			})
			logger.Debug("import row error", zap.Int("index", i), zap.Error(err))
			continue
		}

		// Check for existing record (match by name + project)
		var existing model.TestSet
		found := database.DB.Where("name = ? AND project = ?", ts.Name, ts.Project).
			First(&existing).Error == nil

		if found {
			if mode == "skip" {
				result.Skipped++
				continue
			}
			// upsert: update existing
			updates := buildTestSetUpdates(ts, userID)
			if err := database.DB.Model(&existing).Updates(updates).Error; err != nil {
				result.Failed++
				result.Errors = append(result.Errors, importRowError{
					Index:  i,
					Name:   ts.Name,
					Reason: "更新失败: " + err.Error(),
				})
				continue
			}
		} else {
			ts.CreatedBy = userID
			ts.UpdatedBy = userID
			if err := database.DB.Create(&ts).Error; err != nil {
				result.Failed++
				result.Errors = append(result.Errors, importRowError{
					Index:  i,
					Name:   ts.Name,
					Reason: "创建失败: " + err.Error(),
				})
				continue
			}
		}
		result.Success++
	}

	result.Duration = time.Since(start).String()
	response.OK(c, result)
}

// ── Format converters ─────────────────────────────────────────────────────

// parseImportJSON accepts JSON array, single object, or JSON lines.
func parseImportJSON(data []byte) ([]map[string]string, error) {
	trimmed := strings.TrimSpace(string(data))

	// Try array first
	if strings.HasPrefix(trimmed, "[") {
		var arr []json.RawMessage
		if err := json.Unmarshal(data, &arr); err != nil {
			return nil, err
		}
		var result []map[string]string
		for _, raw := range arr {
			flat, err := flattenRecord(raw)
			if err != nil {
				return nil, err
			}
			result = append(result, flat)
		}
		return result, nil
	}

	// Try single object
	if strings.HasPrefix(trimmed, "{") {
		flat, err := flattenRecord(data)
		if err != nil {
			return nil, err
		}
		return []map[string]string{flat}, nil
	}

	// Try JSON lines
	var result []map[string]string
	for _, line := range strings.Split(trimmed, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		flat, err := flattenRecord([]byte(line))
		if err != nil {
			return nil, fmt.Errorf("line parse error: %w", err)
		}
		result = append(result, flat)
	}
	return result, nil
}

// flattenRecord converts a raw JSON object to a string map for uniform processing.
func flattenRecord(data []byte) (map[string]string, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}

	result := make(map[string]string)
	for k, v := range raw {
		var s string
		if err := json.Unmarshal(v, &s); err == nil {
			result[k] = s
		} else {
			// Store complex values as JSON string for later parsing
			result[k] = string(v)
		}
	}
	return result, nil
}

// convertToTestSet converts a flat string map to a model.TestSet.
// Compatible with your company's JSON format AND the ATOP native format.
func convertToTestSet(raw map[string]string) (*model.TestSet, error) {
	// ── Name ──────────────────────────────────────────────────────────────
	name := firstOf(raw, "name", "test_name", "testSetName")
	if name == "" {
		// Auto-generate from coordinates
		parts := []string{}
		for _, k := range []string{"new_project", "project", "environment", "product", "silicon", "run_type"} {
			if v := raw[k]; v != "" {
				parts = append(parts, v)
			}
		}
		if len(parts) > 0 {
			name = strings.Join(parts, "_")
		}
	}
	if name == "" {
		return nil, fmt.Errorf("缺少 name 字段")
	}

	// ── Project ───────────────────────────────────────────────────────────
	// Support: new_project (company format), project (ATOP format)
	project := firstOf(raw, "new_project", "project")
	if project == "" {
		return nil, fmt.Errorf("缺少 project/new_project 字段")
	}

	// ── Agent Label ───────────────────────────────────────────────────────
	agentLabel := firstOf(raw, "agentLabel", "agent_label", "agent", "label")
	if agentLabel == "" {
		return nil, fmt.Errorf("缺少 agentLabel 字段")
	}

	// ── Optional coordinates ──────────────────────────────────────────────
	environment := firstOf(raw, "environment", "env")
	product     := firstOf(raw, "product")
	silicon     := firstOf(raw, "silicon")
	os          := firstOf(raw, "os", "system")
	runType     := firstOf(raw, "runType", "run_type", "type")
	branch      := firstOf(raw, "branch")

	// ── Status ────────────────────────────────────────────────────────────
	status := "enabled"
	if s := firstOf(raw, "status"); s != "" {
		// Company format: status = 0 (enabled) | 1 (disabled)
		switch s {
		case "0", "enabled", "active":
			status = "enabled"
		case "1", "disabled", "inactive":
			status = "disabled"
		}
	}

	// ── Priority ──────────────────────────────────────────────────────────
	priority := 0
	if p := firstOf(raw, "priority"); p != "" {
		fmt.Sscanf(p, "%d", &priority)
	}

	// ── Stage num (company: stage_num) ────────────────────────────────────
	stageNum := 1
	if s := firstOf(raw, "stageNum", "stage_num"); s != "" {
		fmt.Sscanf(s, "%d", &stageNum)
	}
	if stageNum < 1 {
		stageNum = 1
	}

	// ── CPU lock (company: cpulock = 0|1) ─────────────────────────────────
	cpuLock := false
	if s := firstOf(raw, "cpulock", "cpuLock", "cpu_lock"); s == "1" || s == "true" {
		cpuLock = true
	}

	// ── Timeout ───────────────────────────────────────────────────────────
	// company: test_timeout (seconds, 0 = no limit)
	timeoutMin := 120
	if s := firstOf(raw, "test_timeout", "timeout", "timeoutMinutes"); s != "" {
		var sec int
		fmt.Sscanf(s, "%d", &sec)
		if sec > 0 {
			timeoutMin = sec / 60
			if timeoutMin < 1 {
				timeoutMin = 1
			}
		}
	}

	// ── Tags / Labels ─────────────────────────────────────────────────────
	var tags []string
	// company format: labels = JSON array
	if s := firstOf(raw, "labels", "tags"); s != "" {
		if err := json.Unmarshal([]byte(s), &tags); err != nil {
			// Comma-separated fallback
			for _, t := range strings.Split(s, ",") {
				if t = strings.TrimSpace(t); t != "" {
					tags = append(tags, t)
				}
			}
		}
	}

	// ── Config JSON ───────────────────────────────────────────────────────
	configJSON := buildConfigJSON(raw, timeoutMin)

	ts := &model.TestSet{
		Name:        name,
		Project:     project,
		Environment: environment,
		Product:     product,
		Silicon:     silicon,
		OS:          os,
		RunType:     runType,
		Branch:      branch,
		Status:      status,
		AgentLabel:  agentLabel,
		Tags:        util.ToJSON(tags),
		Priority:    priority,
		StageNum:    stageNum,
		CpuLock:     cpuLock,
		ConfigJSON:  configJSON,
		OperatorName: firstOf(raw, "operatorName", "operator_name"),
		OperatorID:   firstOf(raw, "operatorId", "operator_id"),
		LeaderName:   firstOf(raw, "leaderName", "leader_name"),
		LeaderID:     firstOf(raw, "leaderId", "leader_id"),
		Unit:         firstOf(raw, "unit"),
	}

	return ts, nil
}

// buildConfigJSON converts import raw map to ATOP configJson structure.
func buildConfigJSON(raw map[string]string, timeoutMin int) string {
	// ── Set up ───────────────────────────────────────────────────────────
	var downloads []any

	// company format: set_up.download (stored as JSON string in flat map)
	if s := raw["set_up"]; s != "" {
		var setUp map[string]any
		if err := json.Unmarshal([]byte(s), &setUp); err == nil {
			if dl, ok := setUp["download"].([]any); ok {
				for _, d := range dl {
					if dm, ok := d.(map[string]any); ok {
						downloads = append(downloads, map[string]any{
							"source":          dm["source"],
							"repoType":        convertRepoType(fmt.Sprint(dm["repo_type"])),
							"stage":           dm["stage"],
							"sourceInfolder":  dm["source_infolder"],
							"destPath":        dm["dest_path"],
							"cmd":             dm["cmd"],
						})
					}
				}
			}
		}
	}

	// ── Exec cmds ────────────────────────────────────────────────────────
	var execCmds []any

	// company format: exec_cmd (JSON array)
	if s := raw["exec_cmd"]; s != "" {
		var cmds []map[string]any
		if err := json.Unmarshal([]byte(s), &cmds); err == nil {
			for _, cmd := range cmds {
				useDocker := fmt.Sprint(cmd["use_docker"])
				dockerMode := "none"
				if useDocker == "true" || useDocker == "1" {
					dockerMode = "internal"
				}
				envVars := []any{}
				if params, ok := cmd["ext_param"].([]any); ok {
					for _, p := range params {
						if pm, ok := p.(map[string]any); ok {
							for k, v := range pm {
								// company format: "SDK_DIR=${workspace}/sdk" inside "param" key
								if k == "param" {
									parts := strings.SplitN(fmt.Sprint(v), "=", 2)
									if len(parts) == 2 {
										envVars = append(envVars, map[string]string{
											"key": parts[0], "value": parts[1],
										})
									}
								} else {
									envVars = append(envVars, map[string]string{
										"key": k, "value": fmt.Sprint(v),
									})
								}
							}
						}
					}
				}
				execCmds = append(execCmds, map[string]any{
					"cmdLabel":           fmt.Sprint(cmd["cmdlabel"]),
					"dockerMode":         dockerMode,
					"dockerImgReadfile":  fmt.Sprint(cmd["docker_img_readfile"]),
					"dockerImgLabel":     fmt.Sprint(cmd["docker_img_label"]),
					"cmdRundir":          fmt.Sprint(cmd["cmd_rundir"]),
					"runBash":            fmt.Sprint(cmd["run_bash"]),
					"envVars":            envVars,
					"cmd":                fmt.Sprint(cmd["cmd"]),
					"failPolicy":         "block",
				})
			}
		}
	}

	// ATOP native format: execCmds
	if len(execCmds) == 0 {
		if s := raw["execCmds"]; s != "" {
			json.Unmarshal([]byte(s), &execCmds)
		}
	}

	// Default exec cmd if none
	if len(execCmds) == 0 {
		execCmds = []any{map[string]any{
			"cmdLabel": "run_test", "dockerMode": "none",
			"envVars": []any{}, "cmd": "", "failPolicy": "block",
		}}
	}

	// ── Teardown ─────────────────────────────────────────────────────────
	teardown := map[string]any{
		"cleanWorkspace": true,
		"keepArtifacts":  []string{},
		"stopDocker":     true,
		"postScript":     "",
	}
	if s := raw["tear_down"]; s != "" {
		var td map[string]any
		if err := json.Unmarshal([]byte(s), &td); err == nil {
			if clean, ok := td["clean"].([]any); ok && len(clean) > 0 {
				teardown["cleanWorkspace"] = true
			}
		}
	}

	config := map[string]any{
		"setup": map[string]any{
			"downloads": downloads,
			"preScript": "",
		},
		"execCmds": execCmds,
		"teardown": teardown,
		"reports":  []any{},
	}

	b, _ := json.Marshal(config)
	return string(b)
}

func convertRepoType(s string) string {
	switch strings.ToLower(s) {
	case "artifact":
		return "artifact"
	case "curl_file", "curl":
		return "curl_file"
	case "git":
		return "git"
	case "url", "http", "https":
		return "url"
	default:
		return "artifact"
	}
}

func firstOf(m map[string]string, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != "" {
			return v
		}
	}
	return ""
}

func buildTestSetUpdates(ts *model.TestSet, userID string) map[string]any {
	return map[string]any{
		"environment":  ts.Environment,
		"product":      ts.Product,
		"silicon":      ts.Silicon,
		"os":           ts.OS,
		"run_type":     ts.RunType,
		"branch":       ts.Branch,
		"status":       ts.Status,
		"agent_label":  ts.AgentLabel,
		"tags":         ts.Tags,
		"priority":     ts.Priority,
		"stage_num":    ts.StageNum,
		"cpu_lock":     ts.CpuLock,
		"config_json":  ts.ConfigJSON,
		"operator_name": ts.OperatorName,
		"operator_id":   ts.OperatorID,
		"leader_name":   ts.LeaderName,
		"leader_id":     ts.LeaderID,
		"unit":          ts.Unit,
		"updated_by":    userID,
	}
}

// ImportPreview holds the analysis result before actual import.
type ImportPreview struct {
	Total            int                `json:"total"`
	NewTestSets      int                `json:"newTestSets"`
	UpdateTestSets   int                `json:"updateTestSets"`
	NewDimensions    []NewDimensionItem `json:"newDimensions"`
	Samples          []PreviewSample    `json:"samples"` // first 5 items
	ParseErrors      []importRowError   `json:"parseErrors"`
}

type NewDimensionItem struct {
	Dimension   string `json:"dimension"`
	Value       string `json:"value"`
	DisplayName string `json:"displayName"`
}

type PreviewSample struct {
	Name        string `json:"name"`
	Project     string `json:"project"`
	Environment string `json:"environment"`
	Product     string `json:"product"`
	AgentLabel  string `json:"agentLabel"`
	IsNew       bool   `json:"isNew"`
}

// ImportPreviewHandler handles POST /test-sets/import/preview
// Parses files and returns preview info WITHOUT writing to DB.
func (h *TestSetHandler) ImportPreview(c *gin.Context) {
	// Collect all files (supports multiple)
	var allRecords []map[string]string
	var parseErrors []importRowError

	form, err := c.MultipartForm()
	if err != nil {
		// Try single file
		file, _, ferr := c.Request.FormFile("file")
		if ferr != nil {
			response.BadRequest(c, "MISSING_FILE", "请上传至少一个 JSON 文件")
			return
		}
		defer file.Close()
		data, _ := io.ReadAll(file)
		recs, perr := parseImportJSON(data)
		if perr != nil {
			response.BadRequest(c, "INVALID_JSON", perr.Error())
			return
		}
		allRecords = recs
	} else {
		files := form.File["files"]
		if len(files) == 0 {
			files = form.File["file"]
		}
		for i, fh := range files {
			f, ferr := fh.Open()
			if ferr != nil { continue }
			data, _ := io.ReadAll(f)
			f.Close()
			recs, perr := parseImportJSON(data)
			if perr != nil {
				parseErrors = append(parseErrors, importRowError{
					Index: i, Name: fh.Filename, Reason: perr.Error(),
				})
				continue
			}
			allRecords = append(allRecords, recs...)
		}
	}

	if len(allRecords) == 0 && len(parseErrors) == 0 {
		response.BadRequest(c, "EMPTY_DATA", "未解析到有效数据")
		return
	}

	// Load existing dimensions
	var dims []model.DimensionItem
	database.DB.Find(&dims)
	existingDims := make(map[string]map[string]bool) // dimension -> value -> exists
	for _, d := range dims {
		if existingDims[d.Dimension] == nil {
			existingDims[d.Dimension] = make(map[string]bool)
		}
		existingDims[d.Dimension][d.Value] = true
	}

	// Load existing test sets for duplicate detection
	var existingTS []model.TestSet
	database.DB.Select("name, project").Find(&existingTS)
	existingTSMap := make(map[string]bool)
	for _, ts := range existingTS {
		existingTSMap[ts.Project+"|"+ts.Name] = true
	}

	// Analyse records
	newDimsMap := make(map[string]NewDimensionItem) // key: dim+value
	newCount, updateCount := 0, 0
	var samples []PreviewSample
	var rowErrors []importRowError

	for i, raw := range allRecords {
		ts, err := convertToTestSet(raw)
		if err != nil {
			rowErrors = append(rowErrors, importRowError{Index: i, Name: raw["name"], Reason: err.Error()})
			continue
		}

		isNew := !existingTSMap[ts.Project+"|"+ts.Name]
		if isNew { newCount++ } else { updateCount++ }

		// Check dimensions
		for dim, val := range map[string]string{
			"project":     ts.Project,
			"environment": ts.Environment,
			"product":     ts.Product,
			"silicon":     ts.Silicon,
			"os":          ts.OS,
			"run_type":    ts.RunType,
		} {
			if val == "" { continue }
			if existingDims[dim] == nil || !existingDims[dim][val] {
				key := dim + "|" + val
				if _, exists := newDimsMap[key]; !exists {
					newDimsMap[key] = NewDimensionItem{
						Dimension: dim, Value: val, DisplayName: val,
					}
				}
			}
		}

		if len(samples) < 5 {
			samples = append(samples, PreviewSample{
				Name: ts.Name, Project: ts.Project,
				Environment: ts.Environment, Product: ts.Product,
				AgentLabel: ts.AgentLabel, IsNew: isNew,
			})
		}
	}

	newDims := make([]NewDimensionItem, 0, len(newDimsMap))
	for _, v := range newDimsMap {
		newDims = append(newDims, v)
	}

	// Ensure slices are never null in JSON response
	mergedErrors := append(parseErrors, rowErrors...)
	if mergedErrors == nil { mergedErrors = []importRowError{} }
	if samples == nil { samples = []PreviewSample{} }
	if newDims == nil { newDims = []NewDimensionItem{} }

	response.OK(c, ImportPreview{
		Total:          len(allRecords),
		NewTestSets:    newCount,
		UpdateTestSets: updateCount,
		NewDimensions:  newDims,
		Samples:        samples,
		ParseErrors:    mergedErrors,
	})
}

// BatchImportMulti handles POST /test-sets/import with multiple files
// and auto-creates missing dimensions.
// Optional form field: nameOverrides = JSON object {"original_name": "new_name", ...}
func (h *TestSetHandler) BatchImportMulti(c *gin.Context) {
	mode := c.DefaultQuery("mode", "skip")
	if mode != "skip" && mode != "upsert" { mode = "skip" }

	form, err := c.MultipartForm()
	if err != nil {
		h.BatchImport(c)
		return
	}

	files := form.File["files"]
	if len(files) == 0 { files = form.File["file"] }
	if len(files) == 0 {
		response.BadRequest(c, "MISSING_FILE", "请上传至少一个 JSON 文件"); return
	}

	// Parse optional name overrides: {"original": "new_name"}
	nameOverrides := map[string]string{}
	if overrideVals := form.Value["nameOverrides"]; len(overrideVals) > 0 {
		_ = json.Unmarshal([]byte(overrideVals[0]), &nameOverrides)
	}

	// Merge all files into one record set
	var allRecords []map[string]string
	for _, fh := range files {
		f, ferr := fh.Open()
		if ferr != nil { continue }
		data, _ := io.ReadAll(f)
		f.Close()
		recs, perr := parseImportJSON(data)
		if perr != nil { continue }
		allRecords = append(allRecords, recs...)
	}

	if len(allRecords) == 0 {
		response.BadRequest(c, "EMPTY_DATA", "未解析到有效数据"); return
	}

	// Apply name overrides
	for i, rec := range allRecords {
		origName := firstOf(rec, "name", "test_name", "testSetName")
		if newName, ok := nameOverrides[origName]; ok && newName != "" {
			allRecords[i]["name"] = newName
		}
	}

	// Auto-create missing dimensions
	userID := middleware.GetUserID(c)
	h.autoCreateDimensions(allRecords, userID)

	// Re-encode for processImport
	merged, _ := json.Marshal(allRecords)
	h.processImport(c, merged, mode)
}

// autoCreateDimensions creates dimension items that don't exist yet.
func (h *TestSetHandler) autoCreateDimensions(records []map[string]string, userID string) {
	var dims []model.DimensionItem
	database.DB.Find(&dims)
	existing := make(map[string]bool)
	for _, d := range dims {
		existing[d.Dimension+"|"+d.Value] = true
	}

	dimFields := map[string]string{
		"new_project": "project", "project": "project",
		"environment": "environment", "product": "product",
		"silicon": "silicon", "os": "os", "run_type": "run_type",
	}

	for _, rec := range records {
		for field, dim := range dimFields {
			val := strings.TrimSpace(rec[field])
			if val == "" { continue }
			key := dim + "|" + val
			if existing[key] { continue }
			// Create new dimension item
			item := model.DimensionItem{
				Dimension:   dim,
				Value:       val,
				DisplayName: val,
				SortOrder:   0,
			}
			if err := database.DB.Create(&item).Error; err == nil {
				existing[key] = true // avoid duplicate creation
				logger.Info("auto-created dimension",
					zap.String("dim", dim), zap.String("val", val),
				)
			}
		}
	}
}
