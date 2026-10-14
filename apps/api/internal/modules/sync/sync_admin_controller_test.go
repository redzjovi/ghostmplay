package sync

import (
	"encoding/json"
	"net/http/httptest"
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
