package dto

import (
	"strings"
	"testing"

	"github.com/valyala/fasthttp"
)

// args builds the parsed query string the parsers see. This is what Express and
// Fiber both hand to the query binder, so a test drives exactly the production
// shape -- "?a=1&a=2" is a repeated key here, not a comma-joined string.
func args(raw string) *fasthttp.Args {
	a := &fasthttp.Args{}
	if raw != "" {
		a.ParseBytes([]byte(raw))
	}
	return a
}

func marketplace(raw string) (MarketplaceListQuery, error) { return parseMarketplaceQuery(args(raw)) }
func history(raw string) (HistoryListQuery, error)         { return parseHistoryQuery(args(raw)) }

// --- Finding 2: an empty canonical value must not suppress its alias ---------

// A URL carrying both spellings is what a stale query string looks like. The
// original normalised first, so an empty canonical value fell through to the
// alias; treating mere presence as authoritative silently dropped the filter.
func TestEmptyCanonicalFallsThroughToAlias(t *testing.T) {
	tests := []struct {
		raw  string
		want []string
	}{
		{"equipment_type=Armor", []string{"Armor"}},
		{"equipmentType=Armor", []string{"Armor"}},
		{"equipment_type=", nil},
		{"equipment_type=&equipmentType=Weapon", []string{"Weapon"}},
		{"equipment_type=Armor&equipmentType=Weapon", []string{"Armor"}},
		{"", nil},
	}
	for _, tt := range tests {
		q, err := marketplace(tt.raw)
		if err != nil {
			t.Fatalf("Parse(%q): %v", tt.raw, err)
		}
		got := q.EquipmentTypes
		if len(got) != len(tt.want) {
			t.Errorf("Parse(%q).EquipmentTypes = %v, want %v", tt.raw, got, tt.want)
			continue
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Errorf("Parse(%q).EquipmentTypes = %v, want %v", tt.raw, got, tt.want)
				break
			}
		}
	}
}

func TestEmptyItemNameFallsThroughToQ(t *testing.T) {
	q, err := history("itemName=&q=sword")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if q.ItemName == nil || *q.ItemName != "%sword%" {
		t.Errorf("ItemName = %v, want the q alias to be consulted", q.ItemName)
	}

	q, err = history("itemName=")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if q.ItemName != nil {
		t.Errorf("ItemName = %v, want no filter when there is no alias to fall back to", *q.ItemName)
	}
}

// --- Finding 3: the bounds are rejected, not silently clamped ----------------

// The service clamps; the edge rejects. `?limit=500` answered 200-with-100 in Go
// and 400 in the original, which is the difference between a client being told
// and a client being misled.
func TestOutOfRangePageAndLimitAreRejected(t *testing.T) {
	for _, raw := range []string{"page=0", "page=-1", "limit=0", "limit=-5", "limit=500"} {
		if _, err := marketplace(raw); err == nil {
			t.Errorf("ParseMarketplaceListQuery(%q) was accepted, want a 400", raw)
		}
	}

	for _, raw := range []string{"page=0", "limit=0", "limit=121"} {
		if _, err := history(raw); err == nil {
			t.Errorf("ParseHistoryListQuery(%q) was accepted, want a 400", raw)
		}
	}
}

func TestInRangeBoundsAreAccepted(t *testing.T) {
	q, err := marketplace("page=2&limit=100")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if q.Page != 2 || q.Limit != 100 {
		t.Errorf("page=%d limit=%d, want 2 and 100", q.Page, q.Limit)
	}

	// 120 is history's ceiling, 100 is the marketplace's.
	h, err := history("limit=120")
	if err != nil {
		t.Fatalf("Parse history: %v", err)
	}
	if h.Limit != 120 {
		t.Errorf("history limit=%d, want 120", h.Limit)
	}
}

func TestDefaultsWhenAbsent(t *testing.T) {
	q, err := marketplace("")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if q.Page != 1 || q.Limit != 20 {
		t.Errorf("page=%d limit=%d, want 1 and 20", q.Page, q.Limit)
	}

	h, err := history("")
	if err != nil {
		t.Fatalf("Parse history: %v", err)
	}
	if h.Page != 1 || h.Limit != 15 {
		t.Errorf("history page=%d limit=%d, want 1 and 15", h.Page, h.Limit)
	}
}

// --- Finding 7: a timestamp is not a day ------------------------------------

// Truncating to the first ten characters applied a filter with a boundary the
// client never chose. The original anchored the pattern at both ends.
func TestOnlyABareDayIsAcceptedAsABound(t *testing.T) {
	for _, raw := range []string{"createdFrom=2026-09-01", "createdTo=2026-09-01"} {
		q, err := history(raw)
		if err != nil {
			t.Fatalf("Parse(%q): %v", raw, err)
		}
		bound := q.CreatedFrom
		if strings.HasPrefix(raw, "createdTo") {
			bound = q.CreatedTo
		}
		if bound == nil {
			t.Errorf("Parse(%q) dropped a bare day", raw)
		}
	}

	// These are all rejected as bounds, so the filter is not applied at all.
	for _, raw := range []string{
		"createdFrom=2026-09-01T10:00:00",
		"createdTo=2026-09-01T10:00:00",
		"createdFrom=2026-9-1",
		"createdFrom=2026-13-45",
		"createdFrom=yesterday",
	} {
		q, err := history(raw)
		if err != nil {
			t.Fatalf("Parse(%q): %v", raw, err)
		}
		if q.CreatedFrom != nil || q.CreatedTo != nil {
			t.Errorf("Parse(%q) applied a bound from %q, want it dropped", raw, raw)
		}
	}
}

func TestParseDayDirectly(t *testing.T) {
	tests := []struct {
		in      string
		wantOK  bool
		wantISO string
	}{
		{"2026-09-01", true, "2026-09-01"},
		{"2026-09-01T10:00:00", false, ""},
		{"", false, ""},
		{"not-a-day", false, ""},
		{"2026-13-45", false, ""},
	}
	for _, tt := range tests {
		got, ok := ParseDay(tt.in, true)
		if ok != tt.wantOK {
			t.Errorf("ParseDay(%q) ok = %v, want %v", tt.in, ok, tt.wantOK)
			continue
		}
		if ok && got.Format("2006-01-02") != tt.wantISO {
			t.Errorf("ParseDay(%q) = %v, want %s", tt.in, got, tt.wantISO)
		}
	}
	if _, ok := ParseDay("", false); ok {
		t.Error("an absent parameter produced a bound")
	}
}

// --- Finding 11: whitespace around a number ---------------------------------

func TestNumbersWithSurroundingWhitespace(t *testing.T) {
	// The original used Number(), which trims. A parameter the client sends
	// becoming a default is worse than one that is rejected.
	q, err := marketplace("page=%202%20&limit=%2010%20")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if q.Page != 2 || q.Limit != 10 {
		t.Errorf("page=%d limit=%d, want 2 and 10", q.Page, q.Limit)
	}
}

func TestSortIsStillValidated(t *testing.T) {
	for _, raw := range []string{"sort=bogus", "sort=", "sort=price_sideways"} {
		if _, err := marketplace(raw); err == nil && raw != "sort=" {
			t.Errorf("Parse(%q) was accepted, want a 400", raw)
		}
	}
	for _, raw := range []string{"sort=price_asc", "sort=recent", "sort=created_at_desc"} {
		if _, err := marketplace(raw); err != nil {
			t.Errorf("Parse(%q): %v", raw, err)
		}
	}
}
