package auth

import (
	"context"
	"log/slog"
	"net/url"

	"github.com/gofiber/fiber/v2"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
	"github.com/redzjovi/ghostmplay/apps/api/internal/models"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/auth/google"
)

// Google rate-limit budget.
//
// Thirty attempts per ten minutes per address. The cost of one attempt is a
// round trip to Google, so this is about not being the reason someone else's
// sign-in starts failing. It is not a defence against a distributed flood; a
// platform-level limit is what that would need.
const (
	googleLimit  = 30
	googleWindow = 600
)

// Controller serves the auth routes.
type Controller struct {
	sessions *SessionService
	auth     *google.AuthService
	limiter  *common.RateLimiter
	guards   *Guards
	log      *slog.Logger
}

// NewController builds the controller.
func NewController(sessions *SessionService, auth *google.AuthService, limiter *common.RateLimiter, guards *Guards, log *slog.Logger) *Controller {
	return &Controller{sessions: sessions, auth: auth, limiter: limiter, guards: guards, log: log}
}

// Register mounts the routes on a group.
//
// The guards are mounted per route rather than per group because the group holds
// routes with three different rules: none, optional session, and required
// session.
func (h *Controller) Register(router fiber.Router) {
	router.Get("/providers", h.Providers)
	router.Get("/me", h.guards.Optional, h.Me)
	router.Post("/logout", h.guards.Optional, h.Logout)
	router.Get("/google", h.GoogleStart)
	router.Get("/google/callback", h.GoogleCallback)
}

// Providers reports whether sign-in is available, so the UI can hide the button.
func (h *Controller) Providers(c *fiber.Ctx) error {
	return c.JSON(models.ProvidersResponse{GoogleEnabled: h.auth.ProviderEnabled()})
}

// Me returns the signed-in account, or an explicit null.
//
// The client distinguishes "signed out" from "the server did not tell me", so
// the key is always present. An absent one would make `account === undefined`
// mean two different things.
func (h *Controller) Me(c *fiber.Ctx) error {
	account := AccountOf(c)
	if account == nil {
		return c.JSON(models.MeResponse{Account: nil})
	}

	email, err := h.auth.EmailFor(c.Context(), account.ID)
	if err != nil {
		return err
	}

	role := models.RoleUser
	if account.Role == string(models.RoleAdmin) {
		role = models.RoleAdmin
	}

	return c.JSON(models.MeResponse{Account: &models.AccountPublic{
		ID:    account.ID,
		Email: email,
		Role:  role,
	}})
}

// Logout revokes the session and clears the cookie.
//
// Always 204, whether or not there was a session to revoke. Signing out when
// not signed in is a no-op the caller should not have to distinguish.
func (h *Controller) Logout(c *fiber.Ctx) error {
	if err := h.sessions.Destroy(c.Context(), h.guards.Token(c)); err != nil {
		return err
	}
	h.guards.ClearSessionCookie(c)
	return c.SendStatus(fiber.StatusNoContent)
}

// GoogleStart redirects to Google.
func (h *Controller) GoogleStart(c *fiber.Ctx) error {
	if !h.allowGoogle(c) {
		return redirectFailure(c, google.FailureThrottled)
	}

	result := h.auth.Start(c.Query("next"))
	if result.Err != "" {
		return redirectFailure(c, result.Err)
	}
	return c.Redirect(result.URL, fiber.StatusFound)
}

// GoogleCallback finishes sign-in and redirects into the app.
//
// Every failure is a redirect to the login page with ?oauth=<code> rather than
// an error page or a JSON body. The flow is a top-level navigation, and a user
// who declined the consent screen should land on the app they came from and be
// told what happened, not on a bare error.
func (h *Controller) GoogleCallback(c *fiber.Ctx) error {
	if !h.allowGoogle(c) {
		return redirectFailure(c, google.FailureThrottled)
	}

	result := h.auth.Complete(c.Context(), c.Query("code"), c.Query("state"), c.Query("error"))
	if result.Err != "" {
		return redirectFailure(c, result.Err)
	}

	token, err := h.sessions.Create(c.Context(), result.Account.ID)
	if err != nil {
		return err
	}
	h.guards.SetSessionCookie(c, token)

	return c.Redirect(result.Next, fiber.StatusFound)
}

// allowGoogle applies the per-address rate limit to the sign-in endpoints.
func (h *Controller) allowGoogle(c *fiber.Ctx) bool {
	key := "rl:google:" + NormalizeIP(c.IP())
	return h.limiter.Consume(key, googleLimit, googleWindow)
}

// redirectFailure sends the browser to the login page with a failure code.
func redirectFailure(c *fiber.Ctx, code google.Failure) error {
	return c.Redirect("/login?oauth="+url.QueryEscape(string(code)), fiber.StatusFound)
}

// PurgeExpiredSessions sweeps expired sessions at boot.
//
// Admin is granted per sign-in from GOOGLE_ADMIN_EMAILS rather than seeded, so
// there is nothing to bootstrap here -- only expired sessions to sweep.
func (h *Controller) PurgeExpiredSessions(ctx context.Context) error {
	n, err := h.sessions.PurgeExpired(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		h.log.Info("purged expired sessions", "count", n)
	}
	return nil
}

// bootstrapWarnings returns the two misconfigurations that produce a silent
// lockout rather than an error.
//
// Both are returned rather than failed: an operator may deliberately run this
// read-only for a while, but they need to be told, not left wondering why
// /admin/data 403s.
func (h *Controller) bootstrapWarnings(googleEnabled bool, adminEmails []string) []string {
	var warnings []string

	if !googleEnabled {
		warnings = append(warnings,
			"Google sign-in is not configured: nobody can sign in at all. "+
				"Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.")
	} else if len(adminEmails) == 0 {
		warnings = append(warnings,
			"GOOGLE_ADMIN_EMAILS is empty: visitors can sign in but no account can become admin. "+
				"Add the verified Google address allowed to reach /admin/data.")
	}
	return warnings
}
