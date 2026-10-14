package database

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"os"
	"path"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/redzjovi/ghostmplay/apps/api/db"
)

// These tests need a real PostgreSQL, which is not something `go test ./...`
// should assume. They run when GHOSTMPLAY_TEST_DATABASE_URL is set -- the local
// docker compose service, in practice -- and skip otherwise.
//
// The reason they are worth having at all is that the migration runner and
// db/schema.sql are checked in separately from db/sqlc, and nothing at compile
// time notices when the three disagree. The failure mode is a query that
// type-checks and then errors at runtime, which is exactly the kind of thing
// that only shows up after a deploy.

func testDB(t *testing.T) string {
	t.Helper()
	url := os.Getenv("GHOSTMPLAY_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("GHOSTMPLAY_TEST_DATABASE_URL not set; skipping database tests")
	}
	return url
}

// scratchDatabase creates an empty database and drops it when the test ends.
func scratchDatabase(t *testing.T, adminURL string) string {
	t.Helper()
	ctx := context.Background()

	admin, err := sql.Open("pgx", adminURL)
	if err != nil {
		t.Fatalf("open admin db: %v", err)
	}
	defer admin.Close()

	name := fmt.Sprintf("gmtest_%s_%d", strings.ToLower(strings.ReplaceAll(t.Name(), "/", "_")),
		time.Now().UnixNano()%1_000_000)

	if _, err := admin.ExecContext(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
		t.Fatalf("drop stale scratch db: %v", err)
	}
	if _, err := admin.ExecContext(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create scratch db: %v", err)
	}
	t.Cleanup(func() {
		// FORCE handles the case where a connection was left open by a failed
		// assertion; without it the drop fails and every later test sees a
		// database that already exists.
		admin.ExecContext(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		admin.Close()
	})

	return swapDatabase(adminURL, name)
}

// swapDatabase points a postgres URL at a different database on the same server.
func swapDatabase(rawURL, name string) string {
	i := strings.LastIndex(rawURL, "/")
	j := strings.Index(rawURL[i+1:], "?")
	if j < 0 {
		return rawURL[:i+1] + name
	}
	return rawURL[:i+1] + name + rawURL[i+1+j:]
}

// latestMigrationVersion is the version the schema should be at once every
// migration has run.
//
// Read off the embedded files rather than restated here, because this is the
// number that changes and the one a test is least able to reason about on its own.
// Only .up.sql files count: a down migration moves the schema backwards and
// golang-migrate still records the version of the pair.
func latestMigrationVersion(t *testing.T) uint {
	t.Helper()

	entries, err := fs.Glob(db.Migrations, "migrations/*.up.sql")
	if err != nil {
		t.Fatalf("glob migrations: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("no migrations found in the embedded filesystem")
	}

	var latest uint
	for _, name := range entries {
		// "migrations/000002_last_pending_at.up.sql" -> 2
		base := path.Base(name)
		digits := strings.TrimLeft(base, "0123456789")
		if digits == base {
			t.Fatalf("migration %q does not start with a version number", base)
		}
		n, err := strconv.ParseUint(base[:len(base)-len(digits)], 10, 32)
		if err != nil {
			t.Fatalf("parse version from %q: %v", base, err)
		}
		if uint(n) > latest {
			latest = uint(n)
		}
	}
	return latest
}

func TestMigrateCreatesTheSchema(t *testing.T) {
	adminURL := testDB(t)
	url := scratchDatabase(t, adminURL)

	sqlDB, err := Open(context.Background(), Options{URL: url})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer sqlDB.Close()

	if err := Migrate(sqlDB); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	version, dirty, err := Version(sqlDB)
	if err != nil {
		t.Fatalf("version: %v", err)
	}
	// Derived from the migration files rather than written down. A hardcoded
	// number here went stale the moment a second migration was added, and because
	// these tests only run when GHOSTMPLAY_TEST_DATABASE_URL is set, it sat wrong
	// and unrun at the same time.
	if want := int(latestMigrationVersion(t)); version != want {
		t.Errorf("schema version = %d, want %d", version, want)
	}
	if dirty {
		t.Error("schema is dirty; a migration did not finish")
	}

	// Every table the app reads must exist. sync_state is in this list because
	// it is the one a fresh database would be missing if the seed in the
	// baseline migration were ever dropped -- and nothing else would notice.
	for _, table := range []string{
		"marketplace_items", "marketplace_item_detail", "marketplace_favorites",
		"users", "marketplace_token_transfers", "accounts",
		"account_identities", "sessions", "sync_state",
	} {
		var exists bool
		err := sqlDB.QueryRow(
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables
			                WHERE table_schema='public' AND table_name=$1)`, table).Scan(&exists)
		if err != nil {
			t.Fatalf("check table %s: %v", table, err)
		}
		if !exists {
			t.Errorf("table %s does not exist after migrating", table)
		}
	}
}

func TestMigrateSeedsBothSyncKinds(t *testing.T) {
	adminURL := testDB(t)
	url := scratchDatabase(t, adminURL)

	sqlDB, err := Open(context.Background(), Options{URL: url})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer sqlDB.Close()

	if err := Migrate(sqlDB); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// The sync panel reads one row per kind. A kind with no row is reported as
	// never-run, which on a fresh database would be indistinguishable from a
	// sync that has silently never been scheduled.
	rows, err := sqlDB.Query(`SELECT kind, mode FROM sync_state ORDER BY kind`)
	if err != nil {
		t.Fatalf("query sync_state: %v", err)
	}
	defer rows.Close()

	var kinds []string
	for rows.Next() {
		var kind, mode string
		if err := rows.Scan(&kind, &mode); err != nil {
			t.Fatalf("scan: %v", err)
		}
		kinds = append(kinds, kind)
		if mode != "latest" {
			t.Errorf("sync_state[%s].mode = %q, want %q", kind, mode, "latest")
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate: %v", err)
	}

	want := []string{"history", "marketplace"}
	if strings.Join(kinds, ",") != strings.Join(want, ",") {
		t.Errorf("seeded kinds = %v, want %v", kinds, want)
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	adminURL := testDB(t)
	url := scratchDatabase(t, adminURL)

	sqlDB, err := Open(context.Background(), Options{URL: url})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer sqlDB.Close()

	if err := Migrate(sqlDB); err != nil {
		t.Fatalf("first migrate: %v", err)
	}
	// The second run is what happens on every deploy after the first. It must
	// be a clean no-op rather than an error: ErrNoChange is normal.
	if err := Migrate(sqlDB); err != nil {
		t.Fatalf("second migrate should be a no-op, got: %v", err)
	}
}

// The index the default browse query depends on. If this one ever goes missing,
// every page of the marketplace list turns into a sort over live listings and
// nothing else in the schema would fail loudly enough to notice.
func TestActiveListingsIndexExists(t *testing.T) {
	adminURL := testDB(t)
	url := scratchDatabase(t, adminURL)

	sqlDB, err := Open(context.Background(), Options{URL: url})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer sqlDB.Close()

	if err := Migrate(sqlDB); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	var def string
	err = sqlDB.QueryRow(
		`SELECT indexdef FROM pg_indexes
		 WHERE schemaname='public' AND indexname='idx_items_active_sold_at'`).Scan(&def)
	if err != nil {
		t.Fatalf("idx_items_active_sold_at is missing: %v", err)
	}
	if !strings.Contains(def, "WHERE") || !strings.Contains(def, "DESC") {
		t.Errorf("idx_items_active_sold_at = %q, want a partial DESC index", def)
	}
}

func TestEmbeddedMigrationsMatchTheCheckedInFiles(t *testing.T) {
	entries, err := db.Migrations.ReadDir("migrations")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}

	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	joined := strings.Join(names, ",")
	if !strings.Contains(joined, "000001_baseline.up.sql") ||
		!strings.Contains(joined, "000001_baseline.down.sql") {
		t.Errorf("embedded migrations = %v, want the 000001 baseline pair", names)
	}
}
