package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"

	"github.com/company/atop-backend/internal/config"
	"github.com/company/atop-backend/internal/scheduler"
	"github.com/company/atop-backend/internal/database"
	"github.com/company/atop-backend/internal/handler"
	"github.com/company/atop-backend/pkg/logger"
)

func main() {
	// 1. Load config
	if err := config.Load(); err != nil {
		panic("failed to load config: " + err.Error())
	}

	// 2. Init logger
	logger.Init(config.Global.App.LogLevel)
	logger.Info("ATOP backend starting",
		zap.String("env", config.Global.App.Env),
		zap.String("port", config.Global.App.Port),
	)

	// 3. Init database
	if err := database.Init(); err != nil {
		logger.Fatal("database init failed", zap.Error(err))
	}

	// 4. Run migrations
	if err := database.Migrate(); err != nil {
		logger.Fatal("migration failed", zap.Error(err))
	}

	// 5. Seed default data
	if err := database.Seed(); err != nil {
		logger.Fatal("seed failed", zap.Error(err))
	}

	// 5b. Seed default permissions
	handler.SeedDefaultPermissions()
	handler.RegisterPipelineRunCreator()

	// 6. Init scheduler
	webhookBase := "http://localhost:" + config.Global.App.Port
	if v := os.Getenv("WEBHOOK_BASE_URL"); v != "" {
		webhookBase = v
	}
	scheduler.Init(webhookBase)
	scheduler.StartCron()
	defer scheduler.StopCron()

	// 7. Setup router
	router := setupRouter()

	// 8. Start server
	srv := &http.Server{
		Addr:         ":" + config.Global.App.Port,
		Handler:      router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		logger.Info("server listening", zap.String("addr", srv.Addr))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("server failed", zap.Error(err))
		}
	}()

	<-quit
	logger.Info("shutdown signal received")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("server shutdown error", zap.Error(err))
	}
	logger.Info("server exited cleanly")
}
