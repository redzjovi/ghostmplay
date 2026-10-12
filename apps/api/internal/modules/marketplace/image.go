package marketplace

import (
	"regexp"
	"strings"
	"time"
)

// The upstream reports listing images inconsistently: sometimes a bare CID,
// sometimes a bare URL, sometimes a URL with the CID already under /ipfs/, and
// sometimes a full path on the market's own IPFS gateway. These helpers turn
// all four into something an <img> can load.
//
// The branch order below is the original's and it matters. The order is
// cheapest-and-most-specific first: an input that already contains /ipfs/ is
// repaired in place, then a host-plus-CID is recognised, then a path on the
// configured gateway is recognised, then a bare CID, and only then is an
// absolute URL passed through untouched. Reordering them would make a real URL
// match one of the CID patterns.

// ParseKST reads the upstream's own timestamp format.
//
// "2026-09-20 00:06:31 +0900 KST" becomes "2026-09-20 00:06:31 +09:00" and then
// parses. Returns the zero time for anything unparseable, which the caller
// treats as "no mint time" rather than as an error.
//
// The offset is rewritten from +0900 to +09:00 because that is the form Go's
// time.Parse recognises. A value that already carries a colonated offset is
// left alone.
func ParseKST(s *string) time.Time {
	if s == nil || *s == "" {
		return time.Time{}
	}
	t := strings.Replace(*s, " KST", "", 1)

	// Only an offset at the very end is rewritten, so a string that carries no
	// offset is left as it is. Note the consequence: Go will then reject it,
	// because a bare "2026-09-20 00:06:31" is not a complete instant and the
	// alternative -- reading it as UTC -- would silently shift every real
	// listing by nine hours. Refusing to guess is the right failure, and every
	// mint time the upstream actually sends carries the offset.
	re := regexp.MustCompile(` ([+-]\d{2})(\d{2})$`)
	t = re.ReplaceAllString(t, " $1:$2")

	parsed, err := time.Parse("2006-01-02 15:04:05 -07:00", t)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

var (
	// A CID: the original CIDv0 base58 form (Qm..., 44+ chars) or a CIDv1 form
	// beginning bafy/bafk.
	cidPattern = regexp.MustCompile(`(?i)^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z0-9]+|bafk[a-z0-9]+)`)

	// A whole URL whose path is nothing but a CID, which is the case that needs
	// inserting /ipfs/ into.
	hostPlusCID = regexp.MustCompile(`(?i)^(https?://[^/]+)/(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z0-9]+.*|bafk[a-z0-9]+.*)$`)

	// A doubled slash that is not part of a scheme. Matching on the character
	// before the slash keeps "https://" intact while collapsing "…/ipfs//ipfs/".
	doubledSlash = regexp.MustCompile(`([^:]/)/+`)
)

// BuildImageUrl turns an upstream image reference into a loadable URL.
//
// ipfsBase is the gateway the upstream reported for this page of results. It is
// optional: with no base, a bare CID is returned as-is rather than being turned
// into a relative path that would resolve against this app's own origin.
func BuildImageUrl(ipfsBase string, raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}

	// Already an /ipfs/ URL. The only repair needed is collapsing doubled
	// slashes, which happens in gateway data.
	if strings.Contains(raw, "/ipfs/") {
		return doubledSlash.ReplaceAllString(raw, "$1")
	}

	// scheme://host/CID -> scheme://host/ipfs/CID
	if m := hostPlusCID.FindStringSubmatch(raw); m != nil {
		return m[1] + "/ipfs/" + m[2]
	}

	// Strip a trailing slash and an /ipfs suffix so the prefix comparison below
	// works whether or not the upstream handed us the gateway in either shape.
	normalizedBase := strings.TrimSuffix(ipfsBase, "/")
	normalizedBase = regexp.MustCompile(`/ipfs/?$`).ReplaceAllString(normalizedBase, "")

	// A path continuing the gateway, e.g. base https://ipfs.io and raw
	// https://ipfs.io/Qm... -> https://ipfs.io/ipfs/Qm...
	//
	// The match requires a "/" after the base rather than accepting any string
	// that starts with it. Without that, a gateway of "https://ipfs.io" would
	// also swallow "https://ipfs.io.example.com/x.png" and rewrite it to
	// "https://ipfs.io/ipfs/.example.com/x.png" -- a URL that cannot resolve.
	// The original implementation had that hole; it is closed here because the
	// only inputs it changes are ones that were already wrong, and the failure
	// is a silently broken image rather than a visible error.
	if normalizedBase != "" && strings.HasPrefix(raw, normalizedBase+"/") {
		suffix := strings.TrimPrefix(raw[len(normalizedBase):], "/")
		if suffix != "" {
			return normalizedBase + "/ipfs/" + suffix
		}
	}

	// A bare CID, with a gateway to hang it on.
	if cidPattern.MatchString(raw) {
		if normalizedBase != "" {
			return normalizedBase + "/ipfs/" + raw
		}
		return raw
	}

	// An absolute URL or a data: URI is already loadable.
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") || strings.HasPrefix(raw, "data:") {
		return raw
	}

	return raw
}

// ParseTraitPairs turns the upstream's flat trait list into a lookup.
//
// Each entry is "Key=Value". The split is on the FIRST '=' only, so a value
// containing '=' is preserved rather than truncated at it -- there is no such
// value today, and silently changing this to SplitN-with-a-limit-of-2 in both
// directions would be the kind of change that is right for the wrong reason.
func ParseTraitPairs(pairs []string) map[string]string {
	out := make(map[string]string, len(pairs))
	for _, p := range pairs {
		key, rest, found := strings.Cut(p, "=")
		if !found || key == "" {
			continue
		}
		out[strings.TrimSpace(key)] = strings.TrimSpace(rest)
	}
	return out
}
