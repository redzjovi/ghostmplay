package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
)

// The other tests in the repo cannot see a broken statement.
//
// Every other query test runs against fakeQuerier, which records calls and returns
// canned rows without ever handing a string to Postgres. That is the right trade
// for the ninety-nine percent of the query surface that is arithmetic and
// filtering, and it is total blindness for the one percent that is "does this
// statement parse". UpsertSyncRunFinished named its timestamp parameter twice --
// once bare in a column position, once inside a CASE -- which Postgres rejects at
// parse time with SQLSTATE 42P08, "inconsistent types deduced for parameter $2".
// Every call failed, every run finished without clearing running_since, and every
// sync kind sat permanently marked as running. The whole suite stayed green
// throughout, and it took a production log line to find.
//
// So these run the real statements against a real database, on the same terms as
// the migration tests above: GHOSTMPLAY_TEST_DATABASE_URL, skipped when unset,
// each test in a scratch database that is dropped afterwards.

// statementsPostgresCannotParse are the SQLSTATEs that mean the statement itself
// is wrong, as opposed to the data being wrong.
//
// The list is deliberately short. Every other failure -- a foreign key on a
// zero-valued argument, a CHECK constraint, sql.ErrNoRows from a :one that matched
// nothing -- is expected here and says nothing about whether the SQL is valid, so
// those are counted rather than failed on. Widening it is cheap; widening it too
// far turns a sweep into a fixture problem.
var statementsPostgresCannotParse = map[string]string{
	"42601": "syntax error",
	"42P08": "inconsistent types deduced for a parameter",
	"42703": "undefined column",
	"42P02": "undefined function",
	"42883": "undefined type",
}

// TestEveryGeneratedQueryExecutes calls every generated query against a real
// database and fails only on an error that means the statement cannot run at all.
//
// Each query runs inside its own transaction that is rolled back, which is what
// makes it safe to sweep unconditional DELETEs and UPDATEs across the whole
// generated surface. Arguments are zero values, and none of them need to be valid:
// the parse happens before the values are looked at, and that ordering is the
// entire reason this test works.
//
// Anything skipped is reported rather than hidden. A method reflection cannot
// invoke is a gap in coverage, and a gap nobody prints is a gap nobody closes.
func TestEveryGeneratedQueryExecutes(t *testing.T) {
	adminURL := testDB(t)
	db := migratedScratchDB(t, adminURL)
	ctx := context.Background()

	queriesType := reflect.TypeOf(dbgen.New(db))
	contextType := reflect.TypeOf((*context.Context)(nil)).Elem()
	errorType := reflect.TypeOf((*error)(nil)).Elem()

	var checked int
	var skipped []string
	tolerated := map[string]string{}

	for i := 0; i < queriesType.NumMethod(); i++ {
		method := queriesType.Method(i)

		// A query is (*Queries).Method(context.Context) or
		// (*Queries).Method(context.Context, ParamsStruct). WithTx is neither --
		// it takes a *sql.Tx and returns *Queries -- so it falls out of this shape
		// rather than being excluded by name, and a future helper cannot be
		// mistaken for a query.
		numArgs := method.Type.NumIn() - 1 // less the receiver
		if numArgs < 1 || numArgs > 2 || method.Type.In(1) != contextType {
			skipped = append(skipped, method.Name)
			continue
		}

		args := []reflect.Value{reflect.ValueOf(ctx)}
		if numArgs == 2 {
			args = append(args, reflect.New(method.Type.In(2)).Elem()) // zero-valued params
		}

		execErr := runInRolledBackTx(ctx, db, func(q *dbgen.Queries) error {
			out := reflect.ValueOf(q).Method(i).Call(args)
			last := out[len(out)-1]
			if !last.Type().Implements(errorType) || last.IsNil() {
				return nil
			}
			return last.Interface().(error)
		})
		checked++

		if execErr == nil {
			continue
		}

		var pgErr *pgconn.PgError
		if errors.As(execErr, &pgErr) {
			if why, fatal := statementsPostgresCannotParse[pgErr.Code]; fatal {
				t.Errorf("%s: postgres rejected the statement (%s: %s): %s",
					method.Name, pgErr.Code, why, pgErr.Message)
				continue
			}
			tolerated[method.Name] = pgErr.Code + ": " + pgErr.Message
			continue
		}
		tolerated[method.Name] = execErr.Error()
	}

	t.Logf("executed %d generated queries", checked)
	if len(tolerated) > 0 {
		// Printed rather than asserted, but deliberately visible: if a query starts
		// failing for a data reason, that is worth noticing even though this test
		// is not the place to judge it.
		names := make([]string, 0, len(tolerated))
		for name := range tolerated {
			names = append(names, name)
		}
		sort.Strings(names)
		t.Logf("%d queries hit a data-level error, which this test tolerates:", len(names))
		for _, name := range names {
			t.Logf("  %s: %s", name, tolerated[name])
		}
	}
	if len(skipped) > 0 {
		sort.Strings(skipped)
		t.Logf("not exercised (not a ctx+params method): %v", skipped)
	}
	if checked == 0 {
		t.Fatal("no queries were executed at all -- the sweep is not testing anything")
	}
}

// migratedScratchDB is a throwaway database with the real schema applied, which
// is what the queries have to be parsed against.
func migratedScratchDB(t *testing.T, adminURL string) *sql.DB {
	t.Helper()
	url := scratchDatabase(t, adminURL)

	db, err := Open(context.Background(), Options{URL: url})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

// runInRolledBackTx runs fn against a transaction and always rolls it back.
//
// The rollback is a defer rather than a statement at the end of the function body,
// so a failing assertion inside fn cannot leave the transaction open holding a
// lock for the rest of the run.
func runInRolledBackTx(ctx context.Context, db *sql.DB, fn func(*dbgen.Queries) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	return fn(dbgen.New(tx))
}

// TestUpsertSyncRunFinishedKeepsTheWatermarkHonest pins the behaviour of the
// statement that was broken, because "it parses" is a low bar for the query whose
// job is to decide whether the daily pending re-check is due.
//
// Three things hold at once: a terminal write always clears running_since, only a
// pending run moves the watermark, and a non-pending run leaves the previous
// watermark alone. The third is the one a broken conditional quietly loses -- a
// watermark that never moves looks identical to a re-check that is merely due,
// from both the panel and the scheduler.
func TestUpsertSyncRunFinishedKeepsTheWatermarkHonest(t *testing.T) {
	adminURL := testDB(t)
	db := migratedScratchDB(t, adminURL)
	ctx := context.Background()

	const kind = "watermark-under-test"

	if err := runInRolledBackTx(ctx, db, func(q *dbgen.Queries) error {
		if err := q.UpsertSyncRunStarted(ctx, dbgen.UpsertSyncRunStartedParams{
			Kind:         kind,
			Mode:         "pending",
			RunningSince: nullTime(time.Now().Add(-time.Minute)),
		}); err != nil {
			return fmt.Errorf("start pending: %w", err)
		}

		firstFinish := time.Now().Add(-time.Minute).UTC().Truncate(time.Microsecond)
		if err := q.UpsertSyncRunFinished(ctx, dbgen.UpsertSyncRunFinishedParams{
			Kind:           kind,
			Mode:           "pending",
			LastFinishedAt: firstFinish,
			LastStatus:     nullString("done"),
		}); err != nil {
			return fmt.Errorf("finish pending: %w", err)
		}

		state, err := q.GetSyncState(ctx, kind)
		if err != nil {
			return fmt.Errorf("read after pending: %w", err)
		}
		if state.RunningSince.Valid {
			t.Error("running_since survived a pending run's terminal write")
		}
		if !state.LastPendingAt.Valid {
			t.Fatal("a pending run did not stamp last_pending_at")
		}
		pendingAt := state.LastPendingAt.Time

		// A second run, not a pending one. It has to finish, and it has to leave
		// the watermark exactly where the pending run put it.
		if err := q.UpsertSyncRunStarted(ctx, dbgen.UpsertSyncRunStartedParams{
			Kind:         kind,
			Mode:         "latest",
			RunningSince: nullTime(time.Now().Add(-time.Second)),
		}); err != nil {
			return fmt.Errorf("start latest: %w", err)
		}

		secondFinish := firstFinish.Add(time.Second)
		if err := q.UpsertSyncRunFinished(ctx, dbgen.UpsertSyncRunFinishedParams{
			Kind:           kind,
			Mode:           "latest",
			LastFinishedAt: secondFinish,
			LastStatus:     nullString("done"),
		}); err != nil {
			return fmt.Errorf("finish latest: %w", err)
		}

		state, err = q.GetSyncState(ctx, kind)
		if err != nil {
			return fmt.Errorf("read after latest: %w", err)
		}
		if state.RunningSince.Valid {
			t.Error("running_since survived a latest run's terminal write")
		}
		if !state.LastFinishedAt.Valid || !state.LastFinishedAt.Time.Equal(secondFinish) {
			t.Errorf("last_finished_at = %v, want %v", state.LastFinishedAt.Time, secondFinish)
		}
		if !state.LastPendingAt.Valid {
			t.Fatal("a latest run wiped the pending watermark")
		}
		if !state.LastPendingAt.Time.Equal(pendingAt) {
			t.Errorf("last_pending_at moved on a latest run: %v, want %v",
				state.LastPendingAt.Time, pendingAt)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func nullTime(t time.Time) sql.NullTime { return sql.NullTime{Time: t, Valid: true} }

func nullString(s string) sql.NullString { return sql.NullString{String: s, Valid: true} }