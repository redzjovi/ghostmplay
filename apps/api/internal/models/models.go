// Package models holds the JSON shapes the API returns.
//
// The Vue client in apps/web is not changing as part of this rewrite, so these
// are a contract rather than a design choice. Every field name, its casing, its
// nullability and its absence-or-null behaviour was carried over from
// packages/shared/src/types.ts, and the wire format is asserted by
// TestJSONShapeParity below so a rename cannot land unnoticed.
//
// Two rules apply throughout:
//
//   - A nullable column marshals to JSON null, never to an omitted key. The
//     Node entity had the same property, and the client distinguishes "not
//     sold" (null) from "the server did not tell me".
//   - Timestamps are rendered in the JavaScript ISO shape -- milliseconds, Z --
//     rather than Go's RFC 3339 nanoseconds. Both parse, but keeping the bytes
//     identical means a response diff between the old and new API shows only
//     what actually changed.
package models

import (
	"encoding/json"
	"time"
)

// isoLayout is JavaScript's Date#toJSON: always milliseconds, always Z.
// Go's RFC3339Nano trims trailing zeros from the fraction, which would make
// "no sub-second part" and "exact second" render differently from Node.
const isoLayout = "2006-01-02T15:04:05.000Z"

// ISO renders a timestamp the way the JavaScript implementation did.
func ISO(t time.Time) string { return t.UTC().Format(isoLayout) }

// ISOPtr renders a nullable timestamp, passing null through as null.
func ISOPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := ISO(*t)
	return &s
}

// List is the envelope every paginated endpoint returns.
type List[T any] struct {
	Data  []T `json:"data"`
	Total int `json:"total"`
	Page  int `json:"page"`
	Limit int `json:"limit"`
}

// MarketplaceItem is one listing.
//
// `sold_at` is the entire sold flag: there is no boolean anywhere that could
// disagree with it. Test for absence with a nil check rather than treating an
// absent field and a null field as different things -- they are not, here.
type MarketplaceItem struct {
	ID            int32    `json:"id"`
	TokenID       int32    `json:"tokenId"`
	SellerID      string   `json:"sellerId"`
	SellerName    *string  `json:"sellerName"`
	ImageURL      string   `json:"imageUrl"`
	Name          string   `json:"name"`
	Currency      string   `json:"currency"`
	Price         float64  `json:"price"`
	GradeEffect   string   `json:"gradeEffect"`
	Level         int32    `json:"level"`
	Enchant       int32    `json:"enchant"`
	EquipmentType string   `json:"equipmentType"`
	CreatedAt     string   `json:"createdAt"`
	MintTime      *string  `json:"mintTime"`
	SoldAt        *string  `json:"soldAt"`
	SoldPrice     *float64 `json:"soldPrice"`
}

// MarketplaceItemDetail is the jsonb blob stored alongside a listing.
//
// The three fields are passed through exactly as they were stored. Nothing in
// this app interprets them; the detail page renders them as received, and a
// normalising step between the database and the response is precisely the thing
// that would lose a field the upstream added.
type MarketplaceItemDetail struct {
	Attributes json.RawMessage `json:"attributes"`
	Datas      json.RawMessage `json:"datas"`
	Infos      json.RawMessage `json:"infos"`
}

// ItemWithDetail is the `GET /api/marketplace/items/:tokenId` body. Detail is
// null rather than omitted when the listing has no detail blob.
type ItemWithDetail struct {
	Item   MarketplaceItem        `json:"item"`
	Detail *MarketplaceItemDetail `json:"detail"`
}

// MarketplaceFilterOptions drives the filter dropdowns.
type MarketplaceFilterOptions struct {
	EquipmentTypes []string `json:"equipmentTypes"`
	GradeEffects   []string `json:"gradeEffects"`
}

// MarketplaceFavorite is a saved filter set.
//
// AccountID is deliberately absent: a client has no business knowing the
// numeric id of an account it does not own, and leaving it out removes the
// temptation to build something on it.
type MarketplaceFavorite struct {
	ID             int32    `json:"id"`
	Name           string   `json:"name"`
	Q              *string  `json:"q"`
	EquipmentTypes []string `json:"equipmentTypes"`
	GradeEffects   []string `json:"gradeEffects"`
	Sort           string   `json:"sort"`
	CreatedAt      string   `json:"createdAt"`
	UpdatedAt      string   `json:"updatedAt"`
}

// MarketplaceTokenTransfer is one row of the transfer ledger.
type MarketplaceTokenTransfer struct {
	ID             int32   `json:"id"`
	TokenID        int32   `json:"tokenId"`
	GameName       *string `json:"gameName"`
	SellerID       string  `json:"sellerId"`
	SellerUsername *string `json:"sellerUsername"`
	BuyerID        string  `json:"buyerId"`
	BuyerUsername  *string `json:"buyerUsername"`
	ItemName       string  `json:"itemName"`
	Price          float64 `json:"price"`
	Currency       string  `json:"currency"`
	TxHash         string  `json:"txHash"`
	ImageURL       *string `json:"imageUrl"`
	CreatedAt      string  `json:"createdAt"`
	Claimed        bool    `json:"claimed"`
}

// HistoryFilterOptions drives the history filter dropdowns.
type HistoryFilterOptions struct {
	GameNames   []string `json:"gameNames"`
	SellerNames []string `json:"sellerNames"`
	BuyerNames  []string `json:"buyerNames"`
}

// AccountRole is the only authorisation axis that exists.
type AccountRole string

const (
	RoleUser  AccountRole = "user"
	RoleAdmin AccountRole = "admin"
)

// AccountPublic is what /api/auth/me returns about the signed-in account.
type AccountPublic struct {
	ID    int32       `json:"id"`
	Email *string     `json:"email"`
	Role  AccountRole `json:"role"`
}

// MeResponse is the /api/auth/me body.
type MeResponse struct {
	Account *AccountPublic `json:"account"`
}

// ProvidersResponse is the /api/auth/providers body. The UI uses it to decide
// whether to render the sign-in button at all.
type ProvidersResponse struct {
	GoogleEnabled bool `json:"googleEnabled"`
}

// HealthResponse is the /api/health body. Voroa probes this path, and a
// database it cannot reach is reported as 503 rather than as a healthy service
// with a failing database.
type HealthResponse struct {
	Status        string `json:"status"`
	Database      string `json:"database"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
	Timestamp     string `json:"timestamp"`
}

// LiveItemDetail is the raw upstream item-detail response, proxied for display
// and never persisted. A null body means the token is no longer listed.
type LiveItemDetail map[string]any
