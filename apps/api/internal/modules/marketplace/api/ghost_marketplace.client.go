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
}

// NewClient builds a client. The log level is taken from the logger's enabled
// state, so setting the level to Info is all it takes to get upstream logging.
func NewClient(log *slog.Logger) *Client {
	return &Client{
		http: &http.Client{Timeout: RequestTimeout},
		log:  log,
		// Overridable so a test can point the whole client at a local server.
		baseURL: BaseURL,
	}
}

// SetBaseURL overrides the upstream address. For tests.
func (c *Client) SetBaseURL(u string) { c.baseURL = strings.TrimRight(u, "/") }

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

// The upstream is a browser-facing API behind the same site's CORS rules, and it
// does answer to a plain server-side request. These headers are sent anyway
// because they cost nothing and they keep the shape of the request identical to
// what a browser sends -- which is the difference between "the upstream changed
// something and we did not notice" and a working scrape.
var browserHeaders = map[string]string{
	"Accept":             "application/json",
	"Accept-Language":    "en,id;q=0.9",
	"Origin":             "https://market.numine.io",
	"Referer":            "https://market.numine.io/",
	"Sec-Fetch-Dest":     "empty",
	"Sec-Fetch-Mode":     "cors",
	"Sec-Fetch-Site":     "same-site",
	"User-Agent":         "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
	"sec-ch-ua":          `"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"`,
	"sec-ch-ua-mobile":   "?0",
	"sec-ch-ua-platform": `"Linux"`,
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
	if err := c.get(ctx, "search-redis", q, &out); err != nil {
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
	TokenID     int32   `json:"tokenId"`
	IndexID     string  `json:"indexId"`
	ServiceName string  `json:"serviceName"`
	IPFS        string  `json:"ipfs"`
	Owner       string  `json:"owner"`
	OwnerName   string  `json:"ownerName"`
	ViewCount   float64 `json:"viewCount"`
	Price       float64 `json:"price"`

	Details struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		// Image is a bare CID on a real gateway, not a URL.
		Image       string `json:"image"`
		ExternalURL string `json:"external_url"`
		Attributes  []struct {
			TraitType string `json:"trait_type"`
			Value     any    `json:"value"`
		} `json:"attributes"`
	} `json:"details"`

	ViewData struct {
		Datas []struct {
			Title  string `json:"title"`
			Values []any  `json:"values"`
			Class  string `json:"class"`
		} `json:"datas"`
		Infos    []map[string]any `json:"infos"`
		ViewType string           `json:"viewType"`
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
	if err := c.post(ctx, "item-detail", form, &out); err != nil {
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
	if err := c.get(ctx, "token-transfers", q, &out); err != nil {
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
	for k, v := range browserHeaders {
		req.Header.Set(k, v)
	}
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}

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

	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%s %s: decode: %w", method, target, err)
	}
	return nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
