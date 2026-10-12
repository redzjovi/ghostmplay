package common

import (
	"math"
	"strconv"
	"strings"
)

// Query-string parsing shared by the list DTOs.
//
// Each function exists because of a specific ambiguity in how query strings
// arrive, and the behaviour is deliberately narrow: an empty parameter means
// "not supplied", never "match the empty value". Getting that wrong turns
// `?level=` into a filter for level 0 rather than an ignored filter.

// ToCSV folds a repeated or comma-joined parameter into one comma-joined
// string.
//
// A client may send `?equipment_type=Weapon&equipment_type=Armor` or
// `?equipment_type=Weapon,Armor` and both mean the same list. The SQL layer
// takes an array, but parsing has to happen here because a value that is
// present-but-empty and a value that is absent have to become the same thing.
func ToCSV(value string, present bool) (string, bool) {
	if !present {
		return "", false
	}
	parts := SplitCSV(value)
	if len(parts) == 0 {
		return "", false
	}
	return strings.Join(parts, ","), true
}

// SplitCSV splits a comma-joined value, trimming each entry and dropping empty
// ones. A value of `" , , "` therefore yields an empty slice rather than three
// blank filters.
func SplitCSV(value string) []string {
	if !strings.Contains(value, ",") {
		if t := strings.TrimSpace(value); t != "" {
			return []string{t}
		}
		return nil
	}
	raw := strings.Split(value, ",")
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		if t := strings.TrimSpace(r); t != "" {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// ToOptionalInt keeps an empty string as "not supplied" so `?level=` is ignored
// rather than becoming 0. Without this, an empty filter box silently filters
// the list to level-zero items.
//
// The value is trimmed before parsing. The original reached for JavaScript's
// Number(), which ignores surrounding whitespace, so " 12 " was a page number
// there and is not one here otherwise -- and a parameter the client sends that
// silently becomes a default is worse than one that is rejected.
func ToOptionalInt(value string, present bool) (*int64, bool) {
	if !present {
		return nil, false
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, false
	}
	n, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return nil, false
	}
	i := int64(math.Trunc(n))
	return &i, true
}

// ToOptionalFloat keeps an empty string as "not supplied", for the same reason
// as ToOptionalInt.
func ToOptionalFloat(value string, present bool) (*float64, bool) {
	if !present {
		return nil, false
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, false
	}
	n, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return nil, false
	}
	return &n, true
}

// ToOptionalString trims, collapsing a whitespace-only value to "not supplied".
func ToOptionalString(value string, present bool) (*string, bool) {
	if !present {
		return nil, false
	}
	t := strings.TrimSpace(value)
	if t == "" {
		return nil, false
	}
	return &t, true
}

// ToOptionalBool accepts a bare flag (`?claimed`), `?claimed=true`, and the
// usual textual spellings. Only an explicit affirmative is true; anything
// unrecognised is "not supplied" rather than false, because guessing false
// would quietly apply a filter the client never asked for.
func ToOptionalBool(value string, present bool) (*bool, bool) {
	if !present || value == "" {
		return nil, false
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "1", "on", "yes":
		b := true
		return &b, true
	case "false", "0", "off", "no":
		b := false
		return &b, true
	default:
		return nil, false
	}
}
