-- ghostmplay schema.
--
-- This file is the sqlc input and the single source of truth for the database
-- shape. It is the end state of the ten TypeORM migrations that preceded it,
-- squashed into one baseline: every statement those ten ended up applying is
-- here, and nothing that was later dropped survives.
--
-- The squash is deliberate. Each of those migrations ran once against a
-- deployment that already existed; re-running them on a fresh database would
-- mean replaying a history that no longer has a decision attached to it (the
-- `sold` boolean that turned out to be wrong, the `citext` column that turned
-- out to be unnecessary, the `sync_jobs` table that `sync_state` replaced). A
-- baseline states what the schema is now. `db/migrations/000001_baseline.up.sql`
-- is this file plus the two `sync_state` seed rows.
--
-- Two properties are load-bearing and must survive any future edit:
--
--   1. No `CREATE EXTENSION`. The upstream host is shared and does not grant
--      superuser, so a migration that needs `pg_trgm` or `citext` cannot run at
--      all. That is not tidiness: an optimisation nobody was paying for was
--      blocking every deployment. See the `lower()` expression indexes below.
--   2. No CHECK constraints. `role`, `kind`, `mode` and `last_status` are
--      unions in the application, not enums here, and the application is the
--      only writer. Adding one changes what an out-of-date deploy may insert.

-- ---------------------------------------------------------------------------
-- marketplace_items
-- ---------------------------------------------------------------------------

CREATE TABLE marketplace_items (
    -- Reuses the upstream `item_id` from market-api verbatim. Not a sequence:
    -- the upstream assigns this, and assigning our own would break the
    -- upsert-by-id path in the marketplace sync.
    id           integer                     NOT NULL,
    token_id     integer                     NOT NULL,
    seller_id    text                        NOT NULL,
    seller_name  text,
    image_url    text                        NOT NULL,
    name         text                        NOT NULL,
    currency     text                        NOT NULL DEFAULT 'NUMI',
    -- double precision, not numeric: pg returns numeric as a string, which
    -- would break number handling all the way up into the JSON responses.
    price        double precision            NOT NULL,
    grade_effect text                        NOT NULL,
    level        integer                     NOT NULL,
    enchant      integer                     NOT NULL,
    equipment_type text                      NOT NULL,
    -- Equals the upstream `market_time`. The duplicate in the detail blob was
    -- removed; this is the one that is queried.
    created_at   timestamp with time zone    NOT NULL,
    mint_time    timestamp with time zone,
    -- Sold state, as a timestamp rather than a boolean: a listing is sold when
    -- this is non-null, and the value is the sale itself. It is written from
    -- exactly one place -- the transfer ledger, via MarkItemsSold -- so it
    -- cannot drift into a state the transfer log does not support.
    sold_at      timestamp with time zone,
    sold_price   double precision,

    CONSTRAINT "PK_marketplace_items" PRIMARY KEY (id)
);

-- A relisted token arrives from upstream with a NEW item_id but the SAME
-- token_id, so token_id is what actually identifies a listing across time.
CREATE UNIQUE INDEX "IDX_marketplace_items_token_id" ON marketplace_items (token_id);
CREATE INDEX "IDX_marketplace_items_grade_effect" ON marketplace_items (grade_effect);
CREATE INDEX "IDX_marketplace_items_equipment_type" ON marketplace_items (equipment_type);

-- Partial, because every browse query filters on `sold_at IS NULL`. An index
-- that only contains live listings is both smaller and cheaper to scan, and it
-- matches the predicate exactly so the planner can use it. It also carries the
-- DESC that the default sort needs, which is why the sort is written out as
-- separate per-order queries rather than a CASE expression in ORDER BY: a
-- CASE-wrapped sort would make this index unusable.
CREATE INDEX "idx_items_active_sold_at" ON marketplace_items (created_at DESC) WHERE sold_at IS NULL;

-- ---------------------------------------------------------------------------
-- marketplace_item_detail
-- ---------------------------------------------------------------------------

-- Singular table name, unlike every other table here, because it is a
-- zero-or-one extension of an item rather than a collection.
--
-- The three jsonb columns mirror the upstream payload verbatim. Fidelity is the
-- point: this is a display blob the detail page renders as-is, and normalising
-- it would mean a migration every time upstream changes shape.
CREATE TABLE marketplace_item_detail (
    item_id    integer                     NOT NULL,
    attributes jsonb,
    datas      jsonb,
    infos      jsonb,

    CONSTRAINT "PK_marketplace_item_detail" PRIMARY KEY (item_id),
    CONSTRAINT "FK_marketplace_item_detail_item_id" FOREIGN KEY (item_id)
        REFERENCES marketplace_items (id) ON DELETE CASCADE ON UPDATE NO ACTION
);

-- ---------------------------------------------------------------------------
-- marketplace_favorites
-- ---------------------------------------------------------------------------

CREATE TABLE marketplace_favorites (
    id              serial                    NOT NULL,
    -- Owner. Favorite names are unique per account, not globally.
    --
    -- Deliberately has no foreign key to accounts. See the migration note in
    -- db/migrations about it: favorites outliving their owner is a tolerable
    -- state, and a constraint that blocks account deletion over it is not.
    account_id      integer                   NOT NULL,
    name            text                      NOT NULL,
    q               text,
    equipment_types jsonb,
    grade_effects   jsonb,
    sort            text                      NOT NULL DEFAULT 'recent',
    created_at      timestamp with time zone  NOT NULL DEFAULT now(),
    updated_at      timestamp with time zone  NOT NULL DEFAULT now(),

    CONSTRAINT "PK_marketplace_favorites" PRIMARY KEY (id)
);

CREATE INDEX "IDX_marketplace_favorites_account_id" ON marketplace_favorites (account_id);
CREATE UNIQUE INDEX "UQ_favorites_account_name" ON marketplace_favorites (account_id, name);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

-- The NFT seller/buyer wallets scraped from the upstream API. Distinct from
-- `accounts`, which is the sign-in identity; the two share nothing but the word
-- "user" and confusing them is the easiest mistake to make in this schema.
CREATE TABLE users (
    -- Wallet address, lowercased for case-insensitive joins.
    id       text NOT NULL,
    username text,

    CONSTRAINT "PK_users" PRIMARY KEY (id)
);

-- ---------------------------------------------------------------------------
-- marketplace_token_transfers
-- ---------------------------------------------------------------------------

-- The transfer ledger, and the only authority on sold state. It is
-- deliberately independent of marketplace_items: no foreign key, because a
-- transfer has to remain true after the listing it refers to is gone, and
-- because the ledger is backfilled independently of any scrape.
CREATE TABLE marketplace_token_transfers (
    id        serial                      NOT NULL,
    token_id  integer                     NOT NULL,
    game_name text,
    seller_id text                        NOT NULL,
    buyer_id  text                        NOT NULL,
    item_name text                        NOT NULL,
    price     double precision            NOT NULL,
    currency  text                        NOT NULL DEFAULT 'NUMI',
    tx_hash   text                        NOT NULL,
    image_url text,
    created_at timestamp with time zone   NOT NULL,
    claimed   boolean                     NOT NULL DEFAULT false,

    CONSTRAINT "PK_marketplace_token_transfers" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX "IDX_marketplace_token_transfers_tx_hash" ON marketplace_token_transfers (tx_hash);
CREATE INDEX "IDX_marketplace_token_transfers_token_id" ON marketplace_token_transfers (token_id);
CREATE INDEX "IDX_marketplace_token_transfers_game_name" ON marketplace_token_transfers (game_name);
CREATE INDEX "IDX_marketplace_token_transfers_seller_id" ON marketplace_token_transfers (seller_id);
CREATE INDEX "IDX_marketplace_token_transfers_buyer_id" ON marketplace_token_transfers (buyer_id);
CREATE INDEX "IDX_marketplace_token_transfers_item_name" ON marketplace_token_transfers (item_name);
CREATE INDEX "IDX_marketplace_token_transfers_created_at" ON marketplace_token_transfers (created_at);
CREATE INDEX "IDX_marketplace_token_transfers_claimed" ON marketplace_token_transfers (claimed);

-- Expression indexes that TypeORM's decorator metadata cannot express.
--
-- The history list joins `users` on `su.id = LOWER(t.seller_id)`. A plain b-tree
-- on `seller_id` does not help there -- the indexed expression is `id`, the
-- searched one is `LOWER(seller_id)`, so the join is unsargable and falls back
-- to a nested loop over every transfer row. These two fix it.
--
-- What is deliberately NOT here: a trigram index on the searchable name
-- columns. Those endpoints filter with `LOWER(col) LIKE '%term%'`, which cannot
-- use an ordinary b-tree, so the columns once carried GIN + gin_trgm_ops
-- indexes. They were never chosen by the planner at this table size -- scanning
-- a few hundred rows beats consulting an index, and a full history backfill
-- brings this table to roughly 13,000 rows, where a sequential scan is still
-- single-digit milliseconds. Revisit past ~100k rows, where a trigram index
-- earns an extension request.
CREATE INDEX "IDX_transfers_seller_lower" ON marketplace_token_transfers (lower(seller_id));
CREATE INDEX "IDX_transfers_buyer_lower" ON marketplace_token_transfers (lower(buyer_id));

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------

-- A sign-in identity. Distinct from `users` above, which holds NFT wallets
-- scraped from upstream and has nothing to do with signing in.
--
-- Deliberately holds no credential: there is no username and no password hash,
-- so `id` and `role` are all an account has. Google is the only way in, the
-- verified address lives on account_identities, and admin is granted per
-- sign-in from the GOOGLE_ADMIN_EMAILS allowlist rather than stored as
-- something you could log into. Nothing can be forgotten, guessed or reset.
CREATE TABLE accounts (
    id         serial                     NOT NULL,
    role       text                       NOT NULL DEFAULT 'user',
    created_at timestamp with time zone   NOT NULL DEFAULT now(),

    CONSTRAINT "PK_accounts" PRIMARY KEY (id)
);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------

-- Server-side session. Storing sessions in Postgres rather than in a signed
-- cookie means an account can be logged out server-side and keeps the cookie
-- opaque. Only a SHA-256 hash of the token is stored.
CREATE TABLE sessions (
    id         bigserial                   NOT NULL,
    account_id integer                     NOT NULL,
    token_hash text                        NOT NULL,
    created_at timestamp with time zone   NOT NULL DEFAULT now(),
    expires_at timestamp with time zone   NOT NULL,

    CONSTRAINT "PK_sessions" PRIMARY KEY (id),
    CONSTRAINT "FK_sessions_account_id" FOREIGN KEY (account_id)
        REFERENCES accounts (id) ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "IDX_sessions_token_hash" ON sessions (token_hash);
CREATE INDEX "IDX_sessions_account_id" ON sessions (account_id);
CREATE INDEX "IDX_sessions_created_at" ON sessions (created_at);
CREATE INDEX "IDX_sessions_expires_at" ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- account_identities
-- ---------------------------------------------------------------------------

CREATE TABLE account_identities (
    id               serial                     NOT NULL,
    account_id       integer                    NOT NULL,
    -- Only the provider that is actually wired up, but stored as text to stay
    -- extensible.
    provider         text                       NOT NULL,
    -- One account per external identity. Email is deliberately not part of this
    -- key: it is not something an account owner controls, so keying on it would
    -- let anyone who can register an address resembling someone else's claim
    -- their account. Google's `sub` is stable and never reassigned.
    provider_subject text                       NOT NULL,
    -- Informational only; never used to look an account up.
    --
    -- varchar(255), not citext. Nothing compares this column in SQL: identity
    -- is keyed on `sub` above, no unique constraint covers email, and the one
    -- case-insensitive comparison in the app -- the GOOGLE_ADMIN_EMAILS
    -- allowlist -- normalises in application code before comparing. The length
    -- is the RFC 5321 bound on an address and is documentation rather than a
    -- limit anything relies on.
    email            varchar(255),
    picture_url      text,
    created_at       timestamp with time zone   NOT NULL DEFAULT now(),

    CONSTRAINT "PK_account_identities" PRIMARY KEY (id),
    CONSTRAINT "FK_account_identities_account_id" FOREIGN KEY (account_id)
        REFERENCES accounts (id) ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "UQ_identity_provider_subject" ON account_identities (provider, provider_subject);
CREATE INDEX "IDX_account_identities_account_id" ON account_identities (account_id);

-- ---------------------------------------------------------------------------
-- sync_state
-- ---------------------------------------------------------------------------

-- One mutable row per sync kind, not an append-only log of runs.
--
-- The upstream API is public and unauthenticated, so syncing is by far the most
-- expensive thing this app does, and the only questions the UI ever asked were
-- "is it running?" and "when did it last finish, and how much did it get?".
-- Both are answered by one mutable row. The table this replaced grew ~2,880
-- rows a day at the intended cron cadence, held no information the row does not
-- hold, and had to be pruned.
--
-- There is no 'queued' status: sync is serialised by a lock rather than a queue.
CREATE TABLE sync_state (
    kind             text                      NOT NULL,
    mode             text                      NOT NULL DEFAULT 'latest',
    -- Non-null exactly while a run holds the lock, cleared on completion.
    -- This is the lock made durable: it survives a process restart long enough
    -- for boot recovery to notice and mark the run interrupted.
    running_since    timestamp with time zone,
    last_started_at  timestamp with time zone,
    last_finished_at timestamp with time zone,
    -- When a `pending` run last finished, which is not the same question as
    -- last_finished_at. That column is rewritten by every incremental run, and
    -- the incremental cron fires every minute, so it always answers "when did
    -- anything last run" -- never "when did the pending re-check last run". The
    -- daily pending schedule is measured from this one instead, which is why it
    -- cannot be derived from the row: by the time anything asked, the evidence
    -- would have been overwritten.
    --
    -- Null means the re-check has never run, which reads as due immediately --
    -- a re-check that has never happened is overdue by any interval.
    --
    -- Only the `pending` mode writes it, and "clear all" deliberately does not:
    -- a cleared ledger has nothing pending, so the daily job would find zero
    -- rows in a single query.
    last_pending_at  timestamp with time zone,
    last_status      text,
    last_stats       jsonb,
    last_error       text,

    CONSTRAINT "PK_sync_state_kind" PRIMARY KEY (kind)
);