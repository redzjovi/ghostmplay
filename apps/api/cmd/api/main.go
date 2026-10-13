// Command api serves the ghostmplay API and, when a web build is present, the
// web app itself.
//
// One process does both. That is deliberate: the session cookie is SameSite=Strict
// and first-party, so serving the SPA from the same origin is what lets there be
// no CORS configuration and no cross-site cookie handling at all.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
	"github.com/redzjovi/ghostmplay/apps/api/internal/config"
	"github.com/redzjovi/ghostmplay/apps/api/internal/database"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/auth"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/auth/google"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/health"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/api"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/sync"
	"github.com/redzjovi/ghostmplay/apps/api/internal/platform"
)

// shutdownGrace is how long an in-flight request gets to finish.
//
// Long enough for a slow query, short enough that a deploy does not hang. The
// platform's own window is on the order of thirty seconds; exceeding it means the
// process is killed and a request is cut off mid-response.
const shutdownGrace = 15 * time.Second

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "[bootstrap] failed to start: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	env, err := config.Load()
	if err != nil {
		return err
	}
	log := newLogger(env)

	ctx := context.Background()

	db, err := database.Open(ctx, database.Options{
		URL:      env.DatabaseURL,
		SSL:      env.DatabaseSSL,
		MaxConns: database.PoolSize,
	})
	if err != nil {
		return err
	}
	defer db.Close()

	// Migrations run at boot unless explicitly disabled. Doing it here means a
	// schema change cannot ship without the migration that carries it, and the
	// failure mode is a deploy that reports "failed to start" with a reason
	// rather than an app that is live and broken on its first request.
	if env.MigrationsRun {
		if err := database.Migrate(db); err != nil {
			return fmt.Errorf("run migrations: %w", err)
		}
		log.Info("migrations up to date")
	}

	app, stopBackground, err := wire(env, log, dbgen.New(db), database.NewTxManager(db), db)
	if err != nil {
		return err
	}
	defer stopBackground()

	serve(app, env.Port, log)
	return nil
}

// wire builds the object graph by hand and returns the app plus a function that
// stops the background workers.
//
// There is no container and no reflection. Every dependency is a constructor call
// whose arguments are visible in this one function, so the answer to "what does
// this service actually get" is a screen-reading rather than a runtime trace. It
// also means a wiring mistake is a compile error rather than a nil panic on the
// first request.
func wire(env config.Env, log *slog.Logger, queries dbgen.Querier, txManager database.TxManager, db *sql.DB) (*fiber.App, func(), error) {
	ctx := context.Background()

	// Shared primitives.
	locks := common.NewLockService()
	limiter := common.NewRateLimiter()

	// Auth.
	sessions := auth.NewSessionService(queries)
	guards := auth.NewGuards(sessions, env.IsProd)

	googleProvider := google.NewProvider(google.Config{
		ClientID:     env.Google.ClientID,
		ClientSecret: env.Google.ClientSecret,
		RedirectURI:  env.Google.RedirectURI,
		StateSecret:  env.Google.StateSecret,
		AdminEmails:  env.Google.AdminEmails,
	})
	googleAuth := google.NewAuthService(queries, googleProvider, log)
	authController := auth.NewController(sessions, googleAuth, limiter, guards, log)

	// Marketplace and history.
	marketplaceService := marketplace.NewMarketplaceService(queries, txManager, log)
	historyService := marketplace.NewHistoryService(queries, txManager, log)
	upstream := api.NewClient(log)

	syncService := marketplace.NewSyncService(upstream, marketplaceService, log)
	historySync := marketplace.NewHistorySyncService(upstream, historyService, marketplaceService, log)

	executor := sync.NewExecutorAdapter(marketplaceService, historyService, syncService, historySync, log)
	orchestrator := sync.NewOrchestrator(queries, locks, executor, log)

	// A row found still "running" at startup belongs to a run that died holding
	// its lock -- the container was replaced, or it was stopped mid-run. Without
	// this the panel would show a sync that is still going, with nothing behind
	// it, until somebody noticed.
	if err := orchestrator.RecoverStrandedRuns(ctx); err != nil {
		log.Error("could not recover stranded syncs", "error", err)
	}

	// Expired sessions are also deleted lazily on use, so this is a nicety: it
	// means a deployment that has been idle does not come back carrying rows
	// nobody can use.
	if n, err := sessions.PurgeExpired(ctx); err != nil {
		log.Error("could not purge expired sessions", "error", err)
	} else if n > 0 {
		log.Info("purged expired sessions", "count", n)
	}

	// Both of these are silent lockouts rather than errors, and both are far
	// easier to diagnose from a boot log than from a 403 discovered later.
	for _, warning := range bootstrapWarnings(env) {
		log.Warn(warning)
	}

	app := platform.New(platform.Config{
		Env:         env,
		Log:         log,
		Guards:      guards,
		Auth:        authController,
		Health:      health.NewHandler(health.SQLChecker{DB: db}, log),
		Marketplace: marketplace.NewController(marketplaceService, upstream, log, env),
		History:     marketplace.NewHistoryController(historyService, log, env),
		Favorites:   marketplace.NewFavoritesController(marketplaceService),
		Sync:        sync.NewController(orchestrator),
	})

	// A no-op rather than nil, and not merely for tidiness: main defers
	// stopBackground() unconditionally, so returning nil here would panic on
	// shutdown instead of starting. A flag that turns work off must not turn a
	// clean stop into a crash.
	stopScheduler := func() {}

	if env.CronEnabled {
		scheduler := sync.NewScheduler(orchestrator, log)
		var err error
		stopScheduler, err = sync.StartScheduler(scheduler, log)
		if err != nil {
			return nil, nil, fmt.Errorf("start sync scheduler: %w", err)
		}
	} else {
		// Logged rather than left silent. Nothing here starts a timer, and an
		// absent "sync scheduler started" line is otherwise indistinguishable
		// from a scheduler that failed to start.
		log.Info("sync scheduler disabled", "enabledBy", "CRON_ENABLED",
			"consequence", "data is synced only on request from the admin panel")
	}

	return app, stopScheduler, nil
}

// serve listens and blocks until the process is asked to stop.
func serve(app *fiber.App, port int, log *slog.Logger) {
	errs := make(chan error, 1)
	go func() {
		// Bind 0.0.0.0, never the loopback address: the platform routes to this
		// process from outside the container, and a listener bound to localhost
		// is invisible from there.
		// Fiber returns nil after a graceful shutdown; anything else is real.
		if err := app.Listen(fmt.Sprintf(":%d", port)); err != nil {
			errs <- err
		}
	}()

	log.Info("listening", "port", port)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errs:
		log.Error("server stopped with an error", "error", err)
	case s := <-sig:
		log.Info("shutting down", "signal", s.String())
	}

	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := app.ShutdownWithContext(ctx); err != nil {
		log.Error("shutdown was not clean", "error", err)
	}
}

// bootstrapWarnings returns the misconfigurations that produce a silent lockout
// rather than a failure.
//
// Returned rather than failed on: an operator may deliberately run this
// read-only for a while, but they need to be told, not left wondering why
// /admin/data 403s.
func bootstrapWarnings(env config.Env) []string {
	var warnings []string

	if !env.Google.Enabled {
		warnings = append(warnings,
			"Google sign-in is not configured: nobody can sign in at all. "+
				"Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.")
	} else if len(env.Google.AdminEmails) == 0 {
		warnings = append(warnings,
			"GOOGLE_ADMIN_EMAILS is empty: visitors can sign in but no account can become admin. "+
				"Add the verified Google address allowed to reach /admin/data.")
	}

	return warnings
}

// newLogger builds the process logger.
//
// Text rather than JSON: the platform collects stdout as-is and shows it in a log
// pane, where a readable line is worth more than a parseable one. LOG_LEVEL
// switches to debug output when something needs tracing.
func newLogger(env config.Env) *slog.Logger {
	level := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" || env.LogAPI || env.LogQuery {
		level = slog.LevelDebug
	}
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})).
		With("service", "ghostmplay-api")
}
