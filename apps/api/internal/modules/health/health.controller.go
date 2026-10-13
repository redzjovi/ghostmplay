// Package health reports whether this process is actually working.
//
// The distinction that matters is between "the process is running" and "the
// process can do its job". A health check that only proves the process started
// is what makes a platform report a service as live while every request behind
// it fails on the database.
package health

import (
	"context"
	"database/sql"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
	"github.com/redzjovi/ghostmplay/apps/api/internal/models"
)

// Checker is what the health endpoint probes. An interface so a test can make
// the database fail without one.
type Checker interface {
	Ping(ctx context.Context) error
}

// SQLChecker probes a live database connection.
type SQLChecker struct{ DB *sql.DB }

// Ping checks the connection.
func (c SQLChecker) Ping(ctx context.Context) error { return c.DB.PingContext(ctx) }

// Handler answers the health probe.
type Handler struct {
	checker   Checker
	log       *slog.Logger
	startedAt time.Time
}

// NewHandler builds the handler.
//
// The logger may be nil, which keeps the handler usable in tests that do not
// care about output.
func NewHandler(checker Checker, log *slog.Logger) *Handler {
	return &Handler{checker: checker, log: log, startedAt: time.Now()}
}

// Check reports service health.
//
// 503 when the database is unreachable, and not 200-with-a-worrying-field. A
// platform's health check accepts 200 and treats the service as live; a body
// that says `database: down` next to a 200 would be reported as healthy by
// exactly the thing that is supposed to notice.
func (h *Handler) Check(c *fiber.Ctx) error {
	// Background rather than c.Context(): the latter is Fiber's pooled
	// *fasthttp.RequestCtx, and using a pooled request context as the parent of
	// a database call is fragile. The 3s timeout below is what bounds this.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	database := "up"
	pingErr := h.checker.Ping(ctx)
	if pingErr != nil {
		database = "down"
	}

	if database == "down" {
		// Logged, because returning 503 silently is how a deploy aborts with no
		// explanation in the log. This is the one case where the health path is
		// configured correctly and still fails, and without this line it looks
		// identical to a probe aimed at the wrong path.
		if h.log != nil {
			h.log.Warn("health check reporting unhealthy: database unreachable",
				"method", c.Method(), "path", c.Path(), "status", 503, "error", pingErr.Error())
		}
		return common.ServiceUnavailable("database unreachable")
	}

	return c.JSON(models.HealthResponse{
		Status:   "ok",
		Database: database,
		// Derived from the handler's construction rather than process start, so
		// it answers "how long has this process been serving", which is the
		// question an uptime number should answer.
		UptimeSeconds: int64(time.Since(h.startedAt).Seconds()),
		Timestamp:     models.ISO(time.Now()),
	})
}

// Register mounts the route on the API group, so it lands at /api/health.
//
// Deliberately ungated. A platform's health probe carries no session and does not
// follow a login redirect, so anything here that required either would report
// the service as unhealthy however healthy it was.
func (h *Handler) Register(router fiber.Router) {
	router.Get("/health", h.Check)
}
