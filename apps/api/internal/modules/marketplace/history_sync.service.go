package marketplace

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/api"
)

// HistorySyncService fills the transfer ledger from the upstream.
type HistorySyncService struct {
	client      *api.Client
	history     *HistoryService
	marketplace *MarketplaceService
	log         *slog.Logger
}

// NewHistorySyncService builds the history sync service.
func NewHistorySyncService(client *api.Client, history *HistoryService, marketplace *MarketplaceService, log *slog.Logger) *HistorySyncService {
	return &HistorySyncService{client: client, history: history, marketplace: marketplace, log: log}
}

// Backfill page size and owner-resolution concurrency.
const (
	backfillLimit       = 150
	backfillConcurrency = 3
)

// HistorySyncResult is what one history run reports back to the admin panel.
type HistorySyncResult struct {
	Synced     int   `json:"synced"`
	Total      int64 `json:"total"`
	Enriched   int   `json:"enriched"`
	Claimed    int   `json:"claimed"`
	Skipped    int   `json:"skipped"`
	SoldMarked int   `json:"soldMarked"`
	Pages      int   `json:"pages,omitempty"`
}

// ownerResult is what resolving a token's current owner produced.
type ownerResult struct {
	buyerUsername string
	claimed       bool
}

// Backfill walks every page of the upstream ledger.
//
// No page cap: this endpoint reports a real count, so the walk stops once it has
// covered all of it, and a short page is the second signal. The lock is what
// stops a long walk overlapping the next run.
//
// This is the most expensive operation in the app, and the "clear all" button on
// the history side is what triggers it: the incremental cron only ever reads the
// first page, so a cleared ledger does not refill on its own.
func (s *HistorySyncService) Backfill(ctx context.Context) (HistorySyncResult, error) {
	page := 0
	result := HistorySyncResult{}

	for {
		res, err := s.client.TokenTransfers(ctx, api.TokenTransfersOptions{
			Limit:  backfillLimit,
			Offset: page,
		})
		if err != nil {
			return HistorySyncResult{}, fmt.Errorf("token transfers page %d: %w", page, err)
		}

		result.Total = int64(res.Count)
		lists := res.Lists
		if len(lists) == 0 {
			break
		}

		mapped := make([]mappedTransfer, 0, len(lists))
		for _, it := range lists {
			m := mapTransfer(it)
			if m.gameName == nil || *m.gameName != api.DefaultServiceName {
				result.Skipped++
				continue
			}
			if m.txHash == "" || m.createdAt.IsZero() {
				continue
			}
			mapped = append(mapped, m)
		}

		resolved, err := pool(ctx, backfillConcurrency, mapped,
			func(m mappedTransfer) int32 { return m.tokenID },
			func(m mappedTransfer) (ownerResult, error) { return s.resolveOwnerInline(ctx, m.tokenID) })
		if err != nil {
			return HistorySyncResult{}, err
		}

		for _, m := range mapped {
			r := resolved[m.tokenID]
			if _, err := s.history.UpsertFromApi(ctx, m.toInput(r)); err != nil {
				return HistorySyncResult{}, err
			}
			result.Synced++
			if r.buyerUsername != "" {
				result.Enriched++
			}
			if r.claimed {
				result.Claimed++
			}
		}

		page++
		s.log.Info("backfill page", "page", page, "synced", result.Synced,
			"total", result.Total, "skipped", result.Skipped)

		// Either signal that the end has been reached: a short page, or enough
		// pages read to cover the reported count.
		if len(lists) < backfillLimit || int64(page)*backfillLimit >= result.Total {
			break
		}
	}

	marked, err := s.reconcileSold(ctx)
	if err != nil {
		return HistorySyncResult{}, err
	}
	result.SoldMarked = marked
	result.Pages = page

	return result, nil
}

// RefreshLatest fetches only the first page and stops at the first known
// transfer.
//
// The ledger is newest-first, so the first transfer already in the database
// marks the boundary: everything before it is new and everything after it has
// been seen. That is the whole difference from a backfill, and it is what makes
// the per-minute cron cheap.
func (s *HistorySyncService) RefreshLatest(ctx context.Context) (HistorySyncResult, error) {
	res, err := s.client.TokenTransfers(ctx, api.TokenTransfersOptions{
		Limit:  backfillLimit,
		Offset: 0,
	})
	if err != nil {
		return HistorySyncResult{}, fmt.Errorf("token transfers: %w", err)
	}

	result := HistorySyncResult{Total: int64(res.Count)}

	fresh := make([]mappedTransfer, 0, len(res.Lists))
	for _, it := range res.Lists {
		m := mapTransfer(it)
		if m.txHash == "" {
			continue
		}
		if m.gameName == nil || *m.gameName != api.DefaultServiceName {
			result.Skipped++
			continue
		}
		known, err := s.history.ExistsByTxHash(ctx, m.txHash)
		if err != nil {
			return HistorySyncResult{}, err
		}
		if known {
			s.log.Info("latest break at known transfer", "tx", m.txHash)
			break
		}
		if m.createdAt.IsZero() {
			continue
		}
		fresh = append(fresh, m)
	}

	resolved, err := pool(ctx, backfillConcurrency, fresh,
		func(m mappedTransfer) int32 { return m.tokenID },
		func(m mappedTransfer) (ownerResult, error) { return s.resolveOwnerInline(ctx, m.tokenID) })
	if err != nil {
		return HistorySyncResult{}, err
	}

	for _, m := range fresh {
		r := resolved[m.tokenID]
		if _, err := s.history.UpsertFromApi(ctx, m.toInput(r)); err != nil {
			return HistorySyncResult{}, err
		}
		result.Synced++
		if r.buyerUsername != "" {
			result.Enriched++
		}
		if r.claimed {
			result.Claimed++
		}
	}

	marked, err := s.reconcileSold(ctx)
	if err != nil {
		return HistorySyncResult{}, err
	}
	result.SoldMarked = marked

	return result, nil
}

// resolveOwnerInline asks the upstream who owns a token now.
//
// Three outcomes, and the difference between them is the whole reason this uses
// DetailStrict rather than Detail:
//
//   - 200: the token is listed, and its ownerName is the buyer's username.
//   - 400: the token is claimed and no longer resolvable. Recorded as claimed so
//     no future run asks again about it.
//   - anything else -- 5xx, a timeout, DNS: we do not know. Nothing is
//     recorded, and the next full backfill will try again.
//
// Collapsing the third case into the second would mark tokens claimed because
// the network blipped, and a claimed token is never re-checked. That is the
// mistake this function exists to avoid.
func (s *HistorySyncService) resolveOwnerInline(ctx context.Context, tokenID int32) (ownerResult, error) {
	detail, err := s.client.DetailStrict(ctx, tokenID, api.DefaultServiceName)
	if err != nil {
		if api.StatusOf(err) == 400 {
			s.log.Info("token claimed", "token_id", tokenID)
			return ownerResult{buyerUsername: "", claimed: true}, nil
		}
		// Not a verdict about the token, only about this request. Recorded as
		// nothing at all.
		return ownerResult{}, nil
	}

	name := ""
	if detail != nil {
		name = strings.TrimSpace(detail.OwnerName)
	}
	return ownerResult{buyerUsername: name, claimed: false}, nil
}

// reconcileSold re-derives sold state from the ledger once a run has stored
// everything it fetched.
//
// It runs at the end of a run rather than per page: the statement is one
// UPDATE, and it converges on the whole ledger regardless of which early-break
// path got us here. See MarkItemsSold in db/queries/marketplace.sql for why it
// re-reads everything rather than scoping to this run's transfers.
func (s *HistorySyncService) reconcileSold(ctx context.Context) (int, error) {
	marked, err := s.marketplace.MarkItemsSold(ctx)
	if err != nil {
		return 0, err
	}
	if marked > 0 {
		s.log.Info("marked items sold from the transfer ledger", "count", marked)
	}
	return marked, nil
}

// mappedTransfer is an upstream transfer row before owner resolution.
type mappedTransfer struct {
	tokenID   int32
	txHash    string
	gameName  *string
	sellerID  string
	buyerID   string
	itemName  string
	price     float64
	currency  string
	imageURL  *string
	createdAt time.Time
}

func (m mappedTransfer) toInput(r ownerResult) UpsertTransferInput {
	return UpsertTransferInput{
		TokenID:       m.tokenID,
		GameName:      m.gameName,
		SellerID:      m.sellerID,
		BuyerID:       m.buyerID,
		ItemName:      m.itemName,
		Price:         m.price,
		Currency:      m.currency,
		TxHash:        m.txHash,
		ImageURL:      m.imageURL,
		CreatedAt:     m.createdAt,
		BuyerUsername: r.buyerUsername,
		Claimed:       r.claimed,
	}
}

// mapTransfer turns an upstream transfer row into the mapped shape.
//
// game_name is trimmed and an empty result becomes null rather than "", because
// the filter dropdowns list distinct game names and a blank one would appear as
// an empty option.
func mapTransfer(it api.TokenTransferItem) mappedTransfer {
	gameName := strings.TrimSpace(it.GameName)
	var game *string
	if gameName != "" {
		game = &gameName
	}

	var image *string
	if v := strings.TrimSpace(it.ImageURL); v != "" {
		image = &v
	}

	tokenID, _ := strconv.ParseInt(strings.TrimSpace(it.TokenID.String()), 10, 32)

	return mappedTransfer{
		tokenID:   int32(tokenID),
		txHash:    strings.TrimSpace(it.TxHash),
		gameName:  game,
		sellerID:  it.Seller,
		buyerID:   it.Buyer,
		itemName:  it.ItemName,
		price:     it.Price,
		currency:  it.Currency,
		imageURL:  image,
		createdAt: ParseTransferTime(it.Time),
	}
}
