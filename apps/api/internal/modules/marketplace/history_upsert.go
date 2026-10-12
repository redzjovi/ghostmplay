package marketplace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
	"github.com/redzjovi/ghostmplay/apps/api/internal/models"
)

// UpsertTransferInput is one ledger entry as the scraper read it upstream.
type UpsertTransferInput struct {
	TokenID   int32
	GameName  *string
	SellerID  string
	BuyerID   string
	ItemName  string
	Price     float64
	Currency  string
	TxHash    string
	ImageURL  *string
	CreatedAt time.Time

	// BuyerUsername is resolved by asking the upstream who owns the token now.
	// It is empty whenever the owner could not be resolved, and that is not an
	// error -- an unresolvable owner just means no display name this run.
	BuyerUsername string

	// Claimed means the token has been claimed upstream: the detail fetch
	// answered 400 rather than 200.
	//
	// It is a bool rather than a pointer because every caller computes it, and
	// the write is unconditional for the same reason: a re-scrape that defaulted
	// it to false would resurrect a claimed token on every pass.
	Claimed bool
}

// UpsertFromApi writes one transfer to the ledger.
//
// The ledger is keyed by tx_hash, which is a blockchain transaction hash and is
// therefore the one identifier here that is genuinely unique and immutable. A
// re-scrape of the same transfer updates the existing row rather than
// duplicating it.
func (s *HistoryService) UpsertFromApi(ctx context.Context, raw UpsertTransferInput) (*models.MarketplaceTokenTransfer, error) {
	// Both parties get a users row first, before the transfer references them.
	// The joins in the list query are LEFT, so a missing users row degrades to a
	// null display name rather than losing the row -- but the name arrives later,
	// in the same run, via SetUsername.
	if err := s.EnsureUser(ctx, raw.SellerID); err != nil {
		return nil, err
	}
	if err := s.EnsureUser(ctx, raw.BuyerID); err != nil {
		return nil, err
	}

	// Only a resolved name is worth writing. Storing an empty string would make
	// the filter dropdowns offer a blank option.
	if name := strings.TrimSpace(raw.BuyerUsername); name != "" {
		if err := s.SetUsername(ctx, raw.BuyerID, name); err != nil {
			return nil, err
		}
	}

	_, err := s.queries.GetTransferByTxHash(ctx, raw.TxHash)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		saved, err := s.queries.InsertTokenTransfer(ctx, dbgen.InsertTokenTransferParams{
			TokenID:   raw.TokenID,
			GameName:  nullableString(raw.GameName),
			SellerID:  raw.SellerID,
			BuyerID:   raw.BuyerID,
			ItemName:  raw.ItemName,
			Price:     raw.Price,
			Currency:  currencyOrDefault(raw.Currency),
			TxHash:    raw.TxHash,
			ImageUrl:  nullableString(raw.ImageURL),
			CreatedAt: raw.CreatedAt,
			Claimed:   raw.Claimed,
		})
		if err != nil {
			return nil, fmt.Errorf("insert token transfer %s: %w", raw.TxHash, err)
		}
		out := transferRowFromRecord(saved)
		m := transferToModel(out)
		return &m, nil

	case err != nil:
		return nil, fmt.Errorf("find token transfer %s: %w", raw.TxHash, err)

	default:
		saved, err := s.queries.UpdateTokenTransfer(ctx, dbgen.UpdateTokenTransferParams{
			TxHash:   raw.TxHash,
			TokenID:  raw.TokenID,
			GameName: nullableString(raw.GameName),
			SellerID: raw.SellerID,
			BuyerID:  raw.BuyerID,
			ItemName: raw.ItemName,
			Price:    raw.Price,
			// nil currency and image_url mean "keep what is stored": the
			// statement coalesces them, and a bare "" would be written through
			// as a real value and blank the column.
			Currency:  nullableString(raw.CurrencyOrNil()),
			ImageUrl:  nullableString(raw.ImageURL),
			CreatedAt: raw.CreatedAt,
			Claimed:   raw.Claimed,
		})
		if err != nil {
			return nil, fmt.Errorf("update token transfer %s: %w", raw.TxHash, err)
		}
		m := transferToModel(transferRowFromRecord(saved))
		return &m, nil
	}
}

// CurrencyOrNil reports the currency as nil when there is none, so the update
// path keeps whatever is stored instead of writing an empty string through
// COALESCE.
func (u UpsertTransferInput) CurrencyOrNil() *string {
	if u.Currency == "" {
		return nil
	}
	return &u.Currency
}

// transferRowFromRecord adapts a full table record into the list row shape, so
// one mapper serves the list queries and the upserts.
func transferRowFromRecord(r dbgen.MarketplaceTokenTransfer) transferRow {
	return transferRow{
		ID:        r.ID,
		TokenID:   r.TokenID,
		GameName:  r.GameName,
		SellerID:  r.SellerID,
		BuyerID:   r.BuyerID,
		ItemName:  r.ItemName,
		Price:     r.Price,
		Currency:  r.Currency,
		TxHash:    r.TxHash,
		ImageURL:  r.ImageUrl,
		CreatedAt: r.CreatedAt,
		Claimed:   r.Claimed,
	}
}
