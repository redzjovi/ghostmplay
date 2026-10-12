package marketplace

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/api"
)

// SyncMode is how far a marketplace scrape walks.
type SyncMode string

const (
	// SyncLatest stops at the first listing already stored with an unchanged
	// created_at. One page of new work per run, typically.
	SyncLatest SyncMode = "latest"
	// SyncAll walks to the end of the upstream.
	SyncAll SyncMode = "all"
)

// pageSize is the upstream's listing page size.
//
// Twelve is what the upstream returns comfortably in one response. It is not a
// tuning knob: the marketplace sync runs every minute against a public endpoint,
// so a larger page would mean fewer requests, and a smaller one would mean a
// longer walk for the same coverage.
const pageSize = 12

// detailConcurrency is how many detail fetches run at once.
//
// Three, deliberately small. The detail endpoint is one request per listing, so
// this is the multiplier on load against a public API. Backfill walks thousands
// of pages through this pool and being greedy here would be noticed.
const detailConcurrency = 3

// SyncService scrapes the upstream marketplace into the listings table.
type SyncService struct {
	client      *api.Client
	marketplace *MarketplaceService
	log         *slog.Logger
}

// NewSyncService builds the sync service.
func NewSyncService(client *api.Client, marketplace *MarketplaceService, log *slog.Logger) *SyncService {
	return &SyncService{client: client, marketplace: marketplace, log: log}
}

// SyncResult is what one run reports back to the admin panel.
type SyncResult struct {
	Synced int `json:"synced"`
}

// Refresh scrapes the marketplace.
//
// latest: stop at the first listing whose id is already stored with an unchanged
// created_at. Because the upstream is queried newest-first, everything after
// that point is already stored, so the run stops instead of re-verifying it.
//
// all: walk to the end. No page cap in either mode -- the upstream returns an
// empty page past the end rather than clamping the offset, so `all` terminates on
// its own, and it is what stops a long walk from overlapping the next run.
//
// A detail fetch happens only for listings that are new or whose created_at
// changed. In `latest` mode that is almost nothing after the first run, which is
// the point: the expensive request is the one per listing, and an unchanged
// listing has nothing new to say.
func (s *SyncService) Refresh(ctx context.Context, itemName string, mode SyncMode) (SyncResult, error) {
	if mode == "" {
		mode = SyncLatest
	}

	page := 0
	totalSynced := 0

	for {
		res, err := s.client.SearchRedis(ctx, api.SearchRedisOptions{
			ServiceName: api.DefaultServiceName,
			ItemName:    itemName,
			Sort:        "created_at_desc",
			Offset:      page,
			Limit:       pageSize,
		})
		if err != nil {
			return SyncResult{}, fmt.Errorf("search redis page %d: %w", page, err)
		}

		// The upstream's own count is logged on every page. It is the cheapest
		// possible check that the response was decoded rather than discarded:
		// when the {message,data} envelope was not unwrapped, count and items
		// both came back as 0 and the run reported "synced 0" as a success. Two
		// numbers side by side in the log make that visible in one line.
		s.log.Debug("search page",
			"page", page, "mode", mode, "count", res.Count, "items", len(res.Items))

		items := res.Items
		if len(items) == 0 {
			// An empty first page is a shape the upstream has never had, and it
			// is the exact signature of a response that decoded to nothing.
			// Treating it as a clean finish is how a broken decode turns into a
			// silent outage; treating it as an error turns it into a failed run
			// the sync panel shows.
			if page == 0 && res.Count > 0 {
				return SyncResult{}, fmt.Errorf(
					"search listings reported %v listings but decoded none of them; "+
						"the response shape changed", res.Count)
			}
			s.log.Info("scrape done", "reason", "no items at page", "page", page)
			break
		}

		ids := make([]int32, 0, len(items))
		for _, it := range items {
			ids = append(ids, ItemIDOf(it))
		}

		// In `latest` mode the stored created_at values decide both what needs a
		// detail fetch and where the walk stops, so they are fetched once per
		// page as a batch rather than one query per listing.
		knownCreatedAt := map[int32]int64{}
		if mode == SyncLatest {
			knownCreatedAt, err = s.marketplace.FindCreatedAtMap(ctx, ids)
			if err != nil {
				return SyncResult{}, err
			}
		}

		toFetch := make([]api.SearchRedisItem, 0, len(items))
		for _, it := range items {
			id := ItemIDOf(it)
			if mode == SyncAll {
				toFetch = append(toFetch, it)
				continue
			}
			if knownCreatedAt[id] != itemCreatedAt(it) {
				toFetch = append(toFetch, it)
			}
		}

		details := map[int32]*api.ItemDetail{}
		if len(toFetch) > 0 {
			fetched, err := pool(ctx, detailConcurrency, toFetch,
				ItemIDOf,
				func(it api.SearchRedisItem) (*api.ItemDetail, error) {
					return s.client.Detail(ctx, TokenIDOf(it))
				})
			if err != nil {
				return SyncResult{}, err
			}
			details = fetched
		}

		stopped := false
		for _, it := range items {
			id := ItemIDOf(it)
			incoming := itemCreatedAt(it)

			if mode == SyncLatest {
				if existing, known := knownCreatedAt[id]; known {
					if existing == incoming {
						s.log.Info("scrape break", "id", id, "created_at", incoming, "page", page)
						stopped = true
						break
					}
					s.log.Info("created_at changed", "id", id, "from", existing, "to", incoming)
				}
			}

			detail := details[id]
			if _, fetched := details[id]; fetched && detail == nil {
				// Informational only.
				//
				// This used to mean "sold", which was wrong: the detail fetch
				// swallows every error, so a 5xx, a 429 and a DNS failure all
				// looked identical to a delisted token and were persisted as a
				// sale. Sold state is derived from the transfer ledger alone, in
				// MarkItemsSold.
				s.log.Info("detail empty, no sale inference", "id", id)
			}

			mapped := mapItem(it, res.IPFS, detail)
			if _, err := s.marketplace.UpsertFromApi(ctx, mapped); err != nil {
				return SyncResult{}, err
			}
			totalSynced++

			if mode == SyncLatest {
				knownCreatedAt[id] = incoming
			}
		}

		if stopped {
			break
		}
		// A short page is the end. Checked after the write loop so a page that
		// both fills and ends still gets stored.
		if len(items) < pageSize {
			s.log.Info("scrape done", "reason", "short page", "page", page, "items", len(items))
			break
		}
		page++
	}

	s.log.Info("scrape finished", "synced", totalSynced)
	return SyncResult{Synced: totalSynced}, nil
}

// ItemIDOf reads an item's upstream id.
func ItemIDOf(it api.SearchRedisItem) int32 { return it.ItemID }

// itemCreatedAt reads an item's created_at in epoch seconds.
//
// The upstream sends epoch seconds. Flooring is what makes the equality check
// in `latest` mode stable: both sides are integers, so a listing whose stored
// timestamp differs from the upstream's only by sub-second noise is correctly
// treated as unchanged.
func itemCreatedAt(it api.SearchRedisItem) int64 { return int64(it.CreatedAt) }

// TokenIDOf reads an item's token id, which the upstream sends as a string.
func TokenIDOf(it api.SearchRedisItem) int32 {
	n, err := strconv.ParseInt(it.TokenID.String(), 10, 32)
	if err != nil {
		return 0
	}
	return int32(n)
}

// mapItem turns an upstream listing into the shape the upsert takes.
func mapItem(it api.SearchRedisItem, ipfsBase string, detail *api.ItemDetail) UpsertItemInput {
	traits := ParseTraitPairs(it.TraitPairs)

	// Detail attributes win over trait_pairs: they are the authoritative record
	// of what the token actually is, where trait_pairs is a flattened summary
	// that has been wrong before.
	detailAttrs := map[string]string{}
	if detail != nil {
		for _, a := range detail.Details.Attributes {
			key := strings.TrimSpace(a.TraitType)
			if key == "" {
				continue
			}
			detailAttrs[key] = trimAttrValue(a.Value)
		}
	}

	attr := func(key, fallback string) string {
		if v, ok := detailAttrs[key]; ok {
			return v
		}
		if v, ok := traits[key]; ok {
			return v
		}
		return fallback
	}

	numAttr := func(key string, fromNums float64, hasNums bool) int32 {
		if hasNums {
			return int32(fromNums)
		}
		if v, ok := common.ToOptionalInt(attr(key, "0"), true); ok {
			return int32(*v)
		}
		return 0
	}

	level, hasLevel := it.TraitNums["Level"]
	enchant, hasEnchant := it.TraitNums["Enchant"]

	// Image: the detail blob's CID is preferred when present, falling back to
	// the search result's image_url. The gateway to hang a bare CID on comes
	// from the same source as the image.
	rawImage := strings.TrimSpace(it.ImageURL)
	baseForImage := ipfsBase
	if detail != nil {
		if cid := strings.TrimSpace(detail.Details.Image); cid != "" {
			rawImage = cid
			if d := strings.TrimSpace(detail.IPFS); d != "" {
				baseForImage = d
			}
		}
	}

	// The detail name is more precise than the search result's -- it carries the
	// enchant prefix, e.g. "+4 Spectersoul Greaves (Fire)" -- so it is preferred.
	name := strings.TrimSpace(it.ItemName)
	var mintTime *string
	var sellerName *string
	if detail != nil {
		if n := strings.TrimSpace(detail.Details.Name); n != "" {
			name = n
		}
		// Mint time lives on the listing, not the detail blob. Duplicated there
		// once, and removed.
		if mt := strings.TrimSpace(detail.MintTime); mt != "" {
			mintTime = &mt
		}
		// sellerName comes only from ownerName. Not from index id, not from uid:
		// those are identifiers, not names, and displaying one in the seller
		// column would be a bug that looks like data.
		if on := strings.TrimSpace(detail.OwnerName); on != "" {
			sellerName = &on
		}
	}

	currency := it.Currency
	if currency == "" {
		currency = "NUMI"
	}

	return UpsertItemInput{
		ID:            it.ItemID,
		TokenID:       TokenIDOf(it),
		SellerID:      it.Seller,
		SellerName:    sellerName,
		ImageURL:      BuildImageUrl(baseForImage, rawImage),
		Name:          name,
		Currency:      currency,
		Price:         it.Price,
		GradeEffect:   strings.TrimSpace(attr("Grade Effect", "Normal")),
		Level:         numAttr("Level", level, hasLevel),
		Enchant:       numAttr("Enchant", enchant, hasEnchant),
		EquipmentType: strings.TrimSpace(attr("Equipment Type", "Item")),
		// created_at is epoch seconds; everything downstream stores timestamptz.
		CreatedAt: time.Unix(int64(it.CreatedAt), 0).UTC(),
		MintTime:  mintTime,
		Detail:    detailPayload(detail),
	}
}

// detailPayload extracts the three stored blobs, or nil when no detail was
// fetched.
//
// An empty blob is stored as JSON null rather than skipped: the column is
// nullable and null is what "the upstream did not send this" means.
func detailPayload(detail *api.ItemDetail) *DetailPayload {
	if detail == nil {
		return nil
	}
	payload := &DetailPayload{
		Attributes: json.RawMessage("null"),
		Datas:      json.RawMessage("null"),
		Infos:      json.RawMessage("null"),
	}
	if len(detail.Details.Attributes) > 0 {
		if b, err := json.Marshal(detail.Details.Attributes); err == nil {
			payload.Attributes = b
		}
	}
	if len(detail.ViewData.Datas) > 0 {
		if b, err := json.Marshal(detail.ViewData.Datas); err == nil {
			payload.Datas = b
		}
	}
	if len(detail.ViewData.Infos) > 0 {
		if b, err := json.Marshal(detail.ViewData.Infos); err == nil {
			payload.Infos = b
		}
	}
	return payload
}

// trimAttrValue renders an attribute value as a string.
func trimAttrValue(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(b))
	}
}
