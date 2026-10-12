package api

import (
	"crypto/rand"
	"encoding/binary"
	"strconv"
)

// Browser headers.
//
// The upstream is a browser-facing API sitting behind the same site's CORS
// rules. It answers to a plain server-side request, but it is also watching for
// the shape of one: thousands of requests per day arriving with a byte-identical
// fingerprint is a signature in itself, whatever the User-Agent claims.
//
// So the headers vary per request. What they must NOT do is vary independently.
// A User-Agent saying `Windows NT` next to a `sec-ch-ua-platform` of `Linux`,
// or a Chrome 153 string beside a Chrome 126 client-hint, is a combination no
// real browser emits -- which makes the client MORE distinctive than a fixed
// honest one. So each profile is a coherent whole: a browser, a version and a
// platform that agree with each other, picked together.
//
// This is rotation, not evasion. The rate at which it asks for anything is
// unchanged, and the paths and payloads are the ones the site's own frontend
// sends.

const chromeVersion = 153

// browserProfile is one self-consistent set of identifying headers.
//
// Nothing here is randomised independently of anything else. The whole point is
// that the combination is believable.
type browserProfile struct {
	Name     string
	Version  int
	Platform string // the sec-ch-ua-platform value
	// platformToken is the token inside the User-Agent's platform field, which
	// is spelled differently from the client-hint value ("Windows NT" vs
	// "Windows") and getting them out of step is the mistake this struct exists
	// to prevent.
	platformToken string
	Mobile        bool
	Language      string
}

// headers renders the profile into request headers.
func (p browserProfile) headers() map[string]string {
	h := map[string]string{
		"Accept":          "application/json",
		"Accept-Language": p.Language,
		// Identifies where the request claims to originate. Kept fixed: this
		// client only ever talks to one upstream, from one referrer.
		"Origin":  "https://market.numine.io",
		"Referer": "https://market.numine.io/",
		// Sec-Fetch-* describe how the request was made. A server-side client
		// makes none of these kinds of request, so they are part of the costume
		// rather than part of an identity -- kept constant.
		"Sec-Fetch-Dest": "empty",
		"Sec-Fetch-Mode": "cors",
		"Sec-Fetch-Site": "same-site",

		"User-Agent": p.userAgent(),

		"sec-ch-ua":          p.secChUA(),
		"sec-ch-ua-mobile":   boolHint(p.Mobile),
		"sec-ch-ua-platform": `"` + p.Platform + `"`,
	}

	return h
}

// userAgent renders the Chrome desktop User-Agent.
func (p browserProfile) userAgent() string {
	ua := "Mozilla/5.0 (" + p.platformToken + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" +
		strconv.Itoa(p.Version) + ".0.0.0 Safari/537.36"
	if p.Mobile {
		// Mobile Chrome puts Android in the platform slot and carries a device
		// token. Emitting a desktop UA with a mobile client-hint would be the
		// inconsistency this file exists to avoid.
		ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" +
			strconv.Itoa(p.Version) + ".0.0.0 Mobile Safari/537.36"
	}
	return ua
}

// secChUA renders the client-hint brand list, whose major version must match
// the User-Agent's.
func (p browserProfile) secChUA() string {
	v := `"Chromium";v="` + strconv.Itoa(p.Version) + `"`
	if p.Version >= 116 {
		// Chrome 116+ reports a GREASE brand with a real-looking major version.
		// Omitting it is another thing no current browser emits.
		v = `"Not_A Brand";v="8", ` + v
	}
	return `"Google Chrome";v="` + strconv.Itoa(p.Version) + `", ` + v
}

// browserProfiles is the pool a request draws from.
type browserProfiles struct {
	pool []browserProfile
	// fixed, when non-zero, always selects this index. For tests.
	fixed int
}

// defaultProfiles returns the pool used in normal operation.
func defaultProfiles() *browserProfiles {
	// A spread of versions and platforms. Recent Chrome releases are all
	// plausible, so the pool spans a few majors rather than the single newest
	// one -- pinning the newest is its own kind of fingerprint.
	versions := []int{chromeVersion, chromeVersion - 1, chromeVersion - 2, chromeVersion - 5}
	platforms := []struct{ platform, token string }{
		{"Windows", "Windows NT 10.0; Win64; x64"},
		{"macOS", "Macintosh; Intel Mac OS X 10_15_7"},
		{"Linux", "X11; Linux x86_64"},
	}
	languages := []string{"en-US,en;q=0.9", "en-GB,en;q=0.9", "en,id;q=0.9", "en-CA,en;q=0.9"}

	pool := make([]browserProfile, 0, len(versions)*len(platforms)*len(languages)+4)
	for _, v := range versions {
		for _, pl := range platforms {
			for _, lang := range languages {
				pool = append(pool, browserProfile{
					Name:          "Chrome",
					Version:       v,
					Platform:      pl.platform,
					platformToken: pl.token,
					Language:      lang,
				})
			}
		}
	}

	// Mobile entries, kept in the same pool so the mix is realistic rather than
	// weighted towards desktop.
	for _, v := range versions {
		pool = append(pool, browserProfile{
			Name:     "Chrome",
			Version:  v,
			Platform: "Android",
			Mobile:   true,
			Language: "en-US,en;q=0.9",
		})
	}

	return &browserProfiles{pool: pool}
}

// pick chooses a profile.
//
// crypto/rand rather than math/rand: the sequence a global, seeded-once source
// produces is predictable, and a predictable choice of fingerprint is not a
// rotation. The draw costs microseconds and this is one per upstream request --
// roughly one per page of a once-a-minute crawl.
func (b *browserProfiles) pick() browserProfile {
	if b == nil || len(b.pool) == 0 {
		return browserProfile{
			Name: "Chrome", Version: chromeVersion, Platform: "Linux",
			platformToken: "X11; Linux x86_64", Language: "en,id;q=0.9",
		}
	}
	if b.fixed > 0 {
		return b.pool[b.fixed%len(b.pool)]
	}

	// Rejection sampling, so the choice is uniform. With ~100 profiles a plain
	// modulo would be biased by about one part in 2^55, which is not measurable
	// -- but the correct version is three lines and there is no reason to carry
	// the wrong one next to a comment claiming it matters.
	limit := uint64(len(b.pool))
	threshold := (^uint64(0) / limit) * limit
	for {
		var buf [8]byte
		if _, err := rand.Read(buf[:]); err != nil {
			// crypto/rand does not fail in practice. Falling back to a fixed
			// profile keeps the request going rather than dropping it.
			return b.pool[0]
		}
		n := binary.BigEndian.Uint64(buf[:])
		if n < threshold {
			return b.pool[n%limit]
		}
	}
}

func boolHint(mobile bool) string {
	if mobile {
		return "?1"
	}
	return "?0"
}
