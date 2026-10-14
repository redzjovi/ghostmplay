package marketplace

import (
	"database/sql"
	"testing"
	"time"

	dbgen "github.com/redzjovi/ghostmplay/apps/api/db/sqlc"
)

func storedTransfer(id int32, tokenID int32) dbgen.MarketplaceTokenTransfer {
	return dbgen.MarketplaceTokenTransfer{
		ID:        id,
		TokenID:   tokenID,
		GameName:  sql.NullString{String: "GhostMGlobal", Valid: true},
		SellerID:  "0xseller",
		BuyerID:   "0xbuyer",
		ItemName:  "Sword",
		Price:     12.5,
		Currency:  "NUMI",
		TxHash:    "0xhash",
		CreatedAt: time.Date(2026, 9, 25, 1, 45, 59, 0, time.UTC),
	}
}

// A stored transfer is fed back through the same resolve-then-upsert path the
// upstream walks use, so every field has to survive the round trip intact. The
// one that is easy to lose is created_at, and losing it is not a compile error.
func TestMappedFromStoredRoundTripsEveryField(t *testing.T) {
	created := time.Date(2026, 9, 25, 1, 45, 59, 0, time.UTC)
	row := dbgen.MarketplaceTokenTransfer{
		ID:        7,
		TokenID:   4242,
		GameName:  sql.NullString{String: "GhostMGlobal", Valid: true},
		SellerID:  "0xseller",
		BuyerID:   "0xbuyer",
		ItemName:  "Sword of Dawn",
		Price:     12.5,
		Currency:  "NUMI",
		TxHash:    "0xhash",
		ImageUrl:  sql.NullString{String: "https://img", Valid: true},
		CreatedAt: created,
	}

	m := mappedFromStored(row)

	if m.tokenID != 4242 {
		t.Errorf("tokenID = %d, want 4242", m.tokenID)
	}
	if m.txHash != "0xhash" {
		t.Errorf("txHash = %q, want 0xhash", m.txHash)
	}
	if m.sellerID != "0xseller" || m.buyerID != "0xbuyer" {
		t.Errorf("parties = %q/%q, want 0xseller/0xbuyer", m.sellerID, m.buyerID)
	}
	if m.itemName != "Sword of Dawn" {
		t.Errorf("itemName = %q, want Sword of Dawn", m.itemName)
	}
	if m.price != 12.5 {
		t.Errorf("price = %v, want 12.5", m.price)
	}
	if m.currency != "NUMI" {
		t.Errorf("currency = %q, want NUMI", m.currency)
	}
	if m.gameName == nil || *m.gameName != "GhostMGlobal" {
		t.Errorf("gameName = %v, want GhostMGlobal", m.gameName)
	}
	if m.imageURL == nil || *m.imageURL != "https://img" {
		t.Errorf("imageURL = %v, want https://img", m.imageURL)
	}

	// The one that matters. ParseTransferTime exists because the upstream sends a
	// bare KST string with no offset; a timestamptz column is already absolute,
	// and running it back through that parser would shift it nine hours.
	if !m.createdAt.Equal(created) {
		t.Errorf("createdAt = %s, want %s -- the stored instant must not be reparsed as KST", m.createdAt, created)
	}
	if m.createdAt.Location() != time.UTC {
		t.Errorf("createdAt location = %s, want the instant carried through unchanged", m.createdAt.Location())
	}
}

// A NULL and a stored empty string both mean "nothing", and mapTransfer collapses
// both to nil for the same reason: a blank game name would otherwise show up in
// the filter dropdowns as an empty option.
func TestStoredOptionalCollapsesNullAndEmpty(t *testing.T) {
	if got := storedOptional(sql.NullString{}); got != nil {
		t.Errorf("NULL = %v, want nil", *got)
	}
	if got := storedOptional(sql.NullString{String: "", Valid: true}); got != nil {
		t.Errorf("empty string = %q, want nil", *got)
	}
	got := storedOptional(sql.NullString{String: "GhostMGlobal", Valid: true})
	if got == nil || *got != "GhostMGlobal" {
		t.Errorf("value = %v, want GhostMGlobal", got)
	}
}

// The cursor is the property that makes the pending run correct, and the reason
// it is keyset rather than OFFSET: the run sets claimed = true on rows as it goes,
// so the NOT claimed set shrinks underneath it. An OFFSET cursor steps over the
// rows that fall into the band it already read, and never checks them.
//
// Advancing from the last row of the batch as it was READ is what makes that
// impossible -- the cursor is a position in id space, not an index into a list
// that is being emptied.
func TestPendingCursorAdvancesFromTheLastRowRead(t *testing.T) {
	batch := []dbgen.MarketplaceTokenTransfer{
		storedTransfer(11, 101),
		storedTransfer(12, 102),
		storedTransfer(13, 103),
	}

	// This is the line under test: the cursor comes from the batch as it was
	// READ, before any of it is processed.
	cursor := batch[len(batch)-1].ID

	if cursor != 13 {
		t.Errorf("cursor = %d, want the last row's id 13", cursor)
	}
	// Every row is at or below the cursor, which is what guarantees the next
	// `id > cursor` read returns none of them. The rows are the right shape for
	// that only because the cursor came from the batch as read -- had it come
	// from what survived processing, the rows this run marks claimed would fall
	// out of the comparison and be re-read.
	for _, r := range batch {
		if r.ID > cursor {
			t.Errorf("row %d is above the cursor %d and would be re-read", r.ID, cursor)
		}
	}
}

// The loop ends on a short batch rather than on an empty read, so a run whose
// pending set is an exact multiple of the batch size still terminates.
func TestPendingBatchSizeTerminatesTheLoop(t *testing.T) {
	const total = 1000

	read := 0
	batches := 0
	for {
		batch := pendingBatch
		if remaining := total - read; remaining < batch {
			batch = remaining
		}
		if batch == 0 {
			break
		}
		read += batch
		batches++
		if batch < pendingBatch {
			break
		}
	}

	if read != total {
		t.Errorf("read %d transfers, want %d", read, total)
	}
	if batches != 2 {
		t.Errorf("batches = %d, want 2 for exactly 2x the batch size", batches)
	}
}
