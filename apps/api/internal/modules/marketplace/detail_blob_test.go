package marketplace

import (
	"encoding/json"
	"testing"

	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/api"
)

// These three columns exist to be a faithful mirror of what the upstream sent.
// An earlier version of the port decoded them into typed Go structs and
// re-encoded them on the way to the database, which silently deleted every key
// the structs did not name and invented keys the upstream had omitted.
//
// The web client reads `x.trait_type ?? x.type`, so the `type` alias some
// tokens send was being deleted here and could never be recovered.

// upstreamDetail is a real-shaped payload with keys that a typed struct would
// not have modelled.
const upstreamDetail = `{
	"tokenId": 64181,
	"indexId": "47022",
	"owner": "0xabc",
	"ownerName": "bagastoss",
	"price": 33.9,
	"ipfs": "https://gw.example",
	"details": {
		"name": "10,000,000 Gold Box",
		"description": "a box",
		"external_url": "https://x/y",
		"image": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
		"attributes": [
			{"trait_type":"Level","type":"Level","value":70,"rarity":0.4},
			{"type":"Equipment Type","value":"Weapon"},
			{"trait_type":"Grade Effect","value":"Legacy","icon":"sword.png"},
			{"value":"orphan, no key at all"}
		]
	},
	"viewData": {
		"datas": [{"title":"Basic Effect","values":["a","b"],"class":"weird","extra":123}],
		"infos": [{"title":"x","valueName":"y","value":"z","nope":true}],
		"viewType": "grid"
	},
	"mintTime": "2026-10-13 02:01:24 +0900 KST",
	"state": "listed",
	"descriptionStyle": [{"x":1}],
	"somethingNobodyModelled": {"deeply":{"nested":[1,2,3]}}
}`

func parseDetail(t *testing.T) *api.ItemDetail {
	t.Helper()
	d := &api.ItemDetail{}
	if err := json.Unmarshal([]byte(upstreamDetail), d); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return d
}

// The stored blobs must come out byte-for-byte as the upstream sent them.
func TestDetailBlobsAreStoredVerbatim(t *testing.T) {
	detail := parseDetail(t)
	payload := detailPayload(detail)

	if payload == nil {
		t.Fatal("detailPayload returned nil for a fetched detail")
	}

	tests := []struct {
		name string
		got  json.RawMessage
	}{
		{"attributes", payload.Attributes},
		{"datas", payload.Datas},
		{"infos", payload.Infos},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got, want any
			if err := json.Unmarshal(tt.got, &got); err != nil {
				t.Fatalf("stored blob is not valid JSON: %v", err)
			}
			if err := json.Unmarshal([]byte(wantBlob(t, tt.name)), &want); err != nil {
				t.Fatalf("fixture is not valid JSON: %v", err)
			}
			if !jsonEqual(got, want) {
				t.Errorf("stored %s differs from the upstream payload\n got: %s\nwant: %s",
					tt.name, tt.got, wantBlob(t, tt.name))
			}
		})
	}
}

// wantBlob returns the upstream's own bytes for one blob.
func wantBlob(t *testing.T, name string) string {
	t.Helper()
	var envelope struct {
		Details struct {
			Attributes json.RawMessage `json:"attributes"`
		} `json:"details"`
		ViewData struct {
			Datas json.RawMessage `json:"datas"`
			Infos json.RawMessage `json:"infos"`
		} `json:"viewData"`
	}
	if err := json.Unmarshal([]byte(upstreamDetail), &envelope); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	switch name {
	case "attributes":
		return string(envelope.Details.Attributes)
	case "datas":
		return string(envelope.ViewData.Datas)
	case "infos":
		return string(envelope.ViewData.Infos)
	}
	t.Fatalf("unknown blob %q", name)
	return ""
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// The keys a typed round-trip would have dropped, named explicitly so the
// failure is legible rather than a diff of two JSON blobs.
func TestDetailBlobsKeepUnknownKeys(t *testing.T) {
	payload := detailPayload(parseDetail(t))

	attrs := string(payload.Attributes)
	for _, key := range []string{`"type"`, `"rarity"`, `"icon"`} {
		if !contains(attrs, key) {
			t.Errorf("stored attributes dropped %s: %s", key, attrs)
		}
	}

	datas := string(payload.Datas)
	for _, key := range []string{`"class"`, `"extra"`} {
		if !contains(datas, key) {
			t.Errorf("stored datas dropped %s: %s", key, datas)
		}
	}

	// An attribute with no key at all must still survive.
	if !contains(attrs, "orphan") {
		t.Errorf("stored attributes dropped the keyless entry: %s", attrs)
	}
}

// Reading an attribute accepts either spelling of the key, because the client
// accepts either and the two have to agree on which ones exist.
func TestAttributesAcceptsBothKeySpellings(t *testing.T) {
	attrs := parseDetail(t).Attributes()
	if len(attrs) != 4 {
		t.Fatalf("decoded %d attributes, want 4", len(attrs))
	}

	found := map[string]string{}
	for _, a := range attrs {
		key := a.Type
		if key == "" {
			key = a.AltType
		}
		found[key] = trimAttrValue(a.Value)
	}

	for key, want := range map[string]string{
		"Level":          "70",
		"Equipment Type": "Weapon",
		"Grade Effect":   "Legacy",
		"":               "orphan, no key at all",
	} {
		if got := found[key]; got != want {
			t.Errorf("attribute %q = %q, want %q", key, got, want)
		}
	}
}

// An absent blob is stored as null, which is what the nullable column means and
// what "the upstream did not send this" should look like.
func TestAbsentDetailBlobsBecomeNull(t *testing.T) {
	d := &api.ItemDetail{}
	if err := json.Unmarshal([]byte(`{"tokenId":1}`), d); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	payload := detailPayload(d)
	for name, blob := range map[string]json.RawMessage{
		"attributes": payload.Attributes,
		"datas":      payload.Datas,
		"infos":      payload.Infos,
	} {
		if string(blob) != "null" {
			t.Errorf("%s = %s, want null", name, blob)
		}
	}
}

func TestDetailPayloadIsNilWhenNothingWasFetched(t *testing.T) {
	if got := detailPayload(nil); got != nil {
		t.Errorf("detailPayload(nil) = %+v, want nil", got)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
