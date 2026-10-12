-- accounts / account_identities / sessions queries.
--
-- There are no credentials anywhere in these three tables. There is no username
-- and no password hash, so an account is an id and a role and nothing else.
-- Google is the only way in, the verified address lives on account_identities,
-- and admin is granted per sign-in from the GOOGLE_ADMIN_EMAILS allowlist rather
-- than stored as something you could log into. Nothing can be forgotten,
-- guessed, or reset.

-- name: InsertAccount :one
INSERT INTO accounts (role) VALUES ($1)
RETURNING id, role, created_at;

-- name: GetAccountByID :one
SELECT id, role, created_at FROM accounts WHERE id = $1 LIMIT 1;

-- name: UpdateAccountRole :one
UPDATE accounts SET role = $2 WHERE id = $1
RETURNING id, role, created_at;

-- Read as two queries rather than one join. The sign-in path has to handle an
-- identity whose account row is missing -- an account deleted out from under a
-- leftover identity -- and it does that by looking the identity up first and the
-- account second. A single join would hide the difference by returning no rows
-- at all, and the repair path would never run.
--
-- Email is deliberately not part of the lookup key. It is not something an
-- account owner controls, so keying on it would let anyone who can register an
-- address resembling someone else's claim their account. Google's `sub` is
-- stable and never reassigned.
-- name: GetIdentityByProviderSubject :one
SELECT id, account_id, provider, provider_subject, email, picture_url, created_at
FROM account_identities
WHERE provider = $1 AND provider_subject = $2
LIMIT 1;

-- name: InsertIdentity :one
INSERT INTO account_identities (account_id, provider, provider_subject, email, picture_url)
VALUES ($1, $2, $3, $4, $5)
RETURNING id, account_id, provider, provider_subject, email, picture_url, created_at;

-- name: UpdateIdentityEmail :exec
UPDATE account_identities SET email = $2 WHERE id = $1;

-- name: UpdateIdentityPicture :exec
UPDATE account_identities SET picture_url = $2 WHERE id = $1;

-- No provider filter and no ordering: an account has exactly one identity today,
-- and the day it has two the UI wants the one it already knows about rather than
-- an arbitrary pick.
-- name: GetIdentityEmailByAccountID :one
SELECT email FROM account_identities WHERE account_id = $1 LIMIT 1;

-- name: InsertSession :one
INSERT INTO sessions (account_id, token_hash, expires_at)
VALUES ($1, $2, $3)
RETURNING id, account_id, token_hash, created_at, expires_at;

-- Joins the account because the guard needs the role on every request, and the
-- role is recomputed at sign-in rather than stored in the session -- an admin
-- whose address leaves the allowlist loses admin on their next request, not when
-- their session happens to expire.
--
-- Only a SHA-256 hash of the token is stored, so this cannot be replayed from a
-- database dump.
-- name: GetSessionWithAccountByTokenHash :one
SELECT s.id AS session_id, s.expires_at AS session_expires_at,
       a.id AS account_id, a.role AS account_role
FROM sessions s
JOIN accounts a ON a.id = s.account_id
WHERE s.token_hash = $1
LIMIT 1;

-- Lazy delete of an expired session on use. Cheaper than checking expiry on every
-- request and it leaves the table no bigger than it has to be.
-- name: DeleteSessionByID :exec
DELETE FROM sessions WHERE id = $1;

-- name: DeleteSessionByTokenHash :exec
DELETE FROM sessions WHERE token_hash = $1;

-- name: DeleteExpiredSessions :exec
DELETE FROM sessions WHERE expires_at < now();

-- name: DeleteSessionsByAccount :exec
DELETE FROM sessions WHERE account_id = $1;

-- name: CountExpiredSessions :one
SELECT count(*)::int FROM sessions WHERE expires_at < now();