package database

import (
	"context"
	"database/sql"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
)

// TxManager runs a unit of work inside one transaction.
//
// Services depend on this rather than on *sql.DB so that the read and write
// paths can be exercised without a database: a test substitutes a fake that
// calls the function directly, which is the same trick the repository pattern
// gives and the reason the suite never needs a running PostgreSQL.
type TxManager interface {
	InTx(ctx context.Context, fn func(q dbgen.Querier) error) error
}

type pgTxManager struct{ db *sql.DB }

// NewTxManager returns a TxManager over an open pool.
func NewTxManager(db *sql.DB) TxManager { return &pgTxManager{db: db} }

func (m *pgTxManager) InTx(ctx context.Context, fn func(q dbgen.Querier) error) error {
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	// Rollback on the way out unless the function committed. Ignoring the
	// rollback error is correct: if Commit failed the transaction is already
	// gone, and the commit error is the one worth reporting.
	defer func() { _ = tx.Rollback() }()

	if err := fn(dbgen.New(tx)); err != nil {
		return err
	}
	return tx.Commit()
}

// txPassthrough is a TxManager for tests: it runs the function against a fixed
// querier with no transaction at all.
//
// It exists so a service's transactional method can be unit-tested without
// standing up PostgreSQL. It is in this package so tests outside it can reach
// it, and it is never wired up by NewTxManager.
type txPassthrough struct{ q dbgen.Querier }

// NewPassthroughTx returns a TxManager that does not open a transaction. For
// tests only.
func NewPassthroughTx(q dbgen.Querier) TxManager { return txPassthrough{q: q} }

func (t txPassthrough) InTx(_ context.Context, fn func(q dbgen.Querier) error) error {
	return fn(t.q)
}
