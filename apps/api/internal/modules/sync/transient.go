// Package sync coordinates the scraper runs: who may start one, what state it
// leaves behind, and what the admin panel is told about it.
package sync

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"time"

	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/api"
)

// Retry classification for scraper work.
//
// Only genuinely transient conditions are retried. A 400 (malformed request) or
// 404 (item gone) means the request itself is wrong, and retrying it just burns
// the upstream's rate limit and delays the rest of the run.

// transientCode reports whether err is a condition that resolves on its own
// within seconds.
//
// Once an HTTP status has been received the verdict is made on the status alone.
// That is deliberate: a response means the request reached the upstream and was
// understood, so a transport-level code in the error chain is noise from an
// intermediate hop, and the status is the thing that actually describes the
// outcome.
func transientCode(err error) bool {
	if err == nil {
		return false
	}

	// A cancelled or expired context is not the upstream's fault, and retrying
	// it would fight the caller's deadline. Note this is checked before the HTTP
	// status: a request that fails because its own deadline expired may well
	// carry a status from the last hop, and that status is not why it failed.
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}

	if status, ok := httpStatus(err); ok {
		return status == 408 || status == 425 || status == 429 || status >= 500
	}

	// A network timeout with no status attached: the connection never completed.
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}

	// Then by message. Weak on its own -- a message is prose, not a contract --
	// but it catches the transport errors that arrive wrapped in a way that hides
	// their concrete type, which is how most DNS failures and resets surface.
	return looksTransientMessage(err.Error())
}

// All lower-case, because the message is lower-cased before matching. A
// fragment with a capital in it would never match and would read as coverage
// that does not exist.
var transientFragments = []string{
	"connection reset",
	"connection refused",
	"broken pipe",
	"unexpected eof",
	"eof",
	"no such host",
	"no route to host",
	"server misbehaving",
	"i/o timeout",
	"network is unreachable",
	"host is unreachable",
	"tls handshake timeout",
	"too many open files",
}

// looksTransientMessage is the last resort: match on the message.
//
// Weak on its own -- a message is prose, not a contract -- but it catches the
// transport errors that arrive wrapped in a way that hides their concrete type,
// which in practice is how most DNS failures and resets surface.
func looksTransientMessage(msg string) bool {
	lower := strings.ToLower(msg)
	for _, fragment := range transientFragments {
		if strings.Contains(lower, fragment) {
			return true
		}
	}
	return false
}

// httpStatus extracts an HTTP status from an error, if one is attached.
func httpStatus(err error) (int, bool) {
	var statusErr interface{ StatusCode() int }
	if errors.As(err, &statusErr) {
		if s := statusErr.StatusCode(); s > 0 {
			return s, true
		}
	}

	// api.HTTPError carries the status as a field rather than a method.
	var fieldErr interface{ GetStatusCode() int }
	if errors.As(err, &fieldErr) {
		if s := fieldErr.GetStatusCode(); s > 0 {
			return s, true
		}
	}
	return 0, false
}

// describeError renders an error for a log line: the transport code, the HTTP
// status, and the message, joined by colons and skipping what is absent.
func describeError(err error) string {
	if err == nil {
		return ""
	}
	parts := make([]string, 0, 3)
	if status, ok := httpStatus(err); ok {
		parts = append(parts, fmt.Sprintf("HTTP %d", status))
	}
	if msg := err.Error(); msg != "" {
		parts = append(parts, msg)
	}
	return strings.Join(parts, ": ")
}

// retryPolicy is the backoff schedule for scraper work.
//
// Three attempts with a doubling delay: 2s then 4s, for a worst case of about
// six seconds of waiting. Longer than that would be holding a lock against a
// public endpoint for a failure that is probably not going to clear.
type retryPolicy struct {
	maxAttempts int
	baseDelay   time.Duration
}

// DefaultRetry is the policy used for sync work.
var DefaultRetry = retryPolicy{maxAttempts: 3, baseDelay: 2 * time.Second}

// withRetry runs fn, retrying transient failures.
//
// A non-transient failure is returned on the first attempt. Retrying it would
// burn the upstream's rate limit and delay every page behind it, because the
// failure is a property of the request rather than of the moment.
func withRetry(ctx context.Context, label string, log *slog.Logger, fn func() error) error {
	var lastErr error

	for attempt := 1; attempt <= DefaultRetry.maxAttempts; attempt++ {
		// Checked before the attempt rather than after a failure: a cancelled
		// context should not consume a retry budget.
		if err := ctx.Err(); err != nil {
			if lastErr != nil {
				return lastErr
			}
			return err
		}

		lastErr = fn()
		if lastErr == nil {
			return nil
		}

		if !transientCode(lastErr) || attempt == DefaultRetry.maxAttempts {
			return lastErr
		}

		delay := DefaultRetry.baseDelay * time.Duration(1<<(attempt-1))
		log.Warn("sync attempt failed, retrying",
			"label", label, "attempt", attempt, "max", DefaultRetry.maxAttempts,
			"delay", delay.String(), "error", describeError(lastErr))

		select {
		case <-ctx.Done():
			return lastErr
		case <-time.After(delay):
		}
	}

	return lastErr
}

// upstreamFault is what an upstream said when it refused.
//
// The upstream is a third party serving a public endpoint from behind its own
// database, and when its database is unreachable it answers HTTP 400 with the
// database error in the body. That makes "our bug" and "their outage" produce
// the same log line unless something surfaces the distinction, and when it is
// their outage the only evidence available is what we logged.
type upstreamFault struct {
	// Status is the HTTP status returned.
	Status int
	// Op is the operation: the upstream's path, without the query string.
	Op string
	// Message is what the upstream said, whitespace-collapsed. For an upstream
	// fault this is the part that identifies it.
	Message string
}

// upstreamCause extracts an upstream refusal from an error chain.
//
// The error is wrapped on the way out -- "search redis page 0: market/search-redis:
// upstream returned HTTP 400: ..." -- so the chain is walked rather than only the
// outermost error inspected.
func upstreamCause(err error) (upstreamFault, bool) {
	var httpErr *api.HTTPError
	if !errors.As(err, &httpErr) {
		return upstreamFault{}, false
	}
	return upstreamFault{
		Status:  httpErr.Status,
		Op:      httpErr.Op,
		Message: summarise(httpErr.Body, 300),
	}, true
}

// summarise trims a body to something loggable, collapsing whitespace so a
// multi-line error page cannot become a multi-line log entry.
func summarise(body string, max int) string {
	flat := strings.Join(strings.Fields(body), " ")
	if len(flat) > max {
		return flat[:max] + "..."
	}
	return flat
}
