-- sync_state queries.
--
-- One mutable row per sync kind. Not an append-only log of runs: the only
-- questions the UI ever asks are "is it running?" and "when did it last finish,
-- and how much did it get?", and both are answered by a single row. The table
-- this replaced grew ~2,880 rows a day at the intended cron cadence and held no
-- information this row does not hold.
--
-- Every ON CONFLICT below names the column, not the constraint. The TypeORM
-- migrations that created these indexes hashed their names, so a database that
-- ran them carries different index names than a fresh one -- and `ON CONFLICT
-- ON CONSTRAINT` would fail on whichever did not match.

-- name: GetSyncState :one
SELECT kind, mode, running_since, last_started_at, last_finished_at, last_status,
       last_stats, last_error
FROM sync_state
WHERE kind = $1
LIMIT 1;

-- name: ListSyncStates :many
SELECT kind, mode, running_since, last_started_at, last_finished_at, last_status,
       last_stats, last_error
FROM sync_state
ORDER BY kind ASC;

-- Only the in-flight columns are written on start. last_finished_at, last_stats
-- and last_error deliberately keep the previous run's values, so a run that is
-- currently in progress still reports when the last completed one finished and
-- what it got -- which is what the sync panel shows while it waits.
-- name: UpsertSyncRunStarted :exec
INSERT INTO sync_state (kind, mode, running_since, last_started_at, last_status)
VALUES ($1, $2, $3, $3, 'running')
ON CONFLICT (kind) DO UPDATE SET
  mode = EXCLUDED.mode,
  running_since = EXCLUDED.running_since,
  last_started_at = EXCLUDED.last_started_at,
  last_status = EXCLUDED.last_status;

-- mode is left out of the column list and so takes its default. The row records
-- the mode of the most recent run only for display -- the UI labels a
-- stale-but-running scrape -- and the run that is finishing already set it on
-- start.
-- name: UpsertSyncRunFinished :exec
INSERT INTO sync_state (kind, running_since, last_finished_at, last_status, last_stats, last_error)
VALUES ($1, NULL, $2, $3, $4, $5)
ON CONFLICT (kind) DO UPDATE SET
  running_since = NULL,
  last_finished_at = EXCLUDED.last_finished_at,
  last_status = EXCLUDED.last_status,
  last_stats = EXCLUDED.last_stats,
  last_error = EXCLUDED.last_error;

-- The "clear all" reset. kind and mode survive deliberately: the panel still
-- needs a row per kind to render, and dropping the row would make the next
-- status read report a kind as never-run.
-- name: ResetSyncState :exec
UPDATE sync_state
SET running_since = NULL,
    last_started_at = NULL,
    last_finished_at = NULL,
    last_status = NULL,
    last_stats = NULL,
    last_error = NULL
WHERE kind = $1;

-- Boot recovery.
--
-- running_since is the lock made durable: it is non-null exactly while a run
-- holds the lock, and it outlives the process that took it. A row found in this
-- state at startup belongs to a run that died -- the container was replaced, or
-- it was stopped mid-run -- and reporting it as still running would leave the
-- panel spinning forever with no work behind it.
--
-- RETURNING because the log line says how many were stranded.
-- name: MarkStrandedSyncsInterrupted :many
UPDATE sync_state
SET running_since = NULL,
    last_finished_at = now(),
    last_status = 'interrupted',
    last_error = 'Interrupted by restart'
WHERE running_since IS NOT NULL
RETURNING kind;

-- name: ExistsSyncStateForLock :one
SELECT EXISTS(SELECT 1 FROM sync_state WHERE kind = $1 AND running_since IS NOT NULL);