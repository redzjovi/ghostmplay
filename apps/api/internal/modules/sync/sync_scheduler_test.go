package sync

import (
	"context"
	"database/sql"
	"sync"
	"testing"
	"time"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace"
)

// recordingExecutor captures the order kinds were run in and whether each one
// finished before the next began.
type recordingExecutor struct {
	mu    sync.Mutex
	order []string
	// overlapping records whether a kind started while another was still
	// running. It must always be false.
	overlapping bool
	active      int
	block       chan struct{}
}

func (e *recordingExecutor) begin(kind string) {
	e.mu.Lock()
	e.order = append(e.order, kind)
	if e.active > 0 {
		e.overlapping = true
	}
	e.active++
	e.mu.Unlock()

	if e.block != nil {
		<-e.block
	}

	e.mu.Lock()
	e.active--
	e.mu.Unlock()
}

func (e *recordingExecutor) SyncMarketplace(_ context.Context, _ string, _ marketplace.SyncMode) (Stats, error) {
	e.begin("marketplace")
	return Stats{"synced": 1}, nil
}

func (e *recordingExecutor) SyncHistory(_ context.Context, _ marketplace.HistorySyncMode) (Stats, error) {
	e.begin("history")
	return Stats{"synced": 1}, nil
}

func (e *recordingExecutor) ClearMarketplace(context.Context) (marketplace.ClearResult, error) {
	return marketplace.ClearResult{}, nil
}

func (e *recordingExecutor) ClearHistory(context.Context) (marketplace.HistoryClearResult, error) {
	return marketplace.HistoryClearResult{}, nil
}

// The scheduler visits marketplace before history and waits for each.
//
// The order is not cosmetic: history's last step re-derives sold state from the
// transfer ledger against the listings table. Running it while a marketplace
// scrape is still writing that table reconciles against a moving target, and
// produces marks the next run immediately undoes.
func TestSchedulerRunsMarketplaceBeforeHistoryAndWaits(t *testing.T) {
	exec := &recordingExecutor{}
	orch := NewOrchestrator(newFakeQuerier(), common.NewLockService(), exec, testLogger())
	scheduler := NewScheduler(orch, testLogger())

	scheduler.RunLatest(context.Background())

	exec.mu.Lock()
	defer exec.mu.Unlock()

	if len(exec.order) != 2 {
		t.Fatalf("executor ran %v, want exactly [marketplace history]", exec.order)
	}
	if exec.order[0] != "marketplace" || exec.order[1] != "history" {
		t.Errorf("order = %v, want marketplace then history", exec.order)
	}
	if exec.overlapping {
		t.Error("history started while a marketplace sync was still running")
	}
}

// A run already in flight when the tick arrives must be joined, not duplicated,
// and the scheduler must still wait for it before touching history.
func TestSchedulerJoinsAnInFlightRun(t *testing.T) {
	q := newFakeQuerier()
	block := make(chan struct{})
	exec := &fakeExecutor{block: block}
	orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())

	// A marketplace run is started but will not finish yet.
	if _, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	done := make(chan struct{})
	go func() {
		NewScheduler(orch, testLogger()).RunLatest(context.Background())
		close(done)
	}()

	// The scheduler is blocked waiting on the in-flight marketplace run, so
	// history must not have started yet.
	time.Sleep(100 * time.Millisecond)
	exec.mu.Lock()
	startedHistory := false
	for _, c := range exec.calls {
		if c == "history" {
			startedHistory = true
		}
	}
	exec.mu.Unlock()
	if startedHistory {
		t.Error("history started while a marketplace run was still in flight")
	}

	close(block)
	<-done

	exec.mu.Lock()
	defer exec.mu.Unlock()
	marketplaceRuns := 0
	for _, c := range exec.calls {
		if c == "marketplace" {
			marketplaceRuns++
		}
	}
	// One for the manual enqueue plus one for the scheduler would be two only if
	// the scheduler started its own; joining means it did not.
	if marketplaceRuns != 1 {
		t.Errorf("marketplace ran %d times, want 1 (the scheduler joined the in-flight run)", marketplaceRuns)
	}
}

// The pending re-check is due-or-not as a function of the watermark, and every
// boundary is pinned: this is the whole contract of RunPendingIfDue, and getting
// it wrong either hammers the upstream on every tick or skips the re-check
// indefinitely.
//
// The clock is injected rather than read, so "exactly 24h" is a case rather than
// something that depends on how long the test took to run.
func TestRunPendingIfDue(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	hoursAgo := func(h float64) sql.NullTime {
		return sql.NullTime{Time: now.Add(-time.Duration(h * float64(time.Hour))), Valid: true}
	}

	tests := []struct {
		name      string
		watermark sql.NullTime
		// wantRun is whether a history pending re-check should have started.
		wantRun bool
	}{
		{"never run is overdue", sql.NullTime{}, true},
		{"a quarter of an interval is not due", hoursAgo(6), false},
		{"almost an interval is not due", hoursAgo(23), false},
		// >= and not >, so a job that runs exactly on time does not then wait
		// another full interval because of a rounding hair.
		{"exactly one interval is due", hoursAgo(24), true},
		{"past one interval is due", hoursAgo(25), true},
		{"far past is due", hoursAgo(72), true},
		// A clock that moved backwards -- NTP, a hand-set host -- must not park
		// the job for longer than one interval.
		{"a future watermark is due", hoursAgo(-1), true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q := newFakeQuerier()
			q.states[string(KindHistory)] = dbgen.SyncState{
				Kind:          string(KindHistory),
				LastPendingAt: tc.watermark,
			}
			exec := &fakeExecutor{}
			orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())
			scheduler := NewScheduler(orch, testLogger())
			scheduler.now = func() time.Time { return now }

			scheduler.RunPendingIfDue(context.Background())
			orch.Wait(context.Background(), KindHistory)

			exec.mu.Lock()
			started := false
			for _, c := range exec.calls {
				if c == "history" {
					started = true
				}
			}
			gotMode := exec.historyMode
			exec.mu.Unlock()

			if started != tc.wantRun {
				t.Fatalf("pending re-check started = %v, want %v", started, tc.wantRun)
			}
			if tc.wantRun && gotMode != marketplace.HistoryPending {
				t.Errorf("executor got mode %q, want pending", gotMode)
			}
		})
	}
}

// A missing row is the same as a missing watermark, not an error: the re-check
// has never run, so it is due.
func TestRunPendingIfDueWithoutASyncStateRow(t *testing.T) {
	q := newFakeQuerier() // no states at all, so GetSyncState returns ErrNoRows
	exec := &fakeExecutor{}
	orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())

	NewScheduler(orch, testLogger()).RunPendingIfDue(context.Background())
	orch.Wait(context.Background(), KindHistory)

	exec.mu.Lock()
	defer exec.mu.Unlock()
	for _, c := range exec.calls {
		if c == "history" {
			return
		}
	}
	t.Error("a missing sync_state row was treated as 'not due' rather than 'never run'")
}

// Only a pending run may move the watermark. It is written by the same statement
// that records the outcome, so an incremental run -- which the cron fires every
// minute -- must leave it alone or the re-check would never come due again.
func TestFinishRecordsTheModeSoOnlyPendingMovesTheWatermark(t *testing.T) {
	q := newFakeQuerier()
	exec := &fakeExecutor{}
	orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())

	if _, err := orch.Enqueue(context.Background(), EnqueueOptions{
		Kind: KindHistory, Mode: ModeLatest,
	}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	orch.Wait(context.Background(), KindHistory)

	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.finished) != 1 {
		t.Fatalf("finished writes = %d, want 1", len(q.finished))
	}
	if got := q.finished[0].Mode; got != string(ModeLatest) {
		t.Errorf("finished write recorded mode %q, want %q", got, ModeLatest)
	}
}

var _ = dbgen.SyncState{}
