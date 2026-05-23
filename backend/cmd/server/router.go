package main

import (
	"github.com/gin-gonic/gin"

	"github.com/company/atop-backend/internal/handler"
	"github.com/company/atop-backend/internal/middleware"
)

func setupRouter() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()

	// Global middleware
	r.Use(middleware.Recovery())
	r.Use(middleware.RequestLogger())
	r.MaxMultipartMemory = 32 << 20 // 32 MB max multipart
	r.Use(middleware.CORS())
	r.Use(middleware.SecurityHeaders())
	r.Use(middleware.RequestSizeLimit(10 << 20)) // 10 MB max body
	r.Use(middleware.StringLengthLimit())

	// Handlers
	authH      := &handler.AuthHandler{}
	dimH       := &handler.DimensionHandler{}
	jenkinsH   := &handler.JenkinsHandler{}
	varsH      := &handler.VarsHandler{}
	libsH      := &handler.LibsHandler{}
	tsH        := &handler.TestSetHandler{}
	plH        := &handler.PipelineHandler{}
	runH       := &handler.RunHandler{}
	taskH      := &handler.TaskRunHandler{}
	userH      := &handler.UserHandler{}
	permH      := &handler.PermissionHandler{}
	notiH      := &handler.NotificationHandler{}
	notiRuleH  := handler.NewNotificationRuleHandler()
	envH       := handler.NewEnvDeployHandler()
	pipeVerH   := handler.NewPipelineVersionHandler()
	trendH     := handler.NewTrendHandler()
	cleanH     := &handler.CleanupHandler{}
	dagH       := &handler.DAGHandler{}
	auditH      := &handler.AuditHandler{}
	filterViewH := handler.NewSavedFilterViewHandler()
	prefH       := handler.NewUserPreferenceHandler()

	// ── Public ────────────────────────────────────────────────────────────
	r.GET("/health", authH.Health)

	api := r.Group("/api")
	api.GET("/version", authH.Version)

	// Auth
	auth := api.Group("/auth")
	{
		auth.POST("/login",   middleware.LoginRateLimit(), authH.Login)
		auth.POST("/refresh", authH.Refresh)
		auth.POST("/logout",  middleware.Auth(), authH.Logout)
		auth.POST("/change-password",    middleware.Auth(), authH.ChangePassword)
		auth.POST("/forgot-password",     authH.ForgotPassword)
		auth.POST("/reset-password",      authH.ResetPasswordByToken)
		auth.GET("/validate-reset-token", authH.ValidateResetToken)
	}

	// Webhook (Jenkins callback — authenticated by HMAC, not JWT)
	api.POST("/webhook/task/:taskId", taskH.Webhook)
	api.POST("/webhook/pipeline/:id", plH.WebhookTrigger)

	// Jenkins Report API (public — Jenkins scripts call these directly)
	reportH := &handler.ReportHandler{}
	api.POST("/report/pipeline", reportH.ReportPipeline)
	api.GET("/report/runs",      reportH.ListReportedRuns)
	api.GET("/report/runs/:id",  reportH.GetReportedRun)
	api.GET("/report/by-run/:pipelineRunId", reportH.GetByPipelineRunID)

	// ── Protected ─────────────────────────────────────────────────────────
	protected := api.Group("", middleware.Auth())

	// Dimension dict
	dim := protected.Group("/dimension-dict")
	{
		dim.GET("",      dimH.List)
		dim.POST("",     middleware.RequirePermission("dimensions", "create"), dimH.Create)
		dim.PUT("/:id",  middleware.RequirePermission("dimensions", "edit"), dimH.Update)
		dim.DELETE("/:id", middleware.RequirePermission("dimensions", "delete"), dimH.Delete)
	}

	// Jenkins instances
	jenkins := protected.Group("/settings/jenkins")
	{
		jenkins.GET("",                  jenkinsH.List)
		jenkins.POST("",                 middleware.RequirePermission("jenkins", "create"), jenkinsH.Create)
		jenkins.PUT("/:id",              middleware.RequirePermission("jenkins", "edit"), jenkinsH.Update)
		jenkins.DELETE("/:id",           middleware.RequirePermission("jenkins", "delete"), jenkinsH.Delete)
		jenkins.POST("/:id/ping",        jenkinsH.Ping)
		jenkins.POST("/:id/sync-agents", jenkinsH.SyncAgents)
	}

	// Agent labels & nodes
	protected.GET("/settings/agent-labels", jenkinsH.ListLabels)
	protected.GET("/settings/agent-nodes", jenkinsH.ListInstanceNodes)
	protected.GET("/settings/agent-labels/:labelId/nodes", jenkinsH.ListNodes)

	// Global vars
	vars := protected.Group("/settings/vars")
	{
		vars.GET("",      varsH.List)
		vars.POST("",     middleware.RequirePermission("vars", "create"), varsH.Create)
		vars.PUT("/:id",  middleware.RequirePermission("vars", "edit"), varsH.Update)
		vars.DELETE("/:id", middleware.RequirePermission("vars", "delete"), varsH.Delete)
	}

	// Shared libs
	libs := protected.Group("/shared-libs")
	{
		libs.GET("",                 libsH.List)
		libs.GET("/:id",             libsH.Get)
		libs.POST("",                middleware.RequirePermission("libs", "create"), libsH.Create)
		libs.PUT("/:id",             middleware.RequirePermission("libs", "edit"), libsH.Update)
		libs.DELETE("/:id",          middleware.RequirePermission("libs", "delete"), libsH.Delete)
		libs.GET("/:id/versions",    libsH.ListVersions)
		libs.POST("/:id/rollback",   middleware.RequirePermission("libs", "edit"), libsH.Rollback)
	}

	// Test sets
	ts := protected.Group("/test-sets")
	{
		ts.GET("",                      tsH.List)
		ts.GET("/:id",                  tsH.Get)
		ts.POST("",                     middleware.RequirePermission("test_set", "create"), tsH.Create)
		ts.PUT("/:id",                  middleware.RequirePermission("test_set", "edit"), tsH.Update)
		ts.DELETE("/:id",               middleware.RequirePermission("test_set", "delete"), tsH.Delete)
		ts.PUT("/:id/status",           middleware.RequirePermission("test_set", "edit"), tsH.UpdateStatus)
		ts.GET("/:id/preview-json",     tsH.PreviewJSON)
		// ts.POST("/:id/run",             tsH.TriggerSingle)  // removed: single run flows through pipeline now
		ts.POST("/:id/clone",           middleware.RequirePermission("test_set", "clone"), tsH.Clone)
		ts.POST("/import",               middleware.RequirePermission("test_set", "import"), tsH.BatchImportMulti)
		ts.POST("/import/preview",        middleware.RequirePermission("test_set", "import"), tsH.ImportPreview)
		ts.GET("/tags",                   tsH.GetTags)
	}

	// Batch status update
	protected.PUT("/test-sets/batch-status",
		middleware.RequirePermission("pipeline", "trigger"),
		tsH.BatchUpdateStatus,
	)

	// Pipelines
	pl := protected.Group("/pipelines")
	{
		pl.GET("",          plH.List)
		pl.GET("/:id",      plH.Get)
		pl.POST("",         middleware.RequirePermission("pipeline", "create"), plH.Create)
		pl.PUT("/:id",      middleware.RequirePermission("pipeline", "edit"), plH.Update)
		pl.DELETE("/:id",   middleware.RequirePermission("pipeline", "delete"), plH.Delete)
		pl.POST("/:id/validate-run", plH.ValidateRun)
		pl.POST("/:id/run",      plH.TriggerRun)
		pl.GET("/:id/access",    plH.GetAccess)
		pl.PUT("/:id/access",    plH.UpdateAccess)
		pl.POST("/validate-dag",  plH.ValidateDAG)
		pl.GET("/:id/versions",              pipeVerH.List)
		pl.GET("/:id/versions/:ver",         pipeVerH.Get)
		pl.GET("/:id/versions/:ver/diff",    pipeVerH.Diff)
		pl.POST("/:id/versions/:ver/restore", pipeVerH.Restore)
	}

	// Pipeline runs
	runs := protected.Group("/pipeline-runs")
	{
		runs.GET("",              runH.List)
		runs.GET("/dashboard-stats", runH.DashboardStats)
		runs.GET("/:id",          runH.Get)
		runs.POST("/:id/rebuild", runH.Rebuild)
		runs.POST("/:id/abort",   runH.Abort)
		runs.GET("/:id/tasks",          runH.GetTaskRuns)
		runs.GET("/:id/dispatch-config",  runH.DispatchConfig)
		runs.GET("/:id/children",         plH.GetChildRuns)
	}

	// Task runs
	task := protected.Group("/task-runs")
	{
		task.POST("/:id/abort",       taskH.Abort)
		task.GET("/:id/stages",       taskH.GetStages)
		task.POST("/:id/check-log",   taskH.CheckLog)
		task.POST("/batch-check-log", taskH.BatchCheckLog)
	}

	// Users
	// DAG routes
	dag := protected.Group("/pipelines/:id/dag")
	{
		dag.GET("",           dagH.GetDAG)
		dag.POST("",          dagH.SaveDAG)
		dag.GET("/plan",      dagH.GetDAGExecutionPlan)
		dag.GET("/available-pipelines", dagH.GetAvailablePipelines)
	}

	// Cleanup management (super admin only)
	cleanup := protected.Group("/admin/cleanup")
	{
		cleanup.GET("",        middleware.RequirePermission("cleanup", "view"), cleanH.GetConfig)
		cleanup.PUT("",        middleware.RequirePermission("cleanup", "edit"), cleanH.UpdateConfig)
		cleanup.GET("/dryrun", middleware.RequirePermission("cleanup", "view"), cleanH.DryRun)
		cleanup.POST("/run",   middleware.RequirePermission("cleanup", "edit"), cleanH.Execute)
	}

	// Notification routes
	noti := protected.Group("/notifications")
	{
		noti.GET("",            notiH.List)
		noti.GET("/unread",     notiH.UnreadCount)
		noti.GET("/recent",     notiH.Recent)
		noti.GET("/preference", notiH.GetPreference)
		noti.PUT("/preference", notiH.UpdatePreference)
		noti.PUT("/batch",      notiH.BatchUpdate)
		noti.DELETE("/batch",   notiH.BatchDelete)
		noti.PUT("/all/read",   notiH.MarkAllRead)
		noti.GET("/item/:id",   notiH.Get)
		noti.PUT("/item/:id/read", notiH.MarkRead)
		noti.DELETE("/item/:id", notiH.Delete)

		// Notification rules
		noti.GET("/rules",         middleware.RequirePermission("notification_rule", "view"), notiRuleH.List)
		noti.POST("/rules",        middleware.RequirePermission("notification_rule", "create"), notiRuleH.Create)
		noti.GET("/rules/:id",     middleware.RequirePermission("notification_rule", "view"), notiRuleH.Get)
		noti.PUT("/rules/:id",     middleware.RequirePermission("notification_rule", "edit"), notiRuleH.Update)
		noti.DELETE("/rules/:id",  middleware.RequirePermission("notification_rule", "delete"), notiRuleH.Delete)
		noti.PUT("/rules/:id/toggle", middleware.RequirePermission("notification_rule", "edit"), notiRuleH.Toggle)
		noti.POST("/rules/:id/test", middleware.RequirePermission("notification_rule", "edit"), notiRuleH.Test)
	}

	// Stats / trend routes
	stats := protected.Group("/stats")
	{
		stats.GET("/trends",    trendH.PipelineTrends)
		stats.GET("/summary",   trendH.Summary)
		stats.GET("/pipelines", trendH.PipelineBreakdown)
	}

	// Environment deployment routes
	envP := protected.Group("/env-profiles")
	{
		envP.GET("",                              envH.ListProfiles)
		envP.POST("",                             envH.CreateProfile)
		envP.GET("/:id",                          envH.GetProfile)
		envP.PUT("/:id",                          envH.UpdateProfile)
		envP.DELETE("/:id",                       envH.DeleteProfile)
		envP.GET("/:id/records",                  envH.ListRecords)
		envP.GET("/:id/nodes",                    envH.ListNodes)
		envP.POST("/:id/deploy",                  envH.TriggerDeploy)
		envP.PUT("/:id/records/:nodeId/status",   envH.UpdateRecordStatus)
	}

	// Permission management routes
	perms := protected.Group("/permissions")
	{
		perms.GET("/matrix",                                 permH.GetPermissionMatrix)
		perms.GET("/my",                                     permH.GetMyPermissions)
		perms.GET("/roles/:role",   middleware.RequirePermission("permission", "view"), permH.GetRolePermissions)
		perms.PUT("/roles/:role",   middleware.RequirePermission("permission", "edit"), permH.UpdateRolePermissions)
		perms.GET("/users/:userId", middleware.RequirePermission("permission", "view"), permH.GetUserPermissionOverrides)
		perms.PUT("/users/:userId", middleware.RequirePermission("permission", "edit"), permH.UpdateUserPermissionOverrides)
		perms.GET("/roles-list",    permH.ListRolesLite) // lightweight: for dropdowns
	}

	protected.PUT("/users/me/avatar", userH.UpdateMyAvatar)

	preferences := protected.Group("/users/me/preferences")
	{
		preferences.GET("/:key", prefH.Get)
		preferences.PUT("/:key", prefH.Save)
	}

	filterViews := protected.Group("/saved-filter-views")
	{
		filterViews.GET("",       filterViewH.List)
		filterViews.POST("",      filterViewH.Save)
		filterViews.DELETE("/:id", filterViewH.Delete)
	}

	users := protected.Group("/admin/users")
	{
		users.GET("",                       middleware.RequirePermission("users", "view"), userH.List)
		users.POST("",                      middleware.RequirePermission("users", "create"), userH.Create)
		users.PUT("/:id",                   middleware.RequirePermission("users", "edit"), userH.Update)
		users.PUT("/:id/status",            middleware.RequirePermission("users", "edit"), userH.UpdateStatus)
		users.POST("/:id/reset-password",   middleware.RequirePermission("users", "reset_pwd"), userH.ResetPassword)
		users.DELETE("/:id",                middleware.RequirePermission("users", "delete"), userH.Delete)
		users.POST("/batch-import",          middleware.RequirePermission("users", "import"), userH.BatchImport)
		users.GET("/:id/history",            middleware.RequirePermission("users", "view"), permH.GetUserHistory)
	}

	// Audit logs
	protected.POST("/audit/track", auditH.Track)
	protected.GET("/admin/audit", auditH.List)
	protected.GET("/admin/audit/export", auditH.Export)

	// Role management routes
	roles := protected.Group("/admin/roles")
	{
		roles.GET("",         middleware.RequirePermission("roles", "view"), permH.ListRoles)
		roles.GET("/:id",     middleware.RequirePermission("roles", "view"), permH.GetRole)
		roles.GET("/:id/history", middleware.RequirePermission("roles", "view"), permH.GetRoleHistory)
		roles.GET("/by-name/:roleName/users", middleware.RequirePermission("roles", "view"), permH.GetRoleUsers)
		roles.POST("/by-name/:roleName/users", middleware.RequirePermission("roles", "edit"), permH.AssignUsersToRole)
		roles.DELETE("/by-name/:roleName/users/:userId", middleware.RequirePermission("roles", "edit"), permH.RemoveUserFromRole)
		roles.POST("",        middleware.RequirePermission("roles", "create"), permH.CreateRole)
		roles.PUT("/:id",     middleware.RequirePermission("roles", "edit"), permH.UpdateRole)
		roles.PUT("/:id/status", middleware.RequirePermission("roles", "edit"), permH.ToggleRoleStatus)
		roles.DELETE("/:id",  middleware.RequirePermission("roles", "delete"), permH.DeleteRole)
	}

	return r
}
