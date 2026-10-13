// Package config reads and validates the process environment once, at boot.
//
// Everything the app needs to know about its configuration is in the Env struct
// below, and nothing else in the codebase reads os.Getenv. That is the point:
// a value that is read in one place can be reasoned about, a value read
// ad-hoc from a dozen places cannot.
package config

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

// Env is the validated environment.
type Env struct {
	IsProd      bool
	NodeEnv     string
	Port        int
	DatabaseURL string
	DatabaseSSL bool
	// TrustProxy reads the client address from a forwarding header rather than
	// from the socket.
	//
	// Every deployment of this app sits behind exactly one proxy -- Voroa's edge
	// -- so the address in the header is the real one. Leave it on. Setting
	// TRUST_PROXY=0 turns it off, which is only correct when something else
	// terminates TLS and connects straight through.
	TrustProxy bool
	// ProxyHeader is the header carrying the real client address.
	ProxyHeader string
	CORSOrigins []string

	// Where the built web app lives, if it has been built. Empty means there is
	// no frontend, which is a valid mode -- an API-only deployment.
	WebRoot string
	// WebRootCandidates are the paths that were tried. Carried so an API-only
	// deployment can say where it looked, rather than only reporting that it
	// found nothing -- which is the difference between a five-second diagnosis
	// and an afternoon.
	WebRootCandidates []string

	Google Google

	LogAPI        bool
	LogQuery      bool
	MigrationsRun bool
}

// Google holds the sign-in configuration.
//
// Every field is optional and read without a hard requirement on purpose: an
// absent value must not stop the API from booting, otherwise upgrading would
// break every deployment that has not configured Google yet. When any of them
// is missing the feature is simply off and the UI hides the button.
type Google struct {
	ClientID     string
	ClientSecret string
	RedirectURI  string
	StateSecret  string

	// AdminEmails are the verified Google addresses allowed to hold
	// role='admin'. Comma-separated, lowercased.
	//
	// This is the *only* thing that grants admin -- there is no password
	// account left -- so an empty list means the deployment can never have one.
	// Bootstrap warns about that rather than failing: an operator may
	// deliberately run this read-only for a while, but they need to be told,
	// not left wondering why /admin/data 403s.
	//
	// Safe to derive authority from an address because the ID token is only
	// accepted when email_verified is true, Google guarantees a single account
	// holds any given address, and this value is chosen by whoever has the
	// environment anyway.
	AdminEmails []string

	// Enabled is true when all three OAuth values plus a state secret are
	// present. Nothing else about Google works until it is.
	Enabled bool
}

// Load reads .env if one is findable, then validates the process environment.
func Load() (Env, error) {
	loadDotEnv()

	e := Env{
		IsProd:  os.Getenv("NODE_ENV") == "production",
		NodeEnv: defaultString(os.Getenv("NODE_ENV"), "development"),

		// Voroa assigns the port and passes it as PORT. Reading it rather than
		// hardcoding is the only setup that cannot go wrong: a fixed port works
		// only while the platform agrees with it, and Voroa does not guarantee
		// that between native and Docker runtimes.
		Port: optionalInt(os.Getenv("PORT"), 8080),

		DatabaseSSL: os.Getenv("DATABASE_SSL") == "true",
		// "0" is the only value that disables it, so a deployment that never
		// heard of TRUST_PROXY gets the correct behaviour rather than the wrong
		// one.
		TrustProxy:  strings.TrimSpace(os.Getenv("TRUST_PROXY")) != "0",
		ProxyHeader: "X-Forwarded-For",
		CORSOrigins: splitCSV(os.Getenv("CORS_ORIGINS")),

		LogAPI: os.Getenv("LOG_API") == "1",

		// The TypeORM name is still honoured so an existing deployment's
		// environment keeps working after the rewrite.
		LogQuery: os.Getenv("LOG_QUERY") == "1" || os.Getenv("TYPEORM_LOGGING") == "true",

		// Migrations run at boot unless explicitly turned off. That removes the
		// whole class of deploy bug where a schema change ships without the
		// migration carrying it.
		MigrationsRun: os.Getenv("MIGRATIONS_RUN") != "false",
	}

	var err error
	if e.DatabaseURL, err = required("DATABASE_URL", os.Getenv("DATABASE_URL")); err != nil {
		return Env{}, err
	}

	e.WebRoot, e.WebRootCandidates = resolveWebRoot()
	e.Google = loadGoogle()

	return e, nil
}

func loadGoogle() Google {
	clientID := strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_ID"))
	clientSecret := strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_SECRET"))
	redirectURI := strings.TrimSpace(os.Getenv("GOOGLE_REDIRECT_URI"))

	// GOOGLE_REDIRECT_URI is explicit rather than derived from a public base URL
	// because it has to match the Cloud Console entry byte for byte, and a wrong
	// host only fails at Google's end -- after the user has already been
	// redirected away.
	stateSecret := strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_STATE_SECRET"))
	if stateSecret == "" && clientSecret != "" {
		// Fall back to a key derived from the client secret so there is no third
		// mandatory secret to provision. The explicit variable exists for
		// rotating the state key without rotating the OAuth client.
		sum := sha256.Sum256([]byte("gm-oauth-state\x00" + clientSecret))
		stateSecret = hex.EncodeToString(sum[:])
	}

	adminEmails := make([]string, 0)
	for _, e := range splitCSV(os.Getenv("GOOGLE_ADMIN_EMAILS")) {
		adminEmails = append(adminEmails, strings.ToLower(e))
	}

	return Google{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURI:  redirectURI,
		StateSecret:  stateSecret,
		AdminEmails:  adminEmails,
		Enabled:      clientID != "" && clientSecret != "" && redirectURI != "" && stateSecret != "",
	}
}

// resolveWebRoot finds the built web app, if there is one.
//
// In production this is the public/ directory beside the binary. In development
// the SPA is usually served by Vite instead, and these candidates let the API
// serve it if you prefer a single origin. Candidates are tried in order and the
// first that exists wins; an empty result means the API runs without static
// serving, which is a valid mode.
// resolveWebRoot returns the web build directory and every path it considered.
func resolveWebRoot() (root string, candidates []string) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", nil
	}

	// A path relative to the executable rather than the working directory. A
	// platform that controls the working directory -- cPanel's Passenger did,
	// and Voroa sets it to /app -- makes any cwd-relative guess a guess, while
	// the binary's own directory is always knowable.
	exeDir := ""
	if exe, err := os.Executable(); err == nil {
		exeDir = filepath.Dir(exe)
	}

	// An unset WEB_ROOT is dropped rather than listed: it means "unset", and
	// naming it would send whoever reads the log looking at a path that does not
	// exist.
	raw := []string{
		os.Getenv("WEB_ROOT"),
		filepath.Join(cwd, "public"),
		filepath.Join(exeDir, "public"),
		filepath.Join(cwd, "apps", "web", "dist"),
		filepath.Join(cwd, "..", "web", "dist"),
	}
	candidates = make([]string, 0, len(raw))
	for _, c := range raw {
		if c != "" {
			candidates = append(candidates, c)
		}
	}

	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			return c, candidates
		}
	}
	return "", candidates
}

// loadDotEnv reads the nearest .env, walking up from the working directory.
//
// Walking up rather than using a fixed path is what lets a workspace-local run
// work: the repo's .env lives at the root, while the API is run from apps/api.
// It also means apps/api/.env can override the root one, which is how a
// developer points one checkout at a different database.
//
// A .env file never overrides a real environment variable. That is what makes a
// file optional on a platform where the environment is configured out of band,
// which is every deployment target this has: on Voroa the variables come from
// the service's Environment Variables table, and a stray .env baked into the
// image must not be able to override them.
//
// ENV_FILE points at a specific file instead, bypassing the search. It exists
// for deployments that ship configuration alongside the binary, and it is what
// lets the tests run without the developer's own .env leaking in.
func loadDotEnv() {
	path := strings.TrimSpace(os.Getenv("ENV_FILE"))
	if path == "" {
		found, err := findUp(".env", mustGetwd())
		if err != nil {
			return
		}
		path = found
	}
	// Errors are ignored on purpose: a missing or malformed file must not stop
	// a deployment whose variables are set correctly anyway.
	_ = godotenv.Load(path)
}

func findUp(name, start string) (string, error) {
	dir := start
	for {
		candidate := filepath.Join(dir, name)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", os.ErrNotExist
		}
		dir = parent
	}
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

func required(name, value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", fmt.Errorf("missing required environment variable: %s", name)
	}
	return trimmed, nil
}

// optionalInt parses a positive integer, falling back on anything that is not
// one. Non-numeric, zero and negative all fall back rather than erroring,
// because a malformed PORT should not stop the process from booting.
func optionalInt(value string, fallback int) int {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// splitCSV splits a comma-separated setting, trimming each entry and dropping
// empty ones. An unset variable yields an empty slice, not a one-element slice
// containing "".
func splitCSV(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
