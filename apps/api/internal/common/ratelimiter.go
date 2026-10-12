package common

import (
	"sync"
	"time"
)

// RateLimiter is a fixed-window counter, per key.
//
// It is in-process, which is the same caveat as LockService: on a platform that
// runs one container per service that is correct, and scaling out would give
// each instance its own budget. The only thing currently limited is the Google
// sign-in endpoints, where the budget exists to slow down someone hammering one
// IP rather than to stop a distributed attack -- a platform-level limit is the
// right answer for that, and this is not it.
type RateLimiter struct {
	mu      sync.Mutex
	windows map[string]window
}

type window struct {
	expiresAt time.Time
	count     int
}

// NewRateLimiter returns an empty RateLimiter.
func NewRateLimiter() *RateLimiter {
	return &RateLimiter{windows: make(map[string]window)}
}

// Consume counts one request against key and reports whether the caller is
// still within budget: `limit` requests per `windowSeconds`.
//
// The window starts at the caller's first attempt rather than sliding, which is
// the right trade for this use: a fixed window cannot be gamed by spacing
// requests across a boundary, and the worst case is a caller getting `limit`
// requests at the end of one window and `limit` at the start of the next. That
// is twice the budget in a short span, against an endpoint whose cost is one
// token exchange.
func (r *RateLimiter) Consume(key string, limit int, windowSeconds int) bool {
	now := time.Now()

	r.mu.Lock()
	defer r.mu.Unlock()

	r.evictExpired(now)

	w, ok := r.windows[key]
	if !ok {
		r.windows[key] = window{expiresAt: now.Add(time.Duration(windowSeconds) * time.Second), count: 1}
		return limit >= 1
	}

	w.count++
	r.windows[key] = w
	return w.count <= limit
}

// evictExpired sweeps the whole map rather than just the key being consumed.
// The map holds one entry per distinct key, and only ever per IP, so a full
// sweep on each call is cheap; it also means a client that stops sending never
// leaves an entry behind to be found by someone else's request.
func (r *RateLimiter) evictExpired(now time.Time) {
	for k, w := range r.windows {
		if !w.expiresAt.After(now) {
			delete(r.windows, k)
		}
	}
}

// Remaining reports how much budget is left in the current window. Not used to
// make decisions -- Consume does that -- but useful in a log line.
func (r *RateLimiter) Remaining(key string, limit int) int {
	now := time.Now()

	r.mu.Lock()
	defer r.mu.Unlock()

	w, ok := r.windows[key]
	if !ok || !w.expiresAt.After(now) {
		return limit
	}
	if left := limit - w.count; left > 0 {
		return left
	}
	return 0
}
