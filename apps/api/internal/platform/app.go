// Package platform wires the HTTP surface: the routes, the error handler, the
// validation middleware and the SPA fallback.
//
// This is the only file that knows the complete route table, which is the point.
// The controllers know what they do; this knows what exists and which guard each
// route sits behind.
package platform

import (
	"errors"
	"log/slog"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
	"github.com/redzjovi/ghostmplay/apps/api/internal/config"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/auth"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/health"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/sync"
)

// Config carries everything New needs.
type Config struct {
	Env config.Env
	Log *slog.Logger

	Guards      *auth.Guards
	Auth        *auth.Controller
	Health      *health.Handler
	Marketplace *marketplace.Controller
	History     *marketplace.HistoryController
	Favorites   *marketplace.FavoritesController
	Sync        *sync.Controller
}

// New builds the Fiber app.
func New(cfg Config) *fiber.App {
	app := fiber.New(fiber.Config{
		AppName:               "ghostmplay-api",
		ErrorHandler:          errorHandler(cfg.Log),
		DisableStartupMessage: true,
		// Body limit. The detail blob for one NFT is a few kilobytes; the
		// largest request this API accepts is a favorite definition. A megabyte
		// is generous for both and small enough that a runaway client cannot
		// make the process allocate without bound.
		BodyLimit: 1 * 1024 * 1024,

		// The real client address comes from a header, because every deployment
		// of this app sits behind a proxy: Voroa's edge, or a CDN in front of
		// it. Without this, c.IP() is the proxy's address and the per-address
		// rate limit on the sign-in endpoints becomes global rather than per
		// caller -- one noisy client would lock everyone else out.
		// Read the real client address from the edge's forwarding header.
		//
		// Without this every request looks like it came from the proxy, and the
		// per-address rate limit on the sign-in endpoints becomes a global one --
		// one noisy client would lock everyone else out.
		//
		// The trust is unconditional because there is exactly one hop and it is
		// ours: Voroa's edge sets this header, and nothing else can insert
		// itself in front of it. TRUST_PROXY=0 turns it off for a deployment
		// that does not have a proxy in front of it at all.
		ProxyHeader: cfg.Env.ProxyHeader,
	})

	if len(cfg.Env.CORSOrigins) > 0 {
		app.Use(corsMiddleware(cfg.Env.CORSOrigins))
	}

	apiGroup := app.Group("/api")

	// Health first and unguarded: a platform probe carries no session and must
	// not have to acquire one.
	cfg.Health.Register(apiGroup)
	// The same handler at the root, for a probe configured without the /api
	// prefix. A platform reaching for /health and getting a 404 is
	// indistinguishable from an unhealthy service, and the logs say nothing
	// about which it was.
	app.Get("/health", func(c *fiber.Ctx) error { return cfg.Health.Check(c) })

	// Auth. The guards vary per route -- none, optional, optional -- which is why
	// they sit on the handlers rather than on the group.
	cfg.Auth.Register(apiGroup.Group("/auth"))

	// Marketplace.
	marketplaceGroup := apiGroup.Group("/marketplace")
	cfg.Marketplace.Register(marketplaceGroup)

	historyGroup := apiGroup.Group("/history")
	cfg.History.Register(historyGroup)

	// Favorites are per-account. Every route in this group requires a session.
	favoritesGroup := apiGroup.Group("/favorites", cfg.Guards.Required)
	cfg.Favorites.Register(favoritesGroup)

	// Admin sync. Admin required, mounted on the group rather than per route so
	// a route added later cannot accidentally ship unguarded.
	adminSync := apiGroup.Group("/admin/sync", cfg.Guards.Admin)
	cfg.Sync.Register(adminSync)

	// The SPA last: it has to be a fallback, not a route that shadows the API.
	if cfg.Env.WebRoot != "" {
		cfg.Log.Info("serving the web app", "root", cfg.Env.WebRoot)
		app.Use(spaHandler(cfg.Env.WebRoot, cfg.Log))
	} else {
		// Every path this process looked for a frontend. "There is no web build"
		// and "it is somewhere I did not check" are different problems with
		// different fixes, and the log should not leave you guessing which.
		cfg.Log.Warn("no web build found; serving the API only",
			"lookedIn", cfg.Env.WebRootCandidates,
			"hint", "build the SPA and set WEB_ROOT, or copy the build to apps/api/public")
		app.Use(noWebBuild(cfg.Log, cfg.Env.WebRootCandidates))
	}

	// Named at boot so the health check path configured on the platform can be
	// diffed against what this process actually answers, instead of recalled.
	//
	// A deploy that aborts on "did not pass its health check" is otherwise
	// undiagnosable from the application side: the probe never reaches a route
	// that logs, so nothing distinguishes a probe aimed at a path that 404s from
	// one aimed at a path that 503s. Both look identical in the log.
	//
	// The site root's status is derived rather than hardcoded, because it changes
	// once a web build is deployed. A line claiming 503 next to a service that
	// answers 200 there is worse than no line at all.
	//
	// One line on purpose -- a platform's failure snapshot keeps only the last
	// 50 lines of output, so verbosity here would evict the evidence.
	cfg.Log.Info("health checks answer on these paths",
		"api", "/api/health", "root", "/health", "siteRoot", siteRootStatus(cfg.Env.WebRoot),
		"note", "siteRoot is 503 only while no web build is deployed")

	return app
}

// siteRootStatus reports what "/" will answer.
//
// 200 once a web build is served, 503 while none is -- the no-web-build page is
// deliberately a failure signal, since a missing frontend is a real fault.
//
// Derived rather than hardcoded because it flips when the SPA ships. This line
// exists to be compared against the platform's health check setting, so a stale
// value would be worse than no line at all.
func siteRootStatus(webRoot string) int {
	if webRoot != "" {
		return fiber.StatusOK
	}
	return fiber.StatusServiceUnavailable
}

// errorHandler renders every error in the shape the client expects.
//
// The client reads `message`, and joins it with commas when it is an array --
// which is how validation failures arrive. Matching the previous implementation's
// envelope exactly is a contract, not a style choice: apps/web parses it and is
// not changing as part of this rewrite.
func errorHandler(log *slog.Logger) fiber.ErrorHandler {
	return func(c *fiber.Ctx, err error) error {
		var apiErr *common.Error
		if errors.As(err, &apiErr) {
			if apiErr.Status >= 500 {
				log.Error("request failed", "method", c.Method(), "path", c.Path(),
					"status", apiErr.Status, "error", err.Error())
			}
			body := apiErr.Body()
			return c.Status(apiErr.Status).JSON(&body)
		}

		var fiberErr *fiber.Error
		if errors.As(err, &fiberErr) {
			body := (&common.Error{Status: fiberErr.Code, Message: fiberErr.Message}).Body()
			return c.Status(fiberErr.Code).JSON(&body)
		}

		// Anything unrecognised. Log the detail, return nothing about it: a raw
		// database error reaching the client would carry table and column names.
		log.Error("unhandled error", "method", c.Method(), "path", c.Path(), "error", err)
		body := (&common.Error{Status: 500, Message: "Internal server error"}).Body()
		return c.Status(500).JSON(&body)
	}
}

// corsMiddleware allows the listed origins to send credentialed requests.
//
// Opt-in and empty by default, which means same-origin only. That is the
// recommended setting and the one the SPA deployment uses: the cookie is
// SameSite=Strict, so a cross-origin caller could not send it anyway.
func corsMiddleware(origins []string) fiber.Handler {
	allowed := make(map[string]struct{}, len(origins))
	for _, o := range origins {
		allowed[strings.ToLower(strings.TrimSuffix(o, "/"))] = struct{}{}
	}

	return func(c *fiber.Ctx) error {
		origin := strings.ToLower(strings.TrimSuffix(c.Get(fiber.HeaderOrigin), "/"))
		if _, ok := allowed[origin]; ok {
			c.Set(fiber.HeaderAccessControlAllowOrigin, origin)
			// Credentials requires a specific origin, never "*": the browser
			// rejects the wildcard when credentials are involved, and the whole
			// point of this header is to allow the cookie.
			c.Set(fiber.HeaderAccessControlAllowCredentials, "true")
			c.Set(fiber.HeaderAccessControlAllowHeaders, "Content-Type")
			c.Set(fiber.HeaderAccessControlAllowMethods, "GET,POST,PATCH,DELETE,OPTIONS")
			c.Vary(fiber.HeaderOrigin)
		}

		if c.Method() == fiber.MethodOptions {
			return c.SendStatus(fiber.StatusNoContent)
		}
		return c.Next()
	}
}
