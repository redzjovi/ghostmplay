package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// These tests exist because the client was once wrong in two ways at once, and
// neither was caught by any test: the routes were missing their resource-group
// segment, and the {message,data} envelope was never unwrapped. The first
// produced a loud 404 for two endpoints and a silent wrong endpoint for the
// third; the second produced a silent empty result for all three. Nothing
// asserted the request path or the response decoding, so nothing noticed.

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// recorded is what a fake upstream saw.
type recorded struct {
	Method string
	Path   string
	Query  string
	Header http.Header
	Form   string
}

type fakeUpstream struct {
	t        *testing.T
	server   *httptest.Server
	last     recorded
	requests []recorded
	// handler writes the response; default is a wrapped search page.
	handler func(w http.ResponseWriter, r *http.Request)
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	f := &fakeUpstream{t: t}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.last = recorded{
			Method: r.Method,
			Path:   r.URL.Path,
			Query:  r.URL.RawQuery,
			Header: r.Header.Clone(),
			Form:   r.Form.Encode(),
		}
		f.requests = append(f.requests, f.last)

		w.Header().Set("Content-Type", "application/json")
		if f.handler != nil {
			f.handler(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"message":"ok","data":{"count":0,"ipfs":"","items":[]}}`))
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeUpstream) client() *Client {
	c := NewClient(testLogger())
	c.SetBaseURL(f.server.URL)
	// Pin the profile so a test can assert on headers deterministically.
	c.SetProfiles(&browserProfiles{pool: defaultProfiles().pool, fixed: 1})
	return c
}

// writeJSON sends a JSON body with the given status.
func writeJSON(t *testing.T, w http.ResponseWriter, status int, body string) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// --- Bug A: the routes ------------------------------------------------------

// The exact path is asserted per endpoint, including the resource-group segment.
// A route that quietly resolves to a different endpoint is the failure this
// pins down: /api/users/token-transfers answers 200 with rows that have none of
// the fields the ledger needs.
func TestRoutesMatchTheUpstream(t *testing.T) {
	tests := []struct {
		name       string
		call       func(c *Client) error
		wantMethod string
		wantPath   string
	}{
		{
			name:       "search listings",
			call:       func(c *Client) error { _, err := c.SearchRedis(context.Background(), SearchRedisOptions{}); return err },
			wantMethod: http.MethodGet,
			wantPath:   "/api/users/market/search-redis",
		},
		{
			name:       "item detail",
			call:       func(c *Client) error { _, err := c.DetailStrict(context.Background(), 1, ""); return err },
			wantMethod: http.MethodPost,
			wantPath:   "/api/users/nft/item-detail",
		},
		{
			name: "token transfers",
			call: func(c *Client) error {
				_, err := c.TokenTransfers(context.Background(), TokenTransfersOptions{})
				return err
			},
			wantMethod: http.MethodGet,
			wantPath:   "/api/users/market/token-transfers",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			up := newFakeUpstream(t)
			if err := tt.call(up.client()); err != nil {
				t.Fatalf("call: %v", err)
			}
			if up.last.Method != tt.wantMethod {
				t.Errorf("method = %s, want %s", up.last.Method, tt.wantMethod)
			}
			if up.last.Path != tt.wantPath {
				t.Errorf("path = %s, want %s", up.last.Path, tt.wantPath)
			}
		})
	}
}

// The path constants are what the routes above are built from. Asserting them
// directly means changing one without changing the other fails here.
func TestPathConstants(t *testing.T) {
	tests := map[string]string{
		PathSearchListings: "market/search-redis",
		PathItemDetail:     "nft/item-detail",
		PathTokenTransfers: "market/token-transfers",
	}
	for got, want := range tests {
		if got != want {
			t.Errorf("path constant = %q, want %q", got, want)
		}
	}
}

func TestSearchRedisSendsItsParameters(t *testing.T) {
	up := newFakeUpstream(t)
	c := up.client()

	if _, err := c.SearchRedis(context.Background(), SearchRedisOptions{
		ItemName: "Blade",
		Sort:     "price_asc",
		Offset:   3,
		Limit:    25,
	}); err != nil {
		t.Fatalf("SearchRedis: %v", err)
	}

	q := up.last.Query
	for _, want := range []string{"serviceName=GhostMGlobal", "sort=price_asc", "offset=3", "limit=25", "itemName=Blade"} {
		if !strings.Contains(q, want) {
			t.Errorf("query %q is missing %q", q, want)
		}
	}
}

func TestSearchRedisOmitsAnEmptyItemName(t *testing.T) {
	// An empty itemName is a filter for items with no name, which is not a
	// question anyone is asking. Sending it would return nothing.
	up := newFakeUpstream(t)
	if _, err := up.client().SearchRedis(context.Background(), SearchRedisOptions{}); err != nil {
		t.Fatalf("SearchRedis: %v", err)
	}
	if strings.Contains(up.last.Query, "itemName") {
		t.Errorf("query %q contains itemName, want it omitted when empty", up.last.Query)
	}
}

func TestItemDetailPostsFormEncoded(t *testing.T) {
	up := newFakeUpstream(t)
	if _, err := up.client().DetailStrict(context.Background(), 64181, "GhostMGlobal"); err != nil {
		t.Fatalf("DetailStrict: %v", err)
	}
	if ct := up.last.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/x-www-form-urlencoded") {
		t.Errorf("Content-Type = %q, want form encoding", ct)
	}
	for _, want := range []string{"tokenId=64181", "serviceName=GhostMGlobal"} {
		if !strings.Contains(up.last.Form, want) {
			t.Errorf("form %q is missing %q", up.last.Form, want)
		}
	}
}

// --- Bug B: the envelope ----------------------------------------------------

func TestDecodeEnvelopeUnwrapsData(t *testing.T) {
	up := newFakeUpstream(t)
	up.handler = func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, 200, `{"message":"성공","data":{
			"count":1234,"ipfs":"https://gw.example",
			"items":[{"item_id":42,"token_id":"999","price":7.5,"item_name":"Blade","trait_pairs":["Level=3"],"trait_nums":{"Level":3}}]
		}}`)
	}

	res, err := up.client().SearchRedis(context.Background(), SearchRedisOptions{})
	if err != nil {
		t.Fatalf("SearchRedis: %v", err)
	}

	// Every one of these is zero when the envelope is not unwrapped, and none of
	// them produces an error.
	if res.Count != 1234 {
		t.Errorf("Count = %v, want 1234 (envelope not unwrapped?)", res.Count)
	}
	if res.IPFS != "https://gw.example" {
		t.Errorf("IPFS = %q, want the value from inside data", res.IPFS)
	}
	if len(res.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(res.Items))
	}
	if res.Items[0].ItemID != 42 || res.Items[0].TokenID.String() != "999" {
		t.Errorf("item = %+v, want item_id 42 / token_id 999", res.Items[0])
	}
	if len(res.Items[0].TraitPairs) != 1 || res.Items[0].TraitPairs[0] != "Level=3" {
		t.Errorf("trait_pairs = %v, want [Level=3]", res.Items[0].TraitPairs)
	}
}

func TestDecodeEnvelopeOnTransfers(t *testing.T) {
	up := newFakeUpstream(t)
	up.handler = func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, 200, `{"message":"성공","data":{"count":26002,"lists":[
			{"token_id":"50104","seller":"0xaaa","buyer":"0xbbb","game_name":"GhostMGlobal",
			 "item_name":"Blade","price":150,"currency":"NUMI","tx_hash":"0xdead",
			 "image_url":"https://img","time":"2026-10-13 05:28:18"}
		]}}`)
	}

	res, err := up.client().TokenTransfers(context.Background(), TokenTransfersOptions{})
	if err != nil {
		t.Fatalf("TokenTransfers: %v", err)
	}
	if res.Count != 26002 {
		t.Errorf("Count = %v, want 26002", res.Count)
	}
	if len(res.Lists) != 1 {
		t.Fatalf("lists = %d, want 1", len(res.Lists))
	}
	// The fields the whole history sync depends on. The wrong endpoint returned
	// rows with none of them, so every one of these would have been empty.
	if res.Lists[0].TxHash != "0xdead" || res.Lists[0].Seller != "0xaaa" || res.Lists[0].Buyer != "0xbbb" {
		t.Errorf("transfer = %+v, want the fields from inside data", res.Lists[0])
	}
	if res.Lists[0].Time != "2026-10-13 05:28:18" {
		t.Errorf("Time = %q, want the value from inside data", res.Lists[0].Time)
	}
}

func TestDecodeEnvelopeFallsBackWhenThereIsNoData(t *testing.T) {
	// The previous implementation was `data.data ?? data`: a response without
	// the wrapper still decoded.
	up := newFakeUpstream(t)
	up.handler = func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, 200, `{"count":7,"items":[]}`)
	}
	res, err := up.client().SearchRedis(context.Background(), SearchRedisOptions{})
	if err != nil {
		t.Fatalf("SearchRedis: %v", err)
	}
	if res.Count != 7 {
		t.Errorf("Count = %v, want 7 from the unwrapped body", res.Count)
	}
}

// JavaScript's `??` treats null as absent, so `"data": null` fell back to the
// whole body. A nil check on a json.RawMessage does not, because null
// unmarshals to a four-byte slice. Both spellings are handled.
func TestDecodeEnvelopeFallsBackWhenDataIsNull(t *testing.T) {
	up := newFakeUpstream(t)
	up.handler = func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, 200, `{"data":null,"count":9,"items":[]}`)
	}
	res, err := up.client().SearchRedis(context.Background(), SearchRedisOptions{})
	if err != nil {
		t.Fatalf("SearchRedis: %v", err)
	}
	if res.Count != 9 {
		t.Errorf("Count = %v, want 9; a null data should fall back to the body", res.Count)
	}
}

func TestDecodeEnvelopeRejectsGarbage(t *testing.T) {
	up := newFakeUpstream(t)
	up.handler = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`not json at all`))
	}
	if _, err := up.client().SearchRedis(context.Background(), SearchRedisOptions{}); err == nil {
		t.Error("a non-JSON body was accepted")
	}
}

// --- errors and the detail/strict split ------------------------------------

// resolveOwnerInline's 400-means-claimed rule depends on the status surviving
// to the caller. Detail swallows it; DetailStrict must not.
func TestDetailSwallowsEveryErrorAndStrictDoesNot(t *testing.T) {
	up := newFakeUpstream(t)
	up.handler = func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, 400, `{"message":"bad token"}`)
	}

	if _, err := up.client().Detail(context.Background(), 1); err != nil {
		t.Errorf("Detail returned %v, want every error swallowed", err)
	}

	_, err := up.client().DetailStrict(context.Background(), 1, "")
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("DetailStrict error = %v, want an *HTTPError", err)
	}
	if httpErr.Status != 400 {
		t.Errorf("status = %d, want 400", httpErr.Status)
	}
	if StatusOf(err) != 400 {
		t.Errorf("StatusOf = %d, want 400", StatusOf(err))
	}
}

// A 500 must also be distinguishable from a 400, or a transient upstream blip
// would be recorded as a claimed token that is then never re-checked.
func TestStatusOfDistinguishesServerFailureFromClaimed(t *testing.T) {
	up := newFakeUpstream(t)
	up.handler = func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, 500, `boom`)
	}
	_, err := up.client().DetailStrict(context.Background(), 1, "")
	if got := StatusOf(err); got != 500 {
		t.Errorf("StatusOf = %d, want 500", got)
	}
}

func TestNonJSONErrorBodyStillCarriesItsStatus(t *testing.T) {
	up := newFakeUpstream(t)
	up.handler = func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte("404 page not found"))
	}
	_, err := up.client().SearchRedis(context.Background(), SearchRedisOptions{})
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("error = %v, want an *HTTPError", err)
	}
	if httpErr.Status != 404 {
		t.Errorf("status = %d, want 404", httpErr.Status)
	}
	if !strings.Contains(httpErr.Body, "404 page not found") {
		t.Errorf("body = %q, want the upstream text", httpErr.Body)
	}
}

// --- headers ----------------------------------------------------------------

func TestRequestsCarryBrowserHeaders(t *testing.T) {
	up := newFakeUpstream(t)
	if _, err := up.client().SearchRedis(context.Background(), SearchRedisOptions{}); err != nil {
		t.Fatalf("SearchRedis: %v", err)
	}

	for _, key := range []string{"User-Agent", "Accept", "Origin", "Referer", "Sec-Fetch-Mode", "sec-ch-ua", "sec-ch-ua-platform"} {
		if up.last.Header.Get(key) == "" {
			t.Errorf("header %s is missing", key)
		}
	}
	if got := up.last.Header.Get("Origin"); got != "https://market.numine.io" {
		t.Errorf("Origin = %q, want the upstream's own origin", got)
	}
}

func TestHeadersAreCoherent(t *testing.T) {
	// The whole reason the profile is a struct rather than a bag of independent
	// random fields: a Chrome 153 User-Agent beside a 126 client-hint, or a
	// Windows UA beside a Linux platform hint, is a combination no browser emits
	// and is therefore MORE distinctive than a fixed fingerprint.
	profiles := defaultProfiles()
	for i, p := range profiles.pool {
		h := p.headers()

		ua := h["User-Agent"]
		if !strings.Contains(ua, "Chrome/"+strconv.Itoa(p.Version)) {
			t.Errorf("profile %d: UA %q does not carry Chrome/%d", i, ua, p.Version)
		}
		if !strings.Contains(h["sec-ch-ua"], `"`+strconv.Itoa(p.Version)+`"`) {
			t.Errorf("profile %d: sec-ch-ua %q does not carry version %d", i, h["sec-ch-ua"], p.Version)
		}
		if p.platformToken != "" && !strings.Contains(ua, p.platformToken) {
			t.Errorf("profile %d: UA %q does not carry platform token %q", i, ua, p.platformToken)
		}
		if p.Mobile && h["sec-ch-ua-mobile"] != "?1" {
			t.Errorf("profile %d: mobile profile reports sec-ch-ua-mobile %q", i, h["sec-ch-ua-mobile"])
		}
		if !p.Mobile && h["sec-ch-ua-mobile"] != "?0" {
			t.Errorf("profile %d: desktop profile reports sec-ch-ua-mobile %q", i, h["sec-ch-ua-mobile"])
		}
	}
}

func TestHeadersVaryBetweenRequests(t *testing.T) {
	profiles := defaultProfiles()
	seen := map[string]struct{}{}
	for range 200 {
		seen[profiles.pick().headers()["User-Agent"]] = struct{}{}
	}
	if len(seen) < 2 {
		t.Errorf("200 draws produced %d distinct User-Agents, want the profile to rotate", len(seen))
	}
}

func TestNilProfilesStillProduceHeaders(t *testing.T) {
	// A Client whose profile set is nil must still send a complete, coherent
	// set rather than panicking or sending half a fingerprint. pick() is called
	// on every request, so a nil here is a crash on the sync's hot path.
	var profiles *browserProfiles

	h := profiles.pick().headers()
	for _, key := range []string{"User-Agent", "Accept", "Origin", "Referer", "Sec-Fetch-Mode", "sec-ch-ua", "sec-ch-ua-platform"} {
		if h[key] == "" {
			t.Errorf("fallback profile is missing %s", key)
		}
	}
}
