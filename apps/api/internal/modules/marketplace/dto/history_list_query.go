package dto

import (
	"database/sql"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/valyala/fasthttp"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
)

// HistorySorts are the accepted `sort` values.
var HistorySorts = []string{"recent", "created_at_desc", "created_at_asc", "price_asc", "price_desc"}

// HistoryListQuery is a parsed `GET /api/history/transfers` query.
//
// Every filter is a pointer, because "not supplied" and "supplied as the zero
// value" are genuinely different questions here. `?claimed=false` asks for
// unclaimed transfers; no `claimed` at all asks for all of them. Collapsing
// either into a bool loses the difference and silently returns the wrong rows.
type HistoryListQuery struct {
	Page  int
	Limit int

	// Seller and Buyer match either the wallet address or the username, both
	// case-folded and both as substrings. SellerName and BuyerName are exact
	// and case-sensitive, because they are chosen from a dropdown of names
	// already in the database rather than typed.
	Seller     *string
	Buyer      *string
	SellerName *string
	BuyerName  *string

	// ItemName is a case-folded substring match.
	ItemName *string

	// TokenID is nil when absent or non-numeric. A non-numeric value is
	// ignored rather than rejected: the client clears a filter by emptying the
	// box, and a half-typed number in that box should not 400 the page.
	TokenID *int32

	TxHash *string

	PriceMin *float64
	PriceMax *float64

	// CreatedFrom is inclusive at midnight UTC on the given day. CreatedTo is
	// stored already converted to the *exclusive* start of the next day, which
	// is what makes the whole end day count without a pair of `<=`/`<`
	// conditions and a string comparison.
	CreatedFrom *time.Time
	CreatedTo   *time.Time

	Claimed *bool
	Sort    string
}

const (
	historyDefaultLimit = 15
	historyMaxLimit     = 120
)

// Normalize applies the defaults and clamps.
func (q HistoryListQuery) Normalize() HistoryListQuery {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.Limit < 1 {
		q.Limit = historyDefaultLimit
	}
	if q.Limit > historyMaxLimit {
		q.Limit = historyMaxLimit
	}
	return q
}

// Offset is the row offset for this page.
func (q HistoryListQuery) Offset() int { return (q.Page - 1) * q.Limit }

// ParseHistoryListQuery reads the query string.
func ParseHistoryListQuery(c *fiber.Ctx) (HistoryListQuery, error) {
	return parseHistoryQuery(c.Context().QueryArgs())
}

// parseHistoryQuery is the testable core; see parseMarketplaceQuery.
func parseHistoryQuery(args *fasthttp.Args) (HistoryListQuery, error) {
	q := HistoryListQuery{}

	if page, ok := common.ToOptionalInt(argValue(args, "page"), args.Has("page")); ok {
		if *page < 1 {
			return q, common.BadRequest("page must be at least 1")
		}
		q.Page = int(*page)
	}
	if limit, ok := common.ToOptionalInt(argValue(args, "limit"), args.Has("limit")); ok {
		if *limit < 1 {
			return q, common.BadRequest("limit must be at least 1")
		}
		if *limit > historyMaxLimit {
			return q, common.BadRequest(fmt.Sprintf("limit must be at most %d", historyMaxLimit))
		}
		q.Limit = int(*limit)
	}

	// seller and buyer are substring matches against either the wallet address or
	// the username, so they are wrapped in % signs. sellerName and buyerName are
	// exact and case-sensitive -- they are picked from a dropdown of names already
	// in the database rather than typed -- and txHash is a substring because a
	// hash is too long to type in full.
	q.Seller = patternParam(args, "seller")
	q.Buyer = patternParam(args, "buyer")
	q.SellerName = optionalStringParam(args, "sellerName")
	q.BuyerName = optionalStringParam(args, "buyerName")
	q.TxHash = patternParam(args, "txHash")

	// itemName wins over the deprecated q alias whenever itemName is present,
	// including when it is empty. An emptied itemName box means "no item name
	// filter", which is not the same question as "the item name is empty".
	// An empty itemName falls through to the deprecated q alias rather than
	// suppressing it. The original read `(itemName ?? q)?.trim()` after a
	// transform that collapsed "" to undefined, so presence alone is not the
	// test -- a value is required. `?itemName=&q=sword` means "sword".
	if v := joinAll(args, "itemName"); args.Has("itemName") && strings.TrimSpace(v) != "" {
		q.ItemName = patternParam(args, "itemName")
	} else if args.Has("q") {
		q.ItemName = patternParam(args, "q")
	} else if args.Has("itemName") {
		// Present but empty, with no alias to fall back on: no filter.
		q.ItemName = nil
	}

	if token, ok := common.ToOptionalInt(argValue(args, "tokenId"), args.Has("tokenId")); ok {
		v := int32(*token)
		q.TokenID = &v
	}

	if v, ok := common.ToOptionalFloat(argValue(args, "priceMin"), args.Has("priceMin")); ok {
		q.PriceMin = v
	}
	if v, ok := common.ToOptionalFloat(argValue(args, "priceMax"), args.Has("priceMax")); ok {
		q.PriceMax = v
	}

	if day, ok := ParseDay(argValue(args, "createdFrom"), args.Has("createdFrom")); ok {
		q.CreatedFrom = day
	}
	// Exclusive upper bound: the day after the one named, at midnight UTC.
	if day, ok := ParseDay(argValue(args, "createdTo"), args.Has("createdTo")); ok {
		next := day.AddDate(0, 0, 1)
		q.CreatedTo = &next
	}

	if claimed, ok := common.ToOptionalBool(argValue(args, "claimed"), args.Has("claimed")); ok {
		q.Claimed = claimed
	}

	if sort := argValue(args, "sort"); args.Has("sort") {
		if !contains(HistorySorts, sort) {
			return q, common.BadRequest("sort must be one of: " + strings.Join(HistorySorts, ", "))
		}
		q.Sort = sort
	}

	return q.Normalize(), nil
}

// ParseDay reads a YYYY-MM-DD bound.
//
// The value is truncated to its first ten characters, so a full timestamp is
// accepted and reduced to its date part. It is then checked against the
// calendar rather than trusted: 2026-13-99 is well-formed as a string and is
// not a date, and turning it into a bound would either error out the request or
// -- worse -- wrap into a valid-looking instant.
//
// A bound that is not a usable day is dropped rather than rejected, matching
// every other unparseable filter here.
func ParseDay(value string, present bool) (*time.Time, bool) {
	s, ok := common.ToOptionalString(value, present)
	if !ok {
		return nil, false
	}
	// The whole trimmed value must be a day. Truncating to the first ten
	// characters would accept "2026-09-01T10:00:00" and silently apply the
	// filter the client asked for with a boundary it never chose; the original
	// anchored the pattern at both ends and dropped anything else.
	if !dayPattern.MatchString(*s) {
		return nil, false
	}
	t, err := time.Parse("2006-01-02", *s)
	if err != nil {
		return nil, false
	}
	return &t, true
}

// dayPattern matches a bare YYYY-MM-DD, anchored so a timestamp is not one.
var dayPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// PatternOf wraps a value in % signs, for the case-folded substring filters.
// Shared with the marketplace list so both define "substring match" once.
func PatternOf(s string) string { return "%" + s + "%" }

func optionalStringParam(args *fasthttp.Args, key string) *string {
	s, ok := common.ToOptionalString(argValue(args, key), args.Has(key))
	if !ok {
		return nil
	}
	return s
}

func patternParam(args *fasthttp.Args, key string) *string {
	s, ok := common.ToOptionalString(argValue(args, key), args.Has(key))
	if !ok {
		return nil
	}
	p := PatternOf(*s)
	return &p
}

var _ = sql.ErrNoRows
