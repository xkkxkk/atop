package handler

import (
	"github.com/google/uuid"

	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/model"
)

const (
	ResTestSet      = "test_set"
	ResPipeline     = "pipeline"
	ResJenkins      = "jenkins"
	ResVars         = "vars"
	ResLibs         = "libs"
	ResDimensions   = "dimensions"
	ResUsers        = "users"
	ResAudit        = "audit"
	ResNotification = "notification_rule"
	ResEnvProfile   = "env_profile"
	ResPermission   = "permission"
	ResCleanup      = "cleanup"
	ResRoles        = "roles"

	ActView       = "view"
	ActCreate     = "create"
	ActEdit       = "edit"
	ActDelete     = "delete"
	ActTrigger    = "trigger"
	ActImport     = "import"
	ActClone      = "clone"
	ActPing       = "ping"
	ActSync       = "sync"
	ActResetPwd   = "reset_pwd"
	ActDisable    = "disable"
	ActFullscreen = "fullscreen"
)

var AllResources = []string{
	ResPipeline,
	ResJenkins,
	ResVars,
	ResDimensions,
	ResUsers,
	ResRoles,
	ResAudit,
	ResNotification,
	ResPermission,
	ResCleanup,
}

var ResourceActions = map[string][]string{
	ResPipeline:     {ActView, ActCreate, ActEdit, ActDelete, ActTrigger},
	ResJenkins:      {ActView, ActCreate, ActEdit, ActDelete, ActPing, ActSync},
	ResVars:         {ActView, ActCreate, ActEdit, ActDelete},
	ResDimensions:   {ActView, ActCreate, ActEdit, ActDelete},
	ResUsers:        {ActView, ActCreate, ActEdit, ActDelete, ActDisable, ActResetPwd, ActImport},
	ResRoles:        {ActView, ActCreate, ActEdit, ActDelete},
	ResAudit:        {ActView},
	ResNotification: {ActView, ActCreate, ActEdit, ActDelete},
	ResPermission:   {ActView, ActEdit},
	ResCleanup:      {ActView, ActEdit},
}

func IsKnownPermission(resource, action string) bool {
	for _, candidate := range ResourceActions[resource] {
		if candidate == action {
			return true
		}
	}
	return false
}

var ResourceLabels = map[string]string{
	ResPipeline:     "流水线",
	ResJenkins:      "Jenkins 实例",
	ResVars:         "公共变量池",
	ResDimensions:   "数据字典",
	ResUsers:        "用户管理",
	ResRoles:        "角色管理",
	ResAudit:        "审计日志",
	ResNotification: "通知规则",
	ResPermission:   "权限配置",
	ResCleanup:      "数据清理",
}

var ActionLabels = map[string]string{
	ActView:       "查看",
	ActCreate:     "新建",
	ActEdit:       "编辑",
	ActDelete:     "删除",
	ActTrigger:    "触发",
	ActImport:     "导入",
	ActClone:      "复制",
	ActPing:       "连通",
	ActSync:       "同步",
	ActResetPwd:   "重置密码",
	ActDisable:    "禁用/启用",
	ActFullscreen: "全屏大盘",
}

type permDef struct {
	resource string
	action   string
	allow    bool
}

var defaultRolePerms = map[string][]permDef{
	"project_manager": {
		{ResPipeline, ActView, true},
		{ResPipeline, ActCreate, true},
		{ResPipeline, ActEdit, true},
		{ResPipeline, ActDelete, true},
		{ResPipeline, ActTrigger, true},
		{ResJenkins, ActView, true},
		{ResJenkins, ActPing, true},
		{ResVars, ActView, true},
		{ResVars, ActCreate, true},
		{ResVars, ActEdit, true},
		{ResDimensions, ActView, true},
		{ResUsers, ActView, true},
		{ResRoles, ActView, true},
		{ResAudit, ActView, true},
		{ResNotification, ActView, true},
		{ResNotification, ActCreate, true},
		{ResNotification, ActEdit, true},
		{ResNotification, ActDelete, true},
		{ResPermission, ActView, true},
		{ResCleanup, ActView, true},
	},
	"member": {
		{ResPipeline, ActView, true},
		{ResPipeline, ActTrigger, true},
		{ResJenkins, ActView, true},
		{ResVars, ActView, true},
		{ResDimensions, ActView, true},
	},
	"viewer": {
		{ResPipeline, ActView, true},
		{ResJenkins, ActView, true},
		{ResVars, ActView, true},
		{ResDimensions, ActView, true},
	},
}

func SeedDefaultPermissions() {
	var count int64
	database.DB.Model(&model.RolePermission{}).Count(&count)
	if count > 0 {
		return
	}

	var rows []model.RolePermission
	for role, perms := range defaultRolePerms {
		for _, p := range perms {
			rows = append(rows, model.RolePermission{
				ID:       uuid.New().String(),
				Role:     role,
				Resource: p.resource,
				Action:   p.action,
				Allow:    p.allow,
			})
		}
	}
	if len(rows) > 0 {
		database.DB.CreateInBatches(rows, 100)
	}
}

func HasPermission(userID string, roles []string, resource, action string) bool {
	for _, role := range roles {
		if role == "super_admin" {
			return true
		}
	}

	for _, role := range roles {
		if role == "" {
			continue
		}

		var roleObj struct{ Status string }
		if err := database.DB.Table("roles").Where("name = ?", role).
			Select("status").First(&roleObj).Error; err != nil {
			continue
		}
		if roleObj.Status == "disabled" {
			continue
		}

		var rp model.RolePermission
		if err := database.DB.Where("role = ? AND resource = ? AND action = ?", role, resource, action).
			First(&rp).Error; err == nil && rp.Allow {
			return true
		}
	}

	var up model.UserPermission
	if err := database.DB.Where("user_id = ? AND resource = ? AND action = ?", userID, resource, action).
		First(&up).Error; err == nil && up.Allow {
		return true
	}

	return false
}

func GetUserPermissions(userID string, roles []string) map[string]map[string]bool {
	result := make(map[string]map[string]bool)
	for res := range ResourceActions {
		result[res] = make(map[string]bool)
	}

	for _, role := range roles {
		if role == "super_admin" {
			for res, actions := range ResourceActions {
				for _, act := range actions {
					result[res][act] = true
				}
			}
			return result
		}
	}

	for _, role := range roles {
		if role == "" {
			continue
		}

		var roleObj struct{ Status string }
		if err := database.DB.Table("roles").Where("name = ?", role).
			Select("status").First(&roleObj).Error; err != nil {
			continue
		}
		if roleObj.Status == "disabled" {
			continue
		}

		var rolePerms []model.RolePermission
		database.DB.Where("role = ?", role).Find(&rolePerms)
		for _, p := range rolePerms {
			if !IsKnownPermission(p.Resource, p.Action) {
				continue
			}
			if result[p.Resource] == nil {
				result[p.Resource] = make(map[string]bool)
			}
			if p.Allow {
				result[p.Resource][p.Action] = true
			}
		}
	}

	var userPerms []model.UserPermission
	database.DB.Where("user_id = ?", userID).Find(&userPerms)
	for _, p := range userPerms {
		if !IsKnownPermission(p.Resource, p.Action) {
			continue
		}
		if result[p.Resource] == nil {
			result[p.Resource] = make(map[string]bool)
		}
		if p.Allow {
			result[p.Resource][p.Action] = true
		}
	}

	return result
}
