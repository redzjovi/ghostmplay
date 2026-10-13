package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// The container HEALTHCHECK runs `bin/api -healthcheck`, so its exit code is the
// only readiness signal a Docker-runtime deploy gets -- Voroa ignores the
// service's Health check path there. A wrong exit code is a deploy that hangs or
// a container marked healthy while the database is gone.
//
// Built rather than called in-process, because main() reads os.Args and calls
// os.Exit; testing it any other way would not exercise what the container runs.

func runHealthcheck(t *testing.T, port string, bin string) int {
	t.Helper()
	cmd := exec.Command(bin, "-healthcheck")
	if port != "" {
		cmd.Env = append(os.Environ(), "PORT="+port)
	} else {
		cmd.Env = append(os.Environ(), "PORT=")
	}
	out, err := cmd.CombinedOutput()
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("running %s -healthcheck: %v\n%s", bin, err, out)
	}
	return exitErr.ExitCode()
}

func buildBinary(t *testing.T) string {
	t.Helper()
	bin := t.TempDir() + "/api"
	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("go build: %v", err)
	}
	return bin
}

// Nothing listening at all: the container cannot have started. Distinct from a
// 503, and worth distinguishing because the two mean different problems.
func TestHealthcheckReportsUnreachableWhenNothingIsListening(t *testing.T) {
	bin := buildBinary(t)
	// Port 1 is reserved and nothing will be bound to it.
	if got := runHealthcheck(t, "1", bin); got != 2 {
		t.Errorf("exit = %d, want 2 (unreachable)", got)
	}
}

func TestHealthcheckSucceedsWhenTheServiceIsHealthy(t *testing.T) {
	bin := buildBinary(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	port := portFrom(t, srv.URL)
	if got := runHealthcheck(t, port, bin); got != 0 {
		t.Errorf("exit = %d, want 0 (healthy)", got)
	}
}

// A service that is up but reporting unhealthy must not be called healthy. This
// is the case where the database is unreachable, and it is the whole reason the
// check exists rather than a bare TCP connect.
func TestHealthcheckReportsUnhealthyOnNon200(t *testing.T) {
	bin := buildBinary(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	if got := runHealthcheck(t, portFrom(t, srv.URL), bin); got != 1 {
		t.Errorf("exit = %d, want 1 (unhealthy)", got)
	}
}

// The probe must follow the platform's PORT rather than a hardcoded one, or it
// checks a port nothing is listening on and every deploy looks broken.
func TestHealthcheckFollowsThePortVariable(t *testing.T) {
	bin := buildBinary(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	real := portFrom(t, srv.URL)
	wrong := "1"

	if got := runHealthcheck(t, wrong, bin); got != 2 {
		t.Errorf("probing port %s returned %d, want 2", wrong, got)
	}
	if got := runHealthcheck(t, real, bin); got != 0 {
		t.Errorf("probing port %s returned %d, want 0", real, got)
	}
}

// Without PORT the check falls back to the same default the server binds, so a
// local run and a container both behave identically.
func TestHealthcheckDefaultsWhenPortIsUnset(t *testing.T) {
	bin := buildBinary(t)

	if got := runHealthcheck(t, "", bin); got != 2 {
		// Nothing is on the fallback port, so unreachable is the correct answer.
		// What matters is that it did not panic or exit 0.
		t.Errorf("exit = %d, want 2 with PORT unset", got)
	}
}

// A garbage PORT must not be taken literally; falling back is correct.
func TestHealthcheckIgnoresAnUnparseablePort(t *testing.T) {
	bin := buildBinary(t)

	cmd := exec.Command(bin, "-healthcheck")
	cmd.Env = append(os.Environ(), "PORT=not-a-number")
	out, _ := cmd.CombinedOutput()

	if !strings.Contains(string(out), "unreachable") {
		t.Errorf("expected a probe against the fallback port, got: %s", out)
	}
}

// portFrom extracts the port from an httptest server URL, which is always
// http://127.0.0.1:<port> with no trailing slash.
func portFrom(t *testing.T, rawURL string) string {
	t.Helper()
	host := strings.TrimPrefix(rawURL, "http://")
	host = strings.TrimSuffix(host, "/")
	port, found := strings.CutPrefix(host, "127.0.0.1:")
	if !found {
		t.Fatalf("unexpected test server URL %q", rawURL)
	}
	return port
}
