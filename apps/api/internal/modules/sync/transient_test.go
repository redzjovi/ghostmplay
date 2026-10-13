package sync

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"

	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/api"
)

// httpErr is a minimal HTTP error carrying a status, for the classifier to find.
type httpErr struct{ status int }

func (e httpErr) Error() string   { return fmt.Sprintf("upstream returned HTTP %d", e.status) }
func (e httpErr) StatusCode() int { return e.status }

// These cases decide whether a sync burns three attempts or one, against a
// public endpoint that answers to everybody. Getting it wrong in the permissive
// direction turns a permanently-wrong request into three requests every minute;
// getting it wrong in the strict direction turns a blip into a failed run.

func TestTransientStatusCodes(t *testing.T) {
	transient := []int{408, 425, 429, 500, 502, 503, 504}
	permanent := []int{400, 401, 403, 404, 409, 410, 422}

	for _, status := range transient {
		if !transientCode(httpErr{status}) {
			t.Errorf("HTTP %d classified as permanent, want transient", status)
		}
	}
	for _, status := range permanent {
		if transientCode(httpErr{status}) {
			t.Errorf("HTTP %d classified as transient, want permanent", status)
		}
	}
}

// Once a response has been received the verdict is made on the status alone.
// A transport-level code left in the error chain belongs to an intermediate hop
// and says nothing about what the upstream thought of the request.
func TestStatusOverridesTransportCode(t *testing.T) {
	// A 404 that happens to carry a "connection reset" phrase from a wrapping
	// layer must still be permanent.
	err := fmt.Errorf("request failed: %w: read: connection reset by peer", httpErr{404})
	if transientCode(err) {
		t.Error("a 404 with a reset phrase was classified transient")
	}
}

func TestTransportErrorsAreTransient(t *testing.T) {
	transient := []error{
		&net.DNSError{Err: "server misbehaving", Name: "host"},
		&net.OpError{Op: "read", Err: errors.New("connection reset by peer")},
		&net.OpError{Op: "dial", Err: errors.New("no route to host")},
		errors.New("dial tcp: i/o timeout"),
		errors.New("net/http: TLS handshake timeout"),
		errors.New("unexpected EOF"),
	}
	for _, err := range transient {
		if !transientCode(err) {
			t.Errorf("%q classified as permanent, want transient", err)
		}
	}
}

func TestPermanentErrorsAreNotRetried(t *testing.T) {
	permanent := []error{
		httpErr{400},
		httpErr{404},
		errors.New("pq: syntax error at or near \"SELCT\""),
		errors.New("could not parse item 12"),
	}
	for _, err := range permanent {
		if transientCode(err) {
			t.Errorf("%q classified as transient, want permanent", err)
		}
	}
}

// A cancelled or expired context is not the upstream's fault. Retrying would
// fight the caller's deadline and hold a lock open for nothing.
func TestContextErrorsAreNotTransient(t *testing.T) {
	if transientCode(context.Canceled) {
		t.Error("context.Canceled classified transient")
	}
	if transientCode(context.DeadlineExceeded) {
		t.Error("context.DeadlineExceeded classified transient")
	}
	// Even wrapped, and even when a status rode along from the last hop.
	wrapped := fmt.Errorf("fetching page: %w: %v", context.DeadlineExceeded, httpErr{503})
	if transientCode(wrapped) {
		t.Error("a deadline carrying a 503 was classified transient")
	}
}

// The upstream's own error type must be understood by the classifier, or every
// real scrape failure would be treated as permanent and never retried.
func TestUpstreamHTTPErrorIsClassified(t *testing.T) {
	if !transientCode(&api.HTTPError{Status: 503, Body: "upstream", Op: "GET search-redis"}) {
		t.Error("an upstream 503 was classified permanent")
	}
	if transientCode(&api.HTTPError{Status: 400, Body: "bad token", Op: "POST item-detail"}) {
		t.Error("an upstream 400 was classified transient")
	}
}

func TestTransientCodeOfNil(t *testing.T) {
	if transientCode(nil) {
		t.Error("nil classified as transient")
	}
}

func TestDescribeError(t *testing.T) {
	got := describeError(&api.HTTPError{Status: 429, Body: "slow down", Op: "GET search-redis"})
	if got == "" {
		t.Fatal("describeError returned an empty string")
	}
	// The status must be visible: it is the part that decides retryability, and
	// a log line without it makes a failed run impossible to diagnose.
	if !contains(got, "429") {
		t.Errorf("describeError = %q, want it to mention the status", got)
	}
	if !contains(got, "slow down") {
		t.Errorf("describeError = %q, want it to include the body", got)
	}

	if got := describeError(nil); got != "" {
		t.Errorf("describeError(nil) = %q, want an empty string", got)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) &&
		(haystack == needle || len(needle) == 0 || indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

// --- C1: telling an upstream fault apart from our own -----------------------

// The upstream outage this exists for: market-api answered HTTP 400 carrying its
// own database error, every route at once, and the sync log said only "sync
// failed: search redis page 0". Nothing in it distinguished the upstream being
// broken from this app being broken, which is the distinction that decides
// whether anyone debugs anything at all.
func TestUpstreamCauseSurfacesWhatTheUpstreamSaid(t *testing.T) {
	body := `{"message":"{\"errorCode\":-1,\"message\":\"Error 1045 (28000): ` +
		`Access denied for user 'mwallet_user'@'119.205.199.92' (using password: YES)\"}","data":null}`

	err := fmt.Errorf("search redis page 0: %w", &api.HTTPError{
		Status: 400,
		Op:     "market/search-redis",
		Body:   body,
	})

	up, ok := upstreamCause(err)
	if !ok {
		t.Fatal("a wrapped upstream refusal was not recognised as one")
	}
	if up.Status != 400 {
		t.Errorf("Status = %d, want 400", up.Status)
	}
	if up.Op != "market/search-redis" {
		t.Errorf("Op = %q, want the upstream path", up.Op)
	}
	// The database error is the part that identifies the outage.
	if want := "Error 1045"; !strings.Contains(up.Message, want) {
		t.Errorf("Message does not carry the upstream error: %q", up.Message)
	}
}

// The error is wrapped on the way out, so only walking the chain finds it.
func TestUpstreamCauseUnwraps(t *testing.T) {
	inner := &api.HTTPError{Status: 503, Op: "nft/item-detail", Body: "upstream busy"}

	for depth := 1; depth <= 5; depth++ {
		err := error(inner)
		for i := 1; i < depth; i++ {
			err = fmt.Errorf("item detail page %d: %w", i, err)
		}

		up, ok := upstreamCause(err)
		if !ok {
			t.Fatalf("depth %d: not recognised", depth)
		}
		if up.Status != 503 || up.Op != "nft/item-detail" {
			t.Errorf("depth %d: got %d/%q", depth, up.Status, up.Op)
		}
	}
}

// Our own failures must not be dressed up as upstream ones, or the distinction
// is worthless.
func TestUpstreamCauseIgnoresInternalErrors(t *testing.T) {
	for name, err := range map[string]error{
		"plain":       errors.New("connection reset by peer"),
		"timeout":     context.DeadlineExceeded,
		"wrapped":     fmt.Errorf("run: %w", errors.New("pool exhausted")),
		"db":          fmt.Errorf("query: %w", errors.New("relation does not exist")),
		"double wrap": fmt.Errorf("outer: %w", fmt.Errorf("inner: %w", errors.New("boom"))),
	} {
		if _, ok := upstreamCause(err); ok {
			t.Errorf("%s: an internal error was misreported as an upstream fault", name)
		}
	}
}

func TestUpstreamCauseHandlesNil(t *testing.T) {
	if _, ok := upstreamCause(nil); ok {
		t.Error("nil was reported as an upstream fault")
	}
}

// A long multi-line error page must not become a multi-line log entry.
func TestSummariseCollapsesAndTruncates(t *testing.T) {
	got := summarise("line one\n  line two\tthree   four", 100)
	if want := "line one line two three four"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got := summarise("x", 10); got != "x" {
		t.Errorf("short input was altered: %q", got)
	}
	if got := summarise("abcdefghijklmnop", 10); got != "abcdefghij..." {
		t.Errorf("truncation: got %q", got)
	}
}

func TestSummariseEmpty(t *testing.T) {
	if got := summarise("", 50); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}
