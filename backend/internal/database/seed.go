package database

import (
	"errors"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/model"
	"github.com/company/atop-backend/pkg/logger"
)

const defaultInitialPassword = "#PassW0rd"

// SeedRoles creates the default built-in roles if they don't exist.
func SeedRoles() error {
	builtinRoles := []model.Role{
		{Name: "super_admin", DisplayName: "超级管理员", Description: "拥有全部权限，不可修改", IsBuiltin: true},
		{Name: "project_manager", DisplayName: "项目负责人", Description: "管理测试集、流水线等核心资源", IsBuiltin: true},
		{Name: "member", DisplayName: "普通成员", Description: "可查看和触发运行", IsBuiltin: true},
		{Name: "viewer", DisplayName: "访客", Description: "仅可查看权限", IsBuiltin: true},
	}

	for _, r := range builtinRoles {
		result := DB.Where("name = ?", r.Name).FirstOrCreate(&r)
		if result.Error != nil {
			logger.Warn("seed role failed: " + r.Name + " - " + result.Error.Error())
		} else if result.RowsAffected > 0 {
			logger.Info("seeded role: " + r.Name)
			auditLog := model.AuditLog{
				UserID:       "",
				Username:     "system",
				Action:       "创建角色",
				ResourceType: "角色",
				ResourceID:   r.ID,
				ResourceName: r.DisplayName,
				IP:           "127.0.0.1",
			}
			if err := DB.Create(&auditLog).Error; err != nil {
				logger.Warn("seed role audit log failed: " + r.Name + " - " + err.Error())
			}
		}
	}
	return nil
}

// Seed creates the default admin user if the users table is empty.
func Seed() error {
	if err := SeedRoles(); err != nil {
		return err
	}

	var count int64
	DB.Model(&model.User{}).Count(&count)

	// Always run: migrate legacy role field to bindings for existing users
	migrateRoleBindings()

	if count > 0 {
		return nil
	}

	cfg := config.Global.App
	initialAdminPassword := cfg.AdminPassword
	if initialAdminPassword == "" {
		initialAdminPassword = defaultInitialPassword
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(initialAdminPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	admin := &model.User{
		Username:      "管理员",
		Email:         cfg.AdminEmail,
		PasswordHash:  string(hash),
		Role:          model.RoleSuperAdmin,
		Projects:      "[]",
		Status:        "active",
		MustChangePwd: true,
	}

	if err := DB.Create(admin).Error; err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			return nil
		}
		return err
	}
	_ = UpsertUserIdentitySnapshot(DB, admin, nil)

	binding := &model.UserRoleBinding{
		UserID:   admin.ID,
		RoleName: string(model.RoleSuperAdmin),
	}
	DB.Where("user_id = ? AND role_name = ?", admin.ID, string(model.RoleSuperAdmin)).
		FirstOrCreate(binding)

	migrateRoleBindings()

	logger.Info("default admin created: " + cfg.AdminEmail)
	return nil
}

// migrateRoleBindings creates user_role_bindings from legacy User.Role field for users that don't have any bindings.
func migrateRoleBindings() {
	var users []model.User
	DB.Select("id, role").Where("role != ''").Find(&users)
	for _, u := range users {
		var count int64
		DB.Model(&model.UserRoleBinding{}).Where("user_id = ?", u.ID).Count(&count)
		if count == 0 && string(u.Role) != "" {
			binding := &model.UserRoleBinding{
				UserID:   u.ID,
				RoleName: string(u.Role),
			}
			DB.Create(binding)
		}
	}
}

