package sync

import (
	"context"
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

func (e *recordingExecutor) SyncHistory(_ context.Context, _ bool) (Stats, error) {
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

var _ = dbgen.SyncState{}
