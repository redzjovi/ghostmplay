package health

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
)

// failingChecker lets a test make the database unreachable without one.
type failingChecker struct{ err error }

func (f failingChecker) Ping(context.Context) error { return f.err }

// capturingLogger keeps log lines so a test can assert on what was recorded.
type capturingLogger struct {
	mu    sync.Mutex
	lines []string
}

func (c *capturingLogger) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, string(p))
	return len(p), nil
}

func (c *capturingLogger) contains(needle string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, l := range c.lines {
		if strings.Contains(l, needle) {
			return true
		}
	}
	return false
}

// newTestApp mounts both health paths behind an error handler equivalent to the
// one platform.New installs.
//
// That handler is what turns the *common.Error this package returns into a 503.
// Without it Fiber's default answers 500, and the test would be asserting against
// a status the real deployment never produces -- passing on a broken build, or
// failing on a working one, for reasons that have nothing to do with health.
func newTestApp(h *Handler) *fiber.App {
	app := fiber.New(fiber.Config{
		DisableStartupMessage: true,
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			var apiErr *common.Error
			if errors.As(err, &apiErr) {
				body := apiErr.Body()
				return c.Status(apiErr.Status).JSON(&body)
			}
			var fiberErr *fiber.Error
			if errors.As(err, &fiberErr) {
				return c.Status(fiberErr.Code).SendString(fiberErr.Message)
			}
			return c.Status(fiber.StatusInternalServerError).SendString(err.Error())
		},
	})
	app.Get("/api/health", h.Check)
	app.Get("/health", h.Check)
	return app
}

func probe(t *testing.T, app *fiber.App, path string) *http.Response {
	t.Helper()
	res, err := app.Test(httptest.NewRequest(http.MethodGet, path, nil), -1)
	if err != nil {
		t.Fatalf("request %s: %v", path, err)
	}
	return res
}

// Both paths answer 200 when the database is reachable -- the configuration the
// runbook tells operators to use.
func TestBothPathsReportHealthy(t *testing.T) {
	h := NewHandler(reachableChecker{}, nil)
	app := newTestApp(h)

	for _, path := range []string{"/api/health", "/health"} {
		res := probe(t, app, path)
		if res.StatusCode != 200 {
			t.Fatalf("%s = %d, want 200", path, res.StatusCode)
		}
		defer res.Body.Close()

		var body struct {
			Status   string `json:"status"`
			Database string `json:"database"`
		}
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			t.Fatalf("%s: decode: %v", path, err)
		}
		if body.Status != "ok" || body.Database != "up" {
			t.Errorf("%s body = %+v, want status=ok database=up", path, body)
		}
	}
}

// The deploy that motivated all of this: a correctly-configured health path
// returning 503 used to be silent, which is indistinguishable from a probe aimed
// at the wrong path.
func TestDatabaseDownLogsTheReason(t *testing.T) {
	sink := &capturingLogger{}
	log := slog.New(slog.NewTextHandler(sink, nil))

	h := NewHandler(failingChecker{err: errors.New("dial tcp: connection refused")}, log)
	app := newTestApp(h)

	res := probe(t, app, "/api/health")
	if res.StatusCode != 503 {
		t.Errorf("status = %d, want 503", res.StatusCode)
	}
	res.Body.Close()

	for _, want := range []string{
		"health check reporting unhealthy",
		"database unreachable",
		"connection refused",
		"/api/health",
	} {
		if !sink.contains(want) {
			t.Errorf("log does not mention %q; got:\n%s", want, strings.Join(sink.lines, ""))
		}
	}
}

// A nil logger must not panic: several callers construct the handler without one.
func TestNilLoggerDoesNotPanic(t *testing.T) {
	h := NewHandler(failingChecker{err: errors.New("down")}, nil)
	app := newTestApp(h)

	res := probe(t, app, "/api/health")
	res.Body.Close()
	if res.StatusCode != 503 {
		t.Errorf("status = %d, want 503", res.StatusCode)
	}
}

// A healthy service must not log warnings. If it did, the signal that matters --
// "the health check failed" -- would be buried in noise on every boot.
func TestHealthyServiceLogsNoWarning(t *testing.T) {
	sink := &capturingLogger{}
	log := slog.New(slog.NewTextHandler(sink, &slog.HandlerOptions{Level: slog.LevelInfo}))

	h := NewHandler(reachableChecker{}, log)
	app := newTestApp(h)

	for _, path := range []string{"/api/health", "/health"} {
		res := probe(t, app, path)
		res.Body.Close()
	}

	if len(sink.lines) != 0 {
		t.Errorf("a healthy service logged %d line(s):\n%s", len(sink.lines), strings.Join(sink.lines, ""))
	}
}

// The ping must be bounded even if the checker hangs, or a platform probe hangs
// with it. Regression guard for the timeout parent.
func TestPingIsBoundedByTimeout(t *testing.T) {
	sink := &capturingLogger{}
	log := slog.New(slog.NewTextHandler(sink, nil))

	h := NewHandler(hangingChecker{}, log)
	start := time.Now()

	res, err := newTestApp(h).Test(httptest.NewRequest(http.MethodGet, "/api/health", nil), -1)
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	res.Body.Close()

	if elapsed := time.Since(start); elapsed > 6*time.Second {
		t.Errorf("probe took %v; the 3s timeout is not bounding the ping", elapsed)
	}
}

// hangingChecker blocks until its context is done.
type hangingChecker struct{}

func (hangingChecker) Ping(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}

// reachableChecker stands in for a reachable database.
type reachableChecker struct{}

func (reachableChecker) Ping(context.Context) error { return nil }
