package database

import (
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/pkg/logger"
)

// Migrate runs GORM AutoMigrate for all models.
func Migrate() error {
	logger.Info("running database migrations...")

	// Safe column additions for existing deployments
	DB.Exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_pwd tinyint(1) NOT NULL DEFAULT 0")
	DB.Exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url longtext")
	DB.Exec("ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS dag_config_json longtext")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS dag_node_id varchar(36) DEFAULT NULL")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS dag_node_type varchar(30) DEFAULT NULL")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS dag_deps_json text DEFAULT NULL")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS dag_detached tinyint(1) NOT NULL DEFAULT 0")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS dag_join_policy varchar(20) DEFAULT NULL")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS dag_failure_policy varchar(20) DEFAULT NULL")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS sub_pipeline_id varchar(36) DEFAULT NULL")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS sub_run_id varchar(36) DEFAULT NULL")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS param_mapping_json text DEFAULT NULL")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS node_input_json text DEFAULT NULL")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS node_config_json longtext DEFAULT NULL")
	DB.Exec("ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS outputs_json text DEFAULT NULL")
	DB.Exec("ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS parent_run_id varchar(36) DEFAULT NULL")
	DB.Exec("ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS parent_task_id varchar(36) DEFAULT NULL")
	DB.Exec("ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS context_json longtext DEFAULT NULL")
	DB.Exec("ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS pipeline_snapshot_json longtext DEFAULT NULL")
	DB.Exec("ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS error_summary text DEFAULT NULL")
	DB.Exec("ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS jenkins_queue_id bigint DEFAULT 0")
	DB.Exec("ALTER TABLE jenkins_instances ADD COLUMN IF NOT EXISTS agent_sync_mode varchar(20) NOT NULL DEFAULT 'all'")
	DB.Exec("ALTER TABLE jenkins_instances ADD COLUMN IF NOT EXISTS fixed_nodes text DEFAULT NULL")
	DB.Exec("ALTER TABLE agent_nodes ADD COLUMN IF NOT EXISTS labels_json text DEFAULT NULL")
	DB.Exec("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS button varchar(100) DEFAULT NULL")
	DB.Exec("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS module varchar(50) DEFAULT NULL")
	DB.Exec("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent varchar(500) DEFAULT NULL")
	DB.Exec("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_id varchar(36) DEFAULT NULL")
	DB.Exec("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS status_code int DEFAULT 200")
	DB.Exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token varchar(100) DEFAULT NULL")
	DB.Exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_exp bigint DEFAULT NULL")
	DB.Exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS temp_password_expires_at datetime(3) DEFAULT NULL")
	DB.Exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS current_session_id varchar(36) DEFAULT ''")
	DB.Exec("ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS session_id varchar(36) DEFAULT ''")
	DB.Exec("ALTER TABLE notification_rules ADD COLUMN IF NOT EXISTS channel_configs_json longtext DEFAULT NULL")
	DB.Exec("ALTER TABLE user_identity_snapshots ADD COLUMN IF NOT EXISTS deleted_at datetime(3) DEFAULT NULL")
	DB.Exec("ALTER TABLE users DROP COLUMN IF EXISTS deleted_at")
	DB.Exec("ALTER TABLE roles DROP COLUMN IF EXISTS deleted_at")

	// Role management migration
	DB.Exec("ALTER TABLE pipelines MODIFY COLUMN access_control_json text")

	if err := DB.AutoMigrate(
		&model.Role{},
		&model.PipelineVersion{},
		&model.EnvProfile{},
		&model.AgentDeployRecord{},
		&model.NotificationRule{},
		&model.User{},
		&model.RefreshToken{},
		&model.DimensionItem{},
		&model.JenkinsInstance{},
		&model.AgentLabel{},
		&model.AgentNode{},
		&model.GlobalVar{},
		&model.TestSet{},
		&model.SharedLib{},
		&model.SharedLibVersion{},
		&model.Pipeline{},
		&model.PipelineRun{},
		&model.TaskRun{},
		&model.ReportedPipelineRun{},
		&model.ReportedStageRun{},
		&model.SystemSetting{},
		&model.AuditLog{},
		&model.RolePermission{},
		&model.UserPermission{},
		&model.PipelineNode{},
		&model.PipelineEdge{},
		&model.CleanupConfig{},
		&model.Notification{},
		&model.NotificationPreference{},
		&model.SavedFilterView{},
		&model.UserPreference{},
		&model.UserRoleBinding{},
		&model.UserIdentitySnapshot{},
	); err != nil {
		logger.Error("AutoMigrate failed: " + err.Error())
		return err
	}

	if DB.Migrator().HasTable(&model.User{}) {
		_ = DB.Exec(`
			INSERT INTO user_identity_snapshots (user_id, username, email, deleted_at, created_at, updated_at)
			SELECT id, username, email, NULL, created_at, updated_at
			FROM users
			ON DUPLICATE KEY UPDATE
				username = VALUES(username),
				email = VALUES(email),
				deleted_at = VALUES(deleted_at),
				updated_at = VALUES(updated_at)
		`).Error
	}

	// Verify critical table exists
	if !DB.Migrator().HasTable(&model.Role{}) {
		logger.Warn("roles table not created by AutoMigrate, creating manually...")
		if err := DB.Exec(`CREATE TABLE IF NOT EXISTS roles (
			id VARCHAR(36) PRIMARY KEY,
			created_at DATETIME(3),
			updated_at DATETIME(3),
			name VARCHAR(50) NOT NULL,
			display_name VARCHAR(100) NOT NULL,
			description VARCHAR(500) DEFAULT '',
			is_builtin TINYINT(1) NOT NULL DEFAULT 0,
			created_by VARCHAR(36) DEFAULT '',
			UNIQUE INDEX idx_roles_name (name),
		)`).Error; err != nil {
			logger.Error("manual roles table creation failed: " + err.Error())
			return err
		}
		logger.Info("roles table created manually")
	}

	// Create composite indexes not expressible via struct tags
	type indexDef struct{ table, name, cols string }
	indexes := []indexDef{
		{"test_sets", "idx_testset_coords", "project, environment, product, silicon, os, run_type, status"},
		{"test_sets", "idx_testset_priority", "status, priority DESC, created_at DESC"},
		{"test_sets", "idx_testset_updated", "updated_at DESC"},
		{"task_runs", "idx_taskrun_run_status", "pipeline_run_id, status"},
		{"task_runs", "idx_taskrun_log_check", "log_status, finished_at"},
		{"pipeline_runs", "idx_prun_status_time", "status, started_at DESC"},
		{"pipeline_runs", "idx_prun_pipeline", "pipeline_id, started_at DESC"},
		{"audit_logs", "idx_audit_time", "created_at DESC"},
		{"audit_logs", "idx_audit_resource", "resource_type, resource_id"},
		{"global_vars", "idx_var_scope_key", "scope, project_id, `key`"},
		{"shared_libs", "idx_lib_scope_lang", "scope, lang, project_id"},
		{"dimension_dict", "idx_dim_type_sort", "dimension, sort_order"},
	}

	for _, idx := range indexes {
		sql := "CREATE INDEX IF NOT EXISTS `" + idx.name + "` ON `" + idx.table + "` (" + idx.cols + ")"
		if err := DB.Exec(sql).Error; err != nil {
			logger.Warn("index creation skipped: " + idx.name + " — " + err.Error())
		}
	}

	logger.Info("database migrations completed")
	return nil
}
