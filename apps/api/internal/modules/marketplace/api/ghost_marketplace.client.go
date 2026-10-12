// Package api is the HTTP client for market-api.numine.io, the public upstream
// this app scrapes.
//
// Nothing here is authenticated. The upstream is public and answers to anyone,
// which is the whole reason the sync layer is careful about how much it asks for
// and how often: a duplicate scrape costs the upstream real capacity and buys
// nothing.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// BaseURL is the upstream marketplace API.
const BaseURL = "https://market-api.numine.io"

// DefaultServiceName is the only game this app tracks.
const DefaultServiceName = "GhostMGlobal"

// The upstream's routes, relative to /api/users.
//
// The middle segment is part of the route and omitting it does not reliably
// fail: /api/users/token-transfers answers 200 from a *different* endpoint whose
// rows use different field names entirely. So the paths are named here, spelled
// out in full, and asserted in the tests -- a route that quietly resolves is worse
// than one that 404s.
const (
	PathSearchListings = "market/search-redis"
	PathItemDetail     = "nft/item-detail"
	PathTokenTransfers = "market/token-transfers"
)

// RequestTimeout bounds a single upstream call.
//
// Long enough for a slow page of results, short enough that a hung connection
// does not hold one of the sync worker's three slots indefinitely -- which
// matters because backfill walks thousands of pages through a fixed-size pool.
const RequestTimeout = 15 * time.Second

// Client talks to the upstream marketplace API.
type Client struct {
	http    *http.Client
	log     *slog.Logger
	baseURL string
	// profiles supplies the browser headers sent with each request. A field so
	// a test can pin it; nil means "pick at random per request".
	profiles *browserProfiles
}

// NewClient builds a client. The log level is taken from the logger's enabled
// state, so setting the level to Info is all it takes to get upstream logging.
func NewClient(log *slog.Logger) *Client {
	return &Client{
		http:     &http.Client{Timeout: RequestTimeout},
		log:      log,
		baseURL:  BaseURL,
		profiles: defaultProfiles(),
	}
}

// SetBaseURL overrides the upstream address. For tests.
func (c *Client) SetBaseURL(u string) { c.baseURL = strings.TrimRight(u, "/") }

// SetProfiles pins the browser-header profiles instead of picking at random.
// For tests, which need a request to look identical every time.
func (c *Client) SetProfiles(p *browserProfiles) { c.profiles = p }

// HTTPError carries the upstream status code.
//
// The distinction between this and a transport failure is load-bearing for the
// history sync: a 400 from item-detail means "this token is claimed" and is
// recorded as such, while a 500 or a DNS failure means "we do not know" and must
// not be recorded as anything.
type HTTPError struct {
	Status int
	Body   string
	Op     string
}

// StatusCode exposes the status through a method rather than a field so the
// retry classifier can duck-type it the same way it duck-types any other HTTP
// error. A field of this name would have occupied the method name.
func (e *HTTPError) StatusCode() int { return e.Status }

func (e *HTTPError) Error() string {
	return fmt.Sprintf("%s: upstream returned HTTP %d: %s", e.Op, e.Status, e.Body)
}

// StatusOf returns the upstream status code carried by an error, or 0.
func StatusOf(err error) int {
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.Status
	}
	return 0
}

// SearchRedisItem is one listing from the search endpoint.
type SearchRedisItem struct {
	ItemID     int32              `json:"item_id"`
	ViewCount  float64            `json:"view_count"`
	Price      float64            `json:"price"`
	CreatedAt  float64            `json:"created_at"`
	TokenID    json.Number        `json:"token_id"`
	UID        string             `json:"uid"`
	GameName   string             `json:"game_name"`
	Seller     string             `json:"seller"`
	ItemName   string             `json:"item_name"`
	Currency   string             `json:"currency"`
	ImageURL   string             `json:"image_url"`
	TraitPairs []string           `json:"trait_pairs"`
	TraitNums  map[string]float64 `json:"trait_nums"`
}

// SearchRedisResponse is the search endpoint's body.
type SearchRedisResponse struct {
	Count float64           `json:"count"`
	IPFS  string            `json:"ipfs"`
	Items []SearchRedisItem `json:"items"`
}

// SearchRedisOptions are the search endpoint's parameters.
type SearchRedisOptions struct {
	ServiceName string
	ItemName    string
	Sort        string
	// Offset is a PAGE INDEX, not a row offset. The upstream takes 0, 1, 2...
	// and returns the nth page of `limit` rows. Passing a row offset would walk
	// the whole table twice over and silently return nothing useful.
	Offset int
	Limit  int
}

// SearchRedis fetches one page of listings.
func (c *Client) SearchRedis(ctx context.Context, opts SearchRedisOptions) (*SearchRedisResponse, error) {
	if opts.ServiceName == "" {
		opts.ServiceName = DefaultServiceName
	}
	if opts.Sort == "" {
		opts.Sort = "created_at_desc"
	}
	if opts.Limit <= 0 {
		opts.Limit = 12
	}

	q := url.Values{}
	q.Set("serviceName", opts.ServiceName)
	q.Set("sort", opts.Sort)
	q.Set("offset", strconv.Itoa(opts.Offset))
	q.Set("limit", strconv.Itoa(opts.Limit))
	// Only sent when non-empty. An empty itemName is a filter for items with no
	// name, which is not a question anyone is asking.
	if opts.ItemName != "" {
		q.Set("itemName", opts.ItemName)
	}

	var out SearchRedisResponse
	if err := c.get(ctx, PathSearchListings, q, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ItemDetail is the upstream item-detail response.
//
// `details.attributes` is the authoritative source for Level, Equipment Type,
// Enchant and Grade Effect when it is present; the flat `trait_pairs` on the
// search result is the fallback. Both spellings appear in the wild depending on
// how the token was minted.
type ItemDetail struct {
	// Raw is the decoded object, keys and all.
	//
	// /live proxies the upstream response to the preview dialog verbatim, so the
	// unknown keys have to survive. Typed fields alongside it cover what the
	// sync actually reads; this covers everything else.
	Raw map[string]any `json:"-"`

	TokenID     int32   `json:"tokenId"`
	IndexID     string  `json:"indexId"`
	ServiceName string  `json:"serviceName"`
	IPFS        string  `json:"ipfs"`
	Owner       string  `json:"owner"`
	OwnerName   string  `json:"ownerName"`
	ViewCount   float64 `json:"viewCount"`
	Price       float64 `json:"price"`

	// The three stored blobs are held as raw JSON, not as typed slices.
	//
	// This is not laziness, it is the only way to store them faithfully. These
	// columns are a verbatim mirror of what the upstream sent and the detail page
	// renders whatever arrives. Typed fields would DROP every key the struct does
	// not name -- and the client reads `x.trait_type ?? x.type`, so the `type`
	// alias some tokens send would be deleted here and never recovered -- while
	// also materialising keys the upstream omitted, as `{"trait_type":"","value":null}`
	// rather than leaving them absent.
	//
	// So they are passed through untouched, and anything that needs to read one
	// decodes it on the spot into whatever shape it wants.
	Details struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		// Image is a bare CID on a real gateway, not a URL.
		Image       string          `json:"image"`
		ExternalURL string          `json:"external_url"`
		Attributes  json.RawMessage `json:"attributes"`
	} `json:"details"`

	ViewData struct {
		Datas    json.RawMessage `json:"datas"`
		Infos    json.RawMessage `json:"infos"`
		ViewType string          `json:"viewType"`
	} `json:"viewData"`

	// MintTime is the upstream's own format, e.g. "2026-09-20 00:06:31 +0900 KST".
	MintTime    string `json:"mintTime"`
	MarketTime  string `json:"marketTime"`
	State       string `json:"state"`
	Description any    `json:"descriptionStyle"`
}

// Detail fetches an item's detail, treating any failure as "no detail".
//
// Every error is swallowed, including a 400. That is what makes the result
// unusable for anything that needs to know *why* it failed -- which is why the
// history sync calls DetailStrict instead and handles the error itself.
//
// Used by the marketplace scrape, where a missing detail blob is not a signal
// about anything: sold state is derived from the transfer ledger, not inferred
// from a failed fetch.
func (c *Client) Detail(ctx context.Context, tokenID int32) (*ItemDetail, error) {
	detail, err := c.DetailStrict(ctx, tokenID, DefaultServiceName)
	if err != nil {
		return nil, nil
	}
	return detail, nil
}

// DetailStrict fetches an item's detail and propagates failures.
//
// The caller has to be able to tell a 400 from a 500, so this does not swallow
// anything. The 400-means-claimed rule in the history sync depends on it.
func (c *Client) DetailStrict(ctx context.Context, tokenID int32, serviceName string) (*ItemDetail, error) {
	if serviceName == "" {
		serviceName = DefaultServiceName
	}

	form := url.Values{}
	form.Set("tokenId", strconv.FormatInt(int64(tokenID), 10))
	form.Set("serviceName", serviceName)

	var out ItemDetail
	if err := c.post(ctx, PathItemDetail, form, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// TokenTransferItem is one entry from the transfer endpoint.
type TokenTransferItem struct {
	TokenID  json.Number `json:"token_id"`
	Seller   string      `json:"seller"`
	Buyer    string      `json:"buyer"`
	GameName string      `json:"game_name"`
	ItemName string      `json:"item_name"`
	Price    float64     `json:"price"`
	Currency string      `json:"currency"`
	TxHash   string      `json:"tx_hash"`
	ImageURL string      `json:"image_url"`
	// Time is the transfer time in the market's own clock, with no offset.
	Time string `json:"time"`
}

// TokenTransfersResponse is the transfer endpoint's body.
type TokenTransfersResponse struct {
	Count float64             `json:"count"`
	Lists []TokenTransferItem `json:"lists"`
}

// TokenTransfersOptions are the transfer endpoint's parameters.
type TokenTransfersOptions struct {
	Limit int
	// Offset is a PAGE INDEX, as on the other two endpoints.
	Offset int
}

// TokenTransfers fetches one page of the transfer ledger.
func (c *Client) TokenTransfers(ctx context.Context, opts TokenTransfersOptions) (*TokenTransfersResponse, error) {
	if opts.Limit <= 0 {
		opts.Limit = 150
	}

	q := url.Values{}
	q.Set("limit", strconv.Itoa(opts.Limit))
	q.Set("offset", strconv.Itoa(opts.Offset))

	var out TokenTransfersResponse
	if err := c.get(ctx, PathTokenTransfers, q, &out); err != nil {
		return nil, err
	}
	if out.Lists == nil {
		out.Lists = []TokenTransferItem{}
	}
	return &out, nil
}

func (c *Client) get(ctx context.Context, path string, query url.Values, out any) error {
	target := fmt.Sprintf("%s/api/users/%s?%s", c.baseURL, path, query.Encode())
	return c.do(ctx, http.MethodGet, path, target, nil, out)
}

func (c *Client) post(ctx context.Context, path string, form url.Values, out any) error {
	target := fmt.Sprintf("%s/api/users/%s", c.baseURL, path)
	return c.do(ctx, http.MethodPost, path, target, form, out)
}

func (c *Client) do(ctx context.Context, method, op, target string, form url.Values, out any) error {
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}

	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return fmt.Errorf("build %s %s: %w", method, target, err)
	}
	// Drawn per request, but as a coherent whole -- see browser_headers.go for
	// why the fields must not be randomised independently of each other.
	for k, v := range c.profiles.pick().headers() {
		req.Header.Set(k, v)
	}
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}

	c.log.Debug("upstream request", "op", op, "url", target)

	res, err := c.http.Do(req)
	if err != nil {
		// Transport failures are deliberately not wrapped in HTTPError: no
		// status was received, so the retry classifier in the sync module must
		// see them as transient, which it decides from the Go error.
		return fmt.Errorf("%s %s: %w", method, target, err)
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return fmt.Errorf("%s %s: read body: %w", method, target, err)
	}

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		// The body is truncated: it is enough to diagnose, and an upstream error
		// page is not something to hold a megabyte of in a log line.
		return &HTTPError{
			Status: res.StatusCode,
			Body:   truncate(string(raw), 300),
			Op:     op,
		}
	}

	c.log.Debug("upstream response", "op", op, "status", res.StatusCode, "bytes", len(raw))

	if err := decodeEnvelope(raw, out); err != nil {
		return fmt.Errorf("%s %s: decode: %w", method, target, err)
	}
	return nil
}

// upstreamEnvelope is the shape every endpoint wraps its payload in:
//
//	{"message":"성공","data":{ ... }}
//
// Decoding the body directly into the response struct leaves every field at its
// zero value, silently: a search returns "0 listings", a transfer page returns
// empty rows. Nothing errors. That failure mode is why this is here.
type upstreamEnvelope struct {
	Data    json.RawMessage `json:"data"`
	Message string          `json:"message"`
}

// decodeEnvelope unwraps `data` and decodes it into out.
//
// Falls back to decoding the whole body when there is no usable `data`. The
// previous implementation did `data.data ?? data`, and in JavaScript `??`
// treats `null` as absent -- so a literal `"data": null` fell back too. A plain
// nil check on a json.RawMessage would not, because `null` unmarshals to a
// four-byte slice rather than to nil. Both spellings are handled here.
func decodeEnvelope(raw []byte, out any) error {
	var env upstreamEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		// Not an object with a `data` key: the caller sent a bare payload, or
		// something that is not JSON at all. Let the direct decode produce the
		// useful error.
		return json.Unmarshal(raw, out)
	}

	body := env.Data
	if len(body) == 0 || string(body) == "null" {
		body = raw
	}
	return json.Unmarshal(body, out)
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

// Attribute is one entry from the stored attributes blob.
//
// Declared here, next to the raw field, rather than inline in the consumer, so
// that the one place that knows the blob is untyped is also the place that
// knows what it looks like.
type Attribute struct {
	// Type is the canonical key.
	Type string `json:"trait_type"`
	// AltType is the alias some tokens use instead of trait_type. Kept because
	// the client reads `trait_type ?? type`; anything that normalises the key
	// has to preserve the alternative rather than collapse it.
	AltType string `json:"type"`
	Value   any    `json:"value"`
}

// Attributes decodes the stored attribute blob.
//
// Returns nil on absent or undecodable input, which is what the callers treat
// as "fall back to the search result's trait_pairs".
func (d *ItemDetail) Attributes() []Attribute {
	if d == nil || len(d.Details.Attributes) == 0 {
		return nil
	}
	var out []Attribute
	if err := json.Unmarshal(d.Details.Attributes, &out); err != nil {
		return nil
	}
	return out
}

// Datas decodes the stored datas blob, kept raw because only the detail page
// reads it.
func (d *ItemDetail) Datas() json.RawMessage {
	if d == nil {
		return nil
	}
	return d.ViewData.Datas
}

// Infos decodes the stored infos blob, likewise.
func (d *ItemDetail) Infos() json.RawMessage {
	if d == nil {
		return nil
	}
	return d.ViewData.Infos
}
