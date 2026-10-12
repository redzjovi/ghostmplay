// Package auth holds sign-in, sessions, and the guards that protect routes.
//
// There is no password anywhere in this application, and there is no local
// credential of any kind. An account is created by a verified Google sign-in and
// holds an id and a role; sessions are opaque server-side rows so that signing
// out actually revokes something.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
)

// SessionCookie is the cookie the session token travels in.
const SessionCookie = "gm_session"

// SessionTTL is how long a session stays valid.
//
// Thirty days because the sessions are in a database rather than in a signed
// cookie: there is nothing to rotate out of the browser early, so the expiry is
// the only thing that bounds a stolen token, and it is enforced on every request
// rather than trusted to the cookie.
const SessionTTL = 30 * 24 * time.Hour

// Account is the resolved identity behind a request.
type Account struct {
	ID   int32
	Role string
}

// SessionService creates, resolves and revokes sessions.
type SessionService struct {
	queries dbgen.Querier
}

// NewSessionService builds the service.
func NewSessionService(queries dbgen.Querier) *SessionService {
	return &SessionService{queries: queries}
}

// Create mints a session for an account and returns the raw token.
//
// The raw token is returned rather than looked up later: it is 32 random bytes,
// it is never stored, and the caller hands it to the browser exactly once. Only
// its SHA-256 is persisted, so a database dump cannot be replayed as a set of
// live sessions.
func (s *SessionService) Create(ctx context.Context, accountID int32) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate session token: %w", err)
	}
	token := hex.EncodeToString(raw)

	if _, err := s.queries.InsertSession(ctx, dbgen.InsertSessionParams{
		AccountID: accountID,
		TokenHash: HashToken(token),
		ExpiresAt: time.Now().Add(SessionTTL),
	}); err != nil {
		return "", fmt.Errorf("insert session: %w", err)
	}

	return token, nil
}

// Resolve turns a token into an account, or nil.
//
// An expired session is deleted on the way past rather than swept on a timer:
// checking is free and it happens on every request anyway, so the table never
// grows beyond what is currently in use plus whatever the boot-time purge has
// not reached yet.
func (s *SessionService) Resolve(ctx context.Context, token string) (*Account, error) {
	if token == "" {
		return nil, nil
	}

	row, err := s.queries.GetSessionWithAccountByTokenHash(ctx, HashToken(token))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolve session: %w", err)
	}

	if !row.SessionExpiresAt.After(time.Now()) {
		if delErr := s.queries.DeleteSessionByID(ctx, row.SessionID); delErr != nil {
			return nil, fmt.Errorf("delete expired session: %w", delErr)
		}
		return nil, nil
	}

	return &Account{ID: row.AccountID, Role: row.AccountRole}, nil
}

// Destroy revokes a token. Safe to call with an empty token, which is what
// happens when a browser that was never signed in logs out.
func (s *SessionService) Destroy(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	if err := s.queries.DeleteSessionByTokenHash(ctx, HashToken(token)); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

// PurgeExpired removes every expired session, and reports how many went.
//
// Run at boot. It is a nicety rather than a requirement -- expired sessions are
// deleted lazily on use -- but it means a deployment that has been idle does not
// come back carrying rows nobody can use.
func (s *SessionService) PurgeExpired(ctx context.Context) (int64, error) {
	// Counted first, deleted after. A failed count must not delete the rows: the
	// caller logs how many were purged, and reporting "0" after a successful
	// delete would be a lie that looks like "nothing needed purging".
	count, err := s.queries.CountExpiredSessions(ctx)
	if err != nil {
		return 0, fmt.Errorf("count expired sessions: %w", err)
	}
	if err := s.queries.DeleteExpiredSessions(ctx); err != nil {
		return 0, fmt.Errorf("delete expired sessions: %w", err)
	}
	return int64(count), nil
}

// PurgeForAccount revokes every session belonging to an account.
func (s *SessionService) PurgeForAccount(ctx context.Context, accountID int32) error {
	if err := s.queries.DeleteSessionsByAccount(ctx, accountID); err != nil {
		return fmt.Errorf("delete sessions for account %d: %w", accountID, err)
	}
	return nil
}

// HashToken is the stored form of a session token.
//
// Hex, matching what the previous implementation wrote, so every browser signed
// in before this rewrite stays signed in. Only this function's output is ever
// compared; the raw token never touches the database.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
