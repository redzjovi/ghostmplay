package marketplace

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/redzjovi/ghostmplay/apps/api/internal/database"
	"github.com/redzjovi/ghostmplay/apps/api/internal/models"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/dto"
)

// HistoryService reads and writes the transfer ledger.
//
// The ledger is the only authority on sold state. Nothing infers a sale from a
// failed fetch, because a failed fetch does not distinguish "delisted" from "the
// upstream returned a 500" or "DNS blipped for two seconds", and the earlier
// implementation recorded all three as a sale.
type HistoryService struct {
	queries dbgen.Querier
	tx      database.TxManager
	log     *slog.Logger
}

// NewHistoryService builds the service.
func NewHistoryService(queries dbgen.Querier, tx database.TxManager, log *slog.Logger) *HistoryService {
	return &HistoryService{queries: queries, tx: tx, log: log}
}

// kstZone is the market's own clock. Korea does not observe DST, so a fixed
// offset is the whole rule and there is nothing to compute.
const kstOffset = "+09:00"

// zoneDesignator matches a trailing UTC offset or Z.
//
// Anchored at the end and case-sensitive, which is deliberate: it mirrors the
// original exactly, so a lowercase `z` is treated as "no designator supplied"
// and gets the Korean default appended. That produces an unparseable string and
// the transfer is skipped -- the same outcome the original had, rather than a
// new one.
var zoneDesignator = regexp.MustCompile(`(Z|[+-]\d{2}:?\d{2})$`)

// ParseTransferTime reads the ledger's `time` field.
//
// It arrives as a bare "2026-09-25 01:45:59" with no offset, and it is KST --
// the market's own clock, the same one item-detail spells out as "+0900 KST" in
// its mintTime.
//
// Appending Z here would store every transfer nine hours in the future, which
// is self-evidently wrong: the newest transfer would then read as later than
// "now". The offset is only defaulted when the payload omits one, because some
// responses do carry it and those must win.
//
// Returns the zero time for anything unparseable. That is not an error case but
// a skip case: a garbage timestamp means the transfer is not usable, and the
// caller drops it rather than failing the whole page of a backfill over one bad
// row.
func ParseTransferTime(s string) time.Time {
	t := strings.TrimSpace(s)
	// Only the first space, as in the original. A timestamp has one.
	t = strings.Replace(t, " ", "T", 1)

	// A designator may be preceded by a space, as in "2026-09-25 01:45:59
	// +09:00". Go's time.Parse rejects that outright while V8 accepted it, so
	// the separator is closed up here rather than losing an input format the
	// deployed API handled.
	if m := zoneDesignator.FindString(t); m != "" && strings.HasSuffix(t, m) {
		t = strings.TrimRight(t[:len(t)-len(m)], " ") + m
	}

	if !zoneDesignator.MatchString(t) {
		t += kstOffset
	}

	for _, layout := range []string{
		"2006-01-02T15:04:05.999999999Z07:00",
		"2006-01-02T15:04:05.999999999-0700",
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02T15:04:05-0700",
	} {
		if parsed, err := time.Parse(layout, t); err == nil {
			return parsed
		}
	}
	return time.Time{}
}

// NormalizeAddress lowercases and trims a wallet address.
//
// The `users` table is keyed on this, and the joins against it are written as
// `su.id = LOWER(t.seller_id)`. Anything that writes to users has to go through
// here or the row will be invisible to its own joins.
func NormalizeAddress(address string) string {
	return strings.ToLower(strings.TrimSpace(address))
}

// List returns one page of the ledger, with seller and buyer usernames joined in.
func (s *HistoryService) List(ctx context.Context, q dto.HistoryListQuery) (models.List[models.MarketplaceTokenTransfer], error) {
	params := newHistoryParams(q)

	rows, err := s.listRows(ctx, q, params)
	if err != nil {
		return models.List[models.MarketplaceTokenTransfer]{}, err
	}

	total, err := s.queries.CountTokenTransfers(ctx, dbgen.CountTokenTransfersParams{
		Seller:      params.Seller,
		Buyer:       params.Buyer,
		SellerName:  params.SellerName,
		BuyerName:   params.BuyerName,
		ItemName:    params.ItemName,
		TokenID:     params.TokenID,
		TxHash:      params.TxHash,
		PriceMin:    params.PriceMin,
		PriceMax:    params.PriceMax,
		CreatedFrom: params.CreatedFrom,
		CreatedTo:   params.CreatedTo,
		Claimed:     params.Claimed,
	})
	if err != nil {
		return models.List[models.MarketplaceTokenTransfer]{}, fmt.Errorf("count token transfers: %w", err)
	}

	data := make([]models.MarketplaceTokenTransfer, 0, len(rows))
	for _, row := range rows {
		data = append(data, transferToModel(row))
	}

	return models.List[models.MarketplaceTokenTransfer]{
		Data:  data,
		Total: int(total),
		Page:  q.Page,
		Limit: q.Limit,
	}, nil
}

// historyParams is the shape both list queries take. The recent and sorted
// variants differ only in ORDER BY, so they share one parameter builder.
type historyParams = struct {
	Seller      sql.NullString
	Buyer       sql.NullString
	SellerName  sql.NullString
	BuyerName   sql.NullString
	ItemName    sql.NullString
	TokenID     sql.NullInt32
	TxHash      sql.NullString
	PriceMin    sql.NullFloat64
	PriceMax    sql.NullFloat64
	CreatedFrom sql.NullTime
	CreatedTo   sql.NullTime
	Claimed     sql.NullBool
}

// historyParams converts a parsed query into the sql.Null* fields both list
// queries take.
//
// The conversion is where nil-ness is preserved. sql.NullString.Valid=false is
// what makes SQL take the "no predicate" branch; dropping the Valid flag here
// would turn an absent filter into a filter for the empty string, which on a
// substring match means "matches everything" and quietly removes the filter the
// user asked for.
func newHistoryParams(q dto.HistoryListQuery) historyParams {
	p := historyParams{
		Seller:      nullableString(q.Seller),
		Buyer:       nullableString(q.Buyer),
		SellerName:  nullableString(q.SellerName),
		BuyerName:   nullableString(q.BuyerName),
		ItemName:    nullableString(q.ItemName),
		TokenID:     nullableInt32(q.TokenID),
		TxHash:      nullableString(q.TxHash),
		PriceMin:    nullableFloat(q.PriceMin),
		PriceMax:    nullableFloat(q.PriceMax),
		CreatedFrom: nullableTime(q.CreatedFrom),
		CreatedTo:   nullableTime(q.CreatedTo),
	}
	if q.Claimed != nil {
		p.Claimed = sql.NullBool{Bool: *q.Claimed, Valid: true}
	}
	return p
}

func nullableFloat(v *float64) sql.NullFloat64 {
	if v == nil {
		return sql.NullFloat64{}
	}
	return sql.NullFloat64{Float64: *v, Valid: true}
}

func nullableTime(v *time.Time) sql.NullTime {
	if v == nil {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: *v, Valid: true}
}

// transferRow is one history row, whichever query produced it. Both list
// queries select the same columns, so they share one row type.
type transferRow = struct {
	ID             int32
	TokenID        int32
	GameName       sql.NullString
	SellerID       string
	SellerUsername sql.NullString
	BuyerID        string
	BuyerUsername  sql.NullString
	ItemName       string
	Price          float64
	Currency       string
	TxHash         string
	ImageURL       sql.NullString
	CreatedAt      time.Time
	Claimed        bool
}

func (s *HistoryService) listRows(ctx context.Context, q dto.HistoryListQuery, p historyParams) ([]transferRow, error) {
	limit := int32(q.Limit)
	offset := int32(q.Offset())

	if q.Sort == "recent" || q.Sort == "created_at_desc" || q.Sort == "" {
		rows, err := s.queries.ListTokenTransfersRecent(ctx, dbgen.ListTokenTransfersRecentParams{
			Seller: p.Seller, Buyer: p.Buyer, SellerName: p.SellerName,
			BuyerName: p.BuyerName, ItemName: p.ItemName, TokenID: p.TokenID,
			TxHash: p.TxHash, PriceMin: p.PriceMin, PriceMax: p.PriceMax,
			CreatedFrom: p.CreatedFrom, CreatedTo: p.CreatedTo, Claimed: p.Claimed,
			Limit: limit, Offset: offset,
		})
		if err != nil {
			return nil, fmt.Errorf("list token transfers: %w", err)
		}
		out := make([]transferRow, 0, len(rows))
		for _, r := range rows {
			out = append(out, transferRow{
				ID: r.ID, TokenID: r.TokenID, GameName: r.GameName,
				SellerID: r.SellerID, SellerUsername: r.SellerUsername,
				BuyerID: r.BuyerID, BuyerUsername: r.BuyerUsername,
				ItemName: r.ItemName, Price: r.Price, Currency: r.Currency,
				TxHash: r.TxHash, ImageURL: r.ImageUrl, CreatedAt: r.CreatedAt,
				Claimed: r.Claimed,
			})
		}
		return out, nil
	}

	rows, err := s.queries.ListTokenTransfersSorted(ctx, dbgen.ListTokenTransfersSortedParams{
		Seller: p.Seller, Buyer: p.Buyer, SellerName: p.SellerName,
		BuyerName: p.BuyerName, ItemName: p.ItemName, TokenID: p.TokenID,
		TxHash: p.TxHash, PriceMin: p.PriceMin, PriceMax: p.PriceMax,
		CreatedFrom: p.CreatedFrom, CreatedTo: p.CreatedTo, Claimed: p.Claimed,
		Sort:  q.Sort,
		Limit: limit, Offset: offset,
	})
	if err != nil {
		return nil, fmt.Errorf("list token transfers sorted: %w", err)
	}
	out := make([]transferRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, transferRow{
			ID: r.ID, TokenID: r.TokenID, GameName: r.GameName,
			SellerID: r.SellerID, SellerUsername: r.SellerUsername,
			BuyerID: r.BuyerID, BuyerUsername: r.BuyerUsername,
			ItemName: r.ItemName, Price: r.Price, Currency: r.Currency,
			TxHash: r.TxHash, ImageURL: r.ImageUrl, CreatedAt: r.CreatedAt,
			Claimed: r.Claimed,
		})
	}
	return out, nil
}

// GetDistinctFilters returns the three history dropdowns.
//
// Unlike the marketplace dropdowns these are not scoped: the ledger has no
// live/sold concept, so there is nothing to scope them to.
func (s *HistoryService) GetDistinctFilters(ctx context.Context) (models.HistoryFilterOptions, error) {
	games, err := s.queries.ListDistinctGameNames(ctx)
	if err != nil {
		return models.HistoryFilterOptions{}, fmt.Errorf("list distinct game names: %w", err)
	}
	sellers, err := s.queries.ListDistinctSellerNames(ctx)
	if err != nil {
		return models.HistoryFilterOptions{}, fmt.Errorf("list distinct seller names: %w", err)
	}
	buyers, err := s.queries.ListDistinctBuyerNames(ctx)
	if err != nil {
		return models.HistoryFilterOptions{}, fmt.Errorf("list distinct buyer names: %w", err)
	}

	return models.HistoryFilterOptions{
		GameNames:   trimNulls(games),
		SellerNames: trimNulls(sellers),
		BuyerNames:  trimNulls(buyers),
	}, nil
}

// ExistsByTxHash reports whether a transfer is already stored.
func (s *HistoryService) ExistsByTxHash(ctx context.Context, txHash string) (bool, error) {
	found, err := s.queries.ExistsTransferByTxHash(ctx, txHash)
	if err != nil {
		return false, fmt.Errorf("check transfer exists: %w", err)
	}
	return found, nil
}

// ListPending returns unclaimed transfers with an id above afterID, oldest
// first, at most batch of them.
//
// Keyset rather than offset because the caller sets claimed = true on rows as it
// works through them, which shrinks the NOT claimed set underneath the cursor --
// see ListPendingTransfers for why OFFSET would drop rows silently.
func (s *HistoryService) ListPending(ctx context.Context, afterID int32, batch int) ([]dbgen.MarketplaceTokenTransfer, error) {
	rows, err := s.queries.ListPendingTransfers(ctx, dbgen.ListPendingTransfersParams{
		AfterID: afterID,
		Batch:   int32(batch),
	})
	if err != nil {
		return nil, fmt.Errorf("list pending transfers: %w", err)
	}
	return rows, nil
}

// EnsureUser makes sure a wallet has a users row.
//
// Idempotent and race-safe: ON CONFLICT DO NOTHING rather than
// select-then-insert, because the history sync resolves several addresses in
// parallel and two workers routinely reach the same one at the same moment.
func (s *HistoryService) EnsureUser(ctx context.Context, address string) error {
	id := NormalizeAddress(address)
	if id == "" {
		return nil
	}
	if err := s.queries.EnsureUser(ctx, id); err != nil {
		return fmt.Errorf("ensure user %s: %w", id, err)
	}
	return nil
}

// SetUsername records a resolved display name for a wallet.
func (s *HistoryService) SetUsername(ctx context.Context, address, username string) error {
	id := NormalizeAddress(address)
	if id == "" {
		return nil
	}
	if err := s.queries.UpdateUserUsername(ctx, dbgen.UpdateUserUsernameParams{
		ID:       id,
		Username: sql.NullString{String: username, Valid: true},
	}); err != nil {
		return fmt.Errorf("update username for %s: %w", id, err)
	}
	return nil
}

// ClearResult reports what a "clear all" removed.
type HistoryClearResult struct {
	Transfers int `json:"transfers"`
}

// ClearAll deletes every transfer.
//
// users is left alone: the seller/buyer names are harmless without transfers
// behind them, and they are cheap for a backfill to restore. Only the ledger
// goes.
//
// Worth knowing before using this: the cron only ever fetches the first page,
// so a cleared ledger does NOT refill on its own the way the marketplace does.
// Rebuilding it is a full backfill over every page the upstream holds, which is
// the single most expensive operation in the app.
func (s *HistoryService) ClearAll(ctx context.Context) (HistoryClearResult, error) {
	deleted, err := s.queries.DeleteAllTokenTransfers(ctx)
	if err != nil {
		return HistoryClearResult{}, fmt.Errorf("delete token transfers: %w", err)
	}
	return HistoryClearResult{Transfers: int(deleted)}, nil
}

func transferToModel(r transferRow) models.MarketplaceTokenTransfer {
	m := models.MarketplaceTokenTransfer{
		ID:        r.ID,
		TokenID:   r.TokenID,
		SellerID:  r.SellerID,
		BuyerID:   r.BuyerID,
		ItemName:  r.ItemName,
		Price:     r.Price,
		Currency:  r.Currency,
		TxHash:    r.TxHash,
		CreatedAt: models.ISO(r.CreatedAt),
		Claimed:   r.Claimed,
	}
	if r.GameName.Valid {
		v := r.GameName.String
		m.GameName = &v
	}
	if r.SellerUsername.Valid {
		v := r.SellerUsername.String
		m.SellerUsername = &v
	}
	if r.BuyerUsername.Valid {
		v := r.BuyerUsername.String
		m.BuyerUsername = &v
	}
	if r.ImageURL.Valid {
		v := r.ImageURL.String
		m.ImageURL = &v
	}
	return m
}

func trimNulls(v []sql.NullString) []string {
	out := make([]string, 0, len(v))
	for _, s := range v {
		if s.Valid && strings.TrimSpace(s.String) != "" {
			out = append(out, s.String)
		}
	}
	return out
}
