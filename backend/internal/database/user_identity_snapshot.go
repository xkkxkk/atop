package database

import (
	"time"

	"github.com/company/atop-backend/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// UpsertUserIdentitySnapshot stores the latest known identity for a user.
func UpsertUserIdentitySnapshot(db *gorm.DB, user *model.User, deletedAt *time.Time) error {
	snapshot := model.UserIdentitySnapshot{
		UserID:   user.ID,
		Username: user.Username,
		Email:    user.Email,
	}
	if deletedAt != nil {
		snapshot.DeletedAt = deletedAt
	}
	return db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.Assignments(map[string]any{
			"username":   snapshot.Username,
			"email":      snapshot.Email,
			"deleted_at": snapshot.DeletedAt,
			"updated_at": time.Now(),
		}),
	}).Create(&snapshot).Error
}

// PurgeSoftDeletedUsers is kept for startup cleanup of legacy soft-deleted users.
func PurgeSoftDeletedUsers() error {
	var users []model.User
	if err := DB.Unscoped().
		Select("id, username, email, created_at, updated_at").
		Where("deleted_at IS NOT NULL").
		Find(&users).Error; err != nil {
		return err
	}
	if len(users) == 0 {
		return nil
	}

	return DB.Transaction(func(tx *gorm.DB) error {
		ids := make([]string, 0, len(users))
		for _, user := range users {
			if err := UpsertUserIdentitySnapshot(tx, &user, nil); err != nil {
				return err
			}
			ids = append(ids, user.ID)
		}

		if len(ids) == 0 {
			return nil
		}

		if err := tx.Where("user_id IN ?", ids).Delete(&model.UserRoleBinding{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id IN ?", ids).Delete(&model.UserPermission{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id IN ?", ids).Delete(&model.RefreshToken{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id IN ?", ids).Delete(&model.NotificationPreference{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id IN ?", ids).Delete(&model.Notification{}).Error; err != nil {
			return err
		}
		return tx.Unscoped().Where("id IN ?", ids).Delete(&model.User{}).Error
	})
}
