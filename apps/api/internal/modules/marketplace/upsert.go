package marketplace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/sqlc-dev/pqtype"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/redzjovi/ghostmplay/apps/api/internal/models"
)

// DetailPayload is the jsonb blob that accompanies a listing.
//
// Each field is raw JSON rather than a decoded shape, on purpose. The upstream
// payload is stored and rendered as received, and a Go struct standing in for it
// would drop any field it did not know about at the moment it was written.
type DetailPayload struct {
	Attributes json.RawMessage
	Datas      json.RawMessage
	Infos      json.RawMessage
}

// UpsertItemInput is one listing as the scraper read it upstream.
type UpsertItemInput struct {
	// ID is the upstream item_id, reused verbatim as our primary key. The
	// upstream assigns it, so this is not generated here.
	ID            int32
	TokenID       int32
	SellerID      string
	SellerName    *string
	ImageURL      string
	Name          string
	Currency      string
	Price         float64
	GradeEffect   string
	Level         int32
	Enchant       int32
	EquipmentType string
	CreatedAt     time.Time

	// MintTime arrives as a string in the upstream's own format. It is kept as
	// a string here and parsed once, here, so that a malformed value is a
	// decision this function makes rather than an error every caller has to
	// handle. An absent or unparseable value means "do not touch what we have".
	MintTime *string

	// Detail is nil when no detail fetch was made for this item. In `latest`
	// mode that is the common case: an unchanged listing is never re-fetched,
	// and re-writing the blob it already has would be wasted work.
	Detail *DetailPayload
}

// UpsertFromApi writes one listing, and its detail blob, as the scraper read it.
//
// Three things here are load-bearing and easy to get wrong:
//
//  1. **Relist detection.** A relisted token comes back with a NEW item_id but
//     the SAME token_id. Looking up by id alone misses the existing row, and the
//     insert then trips the unique index on token_id. Matching on either key
//     keeps the original row, which is what preserves its detail blob and its
//     history.
//
//  2. **Only a genuine relist clears sold_at.** A plain re-scrape of a sold
//     item finds the row by id and must keep its sale. If it cleared sold_at,
//     every marketplace sync would resurrect sold listings between the two runs,
//     and only the next history run would put them back.
//
//  3. **The row keeps its original id when relisted.** Only the mutable listing
//     fields are overwritten. The detail row's foreign key points at that id, so
//     changing it would orphan the blob.
func (s *MarketplaceService) UpsertFromApi(ctx context.Context, raw UpsertItemInput) (*models.MarketplaceItem, error) {
	mintTime, hasMintTime := parseOptionalTime(raw.MintTime)

	existing, relisted, err := s.findForUpsert(ctx, raw)
	if err != nil {
		return nil, err
	}

	var saved dbgen.MarketplaceItem
	switch {
	case existing == nil:
		saved, err = s.queries.InsertMarketplaceItem(ctx, dbgen.InsertMarketplaceItemParams{
			ID:            raw.ID,
			TokenID:       raw.TokenID,
			SellerID:      raw.SellerID,
			SellerName:    nullableString(raw.SellerName),
			ImageUrl:      raw.ImageURL,
			Name:          raw.Name,
			Currency:      currencyOrDefault(raw.Currency),
			Price:         raw.Price,
			GradeEffect:   raw.GradeEffect,
			Level:         raw.Level,
			Enchant:       raw.Enchant,
			EquipmentType: raw.EquipmentType,
			CreatedAt:     raw.CreatedAt,
			MintTime:      nullableTimeOrNil(mintTime, hasMintTime),
		})
		if err != nil {
			return nil, fmt.Errorf("insert marketplace item %d: %w", raw.ID, err)
		}

	case relisted:
		saved, err = s.updateListing(ctx, existing.ID, raw, mintTime, hasMintTime)
		if err != nil {
			return nil, err
		}
		// The token is genuinely back on the market: a new listing for a token
		// we already track a sale for. Clear the sale so the browse query shows
		// it again. The guard in MarkItemsSold then keeps the *next* history run
		// from immediately re-selling it using the transfer that predates this
		// listing.
		saved, err = s.queries.ClearMarketplaceItemSold(ctx, saved.ID)
		if err != nil {
			return nil, fmt.Errorf("clear sold state for relisted item %d: %w", saved.ID, err)
		}

	default:
		saved, err = s.updateListing(ctx, existing.ID, raw, mintTime, hasMintTime)
		if err != nil {
			return nil, err
		}
	}

	if err := s.upsertDetail(ctx, saved.ID, raw.Detail); err != nil {
		return nil, err
	}

	item := itemToModel(saved)
	return &item, nil
}

// findForUpsert locates the row this input belongs to.
//
// It returns the row and whether the match came from the token_id fallback.
// That second value is the whole of the relist signal: finding nothing by id and
// then finding something by token_id *is* the definition of a relist.
func (s *MarketplaceService) findForUpsert(ctx context.Context, raw UpsertItemInput) (existing *dbgen.MarketplaceItem, relisted bool, err error) {
	row, err := s.queries.FindMarketplaceItemForUpsertByID(ctx, raw.ID)
	switch {
	case err == nil:
		return &row, false, nil
	case !errors.Is(err, sql.ErrNoRows):
		return nil, false, fmt.Errorf("find marketplace item %d: %w", raw.ID, err)
	}

	// The id did not match. Falling back to token_id is what catches a relist.
	row, err = s.queries.FindMarketplaceItemForUpsertByTokenID(ctx, raw.TokenID)
	switch {
	case err == nil:
		return &row, true, nil
	case !errors.Is(err, sql.ErrNoRows):
		return nil, false, fmt.Errorf("find marketplace item by token %d: %w", raw.TokenID, err)
	}

	// Neither matched: a brand new listing. It is live by definition; sold
	// state arrives later and only ever from the transfer ledger.
	return nil, false, nil
}

// updateListing writes the mutable fields of an existing row.
func (s *MarketplaceService) updateListing(ctx context.Context, id int32, raw UpsertItemInput, mintTime *time.Time, hasMintTime bool) (dbgen.MarketplaceItem, error) {
	saved, err := s.queries.UpdateMarketplaceItem(ctx, dbgen.UpdateMarketplaceItemParams{
		ID:         id,
		TokenID:    raw.TokenID,
		SellerID:   raw.SellerID,
		SellerName: nullableString(raw.SellerName),
		ImageUrl:   raw.ImageURL,
		Name:       raw.Name,
		// An empty currency leaves the stored one alone. Upstream sends it on
		// every response, so this is belt-and-braces rather than a case that
		// occurs -- but a bare "" would otherwise be written through COALESCE
		// as a real value and blank the column.
		Currency:      nullableString(raw.CurrencyOrNil()),
		Price:         raw.Price,
		GradeEffect:   raw.GradeEffect,
		Level:         raw.Level,
		Enchant:       raw.Enchant,
		EquipmentType: raw.EquipmentType,
		CreatedAt:     raw.CreatedAt,
		MintTime:      nullableTimeOrNil(mintTime, hasMintTime),
	})
	if err != nil {
		return dbgen.MarketplaceItem{}, fmt.Errorf("update marketplace item %d: %w", id, err)
	}
	return saved, nil
}

// upsertDetail writes the jsonb blob, if this input carried one.
//
// Each column is coalesced independently: a null in the incoming payload means
// "the upstream did not send this", not "erase what we stored". Upstream
// returns partially-populated details, and blanking a column on a partial
// response would lose data the scrape had already captured.
func (s *MarketplaceService) upsertDetail(ctx context.Context, itemID int32, detail *DetailPayload) error {
	if detail == nil {
		return nil
	}

	_, err := s.queries.GetMarketplaceItemDetail(ctx, itemID)
	switch {
	case err == nil:
		if _, err := s.queries.UpdateMarketplaceItemDetail(ctx, dbgen.UpdateMarketplaceItemDetailParams{
			ItemID:     itemID,
			Attributes: rawMessageParam(detail.Attributes),
			Datas:      rawMessageParam(detail.Datas),
			Infos:      rawMessageParam(detail.Infos),
		}); err != nil {
			return fmt.Errorf("update item detail %d: %w", itemID, err)
		}
		return nil

	case !errors.Is(err, sql.ErrNoRows):
		return fmt.Errorf("find item detail %d: %w", itemID, err)
	}

	if _, err := s.queries.InsertMarketplaceItemDetail(ctx, dbgen.InsertMarketplaceItemDetailParams{
		ItemID:     itemID,
		Attributes: rawMessageParam(detail.Attributes),
		Datas:      rawMessageParam(detail.Datas),
		Infos:      rawMessageParam(detail.Infos),
	}); err != nil {
		return fmt.Errorf("insert item detail %d: %w", itemID, err)
	}
	return nil
}

func currencyOrDefault(currency string) string {
	if currency == "" {
		return "NUMI"
	}
	return currency
}

// CurrencyOrNil reports the currency as nil when there is none, so the update
// path can distinguish "no currency supplied" from "the empty string".
func (u UpsertItemInput) CurrencyOrNil() *string {
	if u.Currency == "" {
		return nil
	}
	return &u.Currency
}

// parseOptionalTime reads an optional upstream timestamp.
//
// The second return value distinguishes "absent or malformed" from "parsed".
// The distinction matters: on insert an unparseable value becomes NULL, and on
// update it leaves the stored value untouched. Folding the two cases into one
// would make a mangled payload erase a good column.
func parseOptionalTime(raw *string) (*time.Time, bool) {
	if raw == nil || *raw == "" {
		return nil, false
	}
	kst := *raw
	t := ParseKST(&kst)
	if t.IsZero() {
		return nil, false
	}
	return &t, true
}

func nullableTimeOrNil(t *time.Time, ok bool) sql.NullTime {
	if !ok || t == nil {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: *t, Valid: true}
}

// rawMessageParam wraps a json.RawMessage for a nullable jsonb parameter.
//
// "null" and the JSON null literal both mean "absent", which the query's COALESCE
// turns into "leave the stored column alone". An empty payload is treated the
// same way: there is nothing to write, and writing an empty jsonb would replace
// real data with nothing.
func rawMessageParam(v json.RawMessage) pqtype.NullRawMessage {
	if len(v) == 0 || string(v) == "null" {
		return pqtype.NullRawMessage{}
	}
	return pqtype.NullRawMessage{RawMessage: v, Valid: true}
}
