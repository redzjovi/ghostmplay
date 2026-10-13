package platform

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func testLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// --- B1: the no-web-build diagnostic ----------------------------------------

// A platform probing "/" and getting a bare 404 concluded the service was
// unhealthy, with one INFO line naming the cause and nothing saying where the
// build was expected. This pins the replacement.
func TestNoWebBuildExplainsItself(t *testing.T) {
	app := fiber.New()
	app.Use(noWebBuild(testLogger(), []string{"/app/public", "/app/apps/web/dist"}))

	res := doRequest(t, app, "/")

	if res.StatusCode == 404 {
		t.Fatal("the site root still 404s with no web build")
	}
	if res.StatusCode != 503 {
		t.Errorf("status = %d, want 503 -- the API works but the service is not whole", res.StatusCode)
	}

	body := readBody(t, res)
	for _, want := range []string{
		"The API is running", // what still works
		"not deployed",       // what does not
		"/app/public",        // where it looked
		"/app/apps/web/dist", //
		"/api/health",        // somewhere to go next
		"DEPLOY-VOROA.md",    // and how to fix it
	} {
		if !strings.Contains(body, want) {
			t.Errorf("the diagnostic does not mention %q", want)
		}
	}
}

// A wrong API base must not read as a healthy service, which is the other half
// of why this returns 503 rather than a page.
func TestNoWebBuildStill404sForRealApiRoutes(t *testing.T) {
	app := fiber.New()
	app.Use(noWebBuild(testLogger(), nil))

	for _, path := range []string{"/api/health", "/api/marketplace/items", "/api/auth/me"} {
		if res := doRequest(t, app, path); res.StatusCode != 404 {
			t.Errorf("%s = %d, want 404", path, res.StatusCode)
		}
	}
}

func TestNoWebBuildIsNotCached(t *testing.T) {
	app := fiber.New()
	app.Use(noWebBuild(testLogger(), nil))
	res := doRequest(t, app, "/")
	if cc := res.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
}

// --- B3: the fallback does not answer asset requests -----------------------

func TestSPAFallbackSkipsPathsWithAnExtension(t *testing.T) {
	root := t.TempDir()
	writeIndex(t, root)

	app := fiber.New()
	app.Use(spaHandler(root, testLogger()))

	// A client-side route has no extension and must reach the SPA.
	for _, path := range []string{"/", "/marketplaces/list", "/items/123", "/history/list"} {
		res := doRequest(t, app, path)
		if res.StatusCode != 200 {
			t.Errorf("SPA route %s = %d, want 200", path, res.StatusCode)
		}
	}

	// A missing asset must not be answered with HTML. Beyond the confusing
	// browser failure, it would let a mistyped health-check path look healthy.
	for _, path := range []string{"/assets/app.js", "/assets/app.css", "/favicon.ico", "/missing.png"} {
		res := doRequest(t, app, path)
		if res.StatusCode != 404 {
			t.Errorf("missing asset %s = %d, want 404", path, res.StatusCode)
		}
	}
}

func TestSPAServesRealFiles(t *testing.T) {
	root := t.TempDir()
	writeIndex(t, root)
	if err := os.MkdirAll(filepath.Join(root, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "assets", "app.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatal(err)
	}

	app := fiber.New()
	app.Use(spaHandler(root, testLogger()))

	res := doRequest(t, app, "/assets/app.js")
	if res.StatusCode != 200 {
		t.Fatalf("a real asset = %d, want 200", res.StatusCode)
	}
	if body := readBody(t, res); !strings.Contains(body, "console.log") {
		t.Errorf("a real asset was not served: %q", body)
	}
	// Content-hashed names can be cached indefinitely.
	if cc := res.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("Cache-Control = %q, want immutable for a hashed asset", cc)
	}
}

func TestSPANeverShadowsTheApi(t *testing.T) {
	root := t.TempDir()
	writeIndex(t, root)

	app := fiber.New()
	app.Use(spaHandler(root, testLogger()))

	// A missing API route must stay a 404 rather than becoming index.html, which
	// the client would try to parse as JSON.
	if res := doRequest(t, app, "/api/does-not-exist"); res.StatusCode != 404 {
		t.Errorf("a missing API route = %d, want 404", res.StatusCode)
	}
}

func TestSPAIndexIsNotCachedHard(t *testing.T) {
	root := t.TempDir()
	writeIndex(t, root)

	app := fiber.New()
	app.Use(spaHandler(root, testLogger()))

	res := doRequest(t, app, "/marketplaces/list")
	if cc := res.Header.Get("Cache-Control"); strings.Contains(cc, "immutable") || strings.Contains(cc, "max-age=31536000") {
		t.Errorf("Cache-Control = %q, want index.html to stay revalidating", cc)
	}
}

// --- helpers ----------------------------------------------------------------

func writeIndex(t *testing.T, root string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, "index.html"),
		[]byte("<!DOCTYPE html><html><body>spa</body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func doRequest(t *testing.T, app *fiber.App, path string) *http.Response {
	t.Helper()
	res, err := app.Test(httptest.NewRequest(http.MethodGet, path, nil), -1)
	if err != nil {
		t.Fatalf("request %s: %v", path, err)
	}
	return res
}

func readBody(t *testing.T, res *http.Response) string {
	t.Helper()
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// newTestApp builds a Fiber app with the static handling platform.New applies,
// without the full dependency graph. An empty webRoot exercises the no-web-build
// path.
func newTestApp(t *testing.T, webRoot string) *fiber.App {
	t.Helper()
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	if webRoot != "" {
		app.Use(spaHandler(webRoot, testLogger()))
	} else {
		app.Use(noWebBuild(testLogger(), nil))
	}
	return app
}

// --- the boot line must not lie about the site root ---------------------------

// The boot log names what a health probe can be pointed at. It said
// "siteRoot=503" unconditionally, which was correct only while no web build was
// deployed -- so shipping the SPA turned the line into a false statement on a
// healthy service, which is the worst thing that line could do.
func TestSiteRootStatusReflectsWhetherAWebBuildExists(t *testing.T) {
	if got := siteRootStatus("public"); got != 200 {
		t.Errorf("site root with a web build = %d, want 200", got)
	}

	if got := siteRootStatus(""); got != 503 {
		t.Errorf("site root without a web build = %d, want 503", got)
	}
}

// A client route resolves to index.html, while a missing asset with an extension
// stays a 404. Getting this backwards is the bug the extension check exists for.
func TestSPAHandlerAndRootStatusAgree(t *testing.T) {
	root := t.TempDir()
	writeIndex(t, root)

	app := newTestApp(t, root)
	for path, want := range map[string]int{
		"/":             200,
		"/marketplaces": 200,
		"/api/health":   404, // unregistered here; the real app registers it
		"/missing.js":   404,
	} {
		if res := doRequest(t, app, path); res.StatusCode != want {
			t.Errorf("%s = %d, want %d", path, res.StatusCode, want)
		}
	}
}

// --- probe logging: making an aborted deploy diagnosable ----------------------

// capturedLogger keeps log lines so a test can assert on what was recorded.
type capturedLogger struct {
	mu    sync.Mutex
	lines []string
}

func (c *capturedLogger) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, string(p))
	return len(p), nil
}

func (c *capturedLogger) contains(needle string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, l := range c.lines {
		if strings.Contains(l, needle) {
			return true
		}
	}
	return false
}

// The site root is the most likely thing for a platform to probe, and it answers
// 503 on purpose. Without this line a deploy that aborts on "/" and one that
// aborts on a mistyped path are indistinguishable in the log.
func TestSiteRootProbeIsLogged(t *testing.T) {
	sink := &capturedLogger{}
	app := fiber.New()
	app.Use(noWebBuild(slog.New(slog.NewTextHandler(sink, nil)), nil))

	res := doRequest(t, app, "/")
	if res.StatusCode != 503 {
		t.Fatalf("status = %d, want 503", res.StatusCode)
	}

	for _, want := range []string{"served the no-web-build page", "path=/", "status=503"} {
		if !sink.contains(want) {
			t.Errorf("log does not mention %q; got:\n%s", want, strings.Join(sink.lines, ""))
		}
	}
}

// A probe aimed at a path this process does not serve returned a bare 404 with
// no log at all, which is what made an aborted deploy undiagnosable: this line
// is how the next one gets explained.
func TestUnmatchedProbeIsLogged(t *testing.T) {
	sink := &capturedLogger{}
	app := fiber.New()
	app.Use(noWebBuild(slog.New(slog.NewTextHandler(sink, nil)), nil))

	res := doRequest(t, app, "/healthcheck")
	if res.StatusCode != 404 {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}

	for _, want := range []string{"no route matched", "path=/healthcheck", "status=404"} {
		if !sink.contains(want) {
			t.Errorf("log does not mention %q; got:\n%s", want, strings.Join(sink.lines, ""))
		}
	}
}

func TestUnmatchedAPIPathIsLogged(t *testing.T) {
	sink := &capturedLogger{}
	app := fiber.New()
	app.Use(noWebBuild(slog.New(slog.NewTextHandler(sink, nil)), nil))

	res := doRequest(t, app, "/api/health")
	if res.StatusCode != 404 {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
	if !sink.contains("path=/api/health") {
		t.Errorf("an unmatched /api path was not logged; got:\n%s", strings.Join(sink.lines, ""))
	}
}
