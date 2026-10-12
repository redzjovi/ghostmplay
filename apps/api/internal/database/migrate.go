package database

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	migratepgx "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"

	"github.com/redzjovi/ghostmplay/apps/api/db"
)

// Migrate brings the schema up to date.
//
// Runs at boot unless MIGRATIONS_RUN is explicitly "false". That default is
// deliberate: it removes the entire class of deploy bug where a schema change
// ships without the migration that carries it, and the cost is one no-op
// statement on start. Turning it off is how migrations get run deliberately
// instead, as a one-off job against a production database.
//
// golang-migrate takes an advisory lock for the duration, so several instances
// starting at once is safe: the losers wait rather than racing.
//
// The migration files themselves live in db/migrations and are generated from
// db/schema.sql -- see scripts/gen-baseline.sh.
func Migrate(sqlDB *sql.DB) error {
	return MigrateFS(db.Migrations, sqlDB)
}

// MigrateFS applies an embedded migration set.
//
// Separated from Migrate so a test can apply a fixture set without touching the
// real one. Reusing the caller's *sql.DB rather than opening a second connection
// is what makes this possible, and it also means the migration runs through the
// same SSL and pool configuration as everything else.
func MigrateFS(fsys embed.FS, sqlDB *sql.DB) error {
	driver, err := migratepgx.WithInstance(sqlDB, &migratepgx.Config{})
	if err != nil {
		return fmt.Errorf("migrate: driver: %w", err)
	}

	// The embedded FS is rooted at db/, so the migration files live one level
	// down in "migrations". iofs.New takes the directory within the FS, not the
	// FS root.
	src, err := iofs.New(fsys, "migrations")
	if err != nil {
		return fmt.Errorf("migrate: source: %w", err)
	}

	m, err := migrate.NewWithInstance("iofs", src, "postgres", driver)
	if err != nil {
		return fmt.Errorf("migrate: new: %w", err)
	}

	// ErrNoChange is the steady state, not a failure: on every deploy after the
	// first there is nothing to apply.
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate: up: %w", err)
	}
	return nil
}

// Version reports which migrations have been applied, for the health endpoint
// and for a deploy check.
func Version(sqlDB *sql.DB) (version int, dirty bool, err error) {
	driver, err := migratepgx.WithInstance(sqlDB, &migratepgx.Config{})
	if err != nil {
		return 0, false, fmt.Errorf("migrate: driver: %w", err)
	}
	v, d, err := driver.Version()
	if err != nil {
		// A database with no schema_migrations table has never had a migration
		// applied, which is version 0 rather than an error.
		if errors.Is(err, migrate.ErrNilVersion) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("migrate: version: %w", err)
	}
	return v, d, nil
}
