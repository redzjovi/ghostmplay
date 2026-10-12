-- marketplace_favorites queries.
--
-- Every read and write is scoped by account_id. That scoping is the security
-- boundary of the whole feature, not a convenience filter: an id belonging to
-- another account has to be indistinguishable from one that does not exist, or
-- the API becomes an oracle for guessing other people's favorite ids.

-- name: ListFavoritesByAccount :many
SELECT id, account_id, name, q, equipment_types, grade_effects, sort,
       created_at, updated_at
FROM marketplace_favorites
WHERE account_id = $1
ORDER BY name ASC;

-- name: GetFavoriteByIDAndAccount :one
SELECT id, account_id, name, q, equipment_types, grade_effects, sort,
       created_at, updated_at
FROM marketplace_favorites
WHERE id = sqlc.arg('id') AND account_id = sqlc.arg('account_id')
LIMIT 1;

-- Deliberately not ON CONFLICT. A duplicate name is a conflict the client
-- deserves to hear about with a 409, not a silently ignored insert, and the
-- service layer turns the 23505 this raises into exactly that.
-- name: InsertFavorite :one
INSERT INTO marketplace_favorites (
  account_id, name, q, equipment_types, grade_effects, sort
) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, account_id, name, q, equipment_types, grade_effects, sort,
          created_at, updated_at;

-- A full-row update rather than a column patch. The service layer computes the
-- complete desired state -- including which keys the client actually sent, so a
-- rename leaves the saved filters alone and a filter-only edit leaves the name
-- alone -- and this writes it.
-- name: UpdateFavorite :one
UPDATE marketplace_favorites
SET name = $3,
    q = $4,
    equipment_types = $5,
    grade_effects = $6,
    sort = $7,
    updated_at = now()
WHERE id = $1 AND account_id = $2
RETURNING id, account_id, name, q, equipment_types, grade_effects, sort,
          created_at, updated_at;

-- execrows: a zero-row delete is the signal that the favorite was not there, or
-- was not this account's, which the service turns into a 404.
-- name: DeleteFavoriteByIDAndAccount :execrows
DELETE FROM marketplace_favorites
WHERE id = sqlc.arg('id') AND account_id = sqlc.arg('account_id');

-- Existence probe used to turn a duplicate name into a 409 before the insert is
-- attempted. It is advisory: two concurrent creates can both pass it, and the
-- unique index is what actually decides. Both paths produce the same response,
-- so the probe only makes the common case a clean 409 instead of an error
-- handler.
-- name: ExistsFavoriteByName :one
SELECT EXISTS(
  SELECT 1 FROM marketplace_favorites WHERE account_id = $1 AND name = $2
);