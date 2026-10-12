package google

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/redzjovi/ghostmplay/apps/api/internal/models"
)

// AuthService resolves a verified Google identity to an account.
//
// The only thing that creates an account is a successful Google sign-in, and the
// only thing that grants admin is the GOOGLE_ADMIN_EMAILS allowlist evaluated on
// every sign-in.
type AuthService struct {
	queries  dbgen.Querier
	provider *Provider
	log      *slog.Logger
}

// NewAuthService builds the service.
func NewAuthService(queries dbgen.Querier, provider *Provider, log *slog.Logger) *AuthService {
	return &AuthService{queries: queries, provider: provider, log: log}
}

// Failure is a user-facing sign-in failure, rendered as ?oauth=<code> rather
// than shown as an error page.
type Failure string

const (
	// FailureDisabled: sign-in is not configured on this deployment.
	FailureDisabled Failure = "oauth_disabled"
	// FailureDenied: the person declined at Google's consent screen.
	FailureDenied Failure = "oauth_denied"
	// FailureState: the state was malformed, tampered with, or expired. All
	// three collapse into one code because they are one thing to the user: try
	// again. They stay distinct inside VerifyState, where the distinction helps
	// whoever is debugging.
	FailureState Failure = "oauth_state"
	// FailureUnverified: Google's address is not verified.
	FailureUnverified Failure = "oauth_unverified"
	// FailureGeneric: anything else.
	FailureGeneric Failure = "oauth_failed"
	// FailureThrottled: too many attempts from this address. Not produced by the
	// auth service itself -- the controller's rate limiter raises it before
	// anything here runs.
	FailureThrottled Failure = "oauth_throttled"
)

// WantedRole is the role an address earns.
//
// An absent address is never an admin. The comparison is case-insensitive
// because addresses behave that way, and the allowlist is compared in lower case
// for the same reason.
func WantedRole(email string, adminEmails []string) models.AccountRole {
	trimmed := strings.ToLower(strings.TrimSpace(email))
	if trimmed == "" {
		return models.RoleUser
	}
	for _, allowed := range adminEmails {
		if strings.ToLower(strings.TrimSpace(allowed)) == trimmed {
			return models.RoleAdmin
		}
	}
	return models.RoleUser
}

// randomNonce returns a URL-safe random value for the state nonce.
func randomNonce() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		// A weak nonce is still better than a predictable empty one; the state
		// is authenticated by HMAC either way, so this path is not a security
		// failure -- it just makes the value less unique.
		return hex.EncodeToString([]byte(time.Now().String()))
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func nowMillis() int64 { return time.Now().UnixMilli() }

// ProviderEnabled reports whether sign-in is configured on this deployment.
func (s *AuthService) ProviderEnabled() bool { return s.provider.Enabled() }

// StartResult is what the authorize endpoint returns.
type StartResult struct {
	URL string
	Err Failure
}

// Start begins an authorization attempt.
func (s *AuthService) Start(next string) StartResult {
	if !s.provider.Enabled() {
		return StartResult{Err: FailureDisabled}
	}

	verifier, challenge, err := NewPKCE()
	if err != nil {
		s.log.Error("could not build the Google authorize URL", "error", err)
		return StartResult{Err: FailureGeneric}
	}

	// SafeNextPath before signing, so what goes in the state is already a
	// same-origin path. VerifyState checks it again at the point of use.
	state, err := SignState(State{
		Nonce:     randomNonce(),
		Verifier:  verifier,
		Next:      SafeNextPath(next),
		ExpiresAt: nowMillis() + StateTTL.Milliseconds(),
	}, s.provider.StateSecret())
	if err != nil {
		s.log.Error("could not sign the OAuth state", "error", err)
		return StartResult{Err: FailureGeneric}
	}

	url, err := s.provider.AuthorizeURL(state, challenge)
	if err != nil {
		s.log.Error("could not build the Google authorize URL", "error", err)
		return StartResult{Err: FailureGeneric}
	}
	return StartResult{URL: url}
}

// CompleteResult is what the callback returns.
type CompleteResult struct {
	Account *models.AccountPublic
	Next    string
	Err     Failure
}

// Complete finishes an authorization attempt.
//
// The order of the checks is deliberate. The denial is read before the state is
// verified because a person who declined the consent screen has a perfectly
// valid state and a perfectly absent code, and reporting that as a state failure
// would point whoever is debugging at the wrong thing.
func (s *AuthService) Complete(ctx context.Context, code, state, oauthError string) CompleteResult {
	if !s.provider.Enabled() {
		return CompleteResult{Err: FailureDisabled}
	}

	if oauthError != "" {
		return CompleteResult{Err: FailureDenied}
	}

	verified, err := VerifyState(state, s.provider.StateSecret())
	if err != nil {
		if reason, ok := StateReason(err); ok {
			s.log.Debug("google state rejected", "reason", string(reason))
		}
		return CompleteResult{Err: FailureState}
	}

	if code == "" {
		return CompleteResult{Err: FailureGeneric}
	}

	profile, err := s.provider.Authenticate(ctx, code, verified.Verifier)
	if err != nil {
		if errors.Is(err, ErrUnverifiedEmail) {
			s.log.Warn("google sign-in refused", "reason", "email not verified")
			return CompleteResult{Err: FailureUnverified}
		}
		s.log.Warn("google sign-in failed", "error", err)
		return CompleteResult{Err: FailureGeneric}
	}

	account, email, err := s.resolveAccount(ctx, profile)
	if err != nil {
		s.log.Error("google sign-in failed after verification", "error", err)
		return CompleteResult{Err: FailureGeneric}
	}

	return CompleteResult{
		Account: &models.AccountPublic{ID: account.ID, Role: roleOf(account), Email: email},
		Next:    verified.Next,
	}
}

// EmailFor returns the verified address stored for an account, for /auth/me.
//
// No provider filter and no ordering: an account has exactly one identity
// today, and when it has two the UI wants the one it already knows about rather
// than an arbitrary pick.
func (s *AuthService) EmailFor(ctx context.Context, accountID int32) (*string, error) {
	email, err := s.queries.GetIdentityEmailByAccountID(ctx, accountID)
	if errors.Is(err, sql.ErrNoRows) || !email.Valid || email.String == "" {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read identity email: %w", err)
	}
	v := email.String
	return &v, nil
}

// resolveAccount maps a verified identity to an account, creating one if needed.
//
// Two things here are worth stating plainly:
//
//   - Identity is keyed on Google's `sub` and never on email. Email is not
//     something an account owner controls, so keying on it would let anyone who
//     can register an address resembling someone else's claim their account.
//   - A unique-violation on the identity insert is not an error. Two concurrent
//     sign-ins for the same identity can both pass the "does this exist" check;
//     the unique index is what decides, and the loser re-reads the winner's row.
func (s *AuthService) resolveAccount(ctx context.Context, profile Profile) (dbgen.Account, *string, error) {
	identity, err := s.queries.GetIdentityByProviderSubject(ctx, dbgen.GetIdentityByProviderSubjectParams{
		Provider:        ProviderName,
		ProviderSubject: profile.Sub,
	})

	switch {
	case err == nil:
		account, accErr := s.queries.GetAccountByID(ctx, identity.AccountID)
		if accErr == nil {
			return s.applyAdminRole(ctx, account, profile, identity)
		}
		if !errors.Is(accErr, sql.ErrNoRows) {
			return dbgen.Account{}, nil, fmt.Errorf("load account %d: %w", identity.AccountID, accErr)
		}
		// The identity points at an account that is gone. Falling through to
		// create a fresh one is the repair; keeping the orphaned identity row
		// would make the unique index reject the insert.
		s.log.Warn("identity points at a missing account, recreating",
			"identity_id", identity.ID, "account_id", identity.AccountID)

	case !errors.Is(err, sql.ErrNoRows):
		return dbgen.Account{}, nil, fmt.Errorf("look up identity: %w", err)

	default:
		// A genuinely new identity. Provision below.
	}

	return s.provision(ctx, profile)
}

// provision creates the account and its identity, surviving a concurrent
// provisioning of the same identity.
func (s *AuthService) provision(ctx context.Context, profile Profile) (dbgen.Account, *string, error) {
	role := WantedRole(profile.Email, s.provider.AdminEmails())

	account, err := s.queries.InsertAccount(ctx, string(role))
	if err != nil {
		return dbgen.Account{}, nil, fmt.Errorf("create account: %w", err)
	}

	_, err = s.queries.InsertIdentity(ctx, dbgen.InsertIdentityParams{
		AccountID:       account.ID,
		Provider:        ProviderName,
		ProviderSubject: profile.Sub,
		Email:           nullable(profile.Email),
		PictureUrl:      nullable(profile.Picture),
	})

	if err != nil {
		if !isUniqueViolation(err) {
			return dbgen.Account{}, nil, fmt.Errorf("create identity: %w", err)
		}
		// Lost the race: another sign-in for the same identity created it while
		// this one was in flight. Read the winner and use that account.
		//
		// The accounts row this call created is left behind. It is not rolled
		// back because there is no transaction spanning the two inserts, and
		// deleting it would risk removing a row the winner is about to use. An
		// orphan account with no identity holds no data and cannot be signed
		// into.
		winner, findErr := s.queries.GetIdentityByProviderSubject(ctx, dbgen.GetIdentityByProviderSubjectParams{
			Provider:        ProviderName,
			ProviderSubject: profile.Sub,
		})
		if findErr != nil {
			return dbgen.Account{}, nil, err
		}
		winnerAccount, accErr := s.queries.GetAccountByID(ctx, winner.AccountID)
		if accErr != nil {
			return dbgen.Account{}, nil, err
		}
		s.log.Debug("lost the provisioning race for an identity", "sub", profile.Sub)
		return s.applyAdminRole(ctx, winnerAccount, profile, winner)
	}

	s.log.Info("provisioned account from a Google identity", "account_id", account.ID)
	return account, stringPtr(profile.Email), nil
}

// applyAdminRole recomputes the role from the allowlist and persists a change.
//
// Recomputed on every sign-in rather than stored once at provisioning, so that
// adding an address to GOOGLE_ADMIN_EMAILS grants admin and removing one
// revokes it -- on the next sign-in, with no deploy and no database change.
// That is the only thing that grants admin, and the absence of a stored grant is
// deliberate: there is nothing to forget, guess or reset.
func (s *AuthService) applyAdminRole(ctx context.Context, account dbgen.Account, profile Profile, identity dbgen.AccountIdentity) (dbgen.Account, *string, error) {
	profileEmail := profile.Email

	if profileEmail != "" && (!identity.Email.Valid || identity.Email.String != profileEmail) {
		if err := s.queries.UpdateIdentityEmail(ctx, dbgen.UpdateIdentityEmailParams{
			ID:    identity.ID,
			Email: nullable(profileEmail),
		}); err != nil {
			return account, nil, fmt.Errorf("update identity email: %w", err)
		}
		identity.Email = nullable(profileEmail)
	}

	// A picture is display-only and never compared, so it is recorded when it
	// changes and otherwise left alone.
	if profile.Picture != "" && (!identity.PictureUrl.Valid || identity.PictureUrl.String != profile.Picture) {
		if err := s.queries.UpdateIdentityPicture(ctx, dbgen.UpdateIdentityPictureParams{
			ID:         identity.ID,
			PictureUrl: nullable(profile.Picture),
		}); err != nil {
			return account, nil, fmt.Errorf("update identity picture: %w", err)
		}
		identity.PictureUrl = nullable(profile.Picture)
	}

	email := identity.Email
	if !email.Valid || email.String == "" {
		email = nullable(profileEmail)
	}

	role := WantedRole(stringOrEmpty(email), s.provider.AdminEmails())
	if account.Role == string(role) {
		return account, stringPtr(stringOrEmpty(email)), nil
	}

	s.log.Info("admin role changed", "account_id", account.ID, "from", account.Role, "to", string(role))
	updated, err := s.queries.UpdateAccountRole(ctx, dbgen.UpdateAccountRoleParams{
		ID:   account.ID,
		Role: string(role),
	})
	if err != nil {
		return account, nil, fmt.Errorf("update account role: %w", err)
	}
	return updated, stringPtr(stringOrEmpty(email)), nil
}

// ProviderName is the only provider wired up. Stored as text rather than an
// enum so a second one can be added without a schema change.
const ProviderName = "google"

func roleOf(account dbgen.Account) models.AccountRole {
	if account.Role == string(models.RoleAdmin) {
		return models.RoleAdmin
	}
	return models.RoleUser
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func nullable(v string) sql.NullString {
	if v == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: v, Valid: true}
}

func stringPtr(v string) *string {
	if v == "" {
		return nil
	}
	s := v
	return &s
}

func stringOrEmpty(v sql.NullString) string {
	if !v.Valid {
		return ""
	}
	return v.String
}
