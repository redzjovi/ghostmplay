package marketplace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/sqlc-dev/pqtype"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
	"github.com/redzjovi/ghostmplay/apps/api/internal/models"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/dto"
)

// Favorite name bounds. The upper bound is applied after trimming, so a name of
// fifty characters plus surrounding whitespace is accepted rather than rejected
// for a length the user never sees.
const (
	favoriteNameMin = 1
	favoriteNameMax = 50
)

// ListFavorites returns an account's saved filters, by name.
func (s *MarketplaceService) ListFavorites(ctx context.Context, accountID int32) ([]models.MarketplaceFavorite, error) {
	rows, err := s.queries.ListFavoritesByAccount(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("list favorites: %w", err)
	}

	out := make([]models.MarketplaceFavorite, 0, len(rows))
	for _, row := range rows {
		out = append(out, favoriteToModel(row))
	}
	return out, nil
}

// GetFavorite returns one saved filter.
//
// Scoped by account. A favorite belonging to another account is reported as not
// found rather than forbidden, so the endpoint cannot be used to discover which
// ids exist.
func (s *MarketplaceService) GetFavorite(ctx context.Context, accountID, id int32) (*models.MarketplaceFavorite, error) {
	row, err := s.queries.GetFavoriteByIDAndAccount(ctx, dbgen.GetFavoriteByIDAndAccountParams{
		ID:        id,
		AccountID: accountID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, common.NotFound("Favorite not found")
	}
	if err != nil {
		return nil, fmt.Errorf("get favorite: %w", err)
	}
	out := favoriteToModel(row)
	return &out, nil
}

// CreateFavorite saves a new filter set for an account.
func (s *MarketplaceService) CreateFavorite(ctx context.Context, accountID int32, in dto.FavoriteInput) (*models.MarketplaceFavorite, error) {
	name, err := favoriteName(in.Name, true)
	if err != nil {
		return nil, err
	}

	// Advisory: two concurrent creates can both pass this, and the unique index
	// decides between them. The 23505 below produces the same 409, so the probe
	// only makes the common case a clean rejection instead of an error handler.
	exists, err := s.queries.ExistsFavoriteByName(ctx, dbgen.ExistsFavoriteByNameParams{
		AccountID: accountID,
		Name:      name,
	})
	if err != nil {
		return nil, fmt.Errorf("check favorite name: %w", err)
	}
	if exists {
		return nil, duplicateName(name)
	}

	row, err := s.queries.InsertFavorite(ctx, dbgen.InsertFavoriteParams{
		AccountID:      accountID,
		Name:           name,
		Q:              favoriteQ(in.QValue()),
		EquipmentTypes: stringListJSON(in.EquipmentTypesValue()),
		GradeEffects:   stringListJSON(in.GradeEffectsValue()),
		Sort:           in.SortValue(),
	})
	if conflictOnUnique(err) {
		return nil, duplicateName(name)
	}
	if err != nil {
		return nil, fmt.Errorf("insert favorite: %w", err)
	}

	out := favoriteToModel(row)
	return &out, nil
}

// UpdateFavorite edits a saved filter set.
//
// The three cases a field can be in drive everything here: absent fields keep
// their stored value, explicit nulls clear, and values replace. A rename that
// does not resend the filters therefore leaves them intact, which is the point.
//
// The lookup is scoped by account, so another account's id is a 404 rather than
// a 403.
func (s *MarketplaceService) UpdateFavorite(ctx context.Context, accountID, id int32, in dto.FavoriteInput) (*models.MarketplaceFavorite, error) {
	existing, err := s.queries.GetFavoriteByIDAndAccount(ctx, dbgen.GetFavoriteByIDAndAccountParams{
		ID:        id,
		AccountID: accountID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, common.NotFound("Favorite not found")
	}
	if err != nil {
		return nil, fmt.Errorf("find favorite: %w", err)
	}

	name := existing.Name
	if in.Name != nil {
		trimmed, err := favoriteName(in.Name, false)
		if err != nil {
			return nil, err
		}
		// Only check for a clash when the name actually changes. Re-saving the
		// same name would otherwise collide with the row being edited.
		if trimmed != existing.Name {
			exists, err := s.queries.ExistsFavoriteByName(ctx, dbgen.ExistsFavoriteByNameParams{
				AccountID: accountID,
				Name:      trimmed,
			})
			if err != nil {
				return nil, fmt.Errorf("check favorite name: %w", err)
			}
			if exists {
				return nil, duplicateName(trimmed)
			}
			name = trimmed
		}
	}

	// Start from what is stored and overwrite only what was sent. This is what
	// makes a rename leave the filters alone.
	params := dbgen.UpdateFavoriteParams{
		ID:             id,
		AccountID:      accountID,
		Name:           name,
		Q:              existing.Q,
		EquipmentTypes: existing.EquipmentTypes,
		GradeEffects:   existing.GradeEffects,
		Sort:           existing.Sort,
	}
	if in.HasQ() {
		params.Q = favoriteQ(in.QValue())
	}
	if in.HasEquipmentTypes() {
		params.EquipmentTypes = stringListJSON(in.EquipmentTypesValue())
	}
	if in.HasGradeEffects() {
		params.GradeEffects = stringListJSON(in.GradeEffectsValue())
	}
	if in.HasSort() {
		params.Sort = in.SortValue()
	}

	row, err := s.queries.UpdateFavorite(ctx, params)
	if conflictOnUnique(err) {
		return nil, duplicateName(name)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, common.NotFound("Favorite not found")
	}
	if err != nil {
		return nil, fmt.Errorf("update favorite: %w", err)
	}

	out := favoriteToModel(row)
	return &out, nil
}

// DeleteFavorite removes a saved filter set.
func (s *MarketplaceService) DeleteFavorite(ctx context.Context, accountID, id int32) error {
	deleted, err := s.queries.DeleteFavoriteByIDAndAccount(ctx, dbgen.DeleteFavoriteByIDAndAccountParams{
		ID:        id,
		AccountID: accountID,
	})
	if err != nil {
		return fmt.Errorf("delete favorite: %w", err)
	}
	// Zero rows means it was not there, or was not this account's. Same answer
	// either way.
	if deleted == 0 {
		return common.NotFound("Favorite not found")
	}
	return nil
}

// favoriteName validates a favorite's name.
func favoriteName(raw *string, required bool) (string, error) {
	trimmed := ""
	if raw != nil {
		trimmed = strings.TrimSpace(*raw)
	}

	if len(trimmed) < favoriteNameMin {
		if required {
			return "", common.BadRequest("Favorite name is required")
		}
		// On update an explicitly empty name is a clear, not a no-op: the client
		// sent the key, so it meant something by it.
		return "", common.BadRequest("Favorite name is required")
	}
	if len([]rune(trimmed)) > favoriteNameMax {
		return "", common.BadRequest(fmt.Sprintf("Favorite name max %d chars", favoriteNameMax))
	}
	return trimmed, nil
}

func duplicateName(name string) error {
	return common.Conflict(fmt.Sprintf("Favorite %q already exists", name))
}

// favoriteQ turns the parsed q into a nullable column value.
//
// q is plain text, not jsonb, unlike the two lists beside it: it is a single
// search term and there is nothing structured about it.
func favoriteQ(v *string, ok bool) sql.NullString {
	if !ok || v == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *v, Valid: true}
}

// stringListJSON encodes a filter list for a jsonb column.
//
// An empty list is stored as `[]`, not as null, so that "no filter" is one
// representation rather than two.
func stringListJSON(v []string) pqtype.NullRawMessage {
	if v == nil {
		v = []string{}
	}
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte("[]")
	}
	return pqtype.NullRawMessage{RawMessage: b, Valid: true}
}

func favoriteToModel(row dbgen.MarketplaceFavorite) models.MarketplaceFavorite {
	return models.MarketplaceFavorite{
		ID:             row.ID,
		Name:           row.Name,
		Q:              decodeFavoriteQ(row.Q),
		EquipmentTypes: decodeStringList(row.EquipmentTypes),
		GradeEffects:   decodeStringList(row.GradeEffects),
		Sort:           row.Sort,
		CreatedAt:      models.ISO(row.CreatedAt),
		UpdatedAt:      models.ISO(row.UpdatedAt),
	}
}

// decodeFavoriteQ reads the stored q back out.
//
// A NULL column and a stored empty string both come back as nil, which is what
// the client renders as "no search term".
func decodeFavoriteQ(v sql.NullString) *string {
	if !v.Valid || v.String == "" {
		return nil
	}
	s := v.String
	return &s
}

// decodeStringList reads a stored jsonb array back out, falling back to an
// empty slice so the client can iterate without a guard.
func decodeStringList(v pqtype.NullRawMessage) []string {
	out := []string{}
	if !v.Valid || len(v.RawMessage) == 0 || string(v.RawMessage) == "null" {
		return out
	}
	if err := json.Unmarshal(v.RawMessage, &out); err != nil {
		return []string{}
	}
	if out == nil {
		return []string{}
	}
	return out
}
