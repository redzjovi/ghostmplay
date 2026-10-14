-- 000002: the watermark the daily pending schedule is measured from.
--
-- The baseline is FROZEN from here on. It is the squashed end state of the ten
-- TypeORM migrations that preceded the Go rewrite, and 000001 will not be
-- regenerated -- see scripts/gen-baseline.sh. Anything after it is its own
-- numbered migration, which is what makes an already-migrated database able to
-- pick the change up at all: a baseline that grew a column would leave every
-- deployed database silently missing it, which is precisely the drift the
-- generated baseline existed to prevent.
--
-- Why a column rather than something derivable: last_finished_at is rewritten by
-- every run and the incremental cron fires every minute, and last_stats is
-- overwritten with it, so neither can answer "when did the pending re-check last
-- run" -- the mode that says so is gone within the minute. Only the pending mode
-- writes this, so it stays put.

ALTER TABLE sync_state
    ADD COLUMN IF NOT EXISTS last_pending_at timestamp with time zone;