package sync

import (
	"context"
	"log/slog"

	"github.com/robfig/cron/v3"

	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace"
)

// ExecutorAdapter turns the marketplace services into the Executor the
// orchestrator sees.
//
// It exists so the orchestrator does not depend on the marketplace package's
// concrete services: the orchestrator's job is ordering, locking and recording,
// and this is the one place that knows what the work actually is.
type ExecutorAdapter struct {
	marketplace *marketplace.MarketplaceService
	history     *marketplace.HistoryService
	sync        *marketplace.SyncService
	historySync *marketplace.HistorySyncService
	log         *slog.Logger
}

// NewExecutorAdapter wires the adapter.
func NewExecutorAdapter(
	marketplaceSvc *marketplace.MarketplaceService,
	historySvc *marketplace.HistoryService,
	syncSvc *marketplace.SyncService,
	historySyncSvc *marketplace.HistorySyncService,
	log *slog.Logger,
) *ExecutorAdapter {
	return &ExecutorAdapter{
		marketplace: marketplaceSvc,
		history:     historySvc,
		sync:        syncSvc,
		historySync: historySyncSvc,
		log:         log,
	}
}

// SyncMarketplace scrapes listings.
func (a *ExecutorAdapter) SyncMarketplace(ctx context.Context, itemName string, mode marketplace.SyncMode) (Stats, error) {
	res, err := a.sync.Refresh(ctx, itemName, mode)
	if err != nil {
		return nil, err
	}
	return Stats{"synced": res.Synced}, nil
}

// SyncHistory fills the ledger, incrementally or in full.
func (a *ExecutorAdapter) SyncHistory(ctx context.Context, full bool) (Stats, error) {
	var (
		res marketplace.HistorySyncResult
		err error
	)
	if full {
		res, err = a.historySync.Backfill(ctx)
	} else {
		res, err = a.historySync.RefreshLatest(ctx)
	}
	if err != nil {
		return nil, err
	}

	stats := Stats{
		"synced":     res.Synced,
		"total":      res.Total,
		"enriched":   res.Enriched,
		"claimed":    res.Claimed,
		"skipped":    res.Skipped,
		"soldMarked": res.SoldMarked,
	}
	if full {
		stats["pages"] = res.Pages
	}
	return stats, nil
}

// ClearMarketplace deletes every listing and its detail blob.
func (a *ExecutorAdapter) ClearMarketplace(ctx context.Context) (marketplace.ClearResult, error) {
	return a.marketplace.ClearAll(ctx)
}

// ClearHistory deletes every transfer. Users are left alone.
func (a *ExecutorAdapter) ClearHistory(ctx context.Context) (marketplace.HistoryClearResult, error) {
	return a.history.ClearAll(ctx)
}

// StartScheduler begins the per-minute cron and returns a stop function.
//
// robfig/cron runs each job in its own goroutine, so a slow run cannot delay the
// next tick. That matters here because the orchestrator's lock is what stops two
// runs overlapping, not the scheduler: a job that fired again while the previous
// one was still walking would be deduped, which is the correct behaviour and
// costs nothing.
func StartScheduler(scheduler *Scheduler, log *slog.Logger) (func(), error) {
	c := cron.New()

	if _, err := c.AddFunc(CronSchedule, func() {
		scheduler.RunLatest(context.Background())
	}); err != nil {
		return nil, err
	}

	c.Start()
	log.Info("sync scheduler started", "schedule", CronSchedule)

	// c.Stop() returns a context that is done once every running job has
	// finished. Waiting on it means a deploy waits for an in-progress run rather
	// than cutting it off mid-write -- and a cut-off run would be recovered as
	// "interrupted" on the next boot, which is correct but noisier.
	return func() { <-c.Stop().Done() }, nil
}
