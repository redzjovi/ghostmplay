package sync

import (
	"context"
	"database/sql"
	"encoding/json"
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
type StatusSnapshot struct {
	Marketplace KindStatus `json:"marketplace"`
	History     KindStatus `json:"history"`
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

// Scheduler runs the incremental sync on a timer.
type Scheduler struct {
	orchestrator *Orchestrator
	log          *slog.Logger
}

// NewScheduler builds the scheduler.
func NewScheduler(orchestrator *Orchestrator, log *slog.Logger) *Scheduler {
	return &Scheduler{orchestrator: orchestrator, log: log}
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
