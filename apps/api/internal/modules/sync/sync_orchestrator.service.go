package sync

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/sqlc-dev/pqtype"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace"
)

// Kind is which half of the data is being synced.
type Kind string

// The two kinds, in the order the scheduler visits them.
const (
	KindMarketplace Kind = "marketplace"
	KindHistory     Kind = "history"
)

// AllKinds is the scheduler's visit order.
//
// Marketplace runs first and is awaited to completion before history starts.
// The order matters: history's last step re-derives sold state from the ledger
// against the listings, so running it while a marketplace scrape is mid-flight
// would reconcile against a table that is still changing.
var AllKinds = []Kind{KindMarketplace, KindHistory}

// Mode is how far a run walks.
type Mode string

const (
	// ModeLatest: the cheap path, run every minute.
	ModeLatest Mode = "latest"
	// ModeAll: walk the whole marketplace.
	ModeAll Mode = "all"
	// ModeFull: walk the whole transfer ledger. The most expensive operation in
	// the app.
	ModeFull Mode = "full"
	// ModePending: walk the whole transfer ledger but skip transfers already
	// recorded claimed. Same page walk as ModeFull, a fraction of the upstream
	// requests, and it never revisits a claimed row -- so ModeFull is still the
	// way to correct one.
	ModePending Mode = "pending"
)

// Status is a run's outcome.
type Status string

const (
	StatusRunning Status = "running"
	StatusDone    Status = "done"
	StatusFailed  Status = "failed"
	// StatusInterrupted means a run died with the lock held -- the container
	// was replaced, or it was stopped mid-run.
	StatusInterrupted Status = "interrupted"
)

// Stats is the per-kind result payload, stored as jsonb and rendered by the
// admin panel. Fields differ per kind, which is why it is a free-form map
// rather than a struct: the panel reads what it recognises.
type Stats map[string]any

// Executor runs one kind of sync, and clears one kind's data.
//
// The orchestrator does not know how any of it works; it knows what to run, when
// to refuse to run it, and what to record afterwards. Keeping the clears on the
// same interface as the runs is what lets Clear refuse while a run is in flight
// -- the two have to agree on what "in progress" means, and there is one lock.
type Executor interface {
	// SyncMarketplace scrapes listings.
	SyncMarketplace(ctx context.Context, itemName string, mode marketplace.SyncMode) (Stats, error)
	// SyncHistory fills the transfer ledger: incrementally, in full, or in full
	// while skipping the transfers already recorded claimed.
	SyncHistory(ctx context.Context, mode marketplace.HistorySyncMode) (Stats, error)
	// ClearMarketplace deletes every listing and its detail blob.
	ClearMarketplace(ctx context.Context) (marketplace.ClearResult, error)
	// ClearHistory deletes every transfer. Users are left alone.
	ClearHistory(ctx context.Context) (marketplace.HistoryClearResult, error)
}

// Orchestrator serialises and records sync runs.
//
// Two things prevent a duplicate scrape. In memory, an inflight map keyed by
// kind. On disk, a running_since column that survives a restart. The first is
// fast and the second is durable, and the second is what makes a container that
// was killed mid-run recover rather than wedge.
type Orchestrator struct {
	queries  dbgen.Querier
	locks    *common.LockService
	executor Executor
	log      *slog.Logger

	mu       sync.Mutex
	inflight map[Kind]chan struct{}
}

// NewOrchestrator builds the orchestrator.
func NewOrchestrator(queries dbgen.Querier, locks *common.LockService, executor Executor, log *slog.Logger) *Orchestrator {
	return &Orchestrator{
		queries:  queries,
		locks:    locks,
		executor: executor,
		log:      log,
		inflight: make(map[Kind]chan struct{}),
	}
}

// EnqueueOptions is one request to start a run.
type EnqueueOptions struct {
	Kind Kind
	Mode Mode
	// ItemName narrows a marketplace scrape to one listing. Ignored by history.
	ItemName string
}

// EnqueueResult is what the admin endpoint returns immediately.
//
// A run is started in the background and never awaited by the request that asked
// for it. A backfill takes minutes; holding a request open for it would tie up
// whatever the client has and let a deploy kill it halfway.
type EnqueueResult struct {
	Deduped      bool   `json:"deduped"`
	Kind         Kind   `json:"kind"`
	Mode         Mode   `json:"mode"`
	RunningSince string `json:"runningSince"`
}

// Enqueue starts a run, or joins one already in progress.
func (o *Orchestrator) Enqueue(ctx context.Context, opts EnqueueOptions) (EnqueueResult, error) {
	if opts.Mode == "" {
		opts.Mode = ModeLatest
	}

	// The inflight map is checked first because it is the cheaper and more
	// accurate signal: it is set by the goroutine that actually owns the run.
	o.mu.Lock()
	if _, running := o.inflight[opts.Kind]; running {
		o.mu.Unlock()
		o.log.Info("joining an in-flight sync", "kind", opts.Kind)
		return o.dedupedResult(ctx, opts)
	}
	o.mu.Unlock()

	// The lock is the second guard, and it covers the window between the check
	// above and the moment this goroutine registers itself -- a window two
	// concurrent requests can both be inside.
	lock := o.locks.Acquire(lockKey(opts.Kind))
	if lock == nil {
		o.log.Info("lock already held, joining that run", "kind", opts.Kind)
		return o.dedupedResult(ctx, opts)
	}

	startedAt := time.Now()

	// Registered before anything that can yield, so a second request arriving
	// in the next few lines sees this run rather than racing it.
	done := make(chan struct{})
	o.mu.Lock()
	o.inflight[opts.Kind] = done
	o.mu.Unlock()

	if err := o.queries.UpsertSyncRunStarted(ctx, dbgen.UpsertSyncRunStartedParams{
		Kind:         string(opts.Kind),
		Mode:         string(opts.Mode),
		RunningSince: pgTime(startedAt),
	}); err != nil {
		o.clearInflight(opts.Kind, done)
		lock.Release()
		return EnqueueResult{}, fmt.Errorf("record sync start: %w", err)
	}

	go func() {
		defer close(done)
		o.run(context.WithoutCancel(ctx), opts, lock)
	}()

	return EnqueueResult{
		Deduped:      false,
		Kind:         opts.Kind,
		Mode:         opts.Mode,
		RunningSince: isoMillis(startedAt),
	}, nil
}

// dedupedResult reports that the caller joined a run rather than starting one.
func (o *Orchestrator) dedupedResult(ctx context.Context, opts EnqueueOptions) (EnqueueResult, error) {
	return EnqueueResult{
		Deduped:      true,
		Kind:         opts.Kind,
		Mode:         opts.Mode,
		RunningSince: o.runningSince(ctx, opts.Kind),
	}, nil
}

// run executes one run and records its outcome.
//
// The lock is released in a defer whatever happens, and the inflight entry is
// cleared alongside it. Between those two the run is always discoverable: a
// crash in the middle leaves running_since set in the database, which is what
// RecoverStrandedRuns looks for on the next boot.
func (o *Orchestrator) run(ctx context.Context, opts EnqueueOptions, lock common.Lock) {
	defer lock.Release()

	started := time.Now()
	o.log.Info("running sync", "kind", opts.Kind, "mode", opts.Mode)

	stats, err := o.execute(ctx, opts)
	elapsed := time.Since(started)

	if err != nil {
		// A failure of the upstream is a different thing from a failure of this
		// app, and the log line has to say which. During an upstream outage the
		// only evidence is this line, so it carries the endpoint and whatever the
		// upstream said rather than only our own summary of it.
		attrs := []any{
			"kind", opts.Kind, "mode", opts.Mode,
			"duration", elapsed.String(),
		}
		if up, ok := upstreamCause(err); ok {
			attrs = append(attrs,
				"cause", "upstream",
				"upstream_status", up.Status,
				"upstream_endpoint", up.Op,
				"upstream_said", up.Message,
			)
		} else {
			attrs = append(attrs, "cause", "internal")
		}
		attrs = append(attrs, "error", describeError(err))

		o.log.Error("sync failed", attrs...)
		o.finish(ctx, opts.Kind, opts.Mode, StatusFailed, nil, describeError(err))
		return
	}

	o.log.Info("sync done", "kind", opts.Kind, "mode", opts.Mode,
		"duration", elapsed.String(), "stats", stats)
	o.finish(ctx, opts.Kind, opts.Mode, StatusDone, stats, "")
}

// execute dispatches to the right scrape, under the retry policy.
func (o *Orchestrator) execute(ctx context.Context, opts EnqueueOptions) (Stats, error) {
	label := fmt.Sprintf("sync %s/%s", opts.Kind, opts.Mode)

	var stats Stats
	err := withRetry(ctx, label, o.log, func() error {
		var err error
		switch opts.Kind {
		case KindMarketplace:
			// "all" is the only marketplace mode that walks to the end. There is
			// no marketplace equivalent of a full history backfill: the upstream
			// listing count is not trustworthy enough to walk against, so `all`
			// simply terminates on the empty page at the end.
			mode := marketplace.SyncLatest
			if opts.Mode == ModeAll {
				mode = marketplace.SyncAll
			}
			stats, err = o.executor.SyncMarketplace(ctx, opts.ItemName, mode)
		case KindHistory:
			// Spelled out rather than passed through, because a mode this table
			// does not name has to land on the incremental walk -- the same silent
			// downgrade lib/syncPanel.backfillMode exists to warn the UI about.
			historyMode := marketplace.HistoryLatest
			switch opts.Mode {
			case ModeFull:
				historyMode = marketplace.HistoryFull
			case ModePending:
				historyMode = marketplace.HistoryPending
			}
			stats, err = o.executor.SyncHistory(ctx, historyMode)
		default:
			err = fmt.Errorf("unknown sync kind %q", opts.Kind)
		}
		return err
	})

	if err != nil {
		return nil, err
	}
	if stats == nil {
		stats = Stats{}
	}
	stats["mode"] = string(opts.Mode)
	return stats, nil
}

// finish records a terminal outcome.
//
// mode is threaded in rather than re-read because the pending watermark is
// written here and only a pending run may move it. UpsertSyncRunFinished makes
// that decision itself, so there is no call site that can forget to pass the mode.
func (o *Orchestrator) finish(ctx context.Context, kind Kind, mode Mode, status Status, stats Stats, errMsg string) {
	defer o.clearInflight(kind, nil)

	// last_stats is nullable jsonb. A failed run stores null rather than an
	// empty object, so the panel can tell "this run produced nothing" from "this
	// run never got far enough to have stats".
	var statsJSON pqtype.NullRawMessage
	if stats != nil {
		if b, err := json.Marshal(stats); err == nil {
			statsJSON = pqtype.NullRawMessage{RawMessage: b, Valid: true}
		}
	}

	// A failure to record the outcome must not take the process down, and it must
	// not leave the inflight entry stuck: the run really is over either way.
	if err := o.queries.UpsertSyncRunFinished(ctx, dbgen.UpsertSyncRunFinishedParams{
		Kind:           string(kind),
		Mode:           string(mode),
		LastFinishedAt: pgTime(time.Now()),
		LastStatus:     sql.NullString{String: string(status), Valid: true},
		LastStats:      statsJSON,
		LastError:      nullableString(errMsg),
	}); err != nil {
		o.log.Error("could not record the sync outcome", "kind", kind, "status", status, "error", err)
	}
}

// Settled returns a channel closed when the current run of a kind finishes, or
// nil when none is in flight.
func (o *Orchestrator) Settled(kind Kind) <-chan struct{} {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.inflight[kind]
}

// Wait blocks until the current run of a kind finishes. Returns immediately when
// none is in flight.
func (o *Orchestrator) Wait(ctx context.Context, kind Kind) {
	done := o.Settled(kind)
	if done == nil {
		return
	}
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// clearInflight removes an entry if it is still the one registered.
func (o *Orchestrator) clearInflight(kind Kind, done chan struct{}) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if done != nil && o.inflight[kind] != done {
		return
	}
	delete(o.inflight, kind)
}

// runningSince reads the durable start time for a kind.
func (o *Orchestrator) runningSince(ctx context.Context, kind Kind) string {
	state, err := o.queries.GetSyncState(ctx, string(kind))
	if err != nil || !state.RunningSince.Valid {
		return ""
	}
	return isoMillis(state.RunningSince.Time)
}

// RecoverStrandedRuns marks runs that died holding the lock.
//
// run() holds the lock in a defer. A process that is killed -- the container is
// replaced mid-run, or the host reboots -- never runs its defers, and the
// in-memory lock dies with it. What survives is running_since, which is exactly
// what this looks for.
//
// Without this, a killed run leaves the panel showing a sync that is still going,
// with nothing behind it, until somebody notices.
func (o *Orchestrator) RecoverStrandedRuns(ctx context.Context) error {
	stranded, err := o.queries.MarkStrandedSyncsInterrupted(ctx)
	if err != nil {
		return fmt.Errorf("mark stranded syncs: %w", err)
	}
	if len(stranded) > 0 {
		o.log.Warn("marked stranded syncs from a previous run", "count", len(stranded))
	}
	return nil
}

// ClearResult is what a "clear all" removed.
type ClearResult struct {
	Kind    Kind `json:"kind"`
	Deleted any  `json:"deleted"`
}

// Clear deletes a kind's data and resets its state.
//
// Refused while a run is in progress. Without the check the delete would race
// the scrape's inserts and leave the table in a state neither the ledger nor the
// next run can explain.
func (o *Orchestrator) Clear(ctx context.Context, kind Kind) (ClearResult, error) {
	if o.Settled(kind) != nil {
		return ClearResult{}, common.Conflict(fmt.Sprintf("A %s sync is in progress", kind))
	}

	lock := o.locks.Acquire(lockKey(kind))
	if lock == nil {
		return ClearResult{}, common.Conflict(fmt.Sprintf("A %s sync is in progress", kind))
	}
	defer lock.Release()

	var deleted any
	switch kind {
	case KindMarketplace:
		res, err := o.executor.ClearMarketplace(ctx)
		if err != nil {
			return ClearResult{}, fmt.Errorf("clear marketplace data: %w", err)
		}
		deleted = res
	case KindHistory:
		res, err := o.executor.ClearHistory(ctx)
		if err != nil {
			return ClearResult{}, fmt.Errorf("clear history data: %w", err)
		}
		deleted = res
	default:
		return ClearResult{}, common.BadRequest(fmt.Sprintf("Unknown sync kind %q", kind))
	}

	if err := o.queries.ResetSyncState(ctx, string(kind)); err != nil {
		return ClearResult{}, fmt.Errorf("reset sync state: %w", err)
	}

	o.log.Warn("cleared sync data", "kind", kind, "deleted", deleted)
	return ClearResult{Kind: kind, Deleted: deleted}, nil
}
