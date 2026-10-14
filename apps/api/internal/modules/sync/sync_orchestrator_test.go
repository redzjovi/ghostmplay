package sync

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sqlc-dev/pqtype"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace"
)

// fakeQuerier is a dbgen.Querier that records writes and serves canned reads.
// Only the methods a test exercises are implemented; anything else panics, which
// is the point -- it fails loudly rather than silently returning zero values.
type fakeQuerier struct {
	// The embedded interface satisfies dbgen.Querier; only the methods below are
	// overridden. Anything else panics if called, which fails loudly rather than
	// silently returning a zero value that could make a test pass for the wrong
	// reason.
	dbgen.Querier

	mu sync.Mutex
	// started / finished record the UpsertSyncRunStarted / Finished calls.
	started  []dbgen.UpsertSyncRunStartedParams
	finished []dbgen.UpsertSyncRunFinishedParams
	// stranded is what MarkStrandedSyncsInterrupted returns.
	stranded []string
	// released records every ReleaseStrandedSync call.
	released []dbgen.ReleaseStrandedSyncParams
	// states is what GetSyncState / ListSyncStates return.
	states map[string]dbgen.SyncState
}

func newFakeQuerier() *fakeQuerier {
	return &fakeQuerier{states: map[string]dbgen.SyncState{}}
}

func (f *fakeQuerier) UpsertSyncRunStarted(_ context.Context, p dbgen.UpsertSyncRunStartedParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started = append(f.started, p)
	return nil
}

func (f *fakeQuerier) UpsertSyncRunFinished(_ context.Context, p dbgen.UpsertSyncRunFinishedParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.finished = append(f.finished, p)
	return nil
}

func (f *fakeQuerier) MarkStrandedSyncsInterrupted(_ context.Context) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stranded, nil
}

func (f *fakeQuerier) GetSyncState(_ context.Context, kind string) (dbgen.SyncState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.states[kind]
	if !ok {
		return dbgen.SyncState{}, sql.ErrNoRows
	}
	return row, nil
}

func (f *fakeQuerier) ListSyncStates(_ context.Context) ([]dbgen.SyncState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]dbgen.SyncState, 0, len(f.states))
	for _, row := range f.states {
		out = append(out, row)
	}
	return out, nil
}

func (f *fakeQuerier) ResetSyncState(_ context.Context, kind string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.states, kind)
	return nil
}

// ReleaseStrandedSync mirrors the query's own guard: it only writes when the row
// is actually set running, and returns ErrNoRows otherwise. Driving it from the
// same fake state as ListSyncStates is what makes a sweeper test honest -- a stub
// that released unconditionally would pass a test that should not exist.
func (f *fakeQuerier) ReleaseStrandedSync(_ context.Context, p dbgen.ReleaseStrandedSyncParams) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.released = append(f.released, p)
	row, ok := f.states[p.Kind]
	if !ok || !row.RunningSince.Valid {
		return "", sql.ErrNoRows
	}
	row.RunningSince = sql.NullTime{}
	row.LastFinishedAt = sql.NullTime{Time: time.Now(), Valid: true}
	row.LastStatus = sql.NullString{String: string(StatusInterrupted), Valid: true}
	row.LastError = p.LastError
	f.states[p.Kind] = row
	return p.Kind, nil
}

// fakeExecutor records what it was asked to run and can be told to fail.
type fakeExecutor struct {
	mu          sync.Mutex
	calls       []string
	historyMode marketplace.HistorySyncMode
	failures    int // number of leading calls that fail transiently
	block       chan struct{}
	clearedKind string
	// panics makes the named call panic instead of returning, so the goroutine's
	// recovery can be tested without a whole scraper to break.
	panics string
}

func (e *fakeExecutor) SyncMarketplace(_ context.Context, _ string, _ marketplace.SyncMode) (Stats, error) {
	e.mu.Lock()
	e.calls = append(e.calls, "marketplace")
	n := len(e.calls)
	block, failures := e.block, e.failures
	if e.panics == "marketplace" {
		e.mu.Unlock()
		panic("scraper exploded")
	}
	e.mu.Unlock()

	if block != nil {
		<-block
	}
	if n <= failures {
		return nil, httpErr{503}
	}
	return Stats{"synced": n}, nil
}

func (e *fakeExecutor) SyncHistory(_ context.Context, mode marketplace.HistorySyncMode) (Stats, error) {
	e.mu.Lock()
	e.calls = append(e.calls, "history")
	e.historyMode = mode
	n := len(e.calls)
	e.mu.Unlock()
	if n == 1 && e.failures > 0 {
		return nil, httpErr{503}
	}
	return Stats{"synced": n}, nil
}

// A history mode the dispatch does not name is not rejected -- it falls through
// to the incremental walk, logs nothing, and returns a normal "done". That is the
// same silent downgrade lib/syncPanel.backfillMode warns the UI about, so the
// mapping is pinned here rather than trusted: a mode added to Mode without a case
// in execute fails this test instead of quietly becoming HistoryLatest.
func TestHistoryModeDispatch(t *testing.T) {
	tests := []struct {
		mode Mode
		want marketplace.HistorySyncMode
	}{
		{ModeLatest, marketplace.HistoryLatest},
		{ModeFull, marketplace.HistoryFull},
		{ModePending, marketplace.HistoryPending},
		{ModeAll, marketplace.HistoryLatest}, // marketplace's backfill; not a history walk
	}

	for _, tc := range tests {
		t.Run(string(tc.mode), func(t *testing.T) {
			q := newFakeQuerier()
			exec := &fakeExecutor{}
			orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())

			if _, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindHistory, Mode: tc.mode}); err != nil {
				t.Fatalf("Enqueue: %v", err)
			}
			orch.Wait(context.Background(), KindHistory)

			exec.mu.Lock()
			got := exec.historyMode
			exec.mu.Unlock()
			if got != tc.want {
				t.Errorf("executor got mode %q, want %q", got, tc.want)
			}
		})
	}
}

// clearedKind records that a clear reached the executor at all. It is set here
// rather than inferred from the returned counts, so a test can assert the
// negative -- that Reset never deletes -- which the counts cannot show.
func (e *fakeExecutor) ClearMarketplace(_ context.Context) (marketplace.ClearResult, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.clearedKind = "marketplace"
	return marketplace.ClearResult{Items: 5, Details: 5}, nil
}

func (e *fakeExecutor) ClearHistory(_ context.Context) (marketplace.HistoryClearResult, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.clearedKind = "history"
	return marketplace.HistoryClearResult{Transfers: 7}, nil
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestEnqueueRunsInBackgroundAndRecords(t *testing.T) {
	q := newFakeQuerier()
	exec := &fakeExecutor{}
	orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())

	res, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace, Mode: ModeLatest})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if res.Deduped {
		t.Error("first Enqueue reported deduped")
	}

	// The run happens in the background; wait for it so the assertions below see
	// the finished write.
	orch.Wait(context.Background(), KindMarketplace)

	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.started) != 1 {
		t.Fatalf("started writes = %d, want 1", len(q.started))
	}
	if !q.started[0].RunningSince.Valid {
		t.Error("started write has no running_since, so the durable lock was never set")
	}
	if len(q.finished) != 1 {
		t.Fatalf("finished writes = %d, want 1", len(q.finished))
	}
	if q.finished[0].LastStatus.String != string(StatusDone) {
		t.Errorf("finished status = %q, want done", q.finished[0].LastStatus.String)
	}
}

func TestEnqueueDedupesWhileInFlight(t *testing.T) {
	q := newFakeQuerier()
	block := make(chan struct{})
	exec := &fakeExecutor{block: block}
	orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())

	if _, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace}); err != nil {
		t.Fatalf("first Enqueue: %v", err)
	}

	// A second enqueue while the first is blocked must join, not start a rival.
	res, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace})
	if err != nil {
		t.Fatalf("second Enqueue: %v", err)
	}
	if !res.Deduped {
		t.Error("second Enqueue while a run is in flight was not deduped")
	}

	close(block)
	orch.Wait(context.Background(), KindMarketplace)

	exec.mu.Lock()
	calls := len(exec.calls)
	exec.mu.Unlock()
	if calls != 1 {
		t.Errorf("executor ran %d times, want exactly 1", calls)
	}
}

func TestEnqueueIsolatesKinds(t *testing.T) {
	// A long marketplace run must not stop a history run from starting. They hold
	// different locks.
	q := newFakeQuerier()
	block := make(chan struct{})
	exec := &fakeExecutor{block: block}
	orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())

	if _, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace}); err != nil {
		t.Fatalf("marketplace Enqueue: %v", err)
	}
	res, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindHistory})
	if err != nil {
		t.Fatalf("history Enqueue: %v", err)
	}
	if res.Deduped {
		t.Error("history was deduped by an in-flight marketplace run; the two kinds are independent")
	}
	close(block)
	orch.Wait(context.Background(), KindMarketplace)
	orch.Wait(context.Background(), KindHistory)
}

func TestRetriesTransientThenSucceeds(t *testing.T) {
	q := newFakeQuerier()
	// One transient failure, then success. The run should still finish "done".
	exec := &fakeExecutor{failures: 1}
	orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())

	if _, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	orch.Wait(context.Background(), KindMarketplace)

	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.finished) != 1 {
		t.Fatalf("finished writes = %d, want 1", len(q.finished))
	}
	if q.finished[0].LastStatus.String != string(StatusDone) {
		t.Errorf("status after one transient failure = %q, want done (it was retried)", q.finished[0].LastStatus.String)
	}
	exec.mu.Lock()
	defer exec.mu.Unlock()
	if len(exec.calls) != 2 {
		t.Errorf("executor ran %d times, want 2 (one failure + one retry)", len(exec.calls))
	}
}

func TestPermanentFailureIsRecordedOnce(t *testing.T) {
	q := newFakeQuerier()
	// A permanent failure is not retried, so the executor runs once.
	exec := &failingExecutor{err: errors.New("permanent failure")}
	orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())

	if _, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	orch.Wait(context.Background(), KindMarketplace)

	exec.mu.Lock()
	calls := len(exec.calls)
	exec.mu.Unlock()
	if calls != 1 {
		t.Errorf("executor ran %d times for a permanent failure, want 1 (no retry)", calls)
	}

	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.finished) != 1 {
		t.Fatalf("finished writes = %d, want 1", len(q.finished))
	}
	if q.finished[0].LastStatus.String != string(StatusFailed) {
		t.Errorf("status = %q, want failed", q.finished[0].LastStatus.String)
	}
	if q.finished[0].LastError.String == "" {
		t.Error("a failed run recorded no error message")
	}
}

type failingExecutor struct {
	mu    sync.Mutex
	calls []string
	err   error
}

func (e *failingExecutor) SyncMarketplace(_ context.Context, _ string, _ marketplace.SyncMode) (Stats, error) {
	e.mu.Lock()
	e.calls = append(e.calls, "marketplace")
	e.mu.Unlock()
	return nil, e.err
}

func (e *failingExecutor) SyncHistory(_ context.Context, _ marketplace.HistorySyncMode) (Stats, error) {
	e.mu.Lock()
	e.calls = append(e.calls, "history")
	e.mu.Unlock()
	return nil, e.err
}

func (e *failingExecutor) ClearMarketplace(context.Context) (marketplace.ClearResult, error) {
	return marketplace.ClearResult{}, nil
}

func (e *failingExecutor) ClearHistory(context.Context) (marketplace.HistoryClearResult, error) {
	return marketplace.HistoryClearResult{}, nil
}

func TestClearRefusesWhileRunning(t *testing.T) {
	q := newFakeQuerier()
	block := make(chan struct{})
	exec := &fakeExecutor{block: block}
	orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())

	if _, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	// The delete would race the run's inserts, so it is refused with a conflict.
	if _, err := orch.Clear(context.Background(), KindMarketplace); err == nil {
		t.Error("Clear succeeded while a run was in flight, want a conflict")
	} else {
		var apiErr *common.Error
		if !errors.As(err, &apiErr) || apiErr.Status != 409 {
			t.Errorf("Clear error = %v, want a 409", err)
		}
	}

	close(block)
	orch.Wait(context.Background(), KindMarketplace)

	// Once the run is done, Clear works.
	if _, err := orch.Clear(context.Background(), KindMarketplace); err != nil {
		t.Errorf("Clear after the run finished: %v", err)
	}
}

func TestClearPayloads(t *testing.T) {
	q := newFakeQuerier()
	orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{}, testLogger())

	res, err := orch.Clear(context.Background(), KindMarketplace)
	if err != nil {
		t.Fatalf("Clear marketplace: %v", err)
	}
	// The admin panel reads deleted.items and deleted.details; the shape has to
	// survive the rewrite.
	deleted, ok := res.Deleted.(marketplace.ClearResult)
	if !ok || deleted.Items != 5 {
		t.Errorf("marketplace clear payload = %#v, want items=5", res.Deleted)
	}

	res, err = orch.Clear(context.Background(), KindHistory)
	if err != nil {
		t.Fatalf("Clear history: %v", err)
	}
	histDeleted, ok := res.Deleted.(marketplace.HistoryClearResult)
	if !ok || histDeleted.Transfers != 7 {
		t.Errorf("history clear payload = %#v, want transfers=7", res.Deleted)
	}
}

func TestRecoverStrandedRuns(t *testing.T) {
	q := newFakeQuerier()
	q.stranded = []string{"marketplace", "history"}
	orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{}, testLogger())

	if err := orch.RecoverStrandedRuns(context.Background()); err != nil {
		t.Fatalf("RecoverStrandedRuns: %v", err)
	}
	// The whole point is that a killed run stops looking "running", so the call
	// must have been made. The specific rows it returns are informational.
}

// A running_since row nobody is clearing is the failure this whole path exists
// for: the panel spins on it forever and every control is disabled.
func TestResetReleasesAStrandedRow(t *testing.T) {
	q := newFakeQuerier()
	q.states["marketplace"] = dbgen.SyncState{
		Kind:         "marketplace",
		RunningSince: sql.NullTime{Time: time.Now().Add(-time.Hour), Valid: true},
		LastStatus:   sql.NullString{String: string(StatusRunning), Valid: true},
	}
	orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{}, testLogger())

	res, err := orch.Reset(context.Background(), KindMarketplace)
	if err != nil {
		t.Fatalf("Reset: %v", err)
	}
	if !res.Reset {
		t.Error("Reset reported nothing to release for a row that was stuck")
	}

	// The row is the thing the panel reads, so it is the thing asserted.
	snap, err := orch.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if snap.Marketplace.Running {
		t.Error("marketplace still reports running after a reset")
	}
	if snap.Marketplace.LastStatus == nil || *snap.Marketplace.LastStatus != StatusInterrupted {
		t.Errorf("lastStatus = %v, want interrupted", snap.Marketplace.LastStatus)
	}
}

// The endpoint has to be safe to call when nothing is stuck, because that is
// what a stale button or a repeated click looks like -- not an error.
func TestResetIsNotAnErrorWhenNothingIsStuck(t *testing.T) {
	q := newFakeQuerier()
	q.states["marketplace"] = dbgen.SyncState{
		Kind:       "marketplace",
		LastStatus: sql.NullString{String: string(StatusDone), Valid: true},
	}
	orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{}, testLogger())

	res, err := orch.Reset(context.Background(), KindMarketplace)
	if err != nil {
		t.Fatalf("Reset on a settled kind: %v", err)
	}
	if res.Reset {
		t.Error("Reset reported a release for a kind that was not running")
	}
}

func TestResetRefusesWhileRunning(t *testing.T) {
	q := newFakeQuerier()
	block := make(chan struct{})
	orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{block: block}, testLogger())

	if _, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	// A live run is not a stuck run. Clearing its row would report a scrape that
	// is still writing as though it had been interrupted.
	if _, err := orch.Reset(context.Background(), KindMarketplace); err == nil {
		t.Error("Reset succeeded while a run was in flight, want a conflict")
	} else {
		var apiErr *common.Error
		if !errors.As(err, &apiErr) || apiErr.Status != 409 {
			t.Errorf("Reset error = %v, want a 409", err)
		}
	}

	close(block)
	orch.Wait(context.Background(), KindMarketplace)
}

// Reset must not delete anything. It shares a kind with Clear, and the two look
// alike from the panel, so the difference is pinned rather than trusted — and the
// second half matters as much as the first: it shows the assertion can fail, so
// the first half is not passing because the fake never records anything.
func TestResetDeletesNoData(t *testing.T) {
	q := newFakeQuerier()
	q.states["history"] = dbgen.SyncState{
		Kind:         "history",
		RunningSince: sql.NullTime{Time: time.Now(), Valid: true},
	}
	exec := &fakeExecutor{}
	orch := NewOrchestrator(q, common.NewLockService(), exec, testLogger())

	if _, err := orch.Reset(context.Background(), KindHistory); err != nil {
		t.Fatalf("Reset: %v", err)
	}

	exec.mu.Lock()
	cleared := exec.clearedKind
	exec.mu.Unlock()
	if cleared != "" {
		t.Errorf("Reset cleared data for %q, want no deletes at all", cleared)
	}

	// The same kind, through the endpoint that does delete.
	if _, err := orch.Clear(context.Background(), KindHistory); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	exec.mu.Lock()
	cleared = exec.clearedKind
	exec.mu.Unlock()
	if cleared != "history" {
		t.Errorf("Clear recorded %q, want history -- so the Reset check above was live", cleared)
	}
}

// A wedged run is the case boot recovery cannot see: the process is alive, so
// nothing reaps the row, and the sweep is what ends it.
func TestReleaseOrphanedRunsReapsOnlyWhatNobodyIsRunning(t *testing.T) {
	block := make(chan struct{})
	q := newFakeQuerier()
	// Marketplace is a genuine live run; history is wedged from an earlier one.
	q.states["history"] = dbgen.SyncState{
		Kind:         "history",
		RunningSince: sql.NullTime{Time: time.Now().Add(-time.Hour), Valid: true},
	}
	orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{block: block}, testLogger())

	if _, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	released, err := orch.ReleaseOrphanedRuns(context.Background())
	if err != nil {
		t.Fatalf("ReleaseOrphanedRuns: %v", err)
	}
	if len(released) != 1 || released[0] != KindHistory {
		t.Fatalf("released = %v, want just history", released)
	}

	// The live run must have survived untouched, or the sweep would be killing
	// the very scrapes it exists to protect. Asserted on the writes rather than
	// on the row: the fake's start write records itself separately and never puts
	// running_since into the state map, so the row cannot show it.
	q.mu.Lock()
	writes := append([]dbgen.ReleaseStrandedSyncParams(nil), q.released...)
	wedged := q.states["history"]
	q.mu.Unlock()

	if len(writes) != 1 || writes[0].Kind != string(KindHistory) {
		t.Errorf("sweep wrote %+v, want only history", writes)
	}
	if wedged.RunningSince.Valid {
		t.Error("history is still marked running after the sweep")
	}

	close(block)
	orch.Wait(context.Background(), KindMarketplace)
}

// The sweep runs every minute forever, so "nothing to do" is the overwhelmingly
// common outcome and must not be reported as a release.
func TestReleaseOrphanedRunsIsQuietWhenSettled(t *testing.T) {
	q := newFakeQuerier()
	q.states["marketplace"] = dbgen.SyncState{
		Kind:       "marketplace",
		LastStatus: sql.NullString{String: string(StatusDone), Valid: true},
	}
	orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{}, testLogger())

	released, err := orch.ReleaseOrphanedRuns(context.Background())
	if err != nil {
		t.Fatalf("ReleaseOrphanedRuns: %v", err)
	}
	if len(released) != 0 {
		t.Errorf("released = %v, want nothing", released)
	}

	// Not even the query: a settled kind is not even a candidate, so this costs
	// one read a minute rather than a read and a write.
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.released) != 0 {
		t.Errorf("the sweep wrote for a settled kind: %+v", q.released)
	}
}

// A panic in the scraper used to take the process down with running_since set,
// which is a stuck panel until the next deploy. The recovery records the failure
// and lets the kind run again.
func TestRunPanicIsRecordedNotPropagated(t *testing.T) {
	q := newFakeQuerier()
	orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{panics: "marketplace"}, testLogger())

	if _, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	// Wait returns once the recovery has run: the outcome is written before the
	// in-flight channel closes, which is the ordering that makes this test a
	// test rather than a race.
	orch.Wait(context.Background(), KindMarketplace)

	q.mu.Lock()
	finished := append([]dbgen.UpsertSyncRunFinishedParams(nil), q.finished...)
	q.mu.Unlock()

	if len(finished) != 1 {
		t.Fatalf("finished writes = %d, want 1 -- a panic recorded nothing", len(finished))
	}
	if finished[0].LastStatus.String != string(StatusFailed) {
		t.Errorf("finished status = %q, want failed", finished[0].LastStatus.String)
	}
	if !strings.Contains(finished[0].LastError.String, "panic") {
		t.Errorf("last_error = %q, want it to say the run panicked", finished[0].LastError.String)
	}

	// The inflight entry has to be gone or the kind could never run again.
	if _, err := orch.Enqueue(context.Background(), EnqueueOptions{Kind: KindMarketplace}); err != nil {
		t.Errorf("Enqueue after a panic: %v", err)
	}
	orch.Wait(context.Background(), KindMarketplace)
}

func TestStatusShapeAlwaysHasBothKinds(t *testing.T) {
	q := newFakeQuerier()
	q.states["marketplace"] = dbgen.SyncState{
		Kind:       "marketplace",
		Mode:       "latest",
		LastStatus: sql.NullString{String: "done", Valid: true},
		LastStats:  pqtype.NullRawMessage{RawMessage: []byte(`{"synced":12}`), Valid: true},
	}
	// No history row at all: the panel must still get a history entry.
	orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{}, testLogger())

	snap, err := orch.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if snap.Marketplace.Kind != KindMarketplace {
		t.Errorf("marketplace kind = %q", snap.Marketplace.Kind)
	}
	if snap.History.Kind != KindHistory {
		t.Errorf("history kind = %q, want it present even with no row", snap.History.Kind)
	}
	if snap.Marketplace.LastSynced == nil || *snap.Marketplace.LastSynced != 12 {
		t.Errorf("marketplace lastSynced = %v, want 12", snap.Marketplace.LastSynced)
	}
	if snap.History.LastSynced != nil {
		t.Errorf("history lastSynced = %v, want nil for a never-run kind", *snap.History.LastSynced)
	}
}

func TestStatusRunningDerivesFromRunningSince(t *testing.T) {
	now := time.Now()
	q := newFakeQuerier()
	q.states["marketplace"] = dbgen.SyncState{
		Kind:         "marketplace",
		RunningSince: sql.NullTime{Time: now, Valid: true},
	}
	orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{}, testLogger())

	snap, _ := orch.Status(context.Background())
	if !snap.Marketplace.Running {
		t.Error("a row with running_since set was not reported as running")
	}
	if snap.Marketplace.RunningSince == nil {
		t.Error("runningSince is nil for a running kind")
	}
}

func TestWithRetryBacksOffAndGivesUp(t *testing.T) {
	attempts := 0
	start := time.Now()
	err := withRetry(context.Background(), "test", testLogger(), func() error {
		attempts++
		return httpErr{503} // always transient
	})
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("withRetry returned nil after always failing")
	}
	if attempts != DefaultRetry.maxAttempts {
		t.Errorf("attempts = %d, want %d", attempts, DefaultRetry.maxAttempts)
	}
	// 2s + 4s of backoff, so anything under six seconds means it did not wait.
	if elapsed < 6*time.Second {
		t.Errorf("backoff took %v, want at least 6s across two retries", elapsed)
	}
}

func TestWithRetryStopsOnCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	attempts := 0
	_ = withRetry(ctx, "test", testLogger(), func() error {
		attempts++
		return httpErr{503}
	})
	// A cancelled context must not consume the retry budget.
	if attempts > 1 {
		t.Errorf("attempts = %d on a cancelled context, want at most 1", attempts)
	}
}
