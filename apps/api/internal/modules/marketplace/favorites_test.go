package marketplace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/sqlc-dev/pqtype"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
	"github.com/redzjovi/ghostmplay/apps/api/internal/database"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/dto"
)

// fakeFavQuerier serves the handful of favourite queries the service touches.
// Like the sync fake, the embedded interface makes an unexpected call panic.
type fakeFavQuerier struct {
	dbgen.Querier

	getByID     dbgen.MarketplaceFavorite
	getErr      error
	nameExists  bool
	inserted    dbgen.InsertFavoriteParams
	updateParam dbgen.UpdateFavoriteParams
	updateRow   dbgen.MarketplaceFavorite
	deleted     int64
}

func (f *fakeFavQuerier) GetFavoriteByIDAndAccount(context.Context, dbgen.GetFavoriteByIDAndAccountParams) (dbgen.MarketplaceFavorite, error) {
	if f.getErr != nil {
		return dbgen.MarketplaceFavorite{}, f.getErr
	}
	return f.getByID, nil
}

func (f *fakeFavQuerier) ExistsFavoriteByName(context.Context, dbgen.ExistsFavoriteByNameParams) (bool, error) {
	return f.nameExists, nil
}

func (f *fakeFavQuerier) InsertFavorite(_ context.Context, p dbgen.InsertFavoriteParams) (dbgen.MarketplaceFavorite, error) {
	if f.nameExists {
		// Emulate the unique index raising 23505, the way a real race would.
		return dbgen.MarketplaceFavorite{}, &pgconn.PgError{Code: "23505"}
	}
	f.inserted = p
	return favWith(p), nil
}

func (f *fakeFavQuerier) UpdateFavorite(_ context.Context, p dbgen.UpdateFavoriteParams) (dbgen.MarketplaceFavorite, error) {
	f.updateParam = p
	return f.updateRow, nil
}

func (f *fakeFavQuerier) DeleteFavoriteByIDAndAccount(context.Context, dbgen.DeleteFavoriteByIDAndAccountParams) (int64, error) {
	return f.deleted, nil
}

func favWith(p dbgen.InsertFavoriteParams) dbgen.MarketplaceFavorite {
	return dbgen.MarketplaceFavorite{
		ID: 1, AccountID: p.AccountID, Name: p.Name,
		Q: p.Q, EquipmentTypes: p.EquipmentTypes, GradeEffects: p.GradeEffects,
		Sort: p.Sort,
	}
}

func favService(q *fakeFavQuerier) *MarketplaceService {
	return NewMarketplaceService(q, database.NewPassthroughTx(q), discardLogger())
}

// The three-way distinction -- absent, explicit null, value -- is the whole
// reason FavoriteInput carries raw JSON. These cases pin each one.

func TestCreateFavoriteRequiresAName(t *testing.T) {
	q := &fakeFavQuerier{}
	svc := favService(q)

	for _, body := range []string{`{}`, `{"name":""}`, `{"name":"   "}`, `{"name":null}`} {
		_, err := svc.CreateFavorite(context.Background(), 1, parseBody(t, body))
		if err == nil {
			t.Errorf("CreateFavorite(%s) succeeded, want a validation error", body)
			continue
		}
		var apiErr *common.Error
		if !errors.As(err, &apiErr) || apiErr.Status != 400 {
			t.Errorf("CreateFavorite(%s) error = %v, want a 400", body, err)
		}
	}
}

func TestCreateFavoriteRejectsLongName(t *testing.T) {
	long := make([]byte, 51)
	for i := range long {
		long[i] = 'x'
	}
	q := &fakeFavQuerier{}
	svc := favService(q)

	_, err := svc.CreateFavorite(context.Background(), 1, parseBody(t, `{"name":"`+string(long)+`"}`))
	var apiErr *common.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 400 {
		t.Errorf("a 51-character name was accepted: %v", err)
	}
}

func TestCreateFavoriteRejectsDuplicateName(t *testing.T) {
	q := &fakeFavQuerier{nameExists: true}
	svc := favService(q)

	_, err := svc.CreateFavorite(context.Background(), 1, parseBody(t, `{"name":"Rare gear"}`))
	var apiErr *common.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 409 {
		t.Errorf("duplicate name error = %v, want a 409", err)
	}
}

// A rename that does not resend the filters must leave them alone. This is the
// bug the raw-JSON input exists to prevent.
func TestUpdateFavoriteRenamePreservesFilters(t *testing.T) {
	stored := dbgen.MarketplaceFavorite{
		ID: 5, AccountID: 1, Name: "old",
		Q:              sql.NullString{String: "blade", Valid: true},
		EquipmentTypes: jsonList(`["Armor"]`),
		GradeEffects:   jsonList(`["Rare"]`),
		Sort:           "price_asc",
	}
	q := &fakeFavQuerier{getByID: stored, updateRow: stored}
	svc := favService(q)

	// Only the name is sent. The service must write back the stored filters.
	_, err := svc.UpdateFavorite(context.Background(), 1, 5, parseBody(t, `{"name":"new"}`))
	if err != nil {
		t.Fatalf("UpdateFavorite: %v", err)
	}
	if q.updateParam.Name != "new" {
		t.Errorf("Name = %q, want new", q.updateParam.Name)
	}
	if q.updateParam.Q.String != "blade" {
		t.Errorf("q = %q, want the stored value preserved", q.updateParam.Q.String)
	}
	if decodeStoredList(q.updateParam.EquipmentTypes) != "Armor" {
		t.Errorf("equipmentTypes = %s, want the stored value preserved", decodeStoredList(q.updateParam.EquipmentTypes))
	}
	if q.updateParam.Sort != "price_asc" {
		t.Errorf("sort = %q, want the stored value preserved", q.updateParam.Sort)
	}
}

// An explicit null must clear the field, which is distinct from leaving it.
func TestUpdateFavoriteNullClearsSearch(t *testing.T) {
	stored := dbgen.MarketplaceFavorite{
		ID: 5, AccountID: 1, Name: "old",
		Q:    sql.NullString{String: "blade", Valid: true},
		Sort: "recent",
	}
	q := &fakeFavQuerier{getByID: stored, updateRow: stored}
	svc := favService(q)

	_, err := svc.UpdateFavorite(context.Background(), 1, 5, parseBody(t, `{"q":null}`))
	if err != nil {
		t.Fatalf("UpdateFavorite: %v", err)
	}
	if q.updateParam.Q.Valid {
		t.Errorf("q = %q (valid), want cleared by an explicit null", q.updateParam.Q.String)
	}
}

func TestUpdateFavoriteMissingIsNotFound(t *testing.T) {
	q := &fakeFavQuerier{getErr: sql.ErrNoRows}
	svc := favService(q)

	_, err := svc.UpdateFavorite(context.Background(), 1, 5, parseBody(t, `{"name":"new"}`))
	var apiErr *common.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 404 {
		t.Errorf("updating a missing favorite = %v, want a 404", err)
	}
}

// Another account's id is a 404, not a 403, so the endpoint cannot be used to
// discover which ids exist.
func TestFavoriteOfAnotherAccountIsNotFound(t *testing.T) {
	q := &fakeFavQuerier{getErr: sql.ErrNoRows}
	svc := favService(q)

	_, err := svc.GetFavorite(context.Background(), 1, 99)
	var apiErr *common.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 404 {
		t.Errorf("GetFavorite = %v, want a 404 for another account's id", err)
	}
}

func TestDeleteMissingFavoriteIsNotFound(t *testing.T) {
	q := &fakeFavQuerier{deleted: 0}
	svc := favService(q)

	err := svc.DeleteFavorite(context.Background(), 1, 5)
	var apiErr *common.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 404 {
		t.Errorf("DeleteFavorite = %v, want a 404 when nothing was deleted", err)
	}
}

func jsonList(s string) pqtype.NullRawMessage {
	return pqtype.NullRawMessage{RawMessage: json.RawMessage(s), Valid: true}
}

func decodeStoredList(v pqtype.NullRawMessage) string {
	var out []string
	json.Unmarshal(v.RawMessage, &out)
	if len(out) == 0 {
		return ""
	}
	return out[0]
}

// parseBody builds a FavoriteInput from a JSON body, through the same parser the
// controller uses.
func parseBody(t *testing.T, body string) dto.FavoriteInput {
	t.Helper()
	in, err := dto.ParseFavoriteBody([]byte(body))
	if err != nil {
		t.Fatalf("parse %s: %v", body, err)
	}
	return in
}

// discardLogger is a logger that throws everything away, so a test's output is
// only what it asserts on.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
