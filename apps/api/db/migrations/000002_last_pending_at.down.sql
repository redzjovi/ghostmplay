-- 000002: the watermark the daily pending schedule is measured from.
--
-- IF EXISTS because a down migration that fails on a database which never ran
-- the up is worse than one that succeeds quietly -- rolling back to a state that
-- never existed is not a useful thing to assert.

ALTER TABLE sync_state
    DROP COLUMN IF EXISTS last_pending_at;