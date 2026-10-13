package platform

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/gofiber/fiber/v2"
)

// spaHandler serves the built web app, with the history fallback an SPA needs.
//
// The fallback is the part that matters. A client-side router owns its own URLs,
// so a deep link like /marketplaces/list is a request for a file that does not
// exist. Answering 404 would break every refresh and every shared link; answering
// index.html and letting the client router resolve the path is how it is meant
// to work.
//
// Deliberately mounted last, after the API, so it can never shadow a real route.
func spaHandler(root string, log *slog.Logger) fiber.Handler {
	indexPath := filepath.Join(root, "index.html")

	return func(c *fiber.Ctx) error {
		// Anything under /api that reached here is a genuinely missing endpoint.
		// Falling through to index.html would answer an API 404 with HTML, and
		// the client would try to parse it as JSON.
		if strings.HasPrefix(c.Path(), "/api/") {
			return fiber.ErrNotFound
		}

		cleaned := filepath.Clean("/" + c.Path())

		path, err := safeJoin(root, cleaned)
		if err == nil && path != "" && isFile(path) {
			applyCacheHeaders(c)
			return c.SendFile(path)
		}

		// A path with a file extension is a request for a real asset -- a script,
		// a stylesheet, an image. Answering index.html for a missing /app.js hands
		// the browser an HTML document where it expects JavaScript, and the
		// resulting failure is far harder to trace back than an honest 404.
		//
		// It also means a mistyped health-check path returns 404 rather than 200,
		// so a broken configuration cannot be mistaken for a healthy service.
		if filepath.Ext(cleaned) != "" {
			return fiber.ErrNotFound
		}

		// The fallback: every other unmatched path is the SPA.
		applyCacheHeaders(c)
		return c.SendFile(indexPath)
	}
}

// noWebBuild answers requests when there is no SPA to serve.
//
// This exists because its absence cost a deploy. With no web build the process
// registered no static handler at all, so "/" returned a bare 404 and a platform
// probing the site root concluded the service was unhealthy -- with nothing in
// the logs but one INFO line naming the cause, and no indication of where the
// build was expected.
//
// Only the site root produces this page. A request for a real API route still
// gets its real 404, so a wrong base URL cannot be mistaken for a healthy
// service either.
func noWebBuild(log *slog.Logger, candidates []string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if strings.HasPrefix(c.Path(), "/api/") {
			// Logged, because returning 404 silently is what made an aborted
			// deploy undiagnosable. A platform probing a path this process does
			// not serve, and a person mistyping one, produce byte-identical
			// silence; only one of them explains why a deploy did not go live.
			log.Warn("no route matched and there is no web build to fall back to",
				"method", c.Method(), "path", c.Path(),
				"status", fiber.StatusNotFound, "from", c.IP())
			return fiber.ErrNotFound
		}
		if c.Path() != "/" {
			log.Warn("no route matched and there is no web build to fall back to",
				"method", c.Method(), "path", c.Path(),
				"status", fiber.StatusNotFound, "from", c.IP())
			return fiber.ErrNotFound
		}

		// The site root answers 503 while no SPA is deployed. That is deliberate:
		// a missing frontend is a real fault, and reporting 200 would hide it.
		//
		// It is also the most likely thing for a platform to probe, so it is
		// logged at WARN with the status returned. On a deploy that aborts on its
		// health check, this line is the difference between knowing the probe hit
		// "/" and only suspecting it.
		log.Warn("served the no-web-build page at the site root",
			"method", c.Method(), "path", c.Path(),
			"status", fiber.StatusServiceUnavailable, "from", c.IP(),
			"fix", "point the platform health check at /api/health or /health, "+
				"or build the SPA into apps/api/public")

		c.Set(fiber.HeaderContentType, fiber.MIMETextHTMLCharsetUTF8)
		c.Set(fiber.HeaderCacheControl, "no-store")
		return c.Status(fiber.StatusServiceUnavailable).SendString(missingWebBuildPage(candidates))
	}
}

// missingWebBuildPage renders the diagnostic.
//
// 503 rather than 200: the API is genuinely serving, but the service is not
// whole, and a page that reported success would be read as "everything is fine".
func missingWebBuildPage(candidates []string) string {
	var looked strings.Builder
	if len(candidates) > 0 {
		looked.WriteString("\n      <h2>Where it looked</h2>\n      <ul>\n")
		for _, p := range candidates {
			looked.WriteString("        <li><code>" + htmlEscape(p) + "</code></li>\n")
		}
		looked.WriteString("      </ul>\n")
	}

	return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>ghostmplay &mdash; web build not deployed</title>
    <style>
      body { font: 15px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;
             margin: 0 auto; max-width: 44rem; padding: 3rem 1.25rem; color: #1b1b1b; }
      h1 { font-size: 1.25rem; line-height: 1.4; margin: 0 0 1rem; }
      h2 { font-size: 1rem; margin: 2rem 0 .5rem; }
      p { margin: .5rem 0; }
      code { background: #f2f2f2; padding: .1rem .35rem; border-radius: 3px; }
      ul { padding-left: 1.1rem; } .muted { color: #666; } a { color: #0a5; }
    </style>
  </head>
  <body>
    <h1>The API is running. The web app was not deployed with it.</h1>
    <p class="muted">This service was built without a frontend, so there is nothing to
    serve at <code>/</code>. The API is unaffected and reachable under <code>/api</code>.</p>
    <h2>To fix it</h2>
    <p>Build the SPA and make it visible to this process, either by pointing
    <code>WEB_ROOT</code> at the built directory or by copying the build to
    <code>apps/api/public</code> before <code>go build</code>. See
    <code>docs/DEPLOY-VOROA.md</code>, "Serving the web app".</p>
    <h2>Check the API</h2>
    <ul>
      <li><a href="/api/health">/api/health</a></li>
      <li><a href="/health">/health</a></li>
      <li><a href="/api/marketplace/items?limit=1">/api/marketplace/items?limit=1</a></li>
    </ul>` + looked.String() + `
  </body>
</html>
`
}

func htmlEscape(s string) string {
	return strings.NewReplacer(
		"&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;",
	).Replace(s)
}

// safeJoin resolves a request path inside root, refusing anything that escapes.
//
// The traversal check is here because the path comes from the request. Fiber's
// SendFile rejects escapes on its own, but the check has to run first to decide
// whether this is a real file or the fallback.
func safeJoin(root, requestPath string) (string, error) {
	cleaned := filepath.Clean("/" + requestPath)

	full := filepath.Join(root, cleaned)
	rel, err := filepath.Rel(root, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fiber.ErrForbidden
	}
	return full, nil
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// immutablePrefixes are the directories a build tool gives content-hashed names.
//
// A file under one of these can be cached forever, because changing its contents
// changes its name.
var immutablePrefixes = []string{"/assets/", "/immutable/", "/_nuxt/"}

// applyCacheHeaders sets a cache policy appropriate to what was served.
func applyCacheHeaders(c *fiber.Ctx) {
	path := c.Path()
	for _, prefix := range immutablePrefixes {
		if strings.HasPrefix(path, prefix) {
			c.Set(fiber.HeaderCacheControl, "public, max-age=31536000, immutable")
			return
		}
	}
	// index.html must not be cached hard, or a browser will keep loading the old
	// document after a deploy and never pick up the new bundle it references.
	c.Set(fiber.HeaderCacheControl, "no-cache")
}
