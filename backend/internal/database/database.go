package database

import (
	"go.uber.org/zap"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/pkg/logger"
)

var DB *gorm.DB

func Init() error {
	cfg := config.Global.Database

	// Custom GORM logger that uses zap
	gormLog := gormlogger.New(
		&zapWriter{},
		gormlogger.Config{
			SlowThreshold:             cfg.SlowThreshold,
			LogLevel:                  gormlogger.Warn,
			IgnoreRecordNotFoundError: true,
			Colorful:                  false,
		},
	)

	db, err := gorm.Open(mysql.Open(cfg.DSN), &gorm.Config{
		Logger:                 gormLog,
		PrepareStmt:            true, // cache prepared statements
		SkipDefaultTransaction: true, // skip default tx for single operations
	})
	if err != nil {
		return err
	}

	sqlDB, err := db.DB()
	if err != nil {
		return err
	}

	// Connection pool tuning
	sqlDB.SetMaxOpenConns(cfg.MaxOpenConns)
	sqlDB.SetMaxIdleConns(cfg.MaxIdleConns)
	sqlDB.SetConnMaxLifetime(cfg.ConnMaxLifetime)
	sqlDB.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)

	DB = db
	logger.Info("database connected",
		zap.Int("max_open", cfg.MaxOpenConns),
		zap.Int("max_idle", cfg.MaxIdleConns),
	)
	return nil
}

// Ping checks the database connection.
func Ping() error {
	sqlDB, err := DB.DB()
	if err != nil {
		return err
	}
	return sqlDB.Ping()
}

// zapWriter bridges GORM logger to zap.
type zapWriter struct{}

func (w *zapWriter) Printf(format string, args ...any) {
	logger.Warn("gorm: " + format)
	_ = args
}
