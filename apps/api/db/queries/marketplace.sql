-- marketplace_items / marketplace_item_detail queries.
--
-- The browse predicate below is written out three times -- twice for the page
-- queries and once for the count -- because sqlc has no mechanism for sharing a
-- WHERE fragment across named queries. Adding a filter means editing all three;
-- the sqlc generator will not catch it if you miss one.
--
-- The list is split by sort for a reason. `idx_items_active_sold_at` is
-- (created_at DESC) WHERE sold_at IS NULL, which matches the default browse
-- query exactly -- same predicate, same sort order -- so `recent` gets a query
-- that can use that index. The two price sorts have no supporting index and
-- always sorted, so they share one query and flip direction by sign rather than
-- each getting its own copy. What is deliberately not done here is a CASE
-- expression in ORDER BY: it would make the index unusable and turn every page
-- of the most common request in the app into a sort.
--
-- The optional filters are written so that an absent filter and an empty list
-- behave identically -- both mean "no predicate". That matches the service layer,
-- which drops empty filters before it ever reaches SQL, so a client sending
-- `?equipment_type=` and one sending nothing get the same result.

-- name: ListMarketplaceItemsRecent :many
SELECT i.id, i.token_id, i.seller_id, i.seller_name, i.image_url, i.name,
       i.currency, i.price, i.grade_effect, i.level, i.enchant,
       i.equipment_type, i.created_at, i.mint_time, i.sold_at, i.sold_price
FROM marketplace_items i
WHERE i.sold_at IS NULL
  AND (
    sqlc.narg('q')::text IS NULL
    OR LOWER(i.name) LIKE LOWER(sqlc.narg('q')::text)
  )
  AND (
    cardinality(sqlc.arg('equipment_types')::text[]) = 0
    OR i.equipment_type = ANY(sqlc.arg('equipment_types')::text[])
  )
  AND (
    cardinality(sqlc.arg('grade_effects')::text[]) = 0
    OR i.grade_effect = ANY(sqlc.arg('grade_effects')::text[])
  )
  AND (sqlc.narg('level')::int IS NULL OR i.level = sqlc.narg('level')::int)
ORDER BY i.created_at DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountMarketplaceItems :one
SELECT count(*)::int
FROM marketplace_items i
WHERE i.sold_at IS NULL
  AND (
    sqlc.narg('q')::text IS NULL
    OR LOWER(i.name) LIKE LOWER(sqlc.narg('q')::text)
  )
  AND (
    cardinality(sqlc.arg('equipment_types')::text[]) = 0
    OR i.equipment_type = ANY(sqlc.arg('equipment_types')::text[])
  )
  AND (
    cardinality(sqlc.arg('grade_effects')::text[]) = 0
    OR i.grade_effect = ANY(sqlc.arg('grade_effects')::text[])
  )
  AND (sqlc.narg('level')::int IS NULL OR i.level = sqlc.narg('level')::int);

-- price_sign is +1 for ascending and -1 for descending. Multiplying by -1 turns
-- an ascending sort into a descending one without a second copy of this query.
-- price is NOT NULL and float8, so the negation is exact.
-- name: ListMarketplaceItemsByPrice :many
SELECT i.id, i.token_id, i.seller_id, i.seller_name, i.image_url, i.name,
       i.currency, i.price, i.grade_effect, i.level, i.enchant,
       i.equipment_type, i.created_at, i.mint_time, i.sold_at, i.sold_price
FROM marketplace_items i
WHERE i.sold_at IS NULL
  AND (
    sqlc.narg('q')::text IS NULL
    OR LOWER(i.name) LIKE LOWER(sqlc.narg('q')::text)
  )
  AND (
    cardinality(sqlc.arg('equipment_types')::text[]) = 0
    OR i.equipment_type = ANY(sqlc.arg('equipment_types')::text[])
  )
  AND (
    cardinality(sqlc.arg('grade_effects')::text[]) = 0
    OR i.grade_effect = ANY(sqlc.arg('grade_effects')::text[])
  )
  AND (sqlc.narg('level')::int IS NULL OR i.level = sqlc.narg('level')::int)
ORDER BY i.price * sqlc.arg('price_sign')::int, i.created_at DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- Deliberately not filtered on sold_at: a deep link to a sold token still has
-- to resolve and render "sold out".
-- name: GetMarketplaceItemByTokenID :one
SELECT id, token_id, seller_id, seller_name, image_url, name, currency, price,
       grade_effect, level, enchant, equipment_type, created_at, mint_time,
       sold_at, sold_price
FROM marketplace_items
WHERE token_id = $1
LIMIT 1;

-- name: GetMarketplaceItemByID :one
SELECT id, token_id, seller_id, seller_name, image_url, name, currency, price,
       grade_effect, level, enchant, equipment_type, created_at, mint_time,
       sold_at, sold_price
FROM marketplace_items
WHERE id = $1
LIMIT 1;

-- name: ExistsMarketplaceItemByID :one
SELECT EXISTS(SELECT 1 FROM marketplace_items WHERE id = $1);

-- The filter dropdowns are scoped to live listings. Without that scope they
-- keep offering equipment types and grade effects that nothing in the list can
-- match, so the user picks one and gets an empty page.
--
-- The IS NOT NULL and TRIM checks are redundant against the current NOT NULL
-- schema and are kept anyway: they are what makes a blank value impossible to
-- render as an empty dropdown option, and the cost is one sequential scan that
-- the distinct already requires.
-- name: ListDistinctEquipmentTypes :many
SELECT DISTINCT i.equipment_type
FROM marketplace_items i
WHERE i.sold_at IS NULL
  AND i.equipment_type IS NOT NULL
  AND TRIM(i.equipment_type) != ''
ORDER BY i.equipment_type ASC;

-- name: ListDistinctGradeEffects :many
SELECT DISTINCT i.grade_effect
FROM marketplace_items i
WHERE i.sold_at IS NULL
  AND i.grade_effect IS NOT NULL
  AND TRIM(i.grade_effect) != ''
ORDER BY i.grade_effect ASC;

-- The two upsert lookups. They are separate queries rather than one COALESCE
-- because the caller needs to know *which* one hit: falling back from id to
-- token_id is what identifies a relist, and only a relist clears sold_at.
-- name: FindMarketplaceItemForUpsertByID :one
SELECT id, token_id, seller_id, seller_name, image_url, name, currency, price,
       grade_effect, level, enchant, equipment_type, created_at, mint_time,
       sold_at, sold_price
FROM marketplace_items
WHERE id = $1
LIMIT 1;

-- name: FindMarketplaceItemForUpsertByTokenID :one
SELECT id, token_id, seller_id, seller_name, image_url, name, currency, price,
       grade_effect, level, enchant, equipment_type, created_at, mint_time,
       sold_at, sold_price
FROM marketplace_items
WHERE token_id = $1
LIMIT 1;

-- name: FindMarketplaceItemPrice :one
SELECT price FROM marketplace_items WHERE id = $1;

-- name: FindMarketplaceItemPrices :many
SELECT id, price FROM marketplace_items WHERE id = ANY(sqlc.arg('ids')::int[]);

-- name: FindMarketplaceItemCreatedAt :many
SELECT id, created_at FROM marketplace_items WHERE id = ANY(sqlc.arg('ids')::int[]);

-- name: InsertMarketplaceItem :one
INSERT INTO marketplace_items (
  id, token_id, seller_id, seller_name, image_url, name, currency, price,
  grade_effect, level, enchant, equipment_type, created_at, mint_time
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
)
RETURNING id, token_id, seller_id, seller_name, image_url, name, currency, price,
          grade_effect, level, enchant, equipment_type, created_at, mint_time,
          sold_at, sold_price;

-- currency falls back to the stored value rather than a literal default, and
-- mint_time is written only when it parsed: an upstream payload that omitted or
-- mangled mint_time must not blank a value we already hold.
--
-- sold_at / sold_price are absent by design. This path is a re-scrape of a row
-- we already had, and a re-scrape of a sold item must keep its sale.
-- name: UpdateMarketplaceItem :one
UPDATE marketplace_items
SET token_id = sqlc.arg('token_id'),
    seller_id = sqlc.arg('seller_id'),
    seller_name = sqlc.narg('seller_name')::text,
    image_url = sqlc.arg('image_url'),
    name = sqlc.arg('name'),
    currency = COALESCE(sqlc.narg('currency')::text, currency),
    price = sqlc.arg('price'),
    grade_effect = sqlc.arg('grade_effect'),
    level = sqlc.arg('level'),
    enchant = sqlc.arg('enchant'),
    equipment_type = sqlc.arg('equipment_type'),
    created_at = sqlc.arg('created_at'),
    mint_time = COALESCE(sqlc.narg('mint_time')::timestamptz, mint_time)
WHERE id = sqlc.arg('id')
RETURNING id, token_id, seller_id, seller_name, image_url, name, currency, price,
          grade_effect, level, enchant, equipment_type, created_at, mint_time,
          sold_at, sold_price;

-- Re-listing clears the sale.
--
-- Only ever reached when the id lookup missed and the token_id lookup hit, which
-- is exactly what "a relisted token" means: the upstream handed back a new
-- item_id for a token we already track. A plain re-scrape finds the row by id and
-- must keep sold_at, otherwise every marketplace sync would resurrect sold
-- listings between the two runs.
-- name: ClearMarketplaceItemSold :one
UPDATE marketplace_items
SET sold_at = NULL,
    sold_price = NULL
WHERE id = $1
RETURNING id, token_id, seller_id, seller_name, image_url, name, currency, price,
          grade_effect, level, enchant, equipment_type, created_at, mint_time,
          sold_at, sold_price;

-- Reconcile the item table against the transfer ledger.
--
-- Deliberately table-wide rather than scoped to the transfers a run just
-- fetched. Both history paths stop early at the first transfer they already
-- have, so a scope built from "the fresh ones" would silently never revisit a
-- transfer whose item row did not exist at the time. Re-deriving from the whole
-- ledger is a hash join on the indexed token_id that makes that class of miss
-- unrepresentable.
--
-- `sold_at IS NULL` does double duty: it makes the statement a no-op once a row
-- is marked, and it pins sold_at to the first sale we ever observed rather than
-- letting a later transfer overwrite it.
--
-- `t.created_at >= i.created_at` is what makes a relist survivable. A token that
-- sold and was relisted arrives as a new item_id for the same token, and
-- ClearMarketplaceItemSold makes the new listing live again -- but its previous
-- sale is still in the ledger, and without this guard the very next run would
-- re-sell the item using a transfer that predates the listing. The invariant is
-- that sold_at can never be earlier than created_at.
--
-- RETURNING is what makes the count obtainable: without it there is no way to
-- tell zero rows from a driver that reported none, and the sync panel would
-- report "0 sold" on every run.
-- name: MarkItemsSold :many
UPDATE marketplace_items i
SET sold_at = t.created_at,
    sold_price = t.price
FROM (
  SELECT DISTINCT ON (token_id) token_id, price, created_at
  FROM marketplace_token_transfers
  WHERE price > 0
  ORDER BY token_id, created_at DESC
) t
WHERE i.token_id = t.token_id
  AND i.sold_at IS NULL
  AND t.created_at >= i.created_at
RETURNING i.id;

-- Detail rows need no explicit delete: the foreign key cascades. They are
-- counted so the caller can say what disappeared alongside the listings.
-- name: CountMarketplaceItemDetails :one
SELECT count(*)::int FROM marketplace_item_detail;

-- execrows, not exec: the admin "clear all" reports how many listings went, and
-- without the affected-row count that number would always be zero.
-- name: DeleteAllMarketplaceItems :execrows
DELETE FROM marketplace_items;

-- The three jsonb columns are a verbatim mirror of the upstream payload. They
-- are stored and read back as raw JSON bytes precisely so that nothing in this
-- path can normalise, reorder or drop a field the detail page renders.
-- name: GetMarketplaceItemDetail :one
SELECT item_id, attributes, datas, infos
FROM marketplace_item_detail
WHERE item_id = $1
LIMIT 1;

-- name: InsertMarketplaceItemDetail :one
INSERT INTO marketplace_item_detail (item_id, attributes, datas, infos)
VALUES ($1, $2, $3, $4)
RETURNING item_id, attributes, datas, infos;

-- COALESCE on each blob: a null in the incoming payload preserves what is stored
-- rather than blanking it.
-- name: UpdateMarketplaceItemDetail :one
UPDATE marketplace_item_detail
SET attributes = COALESCE(sqlc.narg('attributes')::jsonb, attributes),
    datas = COALESCE(sqlc.narg('datas')::jsonb, datas),
    infos = COALESCE(sqlc.narg('infos')::jsonb, infos)
WHERE item_id = sqlc.arg('item_id')
RETURNING item_id, attributes, datas, infos;