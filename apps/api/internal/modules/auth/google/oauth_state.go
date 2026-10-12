// Package google implements Google sign-in: PKCE, the signed state that carries
// it, and account provisioning.
//
// There is no password anywhere in this application. An account is created from
// a verified Google identity and holds nothing but an id and a role.
package google

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// StateTTL is how long an authorization attempt stays valid.
//
// Long enough for a login, including the round trip through a consent screen and
// a password manager, and short enough to blunt replay of a captured URL.
const StateTTL = 10 * time.Minute

// DefaultNextPath is where the browser lands when no safe destination was
// supplied.
const DefaultNextPath = "/marketplaces/list"

// maxNextPathLength bounds the destination so a signed state cannot be used to
// carry an arbitrary payload.
const maxNextPathLength = 200

// State is the payload carried through the authorization request.
//
// The callback arrives as a cross-site top-level navigation, so a SameSite=Strict
// cookie cannot carry anything to it and the correlation has to travel in the
// URL. Everything the callback therefore needs lives here: a nonce, the PKCE
// verifier, the post-login destination and an expiry, all authenticated by an
// HMAC so none of it can be tampered with.
//
// Nothing is stored server-side, so there is no table to sweep and no
// single-use bookkeeping.
//
// This deviates from the OAuth 2.0 spec's "state SHOULD NOT exceed 20
// characters" guidance. Google does not enforce a limit and passing a signed
// blob is common practice; the alternative is a short random state plus a
// server-side row, which trades a stateless flow for state that needs a cleanup
// job.
type State struct {
	// Nonce binds this authorization attempt to one callback.
	Nonce string `json:"n"`
	// Verifier is the PKCE verifier whose SHA-256 became the code_challenge
	// sent to Google at authorize time.
	Verifier string `json:"v"`
	// Next is where to land the browser once signed in. Validated as
	// same-origin on the way in, and again on the way out.
	Next string `json:"x"`
	// ExpiresAt is a Unix millisecond timestamp.
	ExpiresAt int64 `json:"e"`
}

// StateError is why a state was rejected.
type StateError string

const (
	// ErrStateMalformed: not two dot-separated base64url halves, or the body
	// did not decode to a state.
	ErrStateMalformed StateError = "malformed"
	// ErrStateBadSignature: the HMAC did not match.
	ErrStateBadSignature StateError = "bad-signature"
	// ErrStateExpired: past its TTL.
	ErrStateExpired StateError = "expired"
)

// Error implements error, so a reason can be returned directly.
func (e StateError) Error() string { return string(e) }

// IsSafeNextPath reports whether a destination stays on this origin.
//
// Rejects "//evil.com" (protocol-relative), "https://evil.com" (absolute), and
// anything containing "\" or ":", which some browsers normalise back into a
// leading "//". Without this the callback is an open redirect.
func IsSafeNextPath(next string) bool {
	if next == "" || len(next) > maxNextPathLength {
		return false
	}
	if !strings.HasPrefix(next, "/") {
		return false
	}
	if strings.HasPrefix(next, "//") {
		return false
	}
	if strings.ContainsAny(next, `\:`) {
		return false
	}
	return true
}

// SafeNextPath collapses an untrusted destination to a same-origin path.
func SafeNextPath(next string) string {
	if IsSafeNextPath(next) {
		return next
	}
	return DefaultNextPath
}

// NewState mints the payload for one authorization attempt.
//
// verifier is required rather than defaulted, and it is the PKCE verifier whose
// SHA-256 became the code_challenge sent to Google. It has to be threaded in from
// the caller for exactly that reason: an earlier version generated its own random
// value here, so the challenge and the verifier drifted apart and every exchange
// came back invalid_grant.
func NewState(next, verifier string) (State, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return State{}, err
	}
	return State{
		Nonce:     base64.RawURLEncoding.EncodeToString(nonce),
		Verifier:  verifier,
		Next:      next,
		ExpiresAt: time.Now().Add(StateTTL).UnixMilli(),
	}, nil
}

// SignState encodes a state and appends an HMAC of its body.
//
// The signature covers the body only, not the separator, so verification is a
// decode-then-compare with no ambiguity about where one ends.
func SignState(state State, secret string) (string, error) {
	body, err := json.Marshal(state)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(body)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// VerifyState checks a returned state and returns its payload.
//
// The three failure modes stay distinct even though the controller collapses them
// into one user-facing code. They are distinct here because they are different
// bugs: malformed means we generated something wrong, bad-signature means
// something tried to tamper, expired means a user took too long.
func VerifyState(raw, secret string) (State, error) {
	if raw == "" {
		return State{}, ErrStateMalformed
	}

	dot := strings.Index(raw, ".")
	// The separator must be present and neither half may be empty.
	if dot <= 0 || dot == len(raw)-1 {
		return State{}, ErrStateMalformed
	}
	body, given := raw[:dot], raw[dot+1:]

	givenMAC, err := base64.RawURLEncoding.DecodeString(given)
	if err != nil {
		return State{}, ErrStateMalformed
	}

	expected := hmac.New(sha256.New, []byte(secret))
	expected.Write([]byte(body))
	wantMAC := expected.Sum(nil)

	// The length is checked before the comparison. hmac.Equal is
	// constant-time and returns false for a length mismatch, but checking
	// explicitly keeps the intent visible -- and it is what turns a truncated
	// state into a rejected login rather than a panic.
	if len(givenMAC) != len(wantMAC) || !hmac.Equal(givenMAC, wantMAC) {
		return State{}, ErrStateBadSignature
	}

	decoded, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return State{}, ErrStateMalformed
	}

	var state State
	if err := json.Unmarshal(decoded, &state); err != nil {
		return State{}, ErrStateMalformed
	}
	if state.Nonce == "" || state.Verifier == "" {
		return State{}, ErrStateMalformed
	}
	// e == now counts as expired.
	if state.ExpiresAt <= time.Now().UnixMilli() {
		return State{}, ErrStateExpired
	}

	// Re-validated here as well as on the way in. The state was signed by us,
	// but the destination is what the browser is finally sent to, so it gets a
	// second check at the point of use.
	state.Next = SafeNextPath(state.Next)

	return state, nil
}

// NewPKCE returns a fresh PKCE verifier and its S256 challenge.
//
// S256 rather than plain, and base64url of the raw digest rather than hex or
// base64: this is what RFC 7636 specifies and what Google expects. A mismatch
// here produces invalid_grant on every exchange, which is a miserable thing to
// debug from the symptom alone.
func NewPKCE() (verifier, challenge string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	verifier = base64.RawURLEncoding.EncodeToString(raw)

	sum := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(sum[:])
	return verifier, challenge, nil
}

// NewSessionToken returns a fresh opaque session token.
//
// 32 random bytes. The raw token goes in the cookie and only its SHA-256 is
// stored, so a database dump cannot be replayed as a set of sessions.
func NewSessionToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// StateReason extracts the StateError from an error chain, if it is one.
func StateReason(err error) (StateError, bool) {
	var se StateError
	if errors.As(err, &se) {
		return se, true
	}
	return "", false
}
