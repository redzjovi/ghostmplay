package marketplace

import (
	"testing"
	"time"
)

// The transfer ledger's timestamps arrive with no offset and are KST. Getting
// this wrong stores every transfer nine hours in the future, which shows up as
// "the newest transfer is later than now" and nothing else -- so these cases
// are pinned rather than trusted.
func TestParseTransferTime(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string // RFC3339 in UTC, or "" for an unparseable input
	}{
		{"bare KST string", "2026-09-25 01:45:59", "2026-09-24T16:45:59Z"},
		{"already T separated", "2026-09-25T01:45:59", "2026-09-24T16:45:59Z"},
		{"explicit +09:00 wins", "2026-09-25 01:45:59 +09:00", "2026-09-24T16:45:59Z"},
		{"explicit +0900 no colon", "2026-09-25 01:45:59 +0900", "2026-09-24T16:45:59Z"},
		{"Z counts as supplied", "2026-09-25T01:45:59Z", "2026-09-25T01:45:59Z"},
		{"fractional seconds", "2026-09-25 01:45:59.250", "2026-09-24T16:45:59.25Z"},
		{"surrounding whitespace", "  2026-09-25 01:45:59  ", "2026-09-24T16:45:59Z"},
		{"a real non-KST offset is honoured", "2026-09-25 01:45:59 +02:00", "2026-09-24T23:45:59Z"},

		// Not dates. These are skipped by the caller, not fatal -- one bad row
		// must not fail a whole page of a backfill.
		{"empty", "", ""},
		{"garbage", "not-a-date", ""},
		{"nonsense", "2026-13-45 99:99:99", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseTransferTime(tt.in)

			if tt.want == "" {
				if !got.IsZero() {
					t.Fatalf("ParseTransferTime(%q) = %v, want the zero time", tt.in, got)
				}
				return
			}

			if got.IsZero() {
				t.Fatalf("ParseTransferTime(%q) returned the zero time", tt.in)
			}
			want, err := time.Parse(time.RFC3339, tt.want)
			if err != nil {
				t.Fatalf("bad expectation %q: %v", tt.want, err)
			}
			if !got.Equal(want) {
				t.Errorf("ParseTransferTime(%q) = %v, want %v", tt.in, got.UTC(), want.UTC())
			}
		})
	}
}

// Korea has no DST, so a fixed offset is the whole rule. This pins the
// conversion rather than the parser.
func TestParseTransferTimeAppliesKoreaWallClock(t *testing.T) {
	parsed := ParseTransferTime("2026-09-25 01:45:59")

	_, offset := parsed.Zone()
	if offset != 9*3600 {
		t.Errorf("zone offset = %d seconds, want 32400 (UTC+9)", offset)
	}
	if parsed.Hour() != 1 || parsed.Minute() != 45 {
		t.Errorf("wall clock = %02d:%02d, want 01:45; the time was shifted rather than reinterpreted",
			parsed.Hour(), parsed.Minute())
	}
}

func TestParseTransferTimeRejectsLowercaseZ(t *testing.T) {
	// The designator match is case-sensitive, as in the original. A lowercase
	// `z` is therefore treated as absent, the Korean offset is appended, and the
	// result no longer parses. That is the pre-existing behaviour and is kept:
	// the upstream has never sent one, and "fixing" it would make the two
	// implementations diverge for no observed problem.
	if got := ParseTransferTime("2026-09-25 01:45:59z"); !got.IsZero() {
		t.Errorf("ParseTransferTime with a lowercase z = %v, want the zero time", got)
	}
}

func TestNormalizeAddress(t *testing.T) {
	tests := []struct{ in, want string }{
		{"0xAbC", "0xabc"},
		{"  0xABC  ", "0xabc"},
		{"0xABC", "0xabc"},
		{"", ""},
		{"   ", ""},
	}
	for _, tt := range tests {
		if got := NormalizeAddress(tt.in); got != tt.want {
			t.Errorf("NormalizeAddress(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// The address is the users table key, and the history joins are written as
// `su.id = LOWER(t.seller_id)`. If these two ever disagree, a transfer renders
// with a null username.
func TestNormalizeAddressMatchesTheJoinExpression(t *testing.T) {
	address := "  0xAbCdEf  "

	if NormalizeAddress(address) != normalizeLikeSQLLower(address) {
		t.Errorf("NormalizeAddress(%q) = %q, but the join computes %q",
			address, NormalizeAddress(address), normalizeLikeSQLLower(address))
	}
}

// normalizeLikeSQLLower mirrors PostgreSQL's LOWER() for ASCII, which is what
// the `LOWER(seller_id)` join uses.
func normalizeLikeSQLLower(s string) string {
	b := []byte(s)
	start, end := 0, len(b)
	for start < end && isSpace(b[start]) {
		start++
	}
	for end > start && isSpace(b[end-1]) {
		end--
	}
	out := b[start:end]
	for i := range out {
		if out[i] >= 'A' && out[i] <= 'Z' {
			out[i] += 'a' - 'A'
		}
	}
	return string(out)
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}
