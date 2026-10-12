// Package db carries the schema itself.
//
// The migrations live in db/migrations and the schema sqlc reads is
// db/schema.sql; both are here because this package embeds the migrations into
// the binary. Nothing is read from disk at runtime, which matters on Voroa: the
// container's filesystem holds build output and nothing else, so a migration
// directory that lived beside the source would not be there to be read.
//
// The embed lives here rather than in internal/database because go:embed cannot
// reference a parent directory.
package db

import "embed"

// Migrations holds db/migrations/*.sql.
//
//go:embed all:migrations
var Migrations embed.FS
