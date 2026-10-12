package sync

import (
	"encoding/json"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
)

// decodeObject parses a JSON object body.
//
// An empty body is an empty map rather than an error, so a handler that only
// cares about one field does not have to distinguish "no body" from "{}" --
// they are the same request as far as field lookup is concerned.
func decodeObject(body []byte) (map[string]json.RawMessage, error) {
	if len(body) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, common.BadRequest("request body must be a JSON object")
	}
	if raw == nil {
		raw = map[string]json.RawMessage{}
	}
	return raw, nil
}

// stringField reads a string field, or "" when it is absent or not a string.
func stringField(raw map[string]json.RawMessage, key string) string {
	v, ok := raw[key]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return ""
	}
	return s
}

// boolField reads a boolean field, defaulting to false.
func boolField(raw map[string]json.RawMessage, key string) bool {
	v, ok := raw[key]
	if !ok {
		return false
	}
	var b bool
	if err := json.Unmarshal(v, &b); err != nil {
		return false
	}
	return b
}
