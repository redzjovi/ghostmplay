-- marketplace_token_transfers + users queries.
--
-- The transfer ledger is the only authority on sold state, and it is
-- deliberately independent of marketplace_items: no foreign key, because a
-- transfer has to stay true after the listing it refers to is gone, and because
-- the ledger is backfilled independently of any scrape.
--
-- Both joins are LEFT: a transfer whose party has no users row still belongs in
-- the history, with a null username. This also replaces what used to be a
-- second round trip -- the TypeORM version ran the page query, then re-ran it
-- raw to harvest the joined usernames, then fell back to a batch users lookup if
-- that produced nothing. Selecting the columns directly is one query and has no
-- failure mode to fall back from.
--
-- The browse predicate below is repeated across three queries because sqlc
-- cannot share a WHERE fragment between named queries. Editing a filter means
-- editing all three; nothing will catch it if you miss one.

-- name: ListTokenTransfersRecent :many
SELECT t.id, t.token_id, t.game_name, t.seller_id, su.username AS seller_username,
       t.buyer_id, bu.username AS buyer_username, t.item_name, t.price,
       t.currency, t.tx_hash, t.image_url, t.created_at, t.claimed
FROM marketplace_token_transfers t
LEFT JOIN users su ON su.id = LOWER(t.seller_id)
LEFT JOIN users bu ON bu.id = LOWER(t.buyer_id)
WHERE
  -- `seller` / `buyer` match either the wallet address or the username, both
  -- case-folded. `seller_name` / `buyer_name` are exact and case-sensitive,
  -- which is deliberate: those are chosen from a dropdown of names already in
  -- the database, not typed.
  (
    sqlc.narg('seller')::text IS NULL
    OR LOWER(t.seller_id) LIKE LOWER(sqlc.narg('seller')::text)
    OR LOWER(su.username) LIKE LOWER(sqlc.narg('seller')::text)
  )
  AND (
    sqlc.narg('buyer')::text IS NULL
    OR LOWER(t.buyer_id) LIKE LOWER(sqlc.narg('buyer')::text)
    OR LOWER(bu.username) LIKE LOWER(sqlc.narg('buyer')::text)
  )
  AND (sqlc.narg('seller_name')::text IS NULL OR su.username = sqlc.narg('seller_name')::text)
  AND (sqlc.narg('buyer_name')::text IS NULL OR bu.username = sqlc.narg('buyer_name')::text)
  AND (
    sqlc.narg('item_name')::text IS NULL
    OR LOWER(t.item_name) LIKE LOWER(sqlc.narg('item_name')::text)
  )
  AND (sqlc.narg('token_id')::int IS NULL OR t.token_id = sqlc.narg('token_id')::int)
  AND (
    sqlc.narg('tx_hash')::text IS NULL
    OR LOWER(t.tx_hash) LIKE LOWER(sqlc.narg('tx_hash')::text)
  )
  AND (sqlc.narg('price_min')::float8 IS NULL OR t.price >= sqlc.narg('price_min')::float8)
  AND (sqlc.narg('price_max')::float8 IS NULL OR t.price <= sqlc.narg('price_max')::float8)
  AND (
    sqlc.narg('created_from')::timestamptz IS NULL
    OR t.created_at >= sqlc.narg('created_from')::timestamptz
  )
  -- created_to is exclusive at the call site: the DTO turns the inclusive end
  -- day into the next day's midnight, which is what makes the whole day count.
  AND (
    sqlc.narg('created_to')::timestamptz IS NULL
    OR t.created_at < sqlc.narg('created_to')::timestamptz
  )
  -- IS NOT DISTINCT FROM rather than =, so that an explicit `?claimed=false` is
  -- a real filter. That case matters: filtering to unclaimed transfers is a
  -- question the UI actually asks, and it is silently dropped by any "skip the
  -- parameter when it is falsy" shortcut.
  AND (
    sqlc.narg('claimed')::boolean IS NULL
    OR t.claimed IS NOT DISTINCT FROM sqlc.narg('claimed')::boolean
  )
ORDER BY t.created_at DESC, t.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountTokenTransfers :one
SELECT count(*)::int
FROM marketplace_token_transfers t
LEFT JOIN users su ON su.id = LOWER(t.seller_id)
LEFT JOIN users bu ON bu.id = LOWER(t.buyer_id)
WHERE
  (
    sqlc.narg('seller')::text IS NULL
    OR LOWER(t.seller_id) LIKE LOWER(sqlc.narg('seller')::text)
    OR LOWER(su.username) LIKE LOWER(sqlc.narg('seller')::text)
  )
  AND (
    sqlc.narg('buyer')::text IS NULL
    OR LOWER(t.buyer_id) LIKE LOWER(sqlc.narg('buyer')::text)
    OR LOWER(bu.username) LIKE LOWER(sqlc.narg('buyer')::text)
  )
  AND (sqlc.narg('seller_name')::text IS NULL OR su.username = sqlc.narg('seller_name')::text)
  AND (sqlc.narg('buyer_name')::text IS NULL OR bu.username = sqlc.narg('buyer_name')::text)
  AND (
    sqlc.narg('item_name')::text IS NULL
    OR LOWER(t.item_name) LIKE LOWER(sqlc.narg('item_name')::text)
  )
  AND (sqlc.narg('token_id')::int IS NULL OR t.token_id = sqlc.narg('token_id')::int)
  AND (
    sqlc.narg('tx_hash')::text IS NULL
    OR LOWER(t.tx_hash) LIKE LOWER(sqlc.narg('tx_hash')::text)
  )
  AND (sqlc.narg('price_min')::float8 IS NULL OR t.price >= sqlc.narg('price_min')::float8)
  AND (sqlc.narg('price_max')::float8 IS NULL OR t.price <= sqlc.narg('price_max')::float8)
  AND (
    sqlc.narg('created_from')::timestamptz IS NULL
    OR t.created_at >= sqlc.narg('created_from')::timestamptz
  )
  AND (
    sqlc.narg('created_to')::timestamptz IS NULL
    OR t.created_at < sqlc.narg('created_to')::timestamptz
  )
  AND (
    sqlc.narg('claimed')::boolean IS NULL
    OR t.claimed IS NOT DISTINCT FROM sqlc.narg('claimed')::boolean
  );

-- The three non-default sorts share this query. A CASE in ORDER BY is acceptable
-- here because none of these three has a supporting index -- the ledger is small
-- and the default sort, which does have one, has its own query above.
--
-- `sort` is a validated enum from the DTO, so exactly one CASE is non-null and
-- the rest sort together, which still gives a stable total order.
-- name: ListTokenTransfersSorted :many
SELECT t.id, t.token_id, t.game_name, t.seller_id, su.username AS seller_username,
       t.buyer_id, bu.username AS buyer_username, t.item_name, t.price,
       t.currency, t.tx_hash, t.image_url, t.created_at, t.claimed
FROM marketplace_token_transfers t
LEFT JOIN users su ON su.id = LOWER(t.seller_id)
LEFT JOIN users bu ON bu.id = LOWER(t.buyer_id)
WHERE
  (
    sqlc.narg('seller')::text IS NULL
    OR LOWER(t.seller_id) LIKE LOWER(sqlc.narg('seller')::text)
    OR LOWER(su.username) LIKE LOWER(sqlc.narg('seller')::text)
  )
  AND (
    sqlc.narg('buyer')::text IS NULL
    OR LOWER(t.buyer_id) LIKE LOWER(sqlc.narg('buyer')::text)
    OR LOWER(bu.username) LIKE LOWER(sqlc.narg('buyer')::text)
  )
  AND (sqlc.narg('seller_name')::text IS NULL OR su.username = sqlc.narg('seller_name')::text)
  AND (sqlc.narg('buyer_name')::text IS NULL OR bu.username = sqlc.narg('buyer_name')::text)
  AND (
    sqlc.narg('item_name')::text IS NULL
    OR LOWER(t.item_name) LIKE LOWER(sqlc.narg('item_name')::text)
  )
  AND (sqlc.narg('token_id')::int IS NULL OR t.token_id = sqlc.narg('token_id')::int)
  AND (
    sqlc.narg('tx_hash')::text IS NULL
    OR LOWER(t.tx_hash) LIKE LOWER(sqlc.narg('tx_hash')::text)
  )
  AND (sqlc.narg('price_min')::float8 IS NULL OR t.price >= sqlc.narg('price_min')::float8)
  AND (sqlc.narg('price_max')::float8 IS NULL OR t.price <= sqlc.narg('price_max')::float8)
  AND (
    sqlc.narg('created_from')::timestamptz IS NULL
    OR t.created_at >= sqlc.narg('created_from')::timestamptz
  )
  AND (
    sqlc.narg('created_to')::timestamptz IS NULL
    OR t.created_at < sqlc.narg('created_to')::timestamptz
  )
  AND (
    sqlc.narg('claimed')::boolean IS NULL
    OR t.claimed IS NOT DISTINCT FROM sqlc.narg('claimed')::boolean
  )
ORDER BY
  CASE WHEN sqlc.arg('sort') = 'price_asc' THEN t.price END ASC,
  CASE WHEN sqlc.arg('sort') = 'price_desc' THEN t.price END DESC,
  CASE WHEN sqlc.arg('sort') = 'created_at_asc' THEN t.created_at END ASC,
  t.created_at DESC,
  t.id DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- The ledger has no live/sold concept, so these dropdowns are not scoped the way
-- the marketplace ones are.
-- name: ListDistinctGameNames :many
SELECT DISTINCT t.game_name
FROM marketplace_token_transfers t
WHERE t.game_name IS NOT NULL AND TRIM(t.game_name) != ''
ORDER BY t.game_name ASC;

-- INNER, unlike the list query: a party with no users row cannot contribute a
-- username either way, so the outer join would only cost the planner work.
-- name: ListDistinctSellerNames :many
SELECT DISTINCT su.username
FROM marketplace_token_transfers t
INNER JOIN users su ON su.id = LOWER(t.seller_id)
WHERE su.username IS NOT NULL AND TRIM(su.username) != ''
ORDER BY su.username ASC;

-- name: ListDistinctBuyerNames :many
SELECT DISTINCT bu.username
FROM marketplace_token_transfers t
INNER JOIN users bu ON bu.id = LOWER(t.buyer_id)
WHERE bu.username IS NOT NULL AND TRIM(bu.username) != ''
ORDER BY bu.username ASC;

-- name: ExistsTransferByTxHash :one
SELECT EXISTS(SELECT 1 FROM marketplace_token_transfers WHERE tx_hash = $1);

-- name: GetTransferByTxHash :one
SELECT id, token_id, game_name, seller_id, buyer_id, item_name, price, currency,
       tx_hash, image_url, created_at, claimed
FROM marketplace_token_transfers
WHERE tx_hash = $1
LIMIT 1;

-- The unclaimed transfers, for the pending re-check.
--
-- The pending run reads its worklist from here rather than from the upstream
-- ledger. The upstream cannot be asked "which transfers are not claimed" -- it
-- has no such field, and market/token-transfers takes only limit and offset -- so
-- the only way to find them by walking it would be to read all 135 pages and
-- discard what is already settled. The table already knows.
--
-- KEYSET, not OFFSET, and that is load-bearing rather than a preference. The run
-- sets claimed = true on rows as it goes, so the NOT claimed set shrinks
-- underneath the cursor: OFFSET 500 LIMIT 500 would step over the rows that fell
-- into the band it had already read, and never check them. `id > after_id` cannot.
--
-- Oldest first, because a pending row is one waiting to be found claimed, and the
-- stalest is the most overdue. id is a serial and inserts are chronological, so it
-- orders the same way created_at would without needing a second sort key.
-- name: ListPendingTransfers :many
SELECT id, token_id, game_name, seller_id, buyer_id, item_name, price, currency,
       tx_hash, image_url, created_at, claimed
FROM marketplace_token_transfers
WHERE NOT claimed
  AND id > sqlc.arg('after_id')
ORDER BY id
LIMIT sqlc.arg('batch');

-- name: InsertTokenTransfer :one
INSERT INTO marketplace_token_transfers (
  token_id, game_name, seller_id, buyer_id, item_name, price, currency,
  tx_hash, image_url, created_at, claimed
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING id, token_id, game_name, seller_id, buyer_id, item_name, price,
          currency, tx_hash, image_url, created_at, claimed;

-- currency and image_url fall back to what is stored rather than blanking the
-- column, and game_name is only written when the payload carried one. `claimed`
-- is written unconditionally because the only path that sets it true is an
-- explicit upstream "this token is claimed", and defaulting it to false here
-- would resurrect a claimed token on the next re-scrape.
-- name: UpdateTokenTransfer :one
UPDATE marketplace_token_transfers
SET token_id = sqlc.arg('token_id'),
    game_name = COALESCE(sqlc.narg('game_name')::text, game_name),
    seller_id = sqlc.arg('seller_id'),
    buyer_id = sqlc.arg('buyer_id'),
    item_name = sqlc.arg('item_name'),
    price = sqlc.arg('price'),
    currency = COALESCE(sqlc.narg('currency')::text, currency),
    image_url = COALESCE(sqlc.narg('image_url')::text, image_url),
    created_at = sqlc.arg('created_at'),
    claimed = sqlc.arg('claimed')
WHERE tx_hash = sqlc.arg('tx_hash')
RETURNING id, token_id, game_name, seller_id, buyer_id, item_name, price,
          currency, tx_hash, image_url, created_at, claimed;

-- users is left alone by the clear below: the seller/buyer names are harmless
-- without transfers behind them, and they are cheap for a backfill to restore.
-- Only the ledger itself goes.
-- execrows, not exec: the admin "clear all" reports how many transfers went.
-- name: DeleteAllTokenTransfers :execrows
DELETE FROM marketplace_token_transfers;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

-- id is a lowercased wallet address, which is what makes the LOWER() joins work.
-- name: GetUserByID :one
SELECT id, username FROM users WHERE id = $1 LIMIT 1;

-- ON CONFLICT DO NOTHING, rather than SELECT-then-INSERT. Two concurrent history
-- workers resolving the same address would otherwise race and one would fail on
-- the primary key.
-- name: EnsureUser :exec
INSERT INTO users (id, username) VALUES ($1, NULL)
ON CONFLICT (id) DO NOTHING;

-- name: UpdateUserUsername :exec
UPDATE users SET username = $2 WHERE id = $1;

-- name: FindUsersByIDs :many
SELECT id, username FROM users WHERE id = ANY(sqlc.arg('ids')::text[]);