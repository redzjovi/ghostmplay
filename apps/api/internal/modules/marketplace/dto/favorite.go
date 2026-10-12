package dto

import (
	"encoding/json"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
)

// FavoriteInput is a parsed create-or-update body.
//
// Every field is json.RawMessage, and that is the whole design. A field is one
// of three things and the API has to tell them apart:
//
//   - absent -- "leave it as it is"
//   - present and null -- "clear it"
//   - present with a value -- "set it"
//
// A plain *string cannot express the second case distinctly from the first: nil
// means both. Getting that wrong means a client that renames a favorite without
// resending its filters wipes them, which is the bug this shape exists to
// prevent. So the raw bytes are carried and interpreted once, below.
type FavoriteInput struct {
	Name *string

	Q              json.RawMessage
	EquipmentTypes json.RawMessage
	GradeEffects   json.RawMessage
	Sort           json.RawMessage
}

// HasQ reports whether q was supplied at all.
func (f FavoriteInput) HasQ() bool { return f.Q != nil }

// HasEquipmentTypes reports whether equipmentTypes was supplied, under either
// spelling.
func (f FavoriteInput) HasEquipmentTypes() bool {
	return f.EquipmentTypes != nil
}

// HasGradeEffects reports whether gradeEffects was supplied, under either
// spelling.
func (f FavoriteInput) HasGradeEffects() bool { return f.GradeEffects != nil }

// HasSort reports whether sort was supplied.
func (f FavoriteInput) HasSort() bool { return f.Sort != nil }

// HasAnyFilter reports whether the body carries any filter field.
//
// Used to decide whether a request is a rename or a filter edit, because the
// update writes the whole row and must not invent values for fields the client
// did not mention.
func (f FavoriteInput) HasAnyFilter() bool {
	return f.HasQ() || f.HasEquipmentTypes() || f.HasGradeEffects() || f.HasSort()
}

// QValue resolves q to a string and a presence flag: a JSON null means "clear
// it", which is the same end state as an empty string.
func (f FavoriteInput) QValue() (*string, bool) { return stringOrClear(f.Q) }

// SortValue resolves sort, defaulting to "recent" when absent or blank.
func (f FavoriteInput) SortValue() string {
	if v, ok := stringOrClear(f.Sort); ok && strings.TrimSpace(*v) != "" {
		return strings.TrimSpace(*v)
	}
	return "recent"
}

// EquipmentTypesValue resolves the equipment type list. A JSON null and an
// empty list both mean "no equipment filter".
func (f FavoriteInput) EquipmentTypesValue() []string {
	return stringListOrClear(firstPresent(f.EquipmentTypes))
}

// GradeEffectsValue resolves the grade effect list.
func (f FavoriteInput) GradeEffectsValue() []string {
	return stringListOrClear(firstPresent(f.GradeEffects))
}

func firstPresent(values ...json.RawMessage) json.RawMessage {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

// stringOrClear reads a JSON string, treating null as a clear.
func stringOrClear(raw json.RawMessage) (*string, bool) {
	if raw == nil {
		return nil, false
	}
	if string(raw) == "null" {
		return nil, true
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		// Not a string. Treat it as supplied-but-unusable rather than absent, so
		// a malformed field does not silently preserve the old value and look
		// like it worked.
		empty := ""
		return &empty, true
	}
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return nil, true
	}
	return &trimmed, true
}

// stringListOrClear reads a JSON array of strings, also accepting a single
// comma-joined string because the client sends both spellings.
func stringListOrClear(raw json.RawMessage) []string {
	if raw == nil || string(raw) == "null" {
		return []string{}
	}

	var list []string
	if err := json.Unmarshal(raw, &list); err == nil {
		return cleanList(list)
	}

	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return common.SplitCSV(single)
	}

	return []string{}
}

func cleanList(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if t := strings.TrimSpace(v); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// ParseFavoriteInput reads a create or update body from the request.
func ParseFavoriteInput(c *fiber.Ctx) (FavoriteInput, error) {
	return ParseFavoriteBody(c.Body())
}

// ParseFavoriteBody reads a create or update body.
//
// Split from the Fiber-facing wrapper so the parsing -- which is where the
// absent/null/value distinction actually lives -- can be exercised directly,
// without standing up a server to send a request through.
//
// Unknown keys are ignored rather than rejected, matching the global validation
// behaviour of the API: the client sends deprecated aliases and ad-hoc fields,
// and a hard 400 on one of them is hostile.
func ParseFavoriteBody(body []byte) (FavoriteInput, error) {
	var raw map[string]json.RawMessage
	if len(body) > 0 {
		if err := json.Unmarshal(body, &raw); err != nil {
			return FavoriteInput{}, common.BadRequest("request body must be a JSON object")
		}
	}

	in := FavoriteInput{}
	if v, ok := raw["name"]; ok {
		s, _ := stringOrClear(v)
		in.Name = s
	}
	in.Q = raw["q"]

	// camelCase first, then the legacy snake_case alias. Present-and-null on the
	// canonical name wins over a value on the alias, for the same reason it does
	// in the list query: an explicit null is a statement, a stale alias is not.
	in.EquipmentTypes = firstPresent(raw["equipmentTypes"], raw["equipment_type"])
	in.GradeEffects = firstPresent(raw["gradeEffects"], raw["grade_effect"])
	in.Sort = raw["sort"]

	return in, nil
}
