package google

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Config is the Google sign-in configuration, read once from the environment.
type Config struct {
	ClientID     string
	ClientSecret string
	RedirectURI  string
	StateSecret  string
	AdminEmails  []string
}

// Enabled reports whether sign-in can work at all. All three OAuth values and a
// state secret are needed; without them the endpoints refuse to do anything and
// the UI hides the button.
func (c Config) Enabled() bool {
	return c.ClientID != "" && c.ClientSecret != "" && c.RedirectURI != "" && c.StateSecret != ""
}

// Profile is the verified identity Google returned.
type Profile struct {
	Sub     string
	Email   string
	Name    string
	Picture string
}

// ErrUnverifiedEmail is returned when Google's ID token says the address is not
// verified.
//
// Distinct from a generic failure because it is a different situation and gets a
// different message: the person used a real Google account whose address simply
// is not confirmed, and telling them so is more useful than "sign-in failed".
var ErrUnverifiedEmail = errors.New("google: email is not verified")

// Provider performs the raw OAuth exchange with Google.
type Provider struct {
	config Config

	issuer   string
	tokenURL string

	mu       sync.Mutex
	client   *http.Client
	provider *oidc.Provider
}

// NewProvider builds the provider.
func NewProvider(cfg Config) *Provider {
	return &Provider{
		config:   cfg,
		issuer:   "https://accounts.google.com",
		tokenURL: "https://oauth2.googleapis.com/token",
	}
}

// Enabled reports whether the provider is configured.
func (p *Provider) Enabled() bool { return p.config.Enabled() }

// AdminEmails are the addresses allowed to hold the admin role.
func (p *Provider) AdminEmails() []string { return p.config.AdminEmails }

// StateSecret is the HMAC key for the signed state.
//
// Panics rather than returning an error when unset: every caller has already
// checked Enabled, and a missing secret at that point is a wiring bug that
// should stop the process at the first sign-in rather than produce a state that
// nobody can verify.
func (p *Provider) StateSecret() string {
	if p.config.StateSecret == "" {
		panic("google: sign-in is not configured")
	}
	return p.config.StateSecret
}

// AuthorizeURL builds the URL to send the browser to.
func (p *Provider) AuthorizeURL(state, codeChallenge string) (string, error) {
	if !p.Enabled() {
		return "", errors.New("google: sign-in is not configured")
	}

	q := url.Values{}
	q.Set("client_id", p.config.ClientID)
	q.Set("redirect_uri", p.config.RedirectURI)
	q.Set("response_type", "code")
	q.Set("scope", strings.Join([]string{"openid", "email", "profile"}, " "))
	// select_account so a person already signed in to Google can still choose
	// which account to use here, rather than being silently signed in as
	// whichever one the browser had.
	q.Set("prompt", "select_account")
	// false: asking for previously granted scopes can return an account that
	// cannot satisfy what is being asked for now.
	q.Set("include_granted_scopes", "false")
	q.Set("code_challenge", codeChallenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)

	return "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode(), nil
}

// Authenticate exchanges an authorization code for a verified identity.
//
// The ID token is verified against Google's signing keys and this deployment's
// own client id, and the address must be confirmed. None of those checks are
// optional: an unverified ID token is just a JSON blob someone sent us.
func (p *Provider) Authenticate(ctx context.Context, code, codeVerifier string) (Profile, error) {
	if !p.Enabled() {
		return Profile{}, errors.New("google: sign-in is not configured")
	}

	cfg := p.oauthConfig()
	token, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(codeVerifier))
	if err != nil {
		return Profile{}, fmt.Errorf("google: token exchange: %w", err)
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return Profile{}, errors.New("google: no id_token in response")
	}

	verifier, err := p.idTokenVerifier(ctx)
	if err != nil {
		return Profile{}, err
	}

	// Verifies the signature against Google's keys, and checks the audience is
	// this deployment's client id. An unverified ID token is just a JSON blob
	// someone sent us, so none of this is optional.
	idToken, err := verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return Profile{}, fmt.Errorf("google: id token: %w", err)
	}

	// sub is the stable, never-reassigned identifier the account is keyed on.
	// Its absence means the token is not what we think it is.
	if idToken.Subject == "" {
		return Profile{}, errors.New("google: id token carried no sub")
	}

	// email, email_verified, name and picture are not part of the ID token's
	// registered claims, so they are read as loose ones. email_verified is the
	// load-bearing one.
	var claims struct {
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return Profile{}, fmt.Errorf("google: id token claims: %w", err)
	}

	// An unverified address cannot be allowed to create an account: anyone who
	// can register an address resembling someone else's would otherwise be able
	// to take it, and the admin allowlist is keyed on the address.
	if !claims.EmailVerified {
		return Profile{}, ErrUnverifiedEmail
	}

	return Profile{
		Sub:     idToken.Subject,
		Email:   claims.Email,
		Name:    claims.Name,
		Picture: claims.Picture,
	}, nil
}

func (p *Provider) oauthConfig() *oauth2.Config {
	return &oauth2.Config{
		ClientID:     p.config.ClientID,
		ClientSecret: p.config.ClientSecret,
		RedirectURL:  p.config.RedirectURI,
		Scopes:       []string{"openid", "email", "profile"},
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://accounts.google.com/o/oauth2/v2/auth",
			TokenURL: p.tokenURL,
		},
	}
}

// idTokenVerifier returns a verifier pinned to this deployment's client id.
//
// The OIDC provider is built once and cached: it holds Google's signing-key
// cache, and rebuilding it per sign-in would refetch that document every time.
func (p *Provider) idTokenVerifier(ctx context.Context) (*oidc.IDTokenVerifier, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.provider == nil {
		provider, err := oidc.NewProvider(p.oidcContext(ctx), p.issuer)
		if err != nil {
			return nil, fmt.Errorf("google: oidc provider: %w", err)
		}
		p.provider = provider
	}

	return p.provider.Verifier(&oidc.Config{ClientID: p.config.ClientID}), nil
}

// oidcContext carries the test HTTP client into the OIDC library, which takes
// it from the context rather than as an argument.
func (p *Provider) oidcContext(ctx context.Context) context.Context {
	if p.client == nil {
		return ctx
	}
	return oidc.ClientContext(ctx, p.client)
}

// SetHTTPClient points the provider at a different HTTP client, and clears the
// cached OIDC provider so the next call rebuilds against it. For tests, which
// stand a local server in for Google.
func (p *Provider) SetHTTPClient(c *http.Client) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.client = c
	p.provider = nil
}

// SetEndpoints overrides the issuer and token URL. For tests.
func (p *Provider) SetEndpoints(issuer, tokenURL string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.issuer = issuer
	p.tokenURL = tokenURL
	p.provider = nil
}
