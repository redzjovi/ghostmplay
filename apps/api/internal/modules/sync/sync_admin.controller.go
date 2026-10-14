package sync

import (
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/redzjovi/ghostmplay/apps/api/internal/common"
)

// Controller serves the admin sync endpoints.
//
// Every route is behind the admin guard, mounted by the router rather than
// inside this file, so there is one place that decides which routes are guarded.
type Controller struct {
	orchestrator *Orchestrator
	// cronEnabled is deployment configuration the orchestrator has no business
	// knowing about. It rides on the status snapshot because that is the one call
	// the list views already make, and because this endpoint is admin-guarded:
	// handing the flag to a visitor who cannot use it would be information they
	// have no use for.
	cronEnabled bool
}

// NewController builds the controller.
func NewController(orchestrator *Orchestrator, cronEnabled bool) *Controller {
	return &Controller{orchestrator: orchestrator, cronEnabled: cronEnabled}
}

// Register mounts the routes onto an already-guarded group.
func (h *Controller) Register(router fiber.Router) {
	router.Get("/status", h.Status)
	router.Post("", h.Enqueue)
	router.Post("/clear", h.Clear)
	router.Post("/reset", h.Reset)
}

// Status reports both kinds' current state.
//
// Polled by the admin panel every few seconds while anything is running, so it
// has to be cheap: one query, no joins, no upstream calls.
func (h *Controller) Status(c *fiber.Ctx) error {
	snapshot, err := h.orchestrator.Status(c.Context())
	if err != nil {
		return err
	}
	snapshot.CronEnabled = h.cronEnabled
	return c.JSON(snapshot)
}

// enqueueRequest is the body of POST /admin/sync.
type enqueueRequest struct {
	Kind string `json:"kind"`
	Mode string `json:"mode"`
	// ItemName narrows a marketplace scrape to one listing.
	ItemName string `json:"itemName"`
}

// Enqueue starts a run.
//
// 202, not 200: the run has been accepted and is now in the background. A client
// that waits for completion would hold a connection for the length of a
// backfill, and a deploy part-way through would kill it.
func (h *Controller) Enqueue(c *fiber.Ctx) error {
	req, err := parseEnqueueRequest(c.Body())
	if err != nil {
		return err
	}

	result, err := h.orchestrator.Enqueue(c.Context(), req)
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusAccepted).JSON(result)
}

// clearRequest is the body of POST /admin/sync/clear.
type clearRequest struct {
	Kind string `json:"kind"`
	// Confirm is required and is not read for anything else. Its presence is the
	// whole check: this endpoint deletes data irreversibly, and a caller that
	// forgot to pass it should be stopped before the delete rather than after.
	Confirm bool `json:"confirm"`
}

// Clear deletes a kind's data.
//
// 409 while a run is in progress. The orchestrator decides that, because it is
// the thing that knows what "in progress" means -- the same lock that serialises
// runs is the one guarding the delete.
func (h *Controller) Clear(c *fiber.Ctx) error {
	kind, err := parseClearRequest(c.Body())
	if err != nil {
		return err
	}

	result, err := h.orchestrator.Clear(c.Context(), kind)
	if err != nil {
		return err
	}
	return c.JSON(result)
}

// Reset releases a kind's stuck run. No data is deleted.
//
// 409 while a run is in progress, for the same reason Clear has one: if a scrape
// is really running, the row is not stuck and resetting it would report a run
// that is still going as though it had been interrupted.
func (h *Controller) Reset(c *fiber.Ctx) error {
	kind, err := parseKindWithConfirm(c.Body(), "reset sync state")
	if err != nil {
		return err
	}

	result, err := h.orchestrator.Reset(c.Context(), kind)
	if err != nil {
		return err
	}
	return c.JSON(result)
}

func parseEnqueueRequest(body []byte) (EnqueueOptions, error) {
	raw, err := decodeObject(body)
	if err != nil {
		return EnqueueOptions{}, err
	}

	kind := strings.TrimSpace(stringField(raw, "kind"))
	if !isKind(kind) {
		return EnqueueOptions{}, common.BadRequest("kind must be one of: marketplace, history")
	}

	opts := EnqueueOptions{Kind: Kind(kind), Mode: ModeLatest}

	// Mode is optional and defaults to latest. An unrecognised value is rejected
	// rather than ignored: mode selects between a cheap minute-long crawl, a full
	// backfill and a pending-only one, and silently downgrading one to the other is
	// the kind of thing that is discovered days later.
	if mode := strings.TrimSpace(stringField(raw, "mode")); mode != "" {
		switch Mode(mode) {
		case ModeLatest, ModeAll, ModeFull, ModePending:
			opts.Mode = Mode(mode)
		default:
			return EnqueueOptions{}, common.BadRequest("mode must be one of: all, latest, full, pending")
		}
	}

	if itemName := strings.TrimSpace(stringField(raw, "itemName")); itemName != "" {
		if len([]rune(itemName)) > 120 {
			return EnqueueOptions{}, common.BadRequest("itemName max 120 chars")
		}
		opts.ItemName = itemName
	}

	return opts, nil
}

func parseClearRequest(body []byte) (Kind, error) {
	return parseKindWithConfirm(body, "clear data")
}

// parseKindWithConfirm is the body shape both /clear and /reset take:
// `{"kind":"marketplace|history","confirm":true}`.
//
// Declared here rather than as a struct, because decodeObject reads it as a map
// and the two endpoints share the whole shape. The confirm flag is checked by
// presence, not value: the client's job is to show a dialog and pass the flag
// once the person has agreed. A client that sent `confirm: false` is one that
// did not. What the caller gets to choose is the wording of the refusal, because
// the two endpoints are not equally dangerous and should not read as though they
// were.
func parseKindWithConfirm(body []byte, what string) (Kind, error) {
	raw, err := decodeObject(body)
	if err != nil {
		return "", err
	}

	kind := strings.TrimSpace(stringField(raw, "kind"))
	if !isKind(kind) {
		return "", common.BadRequest("kind must be one of: marketplace, history")
	}

	if !boolField(raw, "confirm") {
		return "", common.BadRequest("confirm must be true to " + what)
	}

	return Kind(kind), nil
}

func isKind(kind string) bool {
	return kind == string(KindMarketplace) || kind == string(KindHistory)
}
