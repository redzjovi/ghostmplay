package marketplace

import "testing"

func TestBuildImageUrl(t *testing.T) {
	const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"

	tests := []struct {
		name string
		base string
		raw  string
		want string
	}{
		{"empty stays empty", "https://ipfs.io", "", ""},
		{"whitespace only", "https://ipfs.io", "   ", ""},

		// Already an /ipfs/ URL: repair doubled slashes, leave the scheme alone.
		{"ipfs url untouched", "https://ipfs.io", "https://ipfs.io/ipfs/" + cid, "https://ipfs.io/ipfs/" + cid},
		// The collapse regex matches a slash preceded by a non-colon character,
		// so "ipfs//ipfs" loses one slash and "https://" is left intact.
		{"doubled slashes collapsed", "", "https://ipfs.io/ipfs//" + cid, "https://ipfs.io/ipfs/" + cid},
		{"scheme double slash preserved", "", "https://ipfs.io/ipfs/" + cid, "https://ipfs.io/ipfs/" + cid},

		// scheme://host/CID gets /ipfs/ inserted.
		{"host plus cid", "", "https://example.com/" + cid, "https://example.com/ipfs/" + cid},

		// A path on the reported gateway gets /ipfs/ inserted.
		{"bare suffix on gateway", "https://ipfs.io", "https://ipfs.io/" + cid, "https://ipfs.io/ipfs/" + cid},
		{"gateway with trailing slash", "https://ipfs.io/", "https://ipfs.io/" + cid, "https://ipfs.io/ipfs/" + cid},
		{"gateway given as /ipfs", "https://ipfs.io/ipfs", "https://ipfs.io/" + cid, "https://ipfs.io/ipfs/" + cid},

		// A bare CID is hung on the gateway, or returned alone with no gateway.
		{"bare cid with base", "https://ipfs.io", cid, "https://ipfs.io/ipfs/" + cid},
		{"bare cid no base", "", cid, cid},
		{"cidv1 with base", "https://ipfs.io", "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udh7c2r6s3lqzqgpqhxdc", "https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udh7c2r6s3lqzqgpqhxdc"},

		// Already loadable.
		{"absolute https", "", "https://cdn.example.com/x.png", "https://cdn.example.com/x.png"},
		{"absolute http", "", "http://cdn.example.com/x.png", "http://cdn.example.com/x.png"},
		{"data uri", "", "data:image/png;base64,AAA", "data:image/png;base64,AAA"},

		// Unrecognised: passed through rather than mangled.
		{"relative path", "", "/assets/x.png", "/assets/x.png"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := BuildImageUrl(tt.base, tt.raw); got != tt.want {
				t.Errorf("BuildImageUrl(%q, %q)\n got = %q\nwant = %q", tt.base, tt.raw, got, tt.want)
			}
		})
	}
}

// The image helper has a branch order that only matters if the first matching
// branch is the right one. These two cases pin that.
func TestBuildImageUrlBranchOrder(t *testing.T) {
	const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"

	// An /ipfs/ URL wins over everything, even when it also looks like a bare CID
	// path on the gateway. Getting this backwards would double the /ipfs/.
	got := BuildImageUrl("https://ipfs.io", "https://other.example/ipfs/"+cid)
	if got != "https://other.example/ipfs/"+cid {
		t.Errorf("an /ipfs/ URL was rewritten to %q; the /ipfs/ branch must come first", got)
	}

	// An absolute non-CID URL is returned untouched, never treated as a gateway
	// path just because the gateway happens to be a prefix of it.
	// An absolute URL that merely shares a prefix with the gateway is not a path
	// on it. The original matched any string starting with the gateway and
	// produced "https://cdn/ipfs/.example.com/a.png", which resolves to nothing.
	got = BuildImageUrl("https://cdn", "https://cdn.example.com/a.png")
	if got != "https://cdn.example.com/a.png" {
		t.Errorf("absolute URL was rewritten to %q", got)
	}
}

func TestParseTraitPairs(t *testing.T) {
	got := ParseTraitPairs([]string{
		"Level=0",
		"Grade Effect=Legacy",
		"Equipment Type=Armor",
		"Name=A=B=C",
		// No '=' at all: the key is still recorded, with an empty value, so the
		// lookup yields "" rather than substituting the default.
		"NoEquals",
		// An empty key has nothing to file it under, so it is dropped.
		"=orphanValue",
		"  Spaced  =  value  ",
	})

	want := map[string]string{
		"Level":          "0",
		"Grade Effect":   "Legacy",
		"Equipment Type": "Armor",
		// Split on the FIRST '=' only: a value containing '=' is kept whole.
		"Name": "A=B=C",
		// Key and value are both trimmed, even though the pair was not.
		"Spaced":   "value",
		"NoEquals": "",
	}

	if len(got) != len(want) {
		t.Fatalf("got %d entries %v, want %d %v", len(got), got, len(want), want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("ParseTraitPairs[%q] = %q, want %q", k, got[k], v)
		}
	}
}

func TestParseKST(t *testing.T) {
	tests := []struct {
		name string
		in   *string
		want string // RFC3339 UTC, "" for the zero time
	}{
		{"nil", nil, ""},
		{"empty", ptr(""), ""},
		{"with KST suffix", ptr("2026-09-20 00:06:31 +0900 KST"), "2026-09-19T15:06:31Z"},
		{"without KST suffix", ptr("2026-09-20 00:06:31 +0900"), "2026-09-19T15:06:31Z"},
		{"colonated offset", ptr("2026-09-20 00:06:31 +09:00"), "2026-09-19T15:06:31Z"},

		// A timestamp with no offset is refused rather than guessed. Reading it
		// as UTC would silently shift every real listing by nine hours, which is
		// worse than not having a mint time at all.
		{"no offset", ptr("2026-09-20 00:06:31"), ""},
		{"garbage", ptr("not-a-date"), ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseKST(tt.in)
			if tt.want == "" {
				if !got.IsZero() {
					t.Fatalf("ParseKST(%v) = %v, want the zero time", deref(tt.in), got)
				}
				return
			}
			if got.IsZero() {
				t.Fatalf("ParseKST(%q) returned the zero time", deref(tt.in))
			}
			if got.UTC().Format("2006-01-02T15:04:05Z") != tt.want {
				t.Errorf("ParseKST(%q) = %s, want %s", deref(tt.in), got.UTC().Format(timeLayout), tt.want)
			}
		})
	}
}

const timeLayout = "2006-01-02T15:04:05Z"

func ptr(s string) *string { return &s }
func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
