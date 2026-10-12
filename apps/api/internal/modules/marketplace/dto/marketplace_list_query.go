// Package dto parses query strings and request bodies into the structs the
// services take.
//
// The parsing rules are carried over unchanged from the class-validator DTOs
// they replace, including several that look like bugs and are not:
//
//   - A camelCase alias loses to its snake_case counterpart whenever the
//     snake_case value is present at all, even if it is empty. The canonical
//     names are `equipment_type` and `grade_effect`; the camelCase spellings
//     are deprecated but still sent by the client.
//   - A non-numeric token id is a 400, not a silently-dropped filter.
//   - An empty parameter means "not supplied", never "match the empty value".
package dto

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/valyala/fasthttp"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
)

// MarketplaceSorts are the accepted `sort` values.
var MarketplaceSorts = []string{"price_asc", "price_desc", "recent", "created_at_desc"}

// MarketplaceListQuery is a parsed `GET /api/marketplace/items` query.
type MarketplaceListQuery struct {
	Page  int
	Limit int

	// Q is a substring match on the item name, already wrapped in % signs.
	Q *string

	// EquipmentTypes and GradeEffects are nil when no filter was supplied and
	// non-nil when one was, including when it was explicitly empty. SQL treats
	// both as "no predicate" -- see the queries for why that matters.
	EquipmentTypes []string
	GradeEffects   []string

	Level *int32
	Sort  string
}

// Page and limit bounds.
const (
	marketplaceDefaultLimit = 20
	marketplaceMaxLimit     = 100
)

// Normalize applies the defaults and clamps. It runs after parsing so the clamp
// rules live in exactly one place.
func (q MarketplaceListQuery) Normalize() MarketplaceListQuery {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.Limit < 1 {
		q.Limit = marketplaceDefaultLimit
	}
	if q.Limit > marketplaceMaxLimit {
		q.Limit = marketplaceMaxLimit
	}
	if q.EquipmentTypes == nil {
		q.EquipmentTypes = []string{}
	}
	if q.GradeEffects == nil {
		q.GradeEffects = []string{}
	}
	return q
}

// Offset is the row offset for this page.
func (q MarketplaceListQuery) Offset() int { return (q.Page - 1) * q.Limit }

// ParseMarketplaceListQuery reads the query string.
//
// An unrecognised `sort` is rejected rather than ignored. Every other parameter
// that cannot be understood is ignored, because the client sends deprecated
// aliases and ad-hoc filters and refusing them would be hostile; `sort` is
// different in that silently falling back to the default hides a UI bug behind
// a list that looks plausible.
func ParseMarketplaceListQuery(c *fiber.Ctx) (MarketplaceListQuery, error) {
	return parseMarketplaceQuery(c.Context().QueryArgs())
}

// parseMarketplaceQuery is the testable core, taking the parsed query string
// rather than a request. Every rule below is about how a parameter arrives, so
// being able to hand it one directly is most of what the tests need.
func parseMarketplaceQuery(args *fasthttp.Args) (MarketplaceListQuery, error) {
	q := MarketplaceListQuery{}

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
		if *limit > marketplaceMaxLimit {
			return q, common.BadRequest(fmt.Sprintf("limit must be at most %d", marketplaceMaxLimit))
		}
		q.Limit = int(*limit)
	}
	if s, ok := common.ToOptionalString(argValue(args, "q"), args.Has("q")); ok {
		// The % wrapping happens here rather than in SQL so the pattern and the
		// parameter are the same value. A substring match is the intent; an
		// exact one would return almost nothing.
		pattern := "%" + *s + "%"
		q.Q = &pattern
	}

	// Canonical snake_case first, camelCase second. Present-and-empty beats
	// absent, which is why this is a presence check rather than a value check:
	// a client that sends equipment_type= is asking for no equipment filter,
	// and that outranks a stale equipmentType=Weapon left on the URL.
	equipment := paramWithFallback(args, "equipment_type", "equipmentType")
	if equipment.present {
		q.EquipmentTypes = common.SplitCSV(equipment.value)
	}

	grade := paramWithFallback(args, "grade_effect", "gradeEffect")
	if grade.present {
		q.GradeEffects = common.SplitCSV(grade.value)
	}

	if level, ok := common.ToOptionalInt(argValue(args, "level"), args.Has("level")); ok {
		v := int32(*level)
		q.Level = &v
	}

	if sort := argValue(args, "sort"); args.Has("sort") {
		if !contains(MarketplaceSorts, sort) {
			return q, common.BadRequest("sort must be one of: " + strings.Join(MarketplaceSorts, ", "))
		}
		q.Sort = sort
	}

	return q.Normalize(), nil
}

// TokenIDParam parses a path parameter that must be an integer.
//
// Path params always arrive as strings, and a non-numeric token id is a client
// bug. It is surfaced as a 400 rather than reaching the query layer as a zero
// and quietly resolving some other token.
func TokenIDParam(c *fiber.Ctx) (int32, error) {
	raw := c.Params("tokenId")
	n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 32)
	if err != nil {
		return 0, common.BadRequest("tokenId must be an integer")
	}
	return int32(n), nil
}

// IDParam parses a numeric :id path parameter.
func IDParam(c *fiber.Ctx) (int32, error) {
	raw := c.Params("id")
	n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 32)
	if err != nil {
		return 0, common.BadRequest("id must be an integer")
	}
	return int32(n), nil
}

type param struct {
	value   string
	present bool
}

// paramWithFallback resolves the canonical name against a deprecated alias.
//
// An empty canonical value is treated as absent, which is the rule that matters
// and the one that is easy to get backwards. The original read
// `equipment_type ?? equipmentType` and then normalised, where normalisation
// collapses "" to undefined -- so `?equipment_type=` fell through to the alias
// rather than suppressing it.
//
// Checking mere presence instead would make `?equipment_type=&equipmentType=Weapon`
// mean "no equipment filter" where the original meant "Weapon". A URL carrying
// both spellings is what a stale query string looks like, and silently dropping
// the filter is the worst possible reading of it.
func paramWithFallback(args *fasthttp.Args, canonical, alias string) param {
	if v := joinAll(args, canonical); args.Has(canonical) && strings.TrimSpace(v) != "" {
		return param{value: v, present: true}
	}
	if v := joinAll(args, alias); args.Has(alias) && strings.TrimSpace(v) != "" {
		return param{value: v, present: true}
	}
	// Present but empty on the canonical name, with nothing on the alias: the
	// caller asked for no filter, and that is still not the same as "absent" for
	// a filter the UI is clearing.
	if args.Has(canonical) && !args.Has(alias) {
		return param{value: "", present: true}
	}
	return param{}
}

// joinAll collapses a possibly-repeated parameter into one comma-joined value,
// so `?a=1&a=2` and `?a=1,2` reach the service identically.
func joinAll(args *fasthttp.Args, key string) string {
	values := args.PeekMulti(key)
	if len(values) == 1 {
		return string(values[0])
	}
	parts := make([]string, 0, len(values))
	for _, v := range values {
		parts = append(parts, string(v))
	}
	return strings.Join(parts, ",")
}

func argValue(args *fasthttp.Args, key string) string {
	return string(args.Peek(key))
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
