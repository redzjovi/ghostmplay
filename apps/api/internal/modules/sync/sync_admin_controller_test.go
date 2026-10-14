package sync

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
)

// The list views decide whether to offer a manual "Sync Latest" from this one
// field, and the only way to check it without a signed-in browser is to read the
// response body -- so that is what this does.
//
// It also pins the guard's other half implicitly: the field lives on the
// admin-only status endpoint precisely so a non-admin cannot learn whether the
// scheduler is running, and so the button needs no second check of its own.
func TestStatusCarriesCronEnabled(t *testing.T) {
	tests := []struct {
		name        string
		cronEnabled bool
	}{
		{"scheduler on, nothing to offer", true},
		{"scheduler off, manual trigger warranted", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q := newFakeQuerier()
			orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{}, testLogger())
			h := NewController(orch, tc.cronEnabled)

			app := fiber.New()
			app.Get("/status", h.Status)

			resp, err := app.Test(httptest.NewRequest("GET", "/status", nil))
			if err != nil {
				t.Fatalf("request: %v", err)
			}
			// Checked rather than left bare, unlike the older tests that leave
			// res.Body.Close() unasserted and are flagged for it.
			defer func() { _ = resp.Body.Close() }()

			var body struct {
				CronEnabled *bool `json:"cronEnabled"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Fatalf("decode: %v", err)
			}

			// A pointer, so an absent field is distinguishable from a false one.
			// That distinction is the whole `loaded` guard in the client: a
			// missing key would read as "not known" and a present false reads as
			// "off", and conflating them flashes the button at every visitor.
			if body.CronEnabled == nil {
				t.Fatal("cronEnabled is absent from the response, so the client cannot tell 'off' from 'unknown'")
			}
			if *body.CronEnabled != tc.cronEnabled {
				t.Errorf("cronEnabled = %v, want %v", *body.CronEnabled, tc.cronEnabled)
			}
		})
	}
}

// The reset endpoint moves state, so it takes the same body as the delete and is
// refused the same way. Confirm is the only thing standing between a script and a
// cleared panel, which is why a missing one is refused rather than defaulted.
//
// Tested at the parser rather than over HTTP because the refusal is a
// common.BadRequest, and turning that into a status code is platform.errorHandler's
// job -- unexported, and not what this is checking.
func TestParseKindWithConfirm(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		want    Kind
		wantErr bool
	}{
		{"confirmed", `{"kind":"marketplace","confirm":true}`, KindMarketplace, false},
		{"no confirm", `{"kind":"marketplace"}`, "", true},
		{"confirm false", `{"kind":"marketplace","confirm":false}`, "", true},
		{"unknown kind", `{"kind":"everything","confirm":true}`, "", true},
		{"empty body", ``, "", true},
		{"not an object", `["marketplace"]`, "", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseKindWithConfirm([]byte(tc.body), "reset sync state")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parsed %q with no error, want a refusal", got)
				}
				var apiErr *common.Error
				if !errors.As(err, &apiErr) || apiErr.Status != 400 {
					t.Errorf("error = %v, want a 400", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if got != tc.want {
				t.Errorf("kind = %q, want %q", got, tc.want)
			}
		})
	}
}

// The wording is the only difference between the two callers, and it matters: a
// reset is recoverable and a delete is not, so a shared message would teach an
// admin that both are the same risk.
func TestConfirmRefusalNamesTheAction(t *testing.T) {
	_, clearErr := parseKindWithConfirm([]byte(`{"kind":"history"}`), "clear data")
	_, resetErr := parseKindWithConfirm([]byte(`{"kind":"history"}`), "reset sync state")

	if clearErr == nil || resetErr == nil {
		t.Fatal("a missing confirm was accepted")
	}
	if clearErr.Error() == resetErr.Error() {
		t.Errorf("both refusals read %q, want the action named", clearErr.Error())
	}
}

// A kind that was never stuck answers 200, not 404. The caller asked for a state
// that does not exist and got it; treating that as a failure would make the
// button report an error every time somebody clicked it on a healthy panel.
func TestResetOnASettledKindIsNotAnError(t *testing.T) {
	q := newFakeQuerier()
	orch := NewOrchestrator(q, common.NewLockService(), &fakeExecutor{}, testLogger())
	h := NewController(orch, false)

	app := fiber.New()
	app.Post("/reset", h.Reset)

	resp, err := app.Test(httptest.NewRequest("POST", "/reset",
		strings.NewReader(`{"kind":"history","confirm":true}`)))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var body struct {
		Reset bool `json:"reset"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Reset {
		t.Error("reset = true for a kind that was not running")
	}
}
