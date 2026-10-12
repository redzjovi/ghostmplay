package common

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestLockAcquireRefusesWhileHeld(t *testing.T) {
	l := NewLockService()

	first := l.Acquire("sync:marketplace")
	if first == nil {
		t.Fatal("first Acquire returned nil, want a lock")
	}

	if second := l.Acquire("sync:marketplace"); second != nil {
		t.Error("second Acquire returned a lock while the key was held, want nil")
	}
}

func TestLockIsPerKey(t *testing.T) {
	l := NewLockService()

	if l.Acquire("sync:marketplace") == nil {
		t.Fatal("marketplace lock not acquired")
	}
	// The whole point of per-key locking: the two sync kinds never block each
	// other, so a history scrape is not held up by a marketplace one.
	if l.Acquire("sync:history") == nil {
		t.Error("history lock refused while marketplace was held, want independent keys")
	}
}

func TestLockReleaseFreesTheKey(t *testing.T) {
	l := NewLockService()

	first := l.Acquire("k")
	first.Release()

	if second := l.Acquire("k"); second == nil {
		t.Error("Acquire after Release returned nil, want a lock")
	}
}

func TestLockDoubleReleaseDoesNotStealAnotherHoldersLock(t *testing.T) {
	l := NewLockService()

	first := l.Acquire("k")
	first.Release()

	// Someone else takes the key in between.
	second := l.Acquire("k")
	if second == nil {
		t.Fatal("second holder could not acquire the key")
	}

	// The first holder releases again -- the orchestrator releases in a defer,
	// and a path that already released explicitly would do exactly this.
	first.Release()

	if third := l.Acquire("k"); third != nil {
		third.Release()
		t.Error("a stale handle freed a key another holder owned; two runs could now proceed")
	}
}

func TestLockIsNotReentrant(t *testing.T) {
	l := NewLockService()

	held := l.Acquire("k")
	defer held.Release()

	// Same goroutine, same key. There is no owner tracking here on purpose:
	// reentrancy would let a re-entrant call continue past a guard that
	// believes it has excluded the current holder.
	if again := l.Acquire("k"); again != nil {
		t.Error("Acquire was reentrant, want nil while the key is held")
	}
}

func TestLockConcurrentAcquireHasExactlyOneWinner(t *testing.T) {
	l := NewLockService()

	const goroutines = 64
	var winners atomic.Int32
	var start sync.WaitGroup
	var done sync.WaitGroup

	start.Add(1)
	for range goroutines {
		done.Add(1)
		go func() {
			defer done.Done()
			start.Wait()
			if lock := l.Acquire("contended"); lock != nil {
				winners.Add(1)
			}
		}()
	}

	start.Done()
	done.Wait()

	if got := winners.Load(); got != 1 {
		t.Errorf("%d goroutines acquired the same lock, want exactly 1", got)
	}
}

func TestLockIsHeldReportsState(t *testing.T) {
	l := NewLockService()

	if l.IsHeld("k") {
		t.Error("IsHeld reported a free key as held")
	}
	held := l.Acquire("k")
	defer held.Release()
	if !l.IsHeld("k") {
		t.Error("IsHeld reported a held key as free")
	}
	held.Release()
	if l.IsHeld("k") {
		t.Error("IsHeld still reporting the key after Release")
	}
}

func TestRateLimiterCountsWithinTheBudget(t *testing.T) {
	r := NewRateLimiter()

	for i := 1; i <= 30; i++ {
		if !r.Consume("rl:google:1.2.3.4", 30, 600) {
			t.Fatalf("request %d of 30 was refused, want allowed", i)
		}
	}
}

func TestRateLimiterRefusesOverBudget(t *testing.T) {
	r := NewRateLimiter()

	for i := 0; i < 30; i++ {
		r.Consume("rl:google:1.2.3.4", 30, 600)
	}
	if r.Consume("rl:google:1.2.3.4", 30, 600) {
		t.Error("request 31 of 30 was allowed, want refused")
	}
}

func TestRateLimiterIsPerKey(t *testing.T) {
	r := NewRateLimiter()

	for i := 0; i < 30; i++ {
		r.Consume("rl:google:1.2.3.4", 30, 600)
	}
	if r.Consume("rl:google:1.2.3.4", 30, 600) {
		t.Error("the exhausted key was allowed through")
	}
	// A different IP has its own budget; otherwise one noisy client locks
	// everyone else out.
	if !r.Consume("rl:google:5.6.7.8", 30, 600) {
		t.Error("a second key was refused; the limit is not per key")
	}
}

func TestRateLimiterZeroLimitRefusesImmediately(t *testing.T) {
	r := NewRateLimiter()

	if r.Consume("k", 0, 600) {
		t.Error("a limit of 0 allowed a request through")
	}
}

func TestRateLimiterWindowResets(t *testing.T) {
	r := NewRateLimiter()

	for i := 0; i < 5; i++ {
		r.Consume("k", 5, 600)
	}
	if r.Consume("k", 5, 600) {
		t.Fatal("request 6 of 5 was allowed before the window reset")
	}

	// Rather than sleeping a real window, backdate the entry the way an elapsed
	// window would. It has to move past `now`, not merely shorten: the window is
	// 600 seconds long, so backing it off by a second would leave it comfortably
	// unexpired.
	r.mu.Lock()
	w := r.windows["k"]
	w.expiresAt = time.Now().Add(-time.Second)
	r.windows["k"] = w
	r.mu.Unlock()

	if !r.Consume("k", 5, 600) {
		t.Error("request refused after the window expired, want allowed")
	}
}

func TestRateLimiterEvictsExpiredEntriesOnEveryCall(t *testing.T) {
	r := NewRateLimiter()

	r.Consume("expiring", 1, 0) // a zero-length window is already expired

	r.mu.Lock()
	_, present := r.windows["expiring"]
	r.mu.Unlock()
	if !present {
		t.Fatal("expected the entry to exist before the next Consume")
	}

	r.Consume("unrelated", 1, 600)

	r.mu.Lock()
	_, present = r.windows["expiring"]
	r.mu.Unlock()
	if present {
		t.Error("an expired entry survived an unrelated Consume; the map would grow without bound")
	}
}

func TestRateLimiterConcurrentConsumeIsRaceFree(t *testing.T) {
	r := NewRateLimiter()

	const goroutines = 100
	var allowed atomic.Int32
	var wg sync.WaitGroup

	for range goroutines {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r.Consume("k", 50, 600) {
				allowed.Add(1)
			}
		}()
	}
	wg.Wait()

	if got := allowed.Load(); got != 50 {
		t.Errorf("%d requests allowed concurrently, want exactly 50", got)
	}
}

func TestRateLimiterRemaining(t *testing.T) {
	r := NewRateLimiter()

	if got := r.Remaining("k", 30); got != 30 {
		t.Errorf("Remaining on an unknown key = %d, want 30", got)
	}
	r.Consume("k", 30, 600)
	if got := r.Remaining("k", 30); got != 29 {
		t.Errorf("Remaining after one request = %d, want 29", got)
	}
	for range 40 {
		r.Consume("k", 30, 600)
	}
	if got := r.Remaining("k", 30); got != 0 {
		t.Errorf("Remaining past the limit = %d, want 0", got)
	}
}
