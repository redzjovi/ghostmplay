package google

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

const testSecret = "test-state-secret"

func TestIsSafeNextPath(t *testing.T) {
	safe := []string{
		"/marketplaces/list",
		"/",
		"/history/list?page=2",
		"/items/123",
	}
	for _, p := range safe {
		if !IsSafeNextPath(p) {
			t.Errorf("IsSafeNextPath(%q) = false, want true", p)
		}
	}

	// The open-redirect cases. Each of these, accepted, would let an attacker
	// send a signed-in user to a site they control.
	unsafe := map[string]string{
		"protocol relative": "//evil.com",
		"absolute url":      "https://evil.com",
		"absolute http":     "http://evil.com",
		"backslash":         "/\\evil.com",
		"backslash pair":    "/foo\\..\\bar",
		"colon":             "https:evil",
		"colon in query":    "/x?a=b:c",
		"no leading slash":  "evil.com",
		"relative":          "marketplaces/list",
		"empty":             "",
	}
	for name, p := range unsafe {
		if IsSafeNextPath(p) {
			t.Errorf("IsSafeNextPath(%q) [%s] = true, want false", p, name)
		}
	}

	// Length bound: a signed state carries this, so an unbounded one is a way to
	// smuggle a payload through the callback URL.
	if IsSafeNextPath("/" + strings.Repeat("a", 200)) {
		t.Error("a 201-character path was accepted")
	}
}

func TestSafeNextPathFallsBack(t *testing.T) {
	if got := SafeNextPath("//evil.com"); got != DefaultNextPath {
		t.Errorf("SafeNextPath(\"//evil.com\") = %q, want the default", got)
	}
	if got := SafeNextPath("/history/list"); got != "/history/list" {
		t.Errorf("SafeNextPath dropped a safe path: %q", got)
	}
}

func TestStateRoundTrip(t *testing.T) {
	state, err := NewState("/marketplaces/list", "verifier-abc")
	if err != nil {
		t.Fatalf("NewState: %v", err)
	}
	if state.Nonce == "" {
		t.Error("NewState produced an empty nonce")
	}

	signed, err := SignState(state, testSecret)
	if err != nil {
		t.Fatalf("SignState: %v", err)
	}

	got, err := VerifyState(signed, testSecret)
	if err != nil {
		t.Fatalf("VerifyState: %v", err)
	}
	if got.Verifier != "verifier-abc" {
		t.Errorf("Verifier = %q, want the one that was signed", got.Verifier)
	}
	if got.Next != "/marketplaces/list" {
		t.Errorf("Next = %q, want /marketplaces/list", got.Next)
	}
	if got.Nonce != state.Nonce {
		t.Errorf("Nonce = %q, want %q", got.Nonce, state.Nonce)
	}
}

func TestVerifyStateRejectsTampering(t *testing.T) {
	state, _ := NewState("/marketplaces/list", "verifier-abc")
	signed, _ := SignState(state, testSecret)

	body, mac, _ := strings.Cut(signed, ".")

	t.Run("a different secret", func(t *testing.T) {
		if _, err := VerifyState(signed, "other-secret"); err == nil {
			t.Error("a state verified under a different secret")
		}
	})

	t.Run("a modified body", func(t *testing.T) {
		// Re-encode the body with a different destination but keep the old MAC.
		tampered := base64.RawURLEncoding.EncodeToString(
			[]byte(`{"n":"x","v":"verifier-abc","x":"https://evil.com","e":9999999999999}`))
		if _, err := VerifyState(tampered+"."+mac, testSecret); err == nil {
			t.Error("a tampered body verified against the original signature")
		}
		_ = body
	})

	t.Run("a modified mac", func(t *testing.T) {
		flipped := []byte(mac)
		if flipped[0] == 'A' {
			flipped[0] = 'B'
		} else {
			flipped[0] = 'A'
		}
		if _, err := VerifyState(body+"."+string(flipped), testSecret); err == nil {
			t.Error("a tampered signature verified")
		}
	})

	t.Run("a truncated mac", func(t *testing.T) {
		// The length is checked before the comparison precisely so this is a
		// rejected login rather than a panic or a 500.
		if _, err := VerifyState(body+"."+mac[:10], testSecret); err == nil {
			t.Error("a truncated signature verified")
		}
	})
}

func TestVerifyStateRejectsMalformed(t *testing.T) {
	for _, raw := range []string{
		"",
		"no-separator",
		".onlymac",
		"onlybody.",
		"!!!.!!!",
	} {
		if _, err := VerifyState(raw, testSecret); err == nil {
			t.Errorf("VerifyState(%q) accepted a malformed state", raw)
		}
	}
}

func TestVerifyStateRejectsExpired(t *testing.T) {
	// An expiry in the past. e == now counts as expired, so this is well past.
	expired := State{
		Nonce:     "n",
		Verifier:  "v",
		Next:      "/",
		ExpiresAt: time.Now().Add(-time.Second).UnixMilli(),
	}
	signed, _ := SignState(expired, testSecret)

	_, err := VerifyState(signed, testSecret)
	if err == nil {
		t.Fatal("an expired state verified")
	}
	if reason, ok := StateReason(err); !ok || reason != ErrStateExpired {
		t.Errorf("reason = %v, want expired", err)
	}
}

// The destination is checked twice: once when it goes into the state, and again
// when the callback reads it out. The second check is the one that matters,
// because the second check is what the browser is finally sent to.
func TestVerifyStateRevalidatesNext(t *testing.T) {
	// A state signed by us, carrying a destination that would be an open
	// redirect. Reaching this requires a bug in signing, which is exactly why
	// the check is not only at the boundary.
	state := State{
		Nonce:     "n",
		Verifier:  "v",
		Next:      "https://evil.com",
		ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
	}
	signed, _ := SignState(state, testSecret)

	got, err := VerifyState(signed, testSecret)
	if err != nil {
		t.Fatalf("VerifyState: %v", err)
	}
	if got.Next != DefaultNextPath {
		t.Errorf("Next = %q, want the safe default", got.Next)
	}
}

func TestNewPKCE(t *testing.T) {
	verifier, challenge, err := NewPKCE()
	if err != nil {
		t.Fatalf("NewPKCE: %v", err)
	}
	if verifier == "" || challenge == "" {
		t.Fatal("NewPKCE returned an empty value")
	}
	if verifier == challenge {
		t.Error("verifier and challenge are identical; the challenge is not derived from the verifier")
	}

	// The challenge must be S256: base64url of the raw SHA-256, which is 43
	// characters for 32 bytes. Getting this wrong produces invalid_grant on
	// every exchange.
	if len(challenge) != 43 {
		t.Errorf("challenge length = %d, want 43 for base64url(SHA-256)", len(challenge))
	}

	// Two calls must not collide.
	v2, _, _ := NewPKCE()
	if v2 == verifier {
		t.Error("NewPKCE returned the same verifier twice")
	}
}
