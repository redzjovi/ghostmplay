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

		path, err := safeJoin(root, c.Path())
		if err == nil && path != "" && isFile(path) {
			applyCacheHeaders(c)
			return c.SendFile(path)
		}

		// The fallback: every unmatched non-API path is the SPA.
		applyCacheHeaders(c)
		return c.SendFile(indexPath)
	}
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
