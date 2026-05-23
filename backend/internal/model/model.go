package model

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Base provides common fields for all models.
type Base struct {
	ID        string         `gorm:"type:varchar(36);primaryKey" json:"id"`
	CreatedAt time.Time      `json:"createdAt"`
	UpdatedAt time.Time      `json:"updatedAt"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

func (b *Base) BeforeCreate(tx *gorm.DB) error {
	if b.ID == "" {
		b.ID = uuid.New().String()
	}
	return nil
}

// ── Roles ─────────────────────────────────────────────────────────────────

// Role is a dynamic role table. Roles can be created by admins.
type Role struct {
	Base
	Name        string `gorm:"type:varchar(50);uniqueIndex;not null" json:"name"`        // e.g. super_admin, tester
	DisplayName string `gorm:"type:varchar(100);not null" json:"displayName"`             // e.g. 超级管理员
	Description string `gorm:"type:varchar(500)" json:"description"`
	IsBuiltin   bool   `gorm:"not null;default:false" json:"isBuiltin"`                   // builtin roles cannot be deleted
	Status      string `gorm:"type:varchar(20);not null;default:active" json:"status"`    // active | disabled
	CreatedBy   string `gorm:"type:varchar(36)" json:"createdBy"`
}

func (Role) TableName() string { return "roles" }

// ── Users ────────────────────────────────────────────────────────────────

type UserRole string

const (
	RoleSuperAdmin     UserRole = "super_admin"
	RoleProjectManager UserRole = "project_manager"
	RoleMember         UserRole = "member"
	RoleViewer         UserRole = "viewer"
)

type User struct {
	Base
	Username     string   `gorm:"type:varchar(100);not null" json:"username"`
	Email        string   `gorm:"type:varchar(200);uniqueIndex;not null" json:"email"`
	PasswordHash string   `gorm:"type:varchar(255);not null" json:"-"`
	Role         UserRole `gorm:"type:varchar(30);not null;default:''" json:"role"` // deprecated: kept for backward compat, use user_role_bindings
	Projects     string   `gorm:"type:text" json:"-"` // JSON array of project IDs
	Status       string   `gorm:"type:varchar(20);not null;default:'active'" json:"status"` // active | disabled
	AvatarURL             string     `gorm:"type:longtext" json:"avatarUrl,omitempty"`
	LastLoginAt           *time.Time `json:"lastLoginAt,omitempty"`
	CurrentSessionID      string     `gorm:"type:varchar(36);default:''" json:"-"`
	MustChangePwd         bool       `gorm:"not null;default:false" json:"mustChangePwd"`
	TempPasswordExpiresAt *time.Time `json:"-"`
	ResetToken            string     `gorm:"type:varchar(100);default:null" json:"-"`
	ResetTokenExp         int64      `gorm:"default:0" json:"-"`
}

func (User) TableName() string { return "users" }

// UserRoleBinding is a many-to-many join table between users and roles.
type UserRoleBinding struct {
	ID       string `gorm:"type:varchar(36);primaryKey" json:"id"`
	UserID   string `gorm:"type:varchar(36);not null;index:idx_urb_user" json:"userId"`
	RoleName string `gorm:"type:varchar(50);not null;index:idx_urb_role" json:"roleName"`
}

func (UserRoleBinding) TableName() string { return "user_role_bindings" }

func (u *UserRoleBinding) BeforeCreate(tx *gorm.DB) error {
	if u.ID == "" {
		u.ID = uuid.New().String()
	}
	return nil
}

// UserIdentitySnapshot stores the last known identity of a user for historical display.
type UserIdentitySnapshot struct {
	ID        string     `gorm:"type:varchar(36);primaryKey" json:"id"`
	UserID    string     `gorm:"type:varchar(36);not null;uniqueIndex" json:"userId"`
	Username  string     `gorm:"type:varchar(100)" json:"username"`
	Email     string     `gorm:"type:varchar(200)" json:"email"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

func (UserIdentitySnapshot) TableName() string { return "user_identity_snapshots" }

type RefreshToken struct {
	ID        string    `gorm:"type:varchar(36);primaryKey"`
	UserID    string    `gorm:"type:varchar(36);index;not null"`
	Token     string    `gorm:"type:varchar(512);uniqueIndex;not null"`
	SessionID string    `gorm:"type:varchar(36);index;default:''"`
	ExpiresAt time.Time `gorm:"not null"`
	CreatedAt time.Time
}

func (RefreshToken) TableName() string { return "refresh_tokens" }

// ── Dimension dict ────────────────────────────────────────────────────────

type DimensionItem struct {
	Base
	Dimension   string `gorm:"type:varchar(30);not null;index" json:"dimension"` // project|environment|product|silicon|os|run_type
	Value       string `gorm:"type:varchar(100);not null" json:"value"`
	DisplayName string `gorm:"type:varchar(200)" json:"displayName"`
	SortOrder   int    `gorm:"not null;default:0" json:"sortOrder"`
}

func (DimensionItem) TableName() string { return "dimension_dict" }

// ── Jenkins ───────────────────────────────────────────────────────────────

type JenkinsInstance struct {
	Base
	Name              string `gorm:"type:varchar(200);not null" json:"name"`
	URL               string `gorm:"type:varchar(500);not null" json:"url"`
	Username          string `gorm:"type:varchar(100);not null" json:"username"`
	APITokenEncrypted string `gorm:"type:varchar(500)" json:"-"`
	ViewerTokenEncrypted string `gorm:"type:varchar(500)" json:"-"`
	Status            string `gorm:"type:varchar(20);default:'unknown'" json:"status"` // ok|unreachable|unknown
	IsDefault         bool   `gorm:"not null;default:false" json:"isDefault"`
	ProjectBindings   string `gorm:"type:text" json:"-"` // JSON array
	LastPingAt        *time.Time `json:"lastPingAt,omitempty"`
	AgentSyncMode     string `gorm:"type:varchar(20);not null;default:'all'" json:"agentSyncMode"` // all | bound_only | fixed
	FixedNodes        string `gorm:"type:text" json:"-"` // JSON array of node names
	CreatedBy         string `gorm:"type:varchar(36)" json:"createdBy"`
	UpdatedBy         string `gorm:"type:varchar(36)" json:"updatedBy"`
}

func (JenkinsInstance) TableName() string { return "jenkins_instances" }

type AgentLabel struct {
	Base
	Label              string `gorm:"type:varchar(100);not null;index" json:"label"`
	JenkinsInstanceID  string `gorm:"type:varchar(36);not null;index" json:"jenkinsInstanceId"`
	OnlineCount        int    `gorm:"not null;default:0" json:"onlineCount"`
	TotalCount         int    `gorm:"not null;default:0" json:"totalCount"`
	LastSyncAt         *time.Time `json:"lastSyncAt,omitempty"`
}

func (AgentLabel) TableName() string { return "agent_labels" }

type AgentNode struct {
	Base
	NodeID            string `gorm:"type:varchar(200);not null" json:"nodeId"`
	Name              string `gorm:"type:varchar(200)" json:"name"`
	LabelID           string `gorm:"type:varchar(36);not null;index" json:"labelId"`
	JenkinsInstanceID string `gorm:"type:varchar(36);not null;index" json:"jenkinsInstanceId"`
	Online            bool   `gorm:"not null;default:false" json:"online"`
	OS                string `gorm:"type:varchar(50)" json:"os"`
	LabelsJSON        string `gorm:"type:text" json:"-"`
	LastSyncAt        *time.Time `json:"lastSyncAt,omitempty"`
}

func (AgentNode) TableName() string { return "agent_nodes" }

// ── Global vars ───────────────────────────────────────────────────────────

type GlobalVar struct {
	Base
	Key       string `gorm:"type:varchar(200);not null" json:"key"`
	Value     string `gorm:"type:text;not null" json:"value"`
	Scope     string `gorm:"type:varchar(20);not null;default:'system'" json:"scope"` // system|project
	ProjectID string `gorm:"type:varchar(100);index" json:"projectId,omitempty"`
	CreatedBy string `gorm:"type:varchar(36)" json:"createdBy"`
	UpdatedBy string `gorm:"type:varchar(36)" json:"updatedBy"`
}

func (GlobalVar) TableName() string { return "global_vars" }

// ── Test sets ─────────────────────────────────────────────────────────────

type TestSet struct {
	Base
	Name           string `gorm:"type:varchar(300);not null;index" json:"name"`
	Project        string `gorm:"type:varchar(100);not null;index" json:"project"`
	Environment    string `gorm:"type:varchar(100);not null" json:"environment"`
	Product        string `gorm:"type:varchar(100);not null" json:"product"`
	Silicon        string `gorm:"type:varchar(100)" json:"silicon"`
	OS             string `gorm:"type:varchar(100)" json:"os"`
	RunType        string `gorm:"type:varchar(100)" json:"runType"`
	Branch         string `gorm:"type:varchar(200)" json:"branch"`
	Status         string `gorm:"type:varchar(20);not null;default:'enabled';index" json:"status"`
	AgentLabel     string `gorm:"type:varchar(100);not null" json:"agentLabel"`
	Tags           string `gorm:"type:text" json:"-"` // JSON array
	Unit           string `gorm:"type:varchar(50)" json:"unit"`
	Priority       int    `gorm:"not null;default:0;index" json:"priority"`
	Timeout        int    `gorm:"not null;default:0" json:"timeout"`         // 超时时间（分钟），0 表示不限制
	StageNum       int    `gorm:"not null;default:1" json:"stageNum"`
	CpuLock        bool   `gorm:"not null;default:false" json:"cpulock"`
	CpuLockScript  string `gorm:"type:varchar(200)" json:"cpulockScript"`
	ConfigJSON     string `gorm:"type:longtext;not null" json:"-"`
	ArtifactOutput string `gorm:"type:varchar(500)" json:"artifactOutput"`
	ArtifactInput  string `gorm:"type:varchar(500)" json:"artifactInput"`
	OperatorName   string `gorm:"type:varchar(100)" json:"operatorName"`
	OperatorID     string `gorm:"type:varchar(100)" json:"operatorId"`
	LeaderName     string `gorm:"type:varchar(100)" json:"leaderName"`
	LeaderID       string `gorm:"type:varchar(100)" json:"leaderId"`
	DependsOn      string `gorm:"type:text" json:"-"` // JSON array of test set IDs/names
	SkipOnDepFail  bool   `gorm:"not null;default:false" json:"skipOnDepFail"`
	Remark         string `gorm:"type:varchar(500)" json:"remark"`
	CreatedBy      string `gorm:"type:varchar(36);index" json:"createdBy"`
	UpdatedBy      string `gorm:"type:varchar(36)" json:"updatedBy"`
}

func (TestSet) TableName() string { return "test_sets" }

// ── Shared libs ───────────────────────────────────────────────────────────

type SharedLib struct {
	Base
	Name        string `gorm:"type:varchar(200);not null;index" json:"name"`
	Lang        string `gorm:"type:varchar(10);not null" json:"lang"` // sh|py
	Scope       string `gorm:"type:varchar(20);not null" json:"scope"` // system|project
	ProjectID   string `gorm:"type:varchar(100);index" json:"projectId"`
	Content     string `gorm:"type:longtext;not null" json:"content"`
	ContentHash string `gorm:"type:varchar(64)" json:"contentHash"`
	Version     int    `gorm:"not null;default:1" json:"version"`
	RefCount    int    `gorm:"not null;default:0" json:"refCount"`
	Description string `gorm:"type:varchar(500)" json:"description"`
	CreatedBy   string `gorm:"type:varchar(36)" json:"createdBy"`
	UpdatedBy   string `gorm:"type:varchar(36)" json:"updatedBy"`
}

func (SharedLib) TableName() string { return "shared_libs" }

type SharedLibVersion struct {
	Base
	LibID     string `gorm:"type:varchar(36);not null;index" json:"libId"`
	Version   int    `gorm:"not null" json:"version"`
	Content   string `gorm:"type:longtext;not null" json:"content"`
	ChangedBy string `gorm:"type:varchar(100)" json:"changedBy"`
}

func (SharedLibVersion) TableName() string { return "shared_lib_versions" }

// ── Pipelines ─────────────────────────────────────────────────────────────


// ── DAG Node Types ────────────────────────────────────────────────────────

// DAGNodeType distinguishes test-set nodes from sub-pipeline nodes.
type DAGNodeType string
const (
	DAGNodeTestSet  DAGNodeType = "testset"
	DAGNodePipeline DAGNodeType = "pipeline"
	DAGNodeJenkins  DAGNodeType = "jenkins"
	DAGNodeGate     DAGNodeType = "gate"
)

type DAGEdgeType string
const (
	DAGEdgeWait     DAGEdgeType = "wait"
	DAGEdgeDetached DAGEdgeType = "detached"
)

const (
	DAGJoinAll          = "all"
	DAGJoinAny          = "any"
	DAGFailureBlock     = "block"
	DAGFailureContinue  = "continue"
)

type DAGEdge struct {
	ID     string      `json:"id,omitempty"`
	Source string      `json:"source"`
	Target string      `json:"target"`
	Type   DAGEdgeType `json:"type,omitempty"` // wait | detached; empty = wait
}

// DAGNode represents one node in the pipeline DAG.
// Dependencies are expressed as a list of upstream node IDs.
type DAGNode struct {
	ID           string      `json:"id"`           // uuid for this node
	Type         DAGNodeType `json:"type"`         // testset | pipeline | jenkins | gate | generic component
	RefID        string      `json:"refId"`        // TestSet.ID or Pipeline.ID
	Label        string      `json:"label"`        // display name
	DependsOn    []string    `json:"dependsOn"`    // upstream node IDs (empty = start node)
	JoinPolicy   string      `json:"joinPolicy,omitempty"`    // all | any
	FailurePolicy string    `json:"failurePolicy,omitempty"` // block | continue
	// Position in canvas (for visual editor)
	X            float64     `json:"x"`
	Y            float64     `json:"y"`
	// For sub-pipeline nodes
	ParamMapping map[string]string `json:"paramMapping,omitempty"` // parent_param -> child_param
	InputMapping map[string]string `json:"inputMapping,omitempty"` // target_param -> ${nodes.<id>.outputs.<key>} or ${nodes.<id>.inputs.<key>}
	RequiredOutputs []string `json:"requiredOutputs,omitempty"`
	Config       map[string]any `json:"config,omitempty"`
}

// DAGConfig is the full DAG stored in Pipeline.DAGConfigJSON.
type DAGConfig struct {
	Nodes []DAGNode `json:"nodes"`
	Edges []DAGEdge `json:"edges,omitempty"`
}

type Pipeline struct {
	Base
	Name            string `gorm:"type:varchar(300);not null;index" json:"name"`
	Project         string `gorm:"type:varchar(100);not null;index" json:"project"`
	Environment     string `gorm:"type:varchar(100)" json:"environment"`
	Product         string `gorm:"type:varchar(100)" json:"product"`
	OS              string `gorm:"type:varchar(100)" json:"os"`
	RunType         string `gorm:"type:varchar(100)" json:"runType"`
	TriggerType     string `gorm:"type:varchar(30);not null;default:'manual'" json:"triggerType"`
	CronExpr        string `gorm:"type:varchar(100)" json:"cronExpr"`
	PipelineType    string `gorm:"type:varchar(20);not null;default:'test'" json:"pipelineType"` // test | generic
	JenkinsBindings string `gorm:"type:text" json:"-"` // JSON array of JenkinsJobBinding
	Params          string `gorm:"type:text" json:"-"` // JSON array of PipelineParam
	StageConfigJSON string `gorm:"type:longtext" json:"-"`
	DAGConfigJSON   string `gorm:"type:longtext" json:"-"` // DAG node config
	CreatedBy       string `gorm:"type:varchar(36)" json:"createdBy"`
	UpdatedBy       string `gorm:"type:varchar(36)" json:"updatedBy"`
	// Access control: JSON array of {userId, role} where role = "operator"|"viewer"
	// Creator is always owner. Empty = all users with pipeline permission can access.
	AccessControlJSON string `gorm:"type:text" json:"-"`
}

func (Pipeline) TableName() string { return "pipelines" }

// ── Pipeline runs ─────────────────────────────────────────────────────────

type PipelineRun struct {
	Base
	PipelineID     string     `gorm:"type:varchar(36);not null;index" json:"pipelineId"`
	PipelineName   string     `gorm:"type:varchar(300)" json:"pipelineName"`
	Status         string     `gorm:"type:varchar(30);not null;default:'pending';index" json:"status"`
	TriggerType    string     `gorm:"type:varchar(30)" json:"triggerType"`
	TriggeredBy    string     `gorm:"type:varchar(100)" json:"triggeredBy"`
	RuntimeParams  string     `gorm:"type:text" json:"-"` // JSON map
	ContextJSON    string     `gorm:"type:longtext" json:"-"` // runtime + node outputs snapshot
	PipelineSnapshotJSON string `gorm:"type:longtext" json:"-"` // pipeline config snapshot at trigger time
	Remark         string     `gorm:"type:varchar(500)" json:"remark"`
	ParentRunID    string     `gorm:"type:varchar(36)"  json:"parentRunId,omitempty"`
	ParentTaskID   string     `gorm:"type:varchar(36)"  json:"parentTaskId,omitempty"`
	StartedAt      *time.Time `json:"startedAt"`
	FinishedAt     *time.Time `json:"finishedAt"`
	DurationMs     int64      `json:"durationMs"`
	TotalCount     int        `gorm:"not null;default:0" json:"totalCount"`
	SuccessCount   int        `gorm:"not null;default:0" json:"successCount"`
	FailedCount    int        `gorm:"not null;default:0" json:"failedCount"`
	RunningCount   int        `gorm:"not null;default:0" json:"runningCount"`
	BlockedCount   int        `gorm:"not null;default:0" json:"blockedCount"`
	QueuedCount    int        `gorm:"not null;default:0" json:"queuedCount"`
	PassRate       float64    `gorm:"not null;default:0" json:"passRate"`
	AbortReason    string     `gorm:"type:varchar(200)" json:"abortReason,omitempty"`
	ErrorSummary   string     `gorm:"type:text" json:"errorSummary,omitempty"`
	JenkinsBuildID  int64     `json:"jenkinsBuildId"`
	JenkinsQueueID  int64     `json:"jenkinsQueueId"`
	JenkinsBuildURL string    `gorm:"type:varchar(1000)" json:"jenkinsBuildUrl"`
}

func (PipelineRun) TableName() string { return "pipeline_runs" }

// ── Task runs ─────────────────────────────────────────────────────────────

type TaskRun struct {
	Base
	PipelineRunID       string     `gorm:"type:varchar(36);not null;index" json:"pipelineRunId"`
	TestSetID           string     `gorm:"type:varchar(36);not null;index" json:"testSetId"`
	TestSetName         string     `gorm:"type:varchar(300)" json:"testSetName"`
	Project             string     `gorm:"type:varchar(100);index" json:"project"`
	AgentLabel          string     `gorm:"type:varchar(100)" json:"agentLabel"`
	DAGLayer            int        `gorm:"default:0"         json:"dagLayer"`
	DAGNodeID           string     `gorm:"type:varchar(36)"  json:"dagNodeId,omitempty"`
	DAGNodeType         string     `gorm:"type:varchar(30)"  json:"dagNodeType,omitempty"`
	DAGDepsJSON         string     `gorm:"type:text"         json:"-"`                    // JSON []string of dep nodeIDs
	DAGDetached         bool       `gorm:"not null;default:false" json:"dagDetached"`
	DAGJoinPolicy       string     `gorm:"type:varchar(20)"  json:"dagJoinPolicy,omitempty"`
	DAGFailurePolicy    string     `gorm:"type:varchar(20)"  json:"dagFailurePolicy,omitempty"`
	SubPipelineID       string     `gorm:"type:varchar(36)"  json:"subPipelineId,omitempty"` // for nested pipeline nodes
	SubRunID            string     `gorm:"type:varchar(36)"  json:"subRunId,omitempty"`
	ParamMappingJSON    string     `gorm:"type:text"         json:"-"`
	NodeInputJSON       string     `gorm:"type:text"         json:"-"`
	NodeConfigJSON      string     `gorm:"type:longtext"     json:"-"`
	SubPipelineParams   string     `gorm:"type:text"         json:"subPipelineParams,omitempty"`
	OutputsJSON         string     `gorm:"type:text"         json:"-"`
	Status              string     `gorm:"type:varchar(30);not null;default:'pending';index" json:"status"`
	AbortReason         string     `gorm:"type:varchar(200)" json:"abortReason,omitempty"`
	Phase               string     `gorm:"type:varchar(30);not null;default:''" json:"phase"`
	NodeName            string     `gorm:"type:varchar(200)" json:"nodeName"`
	JenkinsBuildID      int64      `json:"jenkinsBuildId"`
	JenkinsBuildURL     string     `gorm:"type:varchar(1000)" json:"jenkinsBuildUrl"`
	JenkinsQueueID      int64      `json:"jenkinsQueueId"`
	LogStatus           string     `gorm:"type:varchar(20);not null;default:'unknown'" json:"logStatus"`
	LogCheckedAt        *time.Time `json:"logCheckedAt"`
	ErrorSummary        string     `gorm:"type:text" json:"errorSummary"`
	StageSummaryJSON    string     `gorm:"type:text" json:"-"`
	ConfigSnapshotJSON  string     `gorm:"type:longtext" json:"-"`
	GlobalVarsSnapshot  string     `gorm:"type:longtext" json:"-"`
	DurationMs          int64      `json:"durationMs"`
	PassRate            float64    `json:"passRate"`
	BlockedByTaskID     string     `gorm:"type:varchar(36)" json:"blockedByTaskId"`
	StartedAt           *time.Time `json:"startedAt"`
	FinishedAt          *time.Time `json:"finishedAt"`
}

func (TaskRun) TableName() string { return "task_runs" }

// ── Audit logs ────────────────────────────────────────────────────────────





// ── DAG & Pipeline Nesting ────────────────────────────────────────────────

// PipelineNode represents one node in a pipeline's DAG.
// Type "testset" = run a test set; Type "pipeline" = call a sub-pipeline.
type PipelineNode struct {
	Base
	PipelineID   string `gorm:"type:varchar(36);not null;index" json:"pipelineId"`
	NodeType     string `gorm:"type:varchar(20);not null"       json:"nodeType"`     // testset | pipeline
	RefID        string `gorm:"type:varchar(36);not null"       json:"refId"`        // TestSet.ID or Pipeline.ID
	RefName      string `gorm:"type:varchar(300)"               json:"refName"`
	Label        string `gorm:"type:varchar(200)"               json:"label"`
	PositionX    float64 `gorm:"default:0"                     json:"positionX"`
	PositionY    float64 `gorm:"default:0"                     json:"positionY"`
	ParamOverrides string `gorm:"type:text"                    json:"paramOverrides"` // JSON: key→value
}
func (PipelineNode) TableName() string { return "pipeline_nodes" }

// PipelineEdge represents a dependency between two nodes (source must finish before target).
type PipelineEdge struct {
	Base
	PipelineID string `gorm:"type:varchar(36);not null;index" json:"pipelineId"`
	SourceID   string `gorm:"type:varchar(36);not null"       json:"sourceId"`  // PipelineNode.ID
	TargetID   string `gorm:"type:varchar(36);not null"       json:"targetId"`  // PipelineNode.ID
}
func (PipelineEdge) TableName() string { return "pipeline_edges" }

// ── Cleanup Configuration ─────────────────────────────────────────────────

// CleanupConfig stores admin-configurable data retention rules.
// There is only one row (singleton), keyed by ID="default".
type CleanupConfig struct {
	ID string `gorm:"type:varchar(36);primaryKey" json:"id"`
	// Retention days (0 = disabled)
	RunRetentionDays   int  `gorm:"not null;default:180" json:"runRetentionDays"`
	AuditRetentionDays int  `gorm:"not null;default:365" json:"auditRetentionDays"`
	NotiRetentionDays      int  `gorm:"not null;default:90"  json:"notiRetentionDays"`
	SnapshotRetentionDays int  `gorm:"not null;default:30"  json:"snapshotRetentionDays"` // clear snapshots in old task_runs
	// Max count limits (0 = disabled)
	MaxRunsPerPipeline int  `gorm:"not null;default:0"   json:"maxRunsPerPipeline"`
	MaxAuditLogs       int  `gorm:"not null;default:0"   json:"maxAuditLogs"`
	// Auto cleanup enabled
	AutoEnabled        bool `gorm:"not null;default:true" json:"autoEnabled"`
	UpdatedAt time.Time    `json:"updatedAt"`
	UpdatedBy string       `gorm:"type:varchar(36)"      json:"updatedBy"`
}
func (CleanupConfig) TableName() string { return "cleanup_configs" }

// ── Notification System ───────────────────────────────────────────────────

// NotificationEvent types
const (
	NotiPipelineComplete = "pipeline_complete"
	NotiPipelineFailed   = "pipeline_failed"
	NotiPipelineAborted  = "pipeline_aborted"
	NotiTaskFailed       = "task_failed"
	NotiUserDisabled     = "user_disabled"
	NotiPasswordReset    = "password_reset"
)

// Notification is an in-app notification for a specific user.
type Notification struct {
	Base
	UserID    string `gorm:"type:varchar(36);not null;index" json:"userId"`
	Event     string `gorm:"type:varchar(50);not null;index" json:"event"`
	Title     string `gorm:"type:varchar(200);not null" json:"title"`
	Body      string `gorm:"type:text" json:"body"`
	Link      string `gorm:"type:varchar(500)" json:"link,omitempty"`
	IsRead    bool   `gorm:"not null;default:false;index" json:"isRead"`
	RefID     string `gorm:"type:varchar(36);index" json:"refId,omitempty"`  // pipeline/run/task ID
	RefType   string `gorm:"type:varchar(30)" json:"refType,omitempty"`
}
func (Notification) TableName() string { return "notifications" }

// NotificationPreference stores per-user channel preferences.
type NotificationPreference struct {
	Base
	UserID          string `gorm:"type:varchar(36);uniqueIndex;not null" json:"userId"`
	// In-app
	InAppEnabled    bool   `gorm:"not null;default:true"  json:"inAppEnabled"`
	// Email
	EmailEnabled    bool   `gorm:"not null;default:false" json:"emailEnabled"`
	// Webhook
	WebhookEnabled  bool   `gorm:"not null;default:false" json:"webhookEnabled"`
	WebhookURL      string `gorm:"type:varchar(500)"      json:"webhookUrl,omitempty"`
	// Event switches (JSON: {"pipeline_complete":true,...})
	EventSwitches   string `gorm:"type:text"              json:"eventSwitches"`
}
func (NotificationPreference) TableName() string { return "notification_preferences" }

// SavedFilterView stores one user's reusable filter preset for a page/workbench.
type SavedFilterView struct {
	Base
	UserID      string `gorm:"type:varchar(36);not null;index:idx_saved_filter_user_scope" json:"userId"`
	ScopeKey    string `gorm:"type:varchar(100);not null;index:idx_saved_filter_user_scope" json:"scopeKey"`
	Name        string `gorm:"type:varchar(80);not null" json:"name"`
	FiltersJSON string `gorm:"type:longtext;not null" json:"filtersJson"`
}
func (SavedFilterView) TableName() string { return "saved_filter_views" }

// UserPreference stores per-user UI preferences such as pinned work tabs.
type UserPreference struct {
	Base
	UserID    string `gorm:"type:varchar(36);not null;index:idx_user_pref_user_key" json:"userId"`
	PrefKey   string `gorm:"type:varchar(100);not null;index:idx_user_pref_user_key" json:"prefKey"`
	ValueJSON string `gorm:"type:longtext;not null" json:"valueJson"`
}
func (UserPreference) TableName() string { return "user_preferences" }

// ── Permission System ─────────────────────────────────────────────────────

// RolePermission stores permissions for a role.
// resource: test_set|pipeline|jenkins|vars|libs|dimensions|users|audit|dashboard
// action:   view|create|edit|delete|trigger|import|clone|ping|sync|reset_pwd|disable|fullscreen
// allow:    true=grant, false=deny
type RolePermission struct {
	ID       string `gorm:"type:varchar(36);primaryKey" json:"id"`
	Role     string `gorm:"type:varchar(30);not null;index" json:"role"`
	Resource string `gorm:"type:varchar(50);not null" json:"resource"`
	Action   string `gorm:"type:varchar(50);not null" json:"action"`
	Allow    bool   `gorm:"not null" json:"allow"`
}
func (RolePermission) TableName() string { return "role_permissions" }

// UserPermission stores per-user permission overrides (merged with role perms).
type UserPermission struct {
	ID       string `gorm:"type:varchar(36);primaryKey" json:"id"`
	UserID   string `gorm:"type:varchar(36);not null;index" json:"userId"`
	Resource string `gorm:"type:varchar(50);not null" json:"resource"`
	Action   string `gorm:"type:varchar(50);not null" json:"action"`
	Allow    bool   `gorm:"not null" json:"allow"`
}
func (UserPermission) TableName() string { return "user_permissions" }

type AuditLog struct {
	Base
	UserID       string `gorm:"type:varchar(36);index" json:"userId"`
	Username     string `gorm:"type:varchar(100)" json:"username"`
	Action       string `gorm:"type:varchar(50);not null;index" json:"action"`
	ResourceType string `gorm:"type:varchar(50);index" json:"resourceType"`
	ResourceID   string `gorm:"type:varchar(36)" json:"resourceId"`
	ResourceName string `gorm:"type:varchar(300)" json:"resourceName"`
	DiffJSON     string `gorm:"type:longtext" json:"diffJson,omitempty"`
	IP           string `gorm:"type:varchar(50)" json:"ip"`
	// Enhanced fields
	Button      string `gorm:"type:varchar(100)" json:"button,omitempty"`    // which button was clicked
	Module      string `gorm:"type:varchar(50);index" json:"module,omitempty"` // frontend module/page
	UserAgent   string `gorm:"type:varchar(500)" json:"userAgent,omitempty"`
	RequestID   string `gorm:"type:varchar(36);index" json:"requestId,omitempty"`
	StatusCode  int    `gorm:"default:200" json:"statusCode"`
}

func (AuditLog) TableName() string { return "audit_logs" }

// ── Notification Rule System ───────────────────────────────────────────────

// NotificationRule defines when to notify whom via which channel.
type NotificationRule struct {
	Base
	Name          string `gorm:"type:varchar(100);not null" json:"name"`
	Enabled       bool   `gorm:"not null;default:true" json:"enabled"`
	// Events: JSON array of event types, e.g. ["pipeline_failed","pipeline_aborted"]
	EventsJSON    string `gorm:"type:text;not null" json:"eventsJson"`
	// Scope: "global" or "project"
	Scope         string `gorm:"type:varchar(20);not null;default:'global'" json:"scope"`
	// ProjectIDs: JSON array of project IDs (when scope=project)
	ProjectIDsJSON string `gorm:"type:text" json:"projectIdsJson,omitempty"`
	// PipelineIDs: JSON array of pipeline IDs (empty = all pipelines)
	PipelineIDsJSON string `gorm:"type:text" json:"pipelineIdsJson,omitempty"`
	// Channels: JSON array of strings: "inapp","email","dingtalk","feishu","webhook"
	ChannelsJSON  string `gorm:"type:text;not null" json:"channelsJson"`
	// Recipients: JSON, e.g. {"type":"roles","roles":["project_manager"]} or {"type":"users","userIds":["..."]}
	RecipientsJSON string `gorm:"type:text" json:"recipientsJson,omitempty"`
	// Webhook config (when channel includes "webhook" or "dingtalk" or "feishu")
	WebhookURL    string `gorm:"type:varchar(500)" json:"webhookUrl,omitempty"`
	// ChannelConfigsJSON stores per-channel delivery config. Old webhook_url remains a fallback.
	ChannelConfigsJSON string `gorm:"type:longtext" json:"channelConfigsJson,omitempty"`
	// Template override
	TitleTemplate string `gorm:"type:varchar(300)" json:"titleTemplate,omitempty"`
	BodyTemplate  string `gorm:"type:text"         json:"bodyTemplate,omitempty"`
	CreatedBy     string `gorm:"type:varchar(36)"  json:"createdBy,omitempty"`
}
func (NotificationRule) TableName() string { return "notification_rules" }

// ── Environment Deployment ─────────────────────────────────────────────────

// EnvProfile defines how to initialize an environment on a set of agents.
type EnvProfile struct {
	Base
	Name         string `gorm:"type:varchar(200);not null"       json:"name"`
	Project      string `gorm:"type:varchar(100);not null;index" json:"project"`
	AgentLabel   string `gorm:"type:varchar(200);not null"       json:"agentLabel"`
	DeployScript string `gorm:"type:longtext"                    json:"deployScript"`
	CheckCmd     string `gorm:"type:varchar(500)"                json:"checkCmd"`
	ScriptHash   string `gorm:"type:varchar(64)"                 json:"scriptHash"`
	AutoDeploy   bool   `gorm:"not null;default:false"           json:"autoDeploy"`
	Description  string `gorm:"type:varchar(500)"                json:"description"`
	CreatedBy    string `gorm:"type:varchar(36)"                 json:"createdBy"`
}
func (EnvProfile) TableName() string { return "env_profiles" }

// DeployStatus represents the status of a machine deployment.
type DeployStatus string
const (
	DeployStatusPending  DeployStatus = "pending"   // detected, not yet deployed
	DeployStatusRunning  DeployStatus = "running"   // deploy script in progress
	DeployStatusSuccess  DeployStatus = "success"   // deployed and verified
	DeployStatusFailed   DeployStatus = "failed"    // deploy or verify failed
	DeployStatusOutdated DeployStatus = "outdated"  // script hash changed, needs redeploy
)

// AgentDeployRecord tracks the deployment state per (node_id, profile_id) pair.
type AgentDeployRecord struct {
	Base
	ProfileID   string       `gorm:"type:varchar(36);not null;index" json:"profileId"`
	NodeID      string       `gorm:"type:varchar(200);not null;index" json:"nodeId"`
	NodeLabel   string       `gorm:"type:varchar(200)"               json:"nodeLabel"`
	DeployHash  string       `gorm:"type:varchar(64)"                json:"deployHash"`
	Status      DeployStatus `gorm:"type:varchar(20);not null;default:'pending'" json:"status"`
	LastOutput  string       `gorm:"type:text"                       json:"lastOutput,omitempty"`
	DeployedAt  *time.Time                                   `json:"deployedAt,omitempty"`
	DeployedBy  string       `gorm:"type:varchar(36)"                json:"deployedBy,omitempty"`
}
func (AgentDeployRecord) TableName() string { return "agent_deploy_records" }

// ── Pipeline Version History ───────────────────────────────────────────────

// PipelineVersion stores a snapshot of pipeline config on every save.
type PipelineVersion struct {
	Base
	PipelineID      string `gorm:"type:varchar(36);not null;index" json:"pipelineId"`
	Version         int    `gorm:"not null"                       json:"version"`
	Name            string `gorm:"type:varchar(300)"              json:"name"`
	StageConfigJSON string `gorm:"type:longtext"                  json:"stageConfigJson"`
	DAGConfigJSON   string `gorm:"type:longtext"                  json:"dagConfigJson"`
	Params          string `gorm:"type:text"                      json:"params"`
	JenkinsBindings string `gorm:"type:text"                      json:"jenkinsBindings"`
	ChangeSummary   string `gorm:"type:varchar(500)"              json:"changeSummary"`
	ChangedBy       string `gorm:"type:varchar(36)"               json:"changedBy"`
	ChangedByName   string `gorm:"type:varchar(200)"              json:"changedByName"`
}
func (PipelineVersion) TableName() string { return "pipeline_versions" }

// ── Jenkins Report API ────────────────────────────────────────────────────

// ReportedPipelineRun stores runs reported by Jenkins (not triggered from platform).
type ReportedPipelineRun struct {
	Base
	PipelineKey   string     `gorm:"type:varchar(200);not null;index" json:"pipelineKey"`   // Jenkins Job name
	PipelineName  string     `gorm:"type:varchar(300);not null" json:"pipelineName"`        // Display name
	BuildID       int64      `json:"buildId"`
	BuildURL      string     `gorm:"type:varchar(1000)" json:"buildUrl"`
	Status        string     `gorm:"type:varchar(30);not null;default:'running'" json:"status"` // running|success|failed|aborted
	TriggeredBy   string     `gorm:"type:varchar(200)" json:"triggeredBy"`
	StartedAt     *time.Time `json:"startedAt"`
	FinishedAt    *time.Time `json:"finishedAt"`
	DurationMs    int64      `json:"durationMs"`
	ErrorSummary  string     `gorm:"type:text" json:"errorSummary,omitempty"`
	Source        string     `gorm:"type:varchar(30);not null;default:'jenkins_report'" json:"source"` // jenkins_report | platform_trigger
	// Link to platform pipeline (optional, if triggered from platform)
	PipelineID    string     `gorm:"type:varchar(36);index" json:"pipelineId,omitempty"`
	PipelineRunID string     `gorm:"type:varchar(36);index" json:"pipelineRunId,omitempty"`
}
func (ReportedPipelineRun) TableName() string { return "reported_pipeline_runs" }

// ReportedStageRun stores individual stages within a reported pipeline run.
type ReportedStageRun struct {
	Base
	ReportedPipelineRunID string     `gorm:"type:varchar(36);not null;index" json:"reportedPipelineRunId"`
	StageKey              string     `gorm:"type:varchar(200);not null" json:"stageKey"`
	StageName             string     `gorm:"type:varchar(300)" json:"stageName"`
	Status                string     `gorm:"type:varchar(30);not null;default:'pending'" json:"status"` // pending|running|success|failed|aborted
	NodeName              string     `gorm:"type:varchar(200)" json:"nodeName,omitempty"`
	StartedAt             *time.Time `json:"startedAt,omitempty"`
	FinishedAt            *time.Time `json:"finishedAt,omitempty"`
	DurationMs            int64      `json:"durationMs"`
	ErrorSummary          string     `gorm:"type:text" json:"errorSummary,omitempty"`
}
func (ReportedStageRun) TableName() string { return "reported_stage_runs" }

// SystemSetting stores one-time migration markers and lightweight platform flags.
type SystemSetting struct {
	Key       string    `gorm:"type:varchar(100);primaryKey" json:"key"`
	Value     string    `gorm:"type:text" json:"value"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (SystemSetting) TableName() string { return "system_settings" }
