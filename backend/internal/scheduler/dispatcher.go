package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
	"go.uber.org/zap"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/internal/util"
	"github.com/company/atop-backend/pkg/logger"
)

// Dispatcher manages the goroutine pool for dispatching task runs to Jenkins.
type Dispatcher struct {
	sem        chan struct{} // concurrency limiter
	webhookURL string
	mu         sync.Mutex
	running    map[string]bool // track in-flight task IDs
}

var Global *Dispatcher

const PipelineBuildIDWaitTimeout = 5 * time.Minute
const jenkinsSubmitRetryInterval = 2 * time.Second
const taskPhaseMaxLength = 30

var pipelineTriggerLocks sync.Map
var runDispatchLocks sync.Map
var jenkinsJobSubmitLocks sync.Map
var dagAdvanceCallback func(string)

func LockPipelineTrigger(pipelineID string) func() {
	value, _ := pipelineTriggerLocks.LoadOrStore(pipelineID, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return func() { mu.Unlock() }
}

func lockRunDispatch(runID string) func() {
	value, _ := runDispatchLocks.LoadOrStore(runID, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return func() { mu.Unlock() }
}

func jenkinsJobLockKey(inst *model.JenkinsInstance, jobName string) string {
	instanceKey := ""
	if inst != nil {
		instanceKey = strings.TrimSpace(inst.ID)
		if instanceKey == "" {
			instanceKey = strings.TrimRight(strings.TrimSpace(inst.URL), "/")
		}
	}
	return instanceKey + "|" + strings.ToLower(jobPath(jobName))
}

func lockJenkinsJobSubmit(inst *model.JenkinsInstance, jobName string) func() {
	key := jenkinsJobLockKey(inst, jobName)
	value, _ := jenkinsJobSubmitLocks.LoadOrStore(key, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return func() { mu.Unlock() }
}

func SetDAGAdvanceCallback(fn func(string)) {
	dagAdvanceCallback = fn
}

func notifyDAGAdvance(runID string) {
	if dagAdvanceCallback != nil && strings.TrimSpace(runID) != "" {
		go dagAdvanceCallback(runID)
	}
}

func FindPipelineRunAwaitingJenkinsBuild(db *gorm.DB, pipelineID string) (*model.PipelineRun, bool) {
	if db == nil {
		db = database.DB
	}
	cutoff := time.Now().Add(-PipelineBuildIDWaitTimeout)
	var run model.PipelineRun
	err := db.Where(
		"pipeline_id = ? AND status IN ? AND jenkins_queue_id = 0 AND jenkins_build_id = 0 AND created_at >= ?",
		pipelineID,
		[]string{"pending", "running"},
		cutoff,
	).Order("created_at DESC").First(&run).Error
	return &run, err == nil
}

func PipelineRunAwaitingBuildMessage(run *model.PipelineRun) string {
	if run == nil {
        return "This pipeline is currently being submitted to Jenkins. Please wait until the queue ID is created before triggering again"
	}
    return fmt.Sprintf("This pipeline already has a run being submitted to Jenkins (run ID: %s). Please wait until the queue ID is created before triggering again", run.ID)
}

func JenkinsBuildIDUsedByAnotherRun(pipelineID, runID string, buildID int64) bool {
	return jenkinsIDUsedByAnotherPipelineRun(pipelineID, runID, "jenkins_build_id", buildID)
}

func JenkinsQueueIDUsedByAnotherRun(pipelineID, runID string, queueID int64) bool {
	return jenkinsIDUsedByAnotherPipelineRun(pipelineID, runID, "jenkins_queue_id", queueID)
}

func JenkinsBuildIDUsedByAnotherTask(pipelineRunID, taskID string, inst *model.JenkinsInstance, jobName string, buildID int64) bool {
	return jenkinsIDUsedByAnotherTask(pipelineRunID, taskID, inst, jobName, "jenkins_build_id", buildID)
}

func JenkinsQueueIDUsedByAnotherTask(pipelineRunID, taskID string, inst *model.JenkinsInstance, jobName string, queueID int64) bool {
	return jenkinsIDUsedByAnotherTask(pipelineRunID, taskID, inst, jobName, "jenkins_queue_id", queueID)
}

func jenkinsIDUsedByAnotherPipelineRun(pipelineID, runID, column string, value int64) bool {
	if pipelineID == "" || runID == "" || value <= 0 {
		return false
	}
	var currentRun model.PipelineRun
	if err := database.DB.Select("id, pipeline_id, created_at, jenkins_build_id, jenkins_queue_id, pipeline_snapshot_json").First(&currentRun, "id = ?", runID).Error; err != nil {
		return false
	}
	currentAlreadyOwns := jenkinsColumnValueFromRun(&currentRun, column) == value
	inst, jobName, err := ResolveJenkinsJobForPipelineRun(&currentRun)
	if err != nil {
		return false
	}
	currentKey := jenkinsJobLockKey(inst, jobName)

	var runs []model.PipelineRun
	database.DB.Select("id, pipeline_id, created_at, pipeline_snapshot_json").
		Where(column+" = ? AND id <> ?", value, runID).
		Find(&runs)
	for i := range runs {
		otherInst, otherJobName, err := ResolveJenkinsJobForPipelineRun(&runs[i])
		if err != nil {
			continue
		}
		if jenkinsJobLockKey(otherInst, otherJobName) == currentKey &&
			(!currentAlreadyOwns || jenkinsIDOwnerPrecedes(runs[i].CreatedAt, runs[i].ID, currentRun.CreatedAt, currentRun.ID)) {
			return true
		}
	}

	var tasks []model.TaskRun
	database.DB.Where(column+" = ?", value).Find(&tasks)
	for i := range tasks {
		var taskRun model.PipelineRun
		if err := database.DB.Select("id, pipeline_id, pipeline_snapshot_json").First(&taskRun, "id = ?", tasks[i].PipelineRunID).Error; err != nil {
			continue
		}
		otherInst, otherJobName, err := resolveJenkinsJobForTaskRun(&tasks[i], &taskRun)
		if err != nil {
			continue
		}
		if jenkinsJobLockKey(otherInst, otherJobName) == currentKey &&
			(!currentAlreadyOwns || jenkinsIDOwnerPrecedes(tasks[i].CreatedAt, tasks[i].ID, currentRun.CreatedAt, currentRun.ID)) {
			return true
		}
	}
	return false
}

func jenkinsIDUsedByAnotherTask(pipelineRunID, taskID string, inst *model.JenkinsInstance, jobName, column string, value int64) bool {
	if pipelineRunID == "" || taskID == "" || strings.TrimSpace(jobName) == "" || value <= 0 {
		return false
	}
	var currentTask model.TaskRun
	if err := database.DB.Select("id, created_at, jenkins_build_id, jenkins_queue_id").First(&currentTask, "id = ?", taskID).Error; err != nil {
		return false
	}
	currentAlreadyOwns := jenkinsColumnValueFromTask(&currentTask, column) == value
	currentKey := jenkinsJobLockKey(inst, jobName)
	var tasks []model.TaskRun
	database.DB.Where("id <> ? AND "+column+" = ?", taskID, value).Find(&tasks)
	for i := range tasks {
		var run model.PipelineRun
		if err := database.DB.Select("id, pipeline_id, pipeline_snapshot_json").First(&run, "id = ?", tasks[i].PipelineRunID).Error; err != nil {
			continue
		}
		otherInst, otherJobName, err := resolveJenkinsJobForTaskRun(&tasks[i], &run)
		if err != nil {
			continue
		}
		if jenkinsJobLockKey(otherInst, otherJobName) == currentKey &&
			(!currentAlreadyOwns || jenkinsIDOwnerPrecedes(tasks[i].CreatedAt, tasks[i].ID, currentTask.CreatedAt, currentTask.ID)) {
			return true
		}
	}

	var runs []model.PipelineRun
	database.DB.Select("id, pipeline_id, created_at, pipeline_snapshot_json").
		Where(column+" = ?", value).
		Find(&runs)
	for i := range runs {
		otherInst, otherJobName, err := ResolveJenkinsJobForPipelineRun(&runs[i])
		if err != nil {
			continue
		}
		if jenkinsJobLockKey(otherInst, otherJobName) == currentKey &&
			(!currentAlreadyOwns || jenkinsIDOwnerPrecedes(runs[i].CreatedAt, runs[i].ID, currentTask.CreatedAt, currentTask.ID)) {
			return true
		}
	}
	return false
}

func jenkinsColumnValueFromRun(run *model.PipelineRun, column string) int64 {
	if run == nil {
		return 0
	}
	if column == "jenkins_queue_id" {
		return run.JenkinsQueueID
	}
	return run.JenkinsBuildID
}

func jenkinsColumnValueFromTask(task *model.TaskRun, column string) int64 {
	if task == nil {
		return 0
	}
	if column == "jenkins_queue_id" {
		return task.JenkinsQueueID
	}
	return task.JenkinsBuildID
}

func jenkinsIDOwnerPrecedes(existingCreated time.Time, existingID string, currentCreated time.Time, currentID string) bool {
	if existingCreated.Before(currentCreated) {
		return true
	}
	if existingCreated.After(currentCreated) {
		return false
	}
	return existingID < currentID
}

func resolveJenkinsJobForTaskRun(task *model.TaskRun, run *model.PipelineRun) (*model.JenkinsInstance, string, error) {
	if task == nil {
		return nil, "", fmt.Errorf("task is nil")
	}
	if task.TestSetID == "" {
		return ResolveJenkinsJobForTaskInRun(task, run)
	}

	var ts model.TestSet
	if err := database.DB.Select("id, project, os").First(&ts, "id = ?", task.TestSetID).Error; err != nil {
		return nil, "", err
	}
	cfg, err := PipelineConfigForRun(run)
	if err != nil {
		return nil, "", err
	}
	return resolveJenkinsJobFromBindings(cfg.JenkinsBindings, ts.Project, ts.OS)
}

func ResolveJenkinsJobForTaskRun(task *model.TaskRun, pipelineID string) (*model.JenkinsInstance, string, error) {
	var run model.PipelineRun
	if err := database.DB.Select("id, pipeline_id, pipeline_snapshot_json").First(&run, "id = ?", task.PipelineRunID).Error; err == nil {
		return resolveJenkinsJobForTaskRun(task, &run)
	}
	return resolveJenkinsJobForTaskRun(task, &model.PipelineRun{PipelineID: pipelineID})
}

func runIsTerminal(status string) bool {
	switch status {
	case "success", "failed", "error", "aborted", "blocked":
		return true
	default:
		return false
	}
}

func mergePayloadEnvParams(params map[string]string, payload map[string]any) {
	if params == nil || payload == nil {
		return
	}
	setParam := func(key string, value any) {
		key = strings.TrimSpace(key)
		if key == "" || key == "ATOP_PAYLOAD" || value == nil {
			return
		}
		params[key] = fmt.Sprint(value)
	}
	switch env := payload["env_vars"].(type) {
	case map[string]string:
		for k, v := range env {
			setParam(k, v)
		}
	case map[string]any:
		for k, v := range env {
			setParam(k, v)
		}
	}
}

func triggerJenkinsJobWithFreshQueue(inst *model.JenkinsInstance, jc *JenkinsClient, jobName string, params map[string]string, timeout time.Duration, queueInUse func(int64) bool, buildInUse func(int64) bool, markWaiting func(string)) (int64, error) {
	unlock := lockJenkinsJobSubmit(inst, jobName)
	defer unlock()

	deadline := time.Now().Add(timeout)
	for {
		if time.Now().After(deadline) {
			return 0, fmt.Errorf("Jenkins Job %s did not create an independent Queue ID within %d seconds", jobName, int(timeout.Seconds()))
		}

		queueID, err := jc.TriggerJob(jobName, params)
		if err == nil {
			if queueID <= 0 {
				return 0, fmt.Errorf("jenkins accepted trigger but did not return queue id")
			}
			if queueInUse != nil && queueInUse(queueID) {
                reason := fmt.Sprintf("A queue item for the same Jenkins job already exists (#%d). Waiting to create a dedicated queue once it becomes a build", queueID)
				if markWaiting != nil {
					markWaiting(reason)
				}
				if err := waitJenkinsQueueCreated(jc, jobName, queueID, deadline, markWaiting); err != nil {
					return 0, err
				}
				sleepUntil(deadline, jenkinsSubmitRetryInterval)
				continue
			}
			if buildInUse != nil {
				var existingBuildID int64
				if build, err := jc.FindBuildByQueueID(jobName, queueID); err == nil && build != nil && build.Number > 0 {
					existingBuildID = build.Number
				} else if status, err := jc.CheckQueueItem(queueID); err == nil && status.Executable != nil && status.Executable.Number > 0 {
					existingBuildID = status.Executable.Number
				}
				if existingBuildID > 0 && buildInUse(existingBuildID) {
                    reason := fmt.Sprintf("Jenkins queue #%d already points to build #%d. Waiting to create a dedicated queue", queueID, existingBuildID)
					if markWaiting != nil {
						markWaiting(reason)
					}
					if err := waitJenkinsQueueCreated(jc, jobName, queueID, deadline, markWaiting); err != nil {
						return 0, err
					}
					sleepUntil(deadline, jenkinsSubmitRetryInterval)
					continue
				}
			}
			return queueID, nil
		}

		var queueExists *QueueItemExistsError
		if !errors.As(err, &queueExists) {
			return 0, err
		}

        reason := "The same Jenkins job is already in the Jenkins queue. Waiting to create a dedicated queue once it becomes a build"
		if queueExists.QueueID > 0 {
            reason = fmt.Sprintf("The same Jenkins job is already in Jenkins queue #%d. Waiting to create a dedicated queue once it becomes a build", queueExists.QueueID)
		}
		if markWaiting != nil {
			markWaiting(reason)
		}
		if err := waitJenkinsQueueCreated(jc, jobName, queueExists.QueueID, deadline, markWaiting); err != nil {
			return 0, err
		}
		sleepUntil(deadline, jenkinsSubmitRetryInterval)
	}
}

func waitJenkinsQueueCreated(jc *JenkinsClient, jobName string, queueID int64, deadline time.Time, markWaiting func(string)) error {
	if queueID <= 0 {
		if !sleepUntil(deadline, jenkinsSubmitRetryInterval) {
			return fmt.Errorf("Jenkins duplicate queue did not clear before timeout")
		}
		return nil
	}

	for {
		if time.Now().After(deadline) {
			return fmt.Errorf("Jenkins Queue #%d did not create a Build before timeout", queueID)
		}

		if build, err := jc.FindBuildByQueueID(jobName, queueID); err == nil && build != nil && build.Number > 0 {
			return nil
		}

		status, err := jc.CheckQueueItem(queueID)
		if err != nil {
			if strings.Contains(err.Error(), "[404]") {
				return nil
			}
			sleepUntil(deadline, jenkinsSubmitRetryInterval)
			continue
		}
		if status.Cancelled {
			return nil
		}
		if status.Executable != nil && status.Executable.Number > 0 {
			return nil
		}
		if markWaiting != nil && strings.TrimSpace(status.Why) != "" {
			markWaiting(status.Why)
		}
		sleepUntil(deadline, jenkinsSubmitRetryInterval)
	}
}

func sleepUntil(deadline time.Time, duration time.Duration) bool {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return false
	}
	if remaining < duration {
		duration = remaining
	}
	time.Sleep(duration)
	return time.Now().Before(deadline)
}

func truncateTaskPhase(s string) string {
	runes := []rune(strings.TrimSpace(s))
	if len(runes) <= taskPhaseMaxLength {
		return string(runes)
	}
	return string(runes[:taskPhaseMaxLength])
}

func statusFromJenkinsResult(result string) string {
	switch strings.TrimSpace(strings.ToUpper(result)) {
	case "SUCCESS":
		return "success"
	case "FAILURE":
		return "failed"
	case "ABORTED":
		return "aborted"
	default:
		return "error"
	}
}

func taskBuildIdentity(taskID string) map[string]string {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return nil
	}
	return map[string]string{"ATOP_TASK_ID": taskID}
}

func pipelineRunBuildIdentity(runID string) map[string]string {
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return nil
	}
	return map[string]string{"ATOP_RUN_ID": runID}
}

func findTaskBuild(jc *JenkinsClient, jobName string, queueID int64, taskID string) (*BuildRef, error) {
	if build, err := jc.FindBuildByQueueID(jobName, queueID); err != nil || build != nil {
		return build, err
	}
	return jc.FindBuildByParameters(jobName, taskBuildIdentity(taskID))
}

func findPipelineRunBuild(jc *JenkinsClient, jobName string, queueID int64, runID string) (*BuildRef, error) {
	if build, err := jc.FindBuildByQueueID(jobName, queueID); err != nil || build != nil {
		return build, err
	}
	return jc.FindBuildByParameters(jobName, pipelineRunBuildIdentity(runID))
}

func (d *Dispatcher) claimTaskJenkinsSubmission(tr *model.TaskRun, jc *JenkinsClient, jobName string) (bool, error) {
	var latest model.TaskRun
	if err := database.DB.First(&latest, "id = ?", tr.ID).Error; err != nil {
		return false, fmt.Errorf("task run not found: %s", tr.ID)
	}
	if latest.JenkinsQueueID > 0 && latest.JenkinsBuildID == 0 {
		go d.pollQueueItem(&latest, jc, latest.JenkinsQueueID, jobName)
		return false, nil
	}
	if latest.JenkinsBuildID > 0 {
		return false, nil
	}
	if latest.Status != "pending" {
		logger.Info("dispatch: task submit skipped",
			zap.String("task_id", latest.ID),
			zap.String("status", latest.Status),
		)
		return false, nil
	}

	res := database.DB.Model(&model.TaskRun{}).
		Where("id = ? AND status = ? AND jenkins_queue_id = 0 AND jenkins_build_id = 0", latest.ID, "pending").
		Update("status", "submitting")
	if res.Error != nil {
		return false, res.Error
	}
	if res.RowsAffected == 0 {
		if err := database.DB.First(&latest, "id = ?", tr.ID).Error; err == nil {
			if latest.JenkinsQueueID > 0 && latest.JenkinsBuildID == 0 {
				go d.pollQueueItem(&latest, jc, latest.JenkinsQueueID, jobName)
			}
			logger.Info("dispatch: task submit already claimed",
				zap.String("task_id", latest.ID),
				zap.String("status", latest.Status),
				zap.Int64("queue_id", latest.JenkinsQueueID),
				zap.Int64("build_id", latest.JenkinsBuildID),
			)
		}
		return false, nil
	}

	tr.Status = "submitting"
	tr.JenkinsQueueID = 0
	tr.JenkinsBuildID = 0
	UpdatePipelineCounters(tr.PipelineRunID)
	return true, nil
}

func applyTaskBuildRef(tr *model.TaskRun, build *BuildRef) bool {
	if tr == nil || build == nil || build.Number <= 0 {
		return false
	}
	now := time.Now()
	updates := map[string]any{
		"jenkins_build_id":  build.Number,
		"jenkins_build_url": build.URL,
		"error_summary":     "",
	}
	if build.Building {
		updates["status"] = "running"
		updates["started_at"] = now
	} else if build.Result != "" {
		updates["status"] = statusFromJenkinsResult(build.Result)
		updates["phase"] = "completed"
		updates["finished_at"] = now
		updates["duration_ms"] = CalcDurationMs(tr.StartedAt, now)
	}
	database.DB.Model(&model.TaskRun{}).Where("id = ?", tr.ID).Updates(updates)
	UpdatePipelineCounters(tr.PipelineRunID)
	notifyDAGAdvance(tr.PipelineRunID)
	return true
}

func keepTaskQueuedAfterBuildWaitTimeout(tr *model.TaskRun, jc *JenkinsClient, queueID int64) bool {
	status, err := jc.CheckQueueItem(queueID)
	if err != nil {
		return false
	}
	if status.Cancelled {
		finishTaskAfterQueueFailure(tr, "aborted", strings.TrimSpace(status.Why))
		return true
	}
	reason := strings.TrimSpace(status.Why)
	if reason == "" {
        reason = "Jenkins queue is still waiting for a build ID"
	} else {
        reason = "Jenkins queue has not returned a build ID after 5 minutes: " + reason
	}
	database.DB.Model(&model.TaskRun{}).Where("id = ?", tr.ID).Updates(map[string]any{
		"status":        "queued_in_jenkins",
		"phase":         truncateTaskPhase(reason),
		"error_summary": "",
	})
	UpdatePipelineCounters(tr.PipelineRunID)
	return true
}

func finishTaskAfterQueueFailure(tr *model.TaskRun, status string, summary string) {
	now := time.Now()
	updates := map[string]any{
		"status":      status,
		"finished_at": now,
		"duration_ms": CalcDurationMs(tr.StartedAt, now),
	}
	if strings.TrimSpace(summary) != "" {
		updates["error_summary"] = util.TruncateString(summary, 2000)
	}
	database.DB.Model(&model.TaskRun{}).Where("id = ?", tr.ID).Updates(updates)
	UpdatePipelineCounters(tr.PipelineRunID)
	notifyDAGAdvance(tr.PipelineRunID)
}

func finishPipelineRunAfterQueueFailure(runID string, summary string) {
	if strings.TrimSpace(runID) == "" {
		return
	}
	var run model.PipelineRun
	if err := database.DB.Select("id, pipeline_id, started_at").First(&run, "id = ?", runID).Error; err != nil {
		return
	}

	now := time.Now()
	durationMs := CalcDurationMs(run.StartedAt, now)
	database.DB.Model(&model.TaskRun{}).
		Where("pipeline_run_id = ? AND status IN ?", runID, []string{"pending", "waiting", "submitting", "queued_in_jenkins", "running"}).
		Updates(map[string]any{
			"status":      "failed",
			"finished_at": now,
			"duration_ms": durationMs,
		})
	database.DB.Model(&model.PipelineRun{}).Where("id = ?", runID).Updates(map[string]any{
		"status":        "failed",
		"finished_at":   now,
		"duration_ms":   durationMs,
		"error_summary": util.TruncateString(summary, 2000),
	})
	UpdatePipelineCounters(runID)
}

// Init initialises the global dispatcher. Call once from main.
func Init(webhookBaseURL string) {
	maxConcurrent := config.Global.Jenkins.MaxConcurrentCalls
	Global = &Dispatcher{
		sem:        make(chan struct{}, maxConcurrent),
		webhookURL: webhookBaseURL,
		running:    make(map[string]bool),
	}
	logger.Info("scheduler initialised", zap.Int("max_concurrent", maxConcurrent))

	// Start background goroutine that picks up pending task runs on startup
	go Global.recoverPending()
}

// DispatchRun enqueues all pending task runs for a pipeline run.
func (d *Dispatcher) DispatchRun(runID string) {
	unlockRun := lockRunDispatch(runID)
	defer unlockRun()

	var run model.PipelineRun
	if err := database.DB.First(&run, "id = ?", runID).Error; err != nil {
		logger.Error("dispatch: run not found", zap.String("run_id", runID))
		return
	}

	if d.dispatchDAGRun(&run) {
		return
	}

	if run.JenkinsQueueID > 0 || run.JenkinsBuildID > 0 {
		logger.Warn("dispatch: run already submitted to Jenkins",
			zap.String("run_id", runID),
			zap.Int64("queue_id", run.JenkinsQueueID),
			zap.Int64("build_id", run.JenkinsBuildID),
		)
		return
	}

	pipeline, err := PipelineConfigForRun(&run)
	if err != nil {
		logger.Error("dispatch: pipeline not found", zap.String("run_id", runID), zap.Error(err))
		now := time.Now()
		database.DB.Model(&run).Updates(map[string]any{
			"status":        "failed",
			"finished_at":   now,
			"duration_ms":   CalcDurationMs(run.StartedAt, now),
			"error_summary": "Pipeline not found: " + err.Error(),
		})
		go SendPipelineNotifications(run.ID, run.PipelineID, "failed")
		return
	}

	inst, jobName, err := resolveJenkinsJobFromBindings(pipeline.JenkinsBindings, pipeline.Project, pipeline.OS)
	if err != nil {
		logger.Error("dispatch: no Jenkins job", zap.String("run_id", runID), zap.Error(err))
		now := time.Now()
		database.DB.Model(&run).Updates(map[string]any{
			"status":        "failed",
			"finished_at":   now,
			"duration_ms":   CalcDurationMs(run.StartedAt, now),
			"error_summary": "No Jenkins job matched: " + err.Error(),
		})
		go SendPipelineNotifications(run.ID, run.PipelineID, "failed")
		return
	}

	jc, err := NewJenkinsClient(inst)
	if err != nil {
		logger.Error("dispatch: jenkins client error", zap.String("run_id", runID), zap.Error(err))
		now := time.Now()
		database.DB.Model(&run).Updates(map[string]any{
			"status":        "failed",
			"finished_at":   now,
			"duration_ms":   CalcDurationMs(run.StartedAt, now),
			"error_summary": "Jenkins client error: " + err.Error(),
		})
		go SendPipelineNotifications(run.ID, run.PipelineID, "failed")
		return
	}

	params := map[string]string{
		"ATOP_RUN_ID":   runID,
		"ATOP_BASE_URL": d.webhookURL,
	}

	// Merge predefined param defaults
	type paramDef struct {
		Key          string `json:"key"`
		Name         string `json:"name"`
		DefaultValue string `json:"defaultValue"`
	}
	var predefined []paramDef
	json.Unmarshal([]byte(pipeline.Params), &predefined)
	for _, p := range predefined {
		paramName := p.Name
		if paramName == "" {
			paramName = p.Key
		}
		if paramName != "" && paramName != "ATOP_RUN_ID" && paramName != "ATOP_BASE_URL" {
			params[paramName] = p.DefaultValue
		}
	}

	// Merge runtime params
	var runtimeParams map[string]string
	json.Unmarshal([]byte(run.RuntimeParams), &runtimeParams)
	for k, v := range runtimeParams {
		if k != "ATOP_RUN_ID" && k != "ATOP_BASE_URL" {
			params[k] = v
		}
	}

	now := time.Now()
	database.DB.Model(&run).Updates(map[string]any{"status": "running", "started_at": now})

	queueID, err := triggerJenkinsJobWithFreshQueue(
		inst,
		jc,
		jobName,
		params,
		PipelineBuildIDWaitTimeout,
		func(queueID int64) bool {
			return JenkinsQueueIDUsedByAnotherRun(run.PipelineID, run.ID, queueID)
		},
		func(buildID int64) bool {
			return JenkinsBuildIDUsedByAnotherRun(run.PipelineID, run.ID, buildID)
		},
		func(reason string) {
			database.DB.Model(&model.PipelineRun{}).Where("id = ?", run.ID).Updates(map[string]any{
				"status":        "running",
				"error_summary": util.TruncateString(reason, 2000),
			})
		},
	)
	if err != nil {
		logger.Error("dispatch: trigger failed", zap.String("run_id", runID), zap.Error(err))
		now := time.Now()
		database.DB.Model(&run).Updates(map[string]any{
			"status":        "failed",
			"finished_at":   now,
			"duration_ms":   CalcDurationMs(run.StartedAt, now),
			"error_summary": "Jenkins trigger failed: " + err.Error(),
		})
		go SendPipelineNotifications(run.ID, run.PipelineID, "failed")
		return
	}
	if queueID <= 0 {
		logger.Error("dispatch: Jenkins did not return queue id", zap.String("run_id", runID), zap.String("job", jobName))
		now := time.Now()
		database.DB.Model(&run).Updates(map[string]any{
			"status":        "failed",
			"finished_at":   now,
			"duration_ms":   CalcDurationMs(run.StartedAt, now),
			"error_summary": "Jenkins accepted the trigger request but did not return a queue ID, so the build cannot be matched safely",
		})
		go SendPipelineNotifications(run.ID, run.PipelineID, "failed")
		return
	}
	database.DB.Model(&run).Updates(map[string]any{
		"jenkins_queue_id": queueID,
		"error_summary":    "",
	})

	logger.Info("dispatch: triggered", zap.String("run_id", runID), zap.String("job", jobName), zap.Int64("queue", queueID))

	go d.pollPipelineRunQueue(run.ID, jc, jobName, queueID, PipelineBuildIDWaitTimeout)
}

func (d *Dispatcher) dispatchDAGRun(run *model.PipelineRun) bool {
	var dagTaskCount int64
	database.DB.Model(&model.TaskRun{}).
		Where("pipeline_run_id = ? AND dag_node_id <> ''", run.ID).
		Count(&dagTaskCount)
	if dagTaskCount == 0 {
		return false
	}

	var pending []model.TaskRun
	database.DB.Where("pipeline_run_id = ? AND status = ?", run.ID, "pending").
		Order("created_at ASC").Find(&pending)
	if len(pending) == 0 {
		UpdatePipelineCounters(run.ID)
		return true
	}
	if run.Status == "aborted" && strings.TrimSpace(run.AbortReason) != "" {
		return true
	}

	hasMainPending := false
	for i := range pending {
		if !pending[i].DAGDetached {
			hasMainPending = true
			break
		}
	}
	updates := map[string]any{}
	if !runIsTerminal(run.Status) || hasMainPending {
		updates["status"] = "running"
	}
	if run.StartedAt == nil {
		now := time.Now()
		updates["started_at"] = now
	}
	if len(updates) > 0 {
		database.DB.Model(run).Updates(updates)
	}

	dispatchable := 0
	for i := range pending {
		task := &pending[i]
		if task.SubPipelineID != "" {
			continue
		}
		dispatchable++
		go d.dispatchTask(task)
	}
	if dispatchable == 0 {
		UpdatePipelineCounters(run.ID)
	}
	return true
}

func (d *Dispatcher) pollPipelineRunQueue(runID string, jc *JenkinsClient, jobName string, queueID int64, timeout time.Duration) {
	buildID, buildURL := jc.WaitForBuildID(jobName, queueID, timeout)
	if buildID > 0 {
		var run model.PipelineRun
		if err := database.DB.First(&run, "id = ?", runID).Error; err != nil {
			return
		}
		if JenkinsQueueIDUsedByAnotherRun(run.PipelineID, runID, queueID) {
			finishPipelineRunAfterQueueFailure(runID, fmt.Sprintf("Jenkins Queue %d is already used by another run or task of the same Jenkins Job", queueID))
			return
		}
		if JenkinsBuildIDUsedByAnotherRun(run.PipelineID, runID, buildID) {
			finishPipelineRunAfterQueueFailure(runID, fmt.Sprintf("Jenkins Queue %d returned Build #%d already used by another run of this pipeline", queueID, buildID))
			return
		}
		database.DB.Model(&run).Updates(map[string]any{
			"jenkins_build_id":  buildID,
			"jenkins_build_url": buildURL,
		})
		return
	}
	if build, err := findPipelineRunBuild(jc, jobName, queueID, runID); err == nil && build != nil && build.Number > 0 {
		var run model.PipelineRun
		if err := database.DB.First(&run, "id = ?", runID).Error; err != nil {
			return
		}
		database.DB.Model(&run).Updates(map[string]any{
			"jenkins_build_id":  build.Number,
			"jenkins_build_url": build.URL,
			"error_summary":     "",
		})
		return
	}
	if status, err := jc.CheckQueueItem(queueID); err == nil && !status.Cancelled {
		reason := strings.TrimSpace(status.Why)
		if reason == "" {
            reason = "Jenkins queue is still waiting to generate a build ID"
		}
		database.DB.Model(&model.PipelineRun{}).Where("id = ?", runID).Updates(map[string]any{
			"status":        "queued_in_jenkins",
			"error_summary": util.TruncateString(reason, 2000),
		})
		return
	}
	finishPipelineRunAfterQueueFailure(runID, fmt.Sprintf("Jenkins accepted the trigger but did not return a Build ID within %d seconds", int(timeout.Seconds())))
}

// dispatchTask acquires a semaphore slot and submits the task to Jenkins.
func (d *Dispatcher) dispatchTask(tr *model.TaskRun) {
	// Dedup: skip if already dispatching
	d.mu.Lock()
	if d.running[tr.ID] {
		d.mu.Unlock()
		return
	}
	d.running[tr.ID] = true
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.running, tr.ID)
		d.mu.Unlock()
	}()

	// Acquire slot
	d.sem <- struct{}{}
	defer func() { <-d.sem }()

	if err := d.submitToJenkins(tr); err != nil {
		logger.Error("dispatch failed",
			zap.String("task_id", tr.ID),
			zap.String("test_set", tr.TestSetName),
			zap.Error(err),
		)
		database.DB.Model(tr).Updates(map[string]any{
			"status":        "submit_failed",
			"error_summary": util.TruncateString(err.Error(), 500),
		})
		UpdatePipelineCounters(tr.PipelineRunID)
		notifyDAGAdvance(tr.PipelineRunID)
	}
}

func (d *Dispatcher) submitToJenkins(tr *model.TaskRun) error {
	if tr.DAGNodeType == string(model.DAGNodeGate) {
		now := time.Now()
		database.DB.Model(tr).Updates(map[string]any{
			"status":      "success",
			"started_at":  now,
			"finished_at": now,
			"duration_ms": int64(0),
		})
		UpdatePipelineCounters(tr.PipelineRunID)
		return nil
	}

	var run model.PipelineRun
	if err := database.DB.First(&run, "id = ?", tr.PipelineRunID).Error; err != nil {
		return fmt.Errorf("pipeline run not found: %s", tr.PipelineRunID)
	}

	if tr.TestSetID == "" && tr.SubPipelineID == "" {
		inst, jobName, err := ResolveJenkinsJobForTaskInRun(tr, &run)
		if err != nil {
			return fmt.Errorf("no Jenkins job: %w", err)
		}
		jc, err := NewJenkinsClient(inst)
		if err != nil {
			return fmt.Errorf("jenkins client: %w", err)
		}
		claimed, err := d.claimTaskJenkinsSubmission(tr, jc, jobName)
		if err != nil {
			return err
		}
		if !claimed {
			return nil
		}
		payload, err := BuildGenericPayload(tr, &run, d.webhookURL)
		if err != nil {
			return fmt.Errorf("payload: %w", err)
		}
		payloadJSON, _ := json.Marshal(payload)
		params := map[string]string{
			"ATOP_PAYLOAD":     string(payloadJSON),
			"ATOP_TASK_ID":     tr.ID,
			"ATOP_RUN_ID":      run.ID,
			"ATOP_DAG_NODE_ID": tr.DAGNodeID,
		}
		mergePayloadEnvParams(params, payload)
		logger.Info("dispatch: triggering DAG Jenkins task",
			zap.String("run_id", tr.PipelineRunID),
			zap.String("task_id", tr.ID),
			zap.String("dag_node_id", tr.DAGNodeID),
			zap.String("job", jobName),
			zap.Int("param_count", len(params)),
		)
		queueID, err := triggerJenkinsJobWithFreshQueue(
			inst,
			jc,
			jobName,
			params,
			PipelineBuildIDWaitTimeout,
			func(queueID int64) bool {
				return JenkinsQueueIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, inst, jobName, queueID)
			},
			func(buildID int64) bool {
				return JenkinsBuildIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, inst, jobName, buildID)
			},
			func(reason string) {
				database.DB.Model(&model.TaskRun{}).Where("id = ?", tr.ID).Updates(map[string]any{
					"status": "queued_in_jenkins",
					"phase":  truncateTaskPhase(reason),
				})
			},
		)
		if err != nil {
			return fmt.Errorf("trigger job: %w", err)
		}
		if queueID <= 0 {
			return fmt.Errorf("jenkins accepted trigger but did not return queue id")
		}
		database.DB.Model(tr).Updates(map[string]any{
			"status":           "queued_in_jenkins",
			"jenkins_queue_id": queueID,
			"phase":            "",
		})
		tr.Status = "queued_in_jenkins"
		tr.JenkinsQueueID = queueID
		UpdatePipelineCounters(tr.PipelineRunID)
		logger.Info("dispatch: DAG Jenkins task queued",
			zap.String("run_id", tr.PipelineRunID),
			zap.String("task_id", tr.ID),
			zap.String("dag_node_id", tr.DAGNodeID),
			zap.String("job", jobName),
			zap.Int64("queue_id", queueID),
		)
		go d.pollQueueItem(tr, jc, queueID, jobName)
		return nil
	}

	// 1. Load test set
	var ts model.TestSet
	if err := database.DB.First(&ts, "id = ?", tr.TestSetID).Error; err != nil {
		return fmt.Errorf("test set not found: %s", tr.TestSetID)
	}

	// 2. Load pipeline run (for runtime params)
	// 3. Select Jenkins instance
	runCfg, err := PipelineConfigForRun(&run)
	if err != nil {
		return fmt.Errorf("pipeline snapshot: %w", err)
	}
	inst, jobName, err := resolveJenkinsJobFromBindings(runCfg.JenkinsBindings, ts.Project, ts.OS)
	if err != nil {
		return fmt.Errorf("no Jenkins job: %w", err)
	}

	// 4. Build Jenkins client
	jc, err := NewJenkinsClient(inst)
	if err != nil {
		return fmt.Errorf("jenkins client: %w", err)
	}
	claimed, err := d.claimTaskJenkinsSubmission(tr, jc, jobName)
	if err != nil {
		return err
	}
	if !claimed {
		return nil
	}

	// 5. Build payload
	payload, err := BuildPayload(tr, &ts, &run, d.webhookURL)
	if err != nil {
		return fmt.Errorf("payload: %w", err)
	}

	// 6. Serialise payload to JSON and pass as ATOP_PAYLOAD parameter
	payloadJSON, _ := json.Marshal(payload)
	params := map[string]string{
		"ATOP_PAYLOAD": string(payloadJSON),
		"ATOP_TASK_ID": tr.ID,
		"ATOP_RUN_ID":  run.ID,
	}
	mergePayloadEnvParams(params, payload)

	// 7. Trigger Jenkins job
	queueID, err := triggerJenkinsJobWithFreshQueue(
		inst,
		jc,
		jobName,
		params,
		PipelineBuildIDWaitTimeout,
		func(queueID int64) bool {
			return JenkinsQueueIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, inst, jobName, queueID)
		},
		func(buildID int64) bool {
			return JenkinsBuildIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, inst, jobName, buildID)
		},
		func(reason string) {
			database.DB.Model(&model.TaskRun{}).Where("id = ?", tr.ID).Updates(map[string]any{
				"status": "queued_in_jenkins",
				"phase":  truncateTaskPhase(reason),
			})
		},
	)
	if err != nil {
		return fmt.Errorf("trigger job: %w", err)
	}
	if queueID <= 0 {
		return fmt.Errorf("jenkins accepted trigger but did not return queue id")
	}

	database.DB.Model(tr).Updates(map[string]any{
		"status":            "queued_in_jenkins",
		"jenkins_queue_id":  queueID,
		"phase":             "",
	})
	tr.Status = "queued_in_jenkins"
	tr.JenkinsQueueID = queueID
	UpdatePipelineCounters(tr.PipelineRunID)

	// 8. Poll queue until build starts (max 5 min)
	go d.pollQueueItem(tr, jc, queueID, jobName)
	return nil
}

// pollQueueItem waits for Jenkins to assign a build number.
func (d *Dispatcher) pollQueueItem(tr *model.TaskRun, jc *JenkinsClient, queueID int64, jobName string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			logger.Warn("queue poll timeout", zap.String("task_id", tr.ID))
			if build, err := findTaskBuild(jc, jobName, queueID, tr.ID); err == nil && build != nil && build.Number > 0 {
				if JenkinsQueueIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, jc.instance, jobName, queueID) {
					finishTaskAfterQueueFailure(tr, "submit_failed", fmt.Sprintf("Jenkins Queue %d is already used by another task of the same Jenkins Job", queueID))
					return
				}
				if JenkinsBuildIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, jc.instance, jobName, build.Number) {
					logger.Warn("ignore stale Jenkins build lookup",
						zap.String("task_id", tr.ID),
						zap.Int64("queue_id", queueID),
						zap.Int64("build_id", build.Number),
					)
					finishTaskAfterQueueFailure(tr, "submit_failed", fmt.Sprintf("Jenkins queue timeout after 5 minutes; ignored stale Build #%d for Queue %d", build.Number, queueID))
					return
				}
				applyTaskBuildRef(tr, build)
				return
			}
			if keepTaskQueuedAfterBuildWaitTimeout(tr, jc, queueID) {
				return
			}
			finishTaskAfterQueueFailure(tr, "submit_failed", "Jenkins queue timeout after 5 minutes")
			return
		case <-ticker.C:
			status, err := jc.CheckQueueItem(queueID)
			if err != nil {
				if build, lookupErr := findTaskBuild(jc, jobName, queueID, tr.ID); lookupErr == nil && build != nil && build.Number > 0 {
					if JenkinsQueueIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, jc.instance, jobName, queueID) {
						finishTaskAfterQueueFailure(tr, "submit_failed", fmt.Sprintf("Jenkins Queue %d is already used by another task of the same Jenkins Job", queueID))
						return
					}
					if JenkinsBuildIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, jc.instance, jobName, build.Number) {
						logger.Warn("ignore stale Jenkins build lookup",
							zap.String("task_id", tr.ID),
							zap.Int64("queue_id", queueID),
							zap.Int64("build_id", build.Number),
						)
						continue
					}
					applyTaskBuildRef(tr, build)
					return
				}
				logger.Warn("queue check error", zap.String("task_id", tr.ID), zap.Int64("queue_id", queueID), zap.Error(err))
				continue
			}
			if status.Cancelled {
				finishTaskAfterQueueFailure(tr, "aborted", strings.TrimSpace(status.Why))
				return
			}
			queueReason := strings.TrimSpace(status.Why)
			if queueReason != "" {
				database.DB.Model(&model.TaskRun{}).
					Where("id = ? AND (phase = '' OR phase <> ?)", tr.ID, truncateTaskPhase(queueReason)).
					Updates(map[string]any{
						"status": "queued_in_jenkins",
						"phase":  truncateTaskPhase(queueReason),
					})
			}
			if build, lookupErr := findTaskBuild(jc, jobName, queueID, tr.ID); lookupErr == nil && build != nil && build.Number > 0 {
				if JenkinsBuildIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, jc.instance, jobName, build.Number) {
					logger.Warn("ignore stale Jenkins build lookup",
						zap.String("task_id", tr.ID),
						zap.Int64("queue_id", queueID),
						zap.Int64("build_id", build.Number),
					)
				} else {
					applyTaskBuildRef(tr, build)
					return
				}
			}
			if status.Executable != nil {
				buildID := status.Executable.Number
				if JenkinsQueueIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, jc.instance, jobName, queueID) {
					finishTaskAfterQueueFailure(tr, "submit_failed", fmt.Sprintf("Jenkins Queue %d is already used by another task of the same Jenkins Job", queueID))
					return
				}
				if JenkinsBuildIDUsedByAnotherTask(tr.PipelineRunID, tr.ID, jc.instance, jobName, buildID) {
					finishTaskAfterQueueFailure(tr, "submit_failed", fmt.Sprintf("Jenkins Queue %d returned Build #%d already used by another task of the same Jenkins Job", queueID, buildID))
					return
				}
				buildURL := fmt.Sprintf("%s%s/%d/console", jc.baseURL(), jobPath(jobName), buildID)
				now := time.Now()
				database.DB.Model(tr).Updates(map[string]any{
					"status":            "running",
					"jenkins_build_id":  buildID,
					"jenkins_build_url": buildURL,
					"started_at":        now,
					"error_summary":     "",
				})
				logger.Info("task started",
					zap.String("task_id", tr.ID),
					zap.Int64("build_id", buildID),
				)
				return
			}
		}
	}
}

// recoverPending picks up tasks stuck in submitting/queued state on restart.
func (d *Dispatcher) recoverPending() {
	time.Sleep(5 * time.Second) // wait for DB to settle
	var runs []model.PipelineRun
	database.DB.Where("status IN ? AND jenkins_queue_id > 0 AND jenkins_build_id = 0", []string{"pending", "submitting", "queued_in_jenkins", "waiting", "running"}).Find(&runs)
	for i := range runs {
		run := runs[i]
		inst, jobName, err := ResolveJenkinsJobForPipelineRun(&run)
		if err != nil {
			continue
		}
		jc, err := NewJenkinsClient(inst)
		if err != nil {
			continue
		}
		go d.pollPipelineRunQueue(run.ID, jc, jobName, run.JenkinsQueueID, PipelineBuildIDWaitTimeout)
	}

	var stale []model.TaskRun
	database.DB.Where("status IN ('pending','submitting','queued_in_jenkins')").Find(&stale)
	if len(stale) == 0 {
		return
	}
	logger.Info("recovering stale tasks", zap.Int("count", len(stale)))
	for i := range stale {
		go d.dispatchTask(&stale[i])
	}
}

// resolveJenkinsJob finds the Jenkins instance + job name for a given
// pipeline x project x OS combination (3-level priority routing).
func configString(cfg map[string]any, key string) string {
	if cfg == nil {
		return ""
	}
	value, ok := cfg[key]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

// ResolveJenkinsJobForTask uses the pipeline-level Jenkins instance and the
// Jenkins job configured on the canvas component.
func ResolveJenkinsJobForTask(task *model.TaskRun, pipelineID string) (*model.JenkinsInstance, string, error) {
	var run model.PipelineRun
	if task != nil && strings.TrimSpace(task.PipelineRunID) != "" {
		if database.DB.Select("id, pipeline_id, pipeline_snapshot_json").First(&run, "id = ?", task.PipelineRunID).Error == nil {
			return ResolveJenkinsJobForTaskInRun(task, &run)
		}
	}
	return ResolveJenkinsJobForTaskInRun(task, &model.PipelineRun{PipelineID: pipelineID})
}

func ResolveJenkinsJobForTaskInRun(task *model.TaskRun, run *model.PipelineRun) (*model.JenkinsInstance, string, error) {
	cfg := util.FromJSONDefault[map[string]any](task.NodeConfigJSON, nil)
	jobName := configString(cfg, "jobName")
	if jobName == "" {
		return nil, "", fmt.Errorf("component Jenkins job is empty")
	}
	inst, err := ResolveJenkinsInstanceForPipelineRun(run)
	if err != nil {
		return nil, "", err
	}
	return inst, jobName, nil
}

// ResolveJenkinsInstanceForRun resolves the pipeline-level Jenkins instance.
// DAG Jenkins nodes carry their own job name, so the pipeline binding only
// needs to provide the instance in component mode.
func ResolveJenkinsInstanceForRun(pipelineID string) (*model.JenkinsInstance, error) {
	return ResolveJenkinsInstanceForPipelineRun(&model.PipelineRun{PipelineID: pipelineID})
}

func ResolveJenkinsInstanceForPipelineRun(run *model.PipelineRun) (*model.JenkinsInstance, error) {
	cfg, err := PipelineConfigForRun(run)
	if err != nil {
		return nil, err
	}
	return resolveJenkinsInstance(cfg.JenkinsBindings)
}

// ResolveJenkinsJobForRun resolves the Jenkins instance and job name for a pipeline.
// Exported for use by handler (e.g. Abort).
func ResolveJenkinsJobForRun(pipelineID string) (*model.JenkinsInstance, string, error) {
	return ResolveJenkinsJobForPipelineRun(&model.PipelineRun{PipelineID: pipelineID})
}

func ResolveJenkinsJobForPipelineRun(run *model.PipelineRun) (*model.JenkinsInstance, string, error) {
	cfg, err := PipelineConfigForRun(run)
	if err != nil {
		return nil, "", err
	}
	return resolveJenkinsJobFromBindings(cfg.JenkinsBindings, cfg.Project, cfg.OS)
}

func resolveJenkinsInstance(bindingsJSON string) (*model.JenkinsInstance, error) {
	type binding struct {
		JenkinsInstanceID string `json:"jenkinsInstanceId"`
	}
	bindings := util.FromJSONDefault[[]binding](bindingsJSON, nil)
	for _, b := range bindings {
		instanceID := strings.TrimSpace(b.JenkinsInstanceID)
		if instanceID == "" {
			continue
		}
		var inst model.JenkinsInstance
		if err := database.DB.First(&inst, "id = ?", instanceID).Error; err != nil {
			return nil, fmt.Errorf("jenkins instance not found: %s", instanceID)
		}
		return &inst, nil
	}
	return nil, fmt.Errorf("jenkins instance is empty")
}

func resolveJenkinsJob(pipelineID, project, os string) (*model.JenkinsInstance, string, error) {
	project = strings.TrimSpace(project)
	os = strings.TrimSpace(os)

	var pipeline model.Pipeline
	if err := database.DB.Select("jenkins_bindings").First(&pipeline, "id = ?", pipelineID).Error; err != nil {
		return nil, "", fmt.Errorf("pipeline not found")
	}
	return resolveJenkinsJobFromBindings(pipeline.JenkinsBindings, project, os)
}

func resolveJenkinsJobFromBindings(bindingsJSON, project, os string) (*model.JenkinsInstance, string, error) {
	project = strings.TrimSpace(project)
	os = strings.TrimSpace(os)
	type binding struct {
		JenkinsInstanceID string `json:"jenkinsInstanceId"`
		JobName           string `json:"jobName"`
		MatchProject      string `json:"matchProject"`
		MatchOs           string `json:"matchOs"`
	}
	bindings := util.FromJSONDefault[[]binding](bindingsJSON, nil)

	// Priority 1: exact project + OS match
	// Priority 2: project only match
	// Priority 3: OS only match
	// Priority 4: default (no match constraints)
	var matchBoth, matchProject, matchOS, matchDefault *binding
	for i := range bindings {
		b := &bindings[i]
		bProject := strings.TrimSpace(b.MatchProject)
		bOS := strings.TrimSpace(b.MatchOs)
		if bProject == project && bOS == os {
			matchBoth = b
			break
		}
		if bProject == project && bOS == "" && matchProject == nil {
			matchProject = b
		}
		if bProject == "" && bOS == os && os != "" && matchOS == nil {
			matchOS = b
		}
		if bProject == "" && bOS == "" && matchDefault == nil {
			matchDefault = b
		}
	}

	selected := matchBoth
	if selected == nil {
		selected = matchProject
	}
	if selected == nil {
		selected = matchOS
	}
	if selected == nil {
		selected = matchDefault
	}
	if selected == nil {
		return nil, "", fmt.Errorf("no Jenkins job binding for project=%s os=%s", project, os)
	}

	var inst model.JenkinsInstance
	instanceID := strings.TrimSpace(selected.JenkinsInstanceID)
	jobName := strings.TrimSpace(selected.JobName)
	if err := database.DB.First(&inst, "id = ?", instanceID).Error; err != nil {
		return nil, "", fmt.Errorf("jenkins instance not found: %s", selected.JenkinsInstanceID)
	}
	if jobName == "" {
		return &inst, "", fmt.Errorf("jenkins job is empty")
	}
	return &inst, jobName, nil
}

func CalcDurationMs(startedAt *time.Time, finishedAt time.Time) int64 {
	if startedAt == nil {
		return 0
	}
	duration := finishedAt.Sub(*startedAt).Milliseconds()
	if duration < 0 {
		return 0
	}
	return duration
}

func finalizeTerminalPipelineRun(runID, status string) {
	if runID == "" || status == "running" {
		return
	}
	var run model.PipelineRun
	if err := database.DB.Select("id, pipeline_id, parent_run_id, parent_task_id, started_at").First(&run, "id = ?", runID).Error; err != nil {
		return
	}

	if run.ParentTaskID != "" && run.ParentRunID != "" {
		now := time.Now()
		parentOutputs, _ := json.Marshal(map[string]any{
			"childRunId": run.ID,
			"status":     status,
		})
		res := database.DB.Model(&model.TaskRun{}).
			Where("id = ? AND status IN ?", run.ParentTaskID, []string{"waiting", "pending", "submitting", "queued_in_jenkins", "running"}).
			Updates(map[string]any{
				"status":       status,
				"finished_at":  now,
				"duration_ms":  CalcDurationMs(run.StartedAt, now),
				"outputs_json": string(parentOutputs),
			})
		if res.RowsAffected > 0 {
			RefreshRunContext(run.ParentRunID)
			notifyDAGAdvance(run.ParentRunID)
		}
	}

	go SendPipelineNotifications(run.ID, run.PipelineID, status)
}

// updatePipelineCounters re-aggregates run statistics (called from handlers too).
func UpdatePipelineCounters(runID string) {
	// Check if it was manually aborted, and preserve that status.
	var currentRun model.PipelineRun
	if err := database.DB.Select("status, abort_reason, started_at").First(&currentRun, "id = ?", runID).Error; err != nil {
		return
	}
	userAborted := currentRun.Status == "aborted" && currentRun.AbortReason != ""

	type agg struct {
		Total         int64
		Success       int64
		Failed        int64
		Running       int64
		Blocked       int64
		Queued        int64
		JenkinsQueued int64
		Waiting       int64
		Aborted       int64
	}
	var a agg
	database.DB.Model(&model.TaskRun{}).Where("pipeline_run_id = ? AND dag_detached = ?", runID, false).
		Select("COUNT(*) as total," +
			"SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success," +
			"SUM(CASE WHEN status IN ('failed','error','submit_failed') THEN 1 ELSE 0 END) as failed," +
			"SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running," +
			"SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) as blocked," +
			"SUM(CASE WHEN status IN ('pending','submitting','queued_in_jenkins','waiting') THEN 1 ELSE 0 END) as queued," +
			"SUM(CASE WHEN status IN ('submitting','queued_in_jenkins') THEN 1 ELSE 0 END) as jenkins_queued," +
			"SUM(CASE WHEN status IN ('pending','waiting') THEN 1 ELSE 0 END) as waiting," +
			"SUM(CASE WHEN status='aborted' THEN 1 ELSE 0 END) as aborted").
		Scan(&a)

	passRate := 0.0
	done := a.Success + a.Failed
	if done > 0 {
		passRate = float64(a.Success) / float64(done) * 100
	}

	status := currentRun.Status
	if !userAborted {
		if a.Total == 0 {
			if !runIsTerminal(currentRun.Status) {
				status = "running"
			}
		} else {
			if a.Running > 0 {
				status = "running"
			} else if a.JenkinsQueued > 0 {
				status = "queued_in_jenkins"
			} else if a.Waiting > 0 {
				status = "waiting"
			} else {
				if a.Aborted > 0 && a.Success == 0 && a.Failed == 0 {
					status = "aborted"
				} else if a.Failed > 0 {
					status = "failed"
				} else if a.Blocked > 0 {
					status = "failed"
				} else if a.Aborted > 0 {
					status = "aborted"
				} else {
					status = "success"
				}
			}
		}
	}

	updates := map[string]any{
		"total_count":   a.Total,
		"success_count": a.Success,
		"failed_count":  a.Failed,
		"running_count": a.Running,
		"blocked_count": a.Blocked,
		"queued_count":  a.Queued,
		"pass_rate":     passRate,
		"status":        status,
	}
	if runIsTerminal(status) {
		now := time.Now()
		updates["finished_at"] = now
		updates["duration_ms"] = CalcDurationMs(currentRun.StartedAt, now)
	}
	database.DB.Model(&model.PipelineRun{}).Where("id = ?", runID).Updates(updates)
	if runIsTerminal(status) {
		finalizeTerminalPipelineRun(runID, status)
	}
}
