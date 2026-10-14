package sync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/redzjovi/ghostmplay/apps/api/internal/models"
)

func lockKey(kind Kind) string { return "sync:" + string(kind) }

func nullableString(v string) sql.NullString {
	if v == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: v, Valid: true}
}

func pgTime(t time.Time) sql.NullTime {
	return sql.NullTime{Time: t, Valid: true}
}

// isoMillis renders a timestamp the way the JavaScript implementation did, so
// the admin panel reads the same string it always has.
func isoMillis(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return models.ISO(t)
}

// KindStatus is one kind's state, as the admin panel sees it.
type KindStatus struct {
	Kind Kind `json:"kind"`
	// Running is derived from running_since rather than being stored: the
	// column being non-null IS the lock, so a separate flag could disagree with
	// it.
	Running        bool    `json:"running"`
	RunningSince   *string `json:"runningSince"`
	Mode           *Mode   `json:"mode"`
	LastStatus     *Status `json:"lastStatus"`
	LastFinishedAt *string `json:"lastFinishedAt"`
	// LastSynced is the headline number lifted out of the stats blob. The panel
	// shows it next to the kind name and nothing else reads it.
	LastSynced *int64          `json:"lastSynced"`
	LastStats  json.RawMessage `json:"lastStats"`
	LastError  *string         `json:"lastError"`
}

// StatusSnapshot is the whole panel's state.
//
// Both kinds are always present even when their row is missing, so the panel
// renders a fixed shape rather than having to handle a kind appearing.
//
// CronEnabled is deployment configuration rather than a kind's state, and it is
// here rather than on a separate endpoint because the list views already fetch
// this one: it is what decides whether they offer a "Sync Latest" button, since
// with the scheduler running the minute job already does that job. The endpoint
// is admin-guarded, so a non-admin never receives it and never learns either way.
type StatusSnapshot struct {
	Marketplace KindStatus `json:"marketplace"`
	History     KindStatus `json:"history"`
	CronEnabled bool       `json:"cronEnabled"`
}

// Status reads the current state of both kinds.
func (o *Orchestrator) Status(ctx context.Context) (StatusSnapshot, error) {
	rows, err := o.queries.ListSyncStates(ctx)
	if err != nil {
		return StatusSnapshot{}, err
	}

	byKind := make(map[Kind]dbgen.SyncState, len(rows))
	for _, row := range rows {
		byKind[Kind(row.Kind)] = row
	}

	return StatusSnapshot{
		Marketplace: kindStatus(KindMarketplace, byKind[KindMarketplace]),
		History:     kindStatus(KindHistory, byKind[KindHistory]),
	}, nil
}

func kindStatus(kind Kind, row dbgen.SyncState) KindStatus {
	out := KindStatus{Kind: kind}

	// A missing row means a kind that has never run. It is still reported, with
	// every field empty, so the panel has something stable to render.
	if row.Kind == "" {
		return out
	}

	if row.RunningSince.Valid {
		out.Running = true
		s := models.ISO(row.RunningSince.Time)
		out.RunningSince = &s
	}
	if row.Mode != "" {
		m := Mode(row.Mode)
		out.Mode = &m
	}
	if row.LastStatus.Valid && row.LastStatus.String != "" {
		st := Status(row.LastStatus.String)
		out.LastStatus = &st
	}
	if row.LastFinishedAt.Valid {
		s := models.ISO(row.LastFinishedAt.Time)
		out.LastFinishedAt = &s
	}
	if row.LastError.Valid && row.LastError.String != "" {
		s := row.LastError.String
		out.LastError = &s
	}
	if row.LastStats.Valid && len(row.LastStats.RawMessage) > 0 {
		out.LastStats = row.LastStats.RawMessage

		var stats Stats
		if err := json.Unmarshal(row.LastStats.RawMessage, &stats); err == nil {
			if n, ok := stats["synced"].(float64); ok {
				v := int64(n)
				out.LastSynced = &v
			}
		}
	}
	return out
}

// LastPendingRun reports when the history pending re-check last finished, and
// whether it ever has.
//
// Its own column, not last_finished_at: the incremental cron rewrites that every
// minute and takes the mode with it, so it answers "when did anything last run"
// and can never answer this. A null watermark means the re-check has never
// happened, which the caller reads as due rather than as an error.
func (o *Orchestrator) LastPendingRun(ctx context.Context) (time.Time, bool, error) {
	row, err := o.queries.GetSyncState(ctx, string(KindHistory))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return time.Time{}, false, nil
		}
		return time.Time{}, false, err
	}
	if !row.LastPendingAt.Valid {
		return time.Time{}, false, nil
	}
	return row.LastPendingAt.Time, true, nil
}

// Scheduler runs the incremental sync on a timer.
type Scheduler struct {
	orchestrator *Orchestrator
	log          *slog.Logger
	now          func() time.Time
}

// NewScheduler builds the scheduler.
func NewScheduler(orchestrator *Orchestrator, log *slog.Logger) *Scheduler {
	return &Scheduler{orchestrator: orchestrator, log: log, now: time.Now}
}

// RunLatest performs one incremental pass over both kinds, in order.
//
// Marketplace first, awaited to completion, then history. The order is not
// incidental: history's last step re-derives sold state from the ledger against
// the listings table, and reconciling against a table a marketplace scrape is
// still writing is a race that produces marks that the next run immediately
// undoes.
//
// Each kind is awaited even when its Enqueue was deduped. Joining an in-flight
// run and then walking on would let history reconcile against a marketplace
// scrape that is still going.
func (s *Scheduler) RunLatest(ctx context.Context) {
	for _, kind := range AllKinds {
		result, err := s.orchestrator.Enqueue(ctx, EnqueueOptions{Kind: kind, Mode: ModeLatest})
		if err != nil {
			s.log.Error("cron sync failed to start", "kind", kind, "error", describeError(err))
			continue
		}
		if !result.Deduped {
			s.log.Info("cron started an incremental sync", "kind", kind)
		}
		s.orchestrator.Wait(ctx, kind)
	}
}

// CronSchedule is the cron's expression: the top of every minute.
//
// Minute granularity is what the upstream's volume supports. The incremental
// path fetches one page of listings and one page of transfers, so running more
// often than that would mostly re-fetch the page it already has.
const CronSchedule = "@every 1m"

// The pending re-check's two constants.
//
// A due-check ticker rather than a cron expression, because the requirement is
// "24 hours since the last pending run" and only a stored watermark can answer
// that. Both obvious alternatives are wrong: `@every 24h` is relative to when the
// process started, so it resets on every deploy and never fires at all on a
// container redeployed more often than daily, and a wall-clock `0 0 * * *` would
// ignore the last run entirely. Reading the watermark on a short ticker is also
// why this is not a cron.Schedule: Next(t) takes no context and returns no error,
// which is the wrong shape for a query.
//
// The ticker is coarse on purpose. The work is measured in hours when it is due
// at all, so 15 minutes of granularity costs 96 single-row lookups a day --
// almost all of which do nothing -- and buys the ability to notice a redeploy.
const (
	PendingDueCheckSchedule = "@every 15m"
	PendingInterval         = 24 * time.Hour
)

// SweepSchedule is how often a row claiming a run this process is not making is
// reaped.
//
// The same interval as the scrape, which is a coincidence of intent rather than
// convenience: the thing being swept is what the scrape writes and fails to
// clear, so looking for it at the scrape's cadence costs one extra two-row
// query a minute and finds a failure within a minute of it happening.
const SweepSchedule = "@every 1m"

// ReleaseOrphanedRuns is the scheduler's entry point for the sweep.
//
// Like RunPendingIfDue it does not wait for anything -- there is no run to wait
// for by definition -- and a failure is logged rather than returned, because a
// cron job that cannot report is still better than one that stops.
func (s *Scheduler) ReleaseOrphanedRuns(ctx context.Context) {
	if _, err := s.orchestrator.ReleaseOrphanedRuns(ctx); err != nil {
		s.log.Error("stranded sync sweep failed", "error", describeError(err))
	}
}

// RunPendingIfDue starts a history pending re-check when one is due.
//
// "Due" is a function of the watermark, not of the clock, so this is safe to call
// on every tick: almost every call reads one row and returns.
//
// A watermark of null counts as due. The re-check has never run, and a re-check
// that has not happened yet is overdue by any interval.
//
// Unlike RunLatest this does not wait. It is on a 15-minute ticker, so a run that
// could not start now is retried on a later tick rather than blocking the ticker
// for however long the scrape takes -- and because a failed start does not move
// the watermark, "could not start" stays due instead of costing a whole day.
func (s *Scheduler) RunPendingIfDue(ctx context.Context) {
	last, ran, err := s.orchestrator.LastPendingRun(ctx)
	if err != nil {
		s.log.Error("pending due-check could not read the watermark", "error", describeError(err))
		return
	}

	// A negative elapsed means the clock moved backwards (NTP, a hand-set host).
	// That reads as due rather than "not yet": parking until the clock caught up
	// would silently postpone the re-check, and the watermark is stamped from
	// this same process's clock, so it cannot be a standing disagreement between
	// two machines the way a database-side clock could be.
	if ran {
		if elapsed := s.now().Sub(last); elapsed >= 0 && elapsed < PendingInterval {
			return
		}
	}

	since := "never"
	if ran {
		since = s.now().Sub(last).Round(time.Hour).String()
	}
	s.log.Info("pending re-check is due", "last", since)

	result, err := s.orchestrator.Enqueue(ctx, EnqueueOptions{Kind: KindHistory, Mode: ModePending})
	if err != nil {
		// The watermark did not move, so the next tick tries again.
		s.log.Error("pending re-check failed to start", "error", describeError(err))
		return
	}
	if result.Deduped {
		// Joined a run already in flight. The watermark still has not moved, so
		// this stays due and the next tick picks it up -- which is the behaviour
		// that stops a single busy minute from costing a whole day.
		s.log.Info("pending re-check joined an in-flight run, will retry")
		return
	}
	s.log.Info("cron started a pending re-check")
}
