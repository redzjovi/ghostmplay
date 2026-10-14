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
SELECT kind, mode, running_since, last_started_at, last_finished_at, last_pending_at,
       last_status, last_stats, last_error
FROM sync_state
WHERE kind = $1
LIMIT 1;

-- name: ListSyncStates :many
SELECT kind, mode, running_since, last_started_at, last_finished_at, last_pending_at,
       last_status, last_stats, last_error
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
-- start. So the mode that decides whether last_pending_at moves is read from the
-- parameter, not from EXCLUDED.mode: on this INSERT that would be the column
-- default, and the update branch below would never fire.
--
-- last_pending_at moves only for a pending run, and that conditional living here
-- rather than in a second statement the caller has to remember is the point:
-- last_finished_at is rewritten by every run and the incremental cron fires every
-- minute, so the daily pending schedule needs a column only pending runs touch.
-- Stamped on failure too -- the point is "when did we last try", and a permanently
-- failing job re-trying every few minutes would hammer an upstream where every
-- request costs real capacity.
--
-- The timestamp is named once and referenced through a subquery, rather than
-- written twice as $2. That is not a style preference. A parameter that appears
-- twice in one statement has to deduce the same type in both places, and Postgres
-- does not: bare in the last_finished_at position it deduces from the target
-- column, but inside the CASE there is no target column for the parser to resolve
-- against, so it deduces something else and rejects the whole statement at parse
-- time with "inconsistent types deduced for parameter $2" (SQLSTATE 42P08). The
-- failure is total rather than intermittent, and invisible to the test suite
-- because fakeQuerier never executes SQL -- so every run finished without clearing
-- running_since and left the kind permanently marked as running. One occurrence,
-- cast once, is not deducible two ways. See internal/database/queries_test.go,
-- which runs the real statements against a real database for exactly this reason.
-- name: UpsertSyncRunFinished :exec
INSERT INTO sync_state (
  kind, running_since, last_finished_at, last_pending_at,
  last_status, last_stats, last_error
)
SELECT sqlc.arg('kind'),
       NULL,
       f.finished_at,
       CASE WHEN sqlc.arg('mode')::text = 'pending' THEN f.finished_at END,
       sqlc.arg('last_status'),
       sqlc.arg('last_stats'),
       sqlc.arg('last_error')
FROM (SELECT sqlc.arg('last_finished_at')::timestamptz AS finished_at) f
ON CONFLICT (kind) DO UPDATE SET
  running_since = NULL,
  last_finished_at = EXCLUDED.last_finished_at,
  last_pending_at = CASE
    WHEN sqlc.arg('mode')::text = 'pending' THEN EXCLUDED.last_finished_at
    ELSE sync_state.last_pending_at
  END,
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

-- Releasing one kind's stranded row.
--
-- The non-destructive counterpart to the boot sweep: same three columns written,
-- no data touched, so it is safe to point at a kind whose run is merely unknown
-- rather than dead. It backs both the admin reset endpoint and the periodic
-- sweeper, which is why it is per-kind -- the boot sweep above is unconditional
-- and can only run when no run of any kind is in flight.
--
-- `AND running_since IS NOT NULL` is the whole design. It makes the query a
-- no-op when the kind is not stuck, so "nothing to release" is answered by zero
-- rows rather than by the caller having to check first, and it makes the write
-- safe against the race the callers have anyway: a row can go from stuck to
-- genuinely running between the caller's read and this statement. RETURNING
-- because that distinction is the answer -- a row comes back only if there was
-- something to release.
-- name: ReleaseStrandedSync :one
UPDATE sync_state
SET running_since = NULL,
    last_finished_at = now(),
    last_status = 'interrupted',
    last_error = sqlc.narg('last_error')
WHERE kind = sqlc.arg('kind')::text
  AND running_since IS NOT NULL
RETURNING kind;