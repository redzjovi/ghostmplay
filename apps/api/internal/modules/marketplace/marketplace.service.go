// Package marketplace holds the listings, the transfer ledger, and the scraper
// that fills both.
//
// The service layer's job here is narrow: turn a parsed query into sqlc
// parameters, turn a database row into a response model, and keep the
// invariants that the SQL cannot express. Everything else is in
// db/queries/marketplace.sql and db/queries/history.sql.
package marketplace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/sqlc-dev/pqtype"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/redzjovi/ghostmplay/apps/api/internal/database"
	"github.com/redzjovi/ghostmplay/apps/api/internal/models"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/dto"
)

// MarketplaceService reads and writes listings.
type MarketplaceService struct {
	queries dbgen.Querier
	tx      database.TxManager
	log     *slog.Logger
}

// NewMarketplaceService builds the service. The querier is an interface so tests
// can substitute a fake without a database; the transaction manager is a second
// seam for the same reason, since the only method that needs one is ClearAll.
func NewMarketplaceService(queries dbgen.Querier, tx database.TxManager, log *slog.Logger) *MarketplaceService {
	return &MarketplaceService{queries: queries, tx: tx, log: log}
}

// List returns one page of live listings.
//
// Live means sold_at IS NULL, and that filter lives in SQL rather than here so
// it cannot be forgotten by a new caller.
func (s *MarketplaceService) List(ctx context.Context, q dto.MarketplaceListQuery) (models.List[models.MarketplaceItem], error) {
	rows, err := s.listRows(ctx, q)
	if err != nil {
		return models.List[models.MarketplaceItem]{}, err
	}

	total, err := s.queries.CountMarketplaceItems(ctx, dbgen.CountMarketplaceItemsParams{
		Q:              nullableString(q.Q),
		EquipmentTypes: nonNil(q.EquipmentTypes),
		GradeEffects:   nonNil(q.GradeEffects),
		Level:          nullableInt32(q.Level),
	})
	if err != nil {
		return models.List[models.MarketplaceItem]{}, fmt.Errorf("count marketplace items: %w", err)
	}

	data := make([]models.MarketplaceItem, 0, len(rows))
	for _, row := range rows {
		data = append(data, itemToModel(row))
	}

	return models.List[models.MarketplaceItem]{
		Data:  data,
		Total: int(total),
		Page:  q.Page,
		Limit: q.Limit,
	}, nil
}

// listRows dispatches to the query for the requested sort.
func (s *MarketplaceService) listRows(ctx context.Context, q dto.MarketplaceListQuery) ([]dbgen.MarketplaceItem, error) {
	offset := int32(q.Offset())
	limit := int32(q.Limit)

	switch q.Sort {
	case "price_asc", "price_desc":
		// One query for both directions: multiplying by -1 turns an ascending
		// sort into a descending one. There is no index on price either way, so
		// this costs nothing that a second query would have saved, and it keeps
		// the browse predicate written twice instead of three times.
		sign := int32(1)
		if q.Sort == "price_desc" {
			sign = -1
		}
		return s.queries.ListMarketplaceItemsByPrice(ctx, dbgen.ListMarketplaceItemsByPriceParams{
			Q:              nullableString(q.Q),
			EquipmentTypes: nonNil(q.EquipmentTypes),
			GradeEffects:   nonNil(q.GradeEffects),
			Level:          nullableInt32(q.Level),
			PriceSign:      sign,
			Offset:         offset,
			Limit:          limit,
		})
	default:
		// "recent", "created_at_desc" and no sort at all. This is the query the
		// partial index on (created_at DESC) WHERE sold_at IS NULL exists for,
		// and it is the one the default view and the cron both hit.
		return s.queries.ListMarketplaceItemsRecent(ctx, dbgen.ListMarketplaceItemsRecentParams{
			Q:              nullableString(q.Q),
			EquipmentTypes: nonNil(q.EquipmentTypes),
			GradeEffects:   nonNil(q.GradeEffects),
			Level:          nullableInt32(q.Level),
			Offset:         offset,
			Limit:          limit,
		})
	}
}

// GetByTokenID resolves one listing and its detail blob.
//
// Deliberately not filtered on sold_at: a deep link to a sold token still has
// to resolve so the detail page can render "sold out". Returns nil, nil when
// the token is unknown, which is a 200 with a null body rather than a 404 --
// the client distinguishes "no such token" from "listed".
func (s *MarketplaceService) GetByTokenID(ctx context.Context, tokenID int32) (*models.ItemWithDetail, error) {
	item, err := s.queries.GetMarketplaceItemByTokenID(ctx, tokenID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get marketplace item by token: %w", err)
	}

	out := &models.ItemWithDetail{Item: itemToModel(item)}

	detail, err := s.queries.GetMarketplaceItemDetail(ctx, item.ID)
	if errors.Is(err, sql.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get marketplace item detail: %w", err)
	}

	out.Detail = detailToModel(detail)
	return out, nil
}

// GetDistinctEquipmentTypes lists the equipment types present on live listings.
//
// Scoped to live listings: without that scope the dropdowns keep offering types
// that nothing in the list can match, so the user picks one and gets an empty
// page. The SQL has the scope; this is the caller.
func (s *MarketplaceService) GetDistinctEquipmentTypes(ctx context.Context) ([]string, error) {
	rows, err := s.queries.ListDistinctEquipmentTypes(ctx)
	if err != nil {
		return nil, fmt.Errorf("list distinct equipment types: %w", err)
	}
	return nonNilStrings(rows), nil
}

// GetDistinctGradeEffects lists the grade effects present on live listings.
func (s *MarketplaceService) GetDistinctGradeEffects(ctx context.Context) ([]string, error) {
	rows, err := s.queries.ListDistinctGradeEffects(ctx)
	if err != nil {
		return nil, fmt.Errorf("list distinct grade effects: %w", err)
	}
	return nonNilStrings(rows), nil
}

// GetDistinctFilters returns both dropdown lists.
func (s *MarketplaceService) GetDistinctFilters(ctx context.Context) (models.MarketplaceFilterOptions, error) {
	types, err := s.GetDistinctEquipmentTypes(ctx)
	if err != nil {
		return models.MarketplaceFilterOptions{}, err
	}
	effects, err := s.GetDistinctGradeEffects(ctx)
	if err != nil {
		return models.MarketplaceFilterOptions{}, err
	}
	return models.MarketplaceFilterOptions{
		EquipmentTypes: types,
		GradeEffects:   effects,
	}, nil
}

// FindPriceByID returns one listing's price, or nil if it is gone.
func (s *MarketplaceService) FindPriceByID(ctx context.Context, id int32) (*float64, error) {
	price, err := s.queries.FindMarketplaceItemPrice(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find item price: %w", err)
	}
	return &price, nil
}

// FindPricesMap returns id -> price for a batch of listings.
//
// Absent ids are simply missing from the map, which is what the caller wants:
// during a sync the upstream may offer an item that was deleted from our side
// and there is nothing to report for it.
func (s *MarketplaceService) FindPricesMap(ctx context.Context, ids []int32) (map[int32]float64, error) {
	out := make(map[int32]float64, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.queries.FindMarketplaceItemPrices(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("find item prices: %w", err)
	}
	for _, row := range rows {
		out[row.ID] = row.Price
	}
	return out, nil
}

// FindCreatedAtMap returns id -> created-at in EPOCH SECONDS, floored.
//
// The unit is load-bearing and not a detail: the upstream reports created_at in
// epoch seconds, and the sync compares the two for equality to decide whether a
// listing is new. Flooring discards the sub-second part so that comparison is a
// stable integer equality rather than an instant comparison that could differ by
// rounding on either side.
func (s *MarketplaceService) FindCreatedAtMap(ctx context.Context, ids []int32) (map[int32]int64, error) {
	out := make(map[int32]int64, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.queries.FindMarketplaceItemCreatedAt(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("find item created_at: %w", err)
	}
	for _, row := range rows {
		out[row.ID] = row.CreatedAt.Unix()
	}
	return out, nil
}

// MarkItemsSold reconciles listings against the transfer ledger and returns how
// many it marked.
//
// The statement lives in SQL -- see MarkItemsSold in db/queries/marketplace.sql
// for why it is table-wide and what each clause is for. The count comes from
// RETURNING; without it the sync panel would report "0 sold" on every run.
func (s *MarketplaceService) MarkItemsSold(ctx context.Context) (int, error) {
	ids, err := s.queries.MarkItemsSold(ctx)
	if err != nil {
		return 0, fmt.Errorf("mark items sold: %w", err)
	}
	return len(ids), nil
}

// ClearResult reports what a "clear all" removed.
type ClearResult struct {
	Items   int `json:"items"`
	Details int `json:"details"`
}

// ClearAll deletes every listing, and every detail row with it.
//
// Counted and deleted inside one transaction, so the numbers reported back are
// the rows that actually went rather than a count that could drift between two
// statements. marketplace_item_detail needs no explicit delete -- the foreign
// key cascades -- but it is counted so the caller can say what disappeared.
//
// This is irreversible and there is no undo. A re-sync repopulates the table,
// but sold state is rebuilt from the transfer ledger rather than restored, so a
// listing that had sold is only marked again once history runs.
func (s *MarketplaceService) ClearAll(ctx context.Context) (ClearResult, error) {
	var out ClearResult
	err := s.tx.InTx(ctx, func(q dbgen.Querier) error {
		details, err := q.CountMarketplaceItemDetails(ctx)
		if err != nil {
			return fmt.Errorf("count item details: %w", err)
		}

		deleted, err := q.DeleteAllMarketplaceItems(ctx)
		if err != nil {
			return fmt.Errorf("delete marketplace items: %w", err)
		}

		out = ClearResult{Items: int(deleted), Details: int(details)}
		return nil
	})
	if err != nil {
		return ClearResult{}, err
	}
	return out, nil
}

// itemToModel maps a database row to the wire shape.
func itemToModel(row dbgen.MarketplaceItem) models.MarketplaceItem {
	m := models.MarketplaceItem{
		ID:            row.ID,
		TokenID:       row.TokenID,
		SellerID:      row.SellerID,
		ImageURL:      row.ImageUrl,
		Name:          row.Name,
		Currency:      row.Currency,
		Price:         row.Price,
		GradeEffect:   row.GradeEffect,
		Level:         row.Level,
		Enchant:       row.Enchant,
		EquipmentType: row.EquipmentType,
		CreatedAt:     models.ISO(row.CreatedAt),
	}
	if row.SellerName.Valid {
		m.SellerName = &row.SellerName.String
	}
	if row.MintTime.Valid {
		m.MintTime = models.ISOPtr(&row.MintTime.Time)
	}
	if row.SoldAt.Valid {
		m.SoldAt = models.ISOPtr(&row.SoldAt.Time)
	}
	if row.SoldPrice.Valid {
		p := row.SoldPrice.Float64
		m.SoldPrice = &p
	}
	return m
}

// detailToModel passes the jsonb blobs through untouched.
//
// The bytes are copied straight into json.RawMessage. Decoding them into a Go
// shape here would put a normalising step between the database and the detail
// page, and that step is exactly where an upstream field would get dropped or
// reordered.
func detailToModel(row dbgen.MarketplaceItemDetail) *models.MarketplaceItemDetail {
	return &models.MarketplaceItemDetail{
		Attributes: rawJSON(row.Attributes),
		Datas:      rawJSON(row.Datas),
		Infos:      rawJSON(row.Infos),
	}
}

// rawJSON unwraps a nullable jsonb column into something that marshals to null
// rather than to `{}` or being omitted from the response entirely.
func rawJSON(v pqtype.NullRawMessage) json.RawMessage {
	if !v.Valid || len(v.RawMessage) == 0 {
		return json.RawMessage("null")
	}
	return v.RawMessage
}

// nullableString converts an absent optional parameter into the sql.NullString
// that makes SQL skip the predicate.
func nullableString(v *string) sql.NullString {
	if v == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *v, Valid: true}
}

func nullableInt32(v *int32) sql.NullInt32 {
	if v == nil {
		return sql.NullInt32{}
	}
	return sql.NullInt32{Int32: *v, Valid: true}
}

// nonNil converts nil to an empty slice.
//
// The SQL checks cardinality(), where an empty array and a NULL both mean "no
// predicate". Passing a nil slice would send NULL, which also works, but an
// empty slice makes the intent visible in the parameter rather than relying on
// the reader knowing that both are handled.
func nonNil(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

// nonNilStrings makes sure a list endpoint returns [] rather than null, so the
// client can iterate without a guard.
func nonNilStrings(v []string) []string {
	out := make([]string, 0, len(v))
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

// pgUniqueViolation is Postgres's SQLSTATE for a unique constraint violation.
const pgUniqueViolation = "23505"

// conflictOnUnique recognises a unique-violation error.
//
// Used to turn a race into the same clean 409 the pre-check would have
// produced: two concurrent creates can both pass the existence probe, and the
// unique index is what actually decides between them.
func conflictOnUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation
}
