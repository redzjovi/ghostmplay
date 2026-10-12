package auth

import (
	"context"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
	"github.com/redzjovi/ghostmplay/apps/api/internal/models"
)

// accountKey is where the resolved account is stashed on the request.
const accountKey = "auth.account"

// SessionReader is what the guards need. An interface so the guards can be
// tested without a session service, and so a future implementation that caches
// sessions does not change this file.
type SessionReader interface {
	Resolve(ctx context.Context, token string) (*Account, error)
}

// Guards turns a session token into an Account and decides whether a route may
// proceed.
type Guards struct {
	sessions SessionReader
	// secureCookies adds the Secure attribute to Set-Cookie. On by in
	// production, off in development, where the app is reached over plain HTTP
	// on localhost and a Secure cookie would simply never be sent back.
	secureCookies bool
}

// NewGuards builds the guards.
func NewGuards(sessions SessionReader, secureCookies bool) *Guards {
	return &Guards{sessions: sessions, secureCookies: secureCookies}
}

// CookieOptions are the attributes for the session cookie.
//
// SameSite=Strict is what makes the cookie work with no CORS configuration: the
// request that carries it is always first-party. It also means the OAuth
// callback cannot carry anything on a cookie, which is why the correlation data
// lives in the signed state instead of in session storage.
func (g *Guards) CookieOptions() *fiber.Cookie {
	return &fiber.Cookie{
		Path:     "/",
		HTTPOnly: true,
		SameSite: fiber.CookieSameSiteStrictMode,
		Secure:   g.secureCookies,
		MaxAge:   int(SessionTTL.Seconds()),
	}
}

// SetSessionCookie writes the session cookie.
func (g *Guards) SetSessionCookie(c *fiber.Ctx, token string) {
	c.Cookie(&fiber.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		HTTPOnly: true,
		SameSite: fiber.CookieSameSiteStrictMode,
		Secure:   g.secureCookies,
		MaxAge:   int(SessionTTL.Seconds()),
	})
}

// ClearSessionCookie expires the session cookie.
//
// The attributes must match those the cookie was set with, or the browser will
// treat it as a different cookie and leave the original in place.
func (g *Guards) ClearSessionCookie(c *fiber.Ctx) {
	c.Cookie(&fiber.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		HTTPOnly: true,
		SameSite: fiber.CookieSameSiteStrictMode,
		Secure:   g.secureCookies,
		MaxAge:   -1,
	})
}

// Token reads the session token off the request.
//
// Cookie only. There is no Authorization-header fallback, which is a deliberate
// narrowing: one path means one thing to reason about when deciding what a
// cross-site request can do.
func (g *Guards) Token(c *fiber.Ctx) string {
	return c.Cookies(SessionCookie)
}

// Optional resolves a session if one is present and never rejects.
//
// This is the guard for endpoints that are public but change their answer based
// on who is asking -- /auth/me is the only one. Making it a hard requirement
// would break anonymous browsing, and making it a no-op would break the UI's
// ability to tell "signed out" from "signed in as someone".
func (g *Guards) Optional(c *fiber.Ctx) error {
	account, err := g.sessions.Resolve(c.Context(), g.Token(c))
	if err != nil {
		return err
	}
	if account != nil {
		c.Locals(accountKey, account)
	}
	return c.Next()
}

// Required rejects a request with no valid session.
func (g *Guards) Required(c *fiber.Ctx) error {
	account, err := g.sessions.Resolve(c.Context(), g.Token(c))
	if err != nil {
		return err
	}
	if account == nil {
		return common.Unauthorized("Authentication required")
	}
	c.Locals(accountKey, account)
	return c.Next()
}

// Admin requires a valid session holding the admin role.
//
// 401 and 403 are distinct on purpose: 401 means "sign in", 403 means "sign in
// as someone else", and a client that conflates them produces a UI that tells
// the wrong person to do the wrong thing.
func (g *Guards) Admin(c *fiber.Ctx) error {
	account, err := g.sessions.Resolve(c.Context(), g.Token(c))
	if err != nil {
		return err
	}
	if account == nil {
		return common.Unauthorized("Authentication required")
	}
	if account.Role != string(models.RoleAdmin) {
		return common.Forbidden("Admin access required")
	}
	c.Locals(accountKey, account)
	return c.Next()
}

// AccountOf returns the account the guards attached to this request.
//
// It returns nil when the guards did not run, which is a programming error in the
// route table rather than a state the UI can be in.
func AccountOf(c *fiber.Ctx) *Account {
	account, ok := c.Locals(accountKey).(*Account)
	if !ok {
		return nil
	}
	return account
}

// AccountIDOf returns the signed-in account's id, or 0 when there is none.
func AccountIDOf(c *fiber.Ctx) int32 {
	if account := AccountOf(c); account != nil {
		return account.ID
	}
	return 0
}

// NormalizeIP trims an address for use in a rate-limit key.
func NormalizeIP(ip string) string {
	return strings.TrimSpace(ip)
}
