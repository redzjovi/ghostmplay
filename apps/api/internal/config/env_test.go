package config

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadRequiresDatabaseURL(t *testing.T) {
	// Every other variable is optional. This one is not, because there is
	// nothing to run against without it, and failing at boot reports "failed to
	// start" with a reason -- which is the outcome that can be acted on. Failing
	// later, on the first request, looks like the app works.
	clearEnv(t)
	_, err := Load()
	if err == nil {
		t.Fatal("Load succeeded without DATABASE_URL")
	}
	if !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Errorf("error = %q, want it to name DATABASE_URL", err)
	}
}

func TestLoadDefaults(t *testing.T) {
	clearEnv(t)
	t.Setenv("DATABASE_URL", "postgres://localhost/ghostmplay")

	e, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if e.Port != 8080 {
		t.Errorf("Port = %d, want the 8080 default", e.Port)
	}
	if e.IsProd {
		t.Error("IsProd is true without NODE_ENV=production")
	}
	if !e.MigrationsRun {
		t.Error("MigrationsRun is false by default; it must be opt-out via MIGRATIONS_RUN=false")
	}
	// Empty means same-origin only, which is the recommended setting.
	if len(e.CORSOrigins) != 0 {
		t.Errorf("CORSOrigins = %v, want empty", e.CORSOrigins)
	}
	if !e.TrustProxy {
		t.Error("TrustProxy is false by default; a proxied deploy would rate limit on the proxy's IP")
	}
}

func TestLoadPortFallsBackOnGarbage(t *testing.T) {
	clearEnv(t)
	t.Setenv("DATABASE_URL", "postgres://localhost/ghostmplay")

	// A malformed port must not stop the process booting, and it must not be
	// silently coerced to zero either.
	for _, value := range []string{"", "abc", "0", "-1", "  "} {
		t.Setenv("PORT", value)
		e, err := Load()
		if err != nil {
			t.Fatalf("Load with PORT=%q: %v", value, err)
		}
		if e.Port != 8080 {
			t.Errorf("PORT=%q gave Port=%d, want the 8080 fallback", value, e.Port)
		}
	}

	t.Setenv("PORT", "3000")
	e, _ := Load()
	if e.Port != 3000 {
		t.Errorf("PORT=3000 gave Port=%d, want 3000", e.Port)
	}
}

func TestGoogleDisabledWithoutFullConfiguration(t *testing.T) {
	// An absent Google value must not stop the API from booting, or upgrading
	// would break every deployment that has not configured it yet.
	cases := []struct {
		name    string
		present map[string]string
	}{
		{"nothing set", nil},
		{"only client id", map[string]string{"GOOGLE_CLIENT_ID": "id"}},
		{"no secret", map[string]string{"GOOGLE_CLIENT_ID": "id", "GOOGLE_REDIRECT_URI": "https://x/cb"}},
		{"no redirect uri", map[string]string{"GOOGLE_CLIENT_ID": "id", "GOOGLE_CLIENT_SECRET": "secret"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearEnv(t)
			t.Setenv("DATABASE_URL", "postgres://localhost/ghostmplay")
			for k, v := range tc.present {
				t.Setenv(k, v)
			}

			e, err := Load()
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if e.Google.Enabled {
				t.Error("Google.Enabled is true with incomplete configuration")
			}
		})
	}
}

func TestGoogleEnabled(t *testing.T) {
	clearEnv(t)
	t.Setenv("DATABASE_URL", "postgres://localhost/ghostmplay")
	t.Setenv("GOOGLE_CLIENT_ID", "id")
	t.Setenv("GOOGLE_CLIENT_SECRET", "secret")
	t.Setenv("GOOGLE_REDIRECT_URI", "https://example.com/api/auth/google/callback")

	e, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !e.Google.Enabled {
		t.Fatal("Google.Enabled is false with complete configuration")
	}
	// Derived from the client secret so there is no third mandatory secret to
	// provision.
	if e.Google.StateSecret == "" {
		t.Error("StateSecret is empty; it should fall back to a key derived from the client secret")
	}
}

func TestGoogleStateSecretPrefersTheExplicitVariable(t *testing.T) {
	clearEnv(t)
	t.Setenv("DATABASE_URL", "postgres://localhost/ghostmplay")
	t.Setenv("GOOGLE_CLIENT_ID", "id")
	t.Setenv("GOOGLE_CLIENT_SECRET", "secret")
	t.Setenv("GOOGLE_REDIRECT_URI", "https://example.com/cb")
	t.Setenv("GOOGLE_OAUTH_STATE_SECRET", "explicit")

	e, _ := Load()
	if e.Google.StateSecret != "explicit" {
		t.Errorf("StateSecret = %q, want the explicit value", e.Google.StateSecret)
	}
}

func TestGoogleStateSecretDerivationIsStable(t *testing.T) {
	// The derivation has to be byte-identical on every boot: a state signed
	// yesterday has to verify today, and any deploy would otherwise invalidate
	// every in-flight login.
	clearEnv(t)
	t.Setenv("DATABASE_URL", "postgres://localhost/ghostmplay")
	t.Setenv("GOOGLE_CLIENT_ID", "id")
	t.Setenv("GOOGLE_CLIENT_SECRET", "client-secret")
	t.Setenv("GOOGLE_REDIRECT_URI", "https://example.com/cb")

	first, _ := Load()

	sum := sha256.Sum256([]byte("gm-oauth-state\x00" + "client-secret"))
	want := hex.EncodeToString(sum[:])
	if first.Google.StateSecret != want {
		t.Errorf("derived secret = %q, want sha256 of the documented input", first.Google.StateSecret)
	}
}

func TestGoogleAdminEmailsAreLowercased(t *testing.T) {
	// Addresses are compared case-insensitively because that is how they
	// behave, and admin is granted from this list on every sign-in.
	clearEnv(t)
	t.Setenv("DATABASE_URL", "postgres://localhost/ghostmplay")
	t.Setenv("GOOGLE_ADMIN_EMAILS", " Admin@Example.COM , ops@example.com ,, ")

	e, _ := Load()
	want := []string{"admin@example.com", "ops@example.com"}
	if len(e.Google.AdminEmails) != len(want) {
		t.Fatalf("AdminEmails = %v, want %v", e.Google.AdminEmails, want)
	}
	for i := range want {
		if e.Google.AdminEmails[i] != want[i] {
			t.Errorf("AdminEmails = %v, want %v", e.Google.AdminEmails, want)
			break
		}
	}
}

func TestMigrationsRunCanBeDisabled(t *testing.T) {
	clearEnv(t)
	t.Setenv("DATABASE_URL", "postgres://localhost/ghostmplay")
	t.Setenv("MIGRATIONS_RUN", "false")

	e, _ := Load()
	if e.MigrationsRun {
		t.Error("MigrationsRun is true with MIGRATIONS_RUN=false")
	}
}

func TestSplitCSV(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"   ", nil},
		{",,,", nil},
		{"a", []string{"a"}},
		{" a , b ", []string{"a", "b"}},
		{"a,,b", []string{"a", "b"}},
	}
	for _, tt := range tests {
		got := splitCSV(tt.in)
		if len(got) != len(tt.want) {
			t.Errorf("splitCSV(%q) = %v, want %v", tt.in, got, tt.want)
			continue
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Errorf("splitCSV(%q) = %v, want %v", tt.in, got, tt.want)
				break
			}
		}
	}
}

// clearEnv unsets everything the config reads, so a test cannot accidentally
// inherit the developer's real GOOGLE_CLIENT_SECRET or a stray MIGRATIONS_RUN.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"NODE_ENV", "PORT", "DATABASE_URL", "DATABASE_SSL", "TRUST_PROXY",
		"CORS_ORIGINS", "WEB_ROOT", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
		"GOOGLE_REDIRECT_URI", "GOOGLE_ADMIN_EMAILS", "GOOGLE_OAUTH_STATE_SECRET",
		"MIGRATIONS_RUN", "LOG_API", "LOG_QUERY", "TYPEORM_LOGGING",
	} {
		t.Setenv(k, "")
		if err := os.Unsetenv(k); err != nil {
			t.Fatalf("unset %s: %v", k, err)
		}
	}
	// Point the .env lookup at a file that does not exist. Without this the
	// repo's own .env -- which has a real GOOGLE_CLIENT_SECRET in it -- is
	// loaded by Load() and these tests assert against it.
	t.Setenv("ENV_FILE", filepath.Join(t.TempDir(), "no-such-file"))
}

func unset(key string) error { return os.Unsetenv(key) }
