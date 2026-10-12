package marketplace

import (
	"log/slog"

	"github.com/gofiber/fiber/v2"

	"github.com/redzjovi/ghostmplay/apps/api/internal/config"
	"github.com/redzjovi/ghostmplay/apps/api/internal/models"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/auth"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/api"
	"github.com/redzjovi/ghostmplay/apps/api/internal/modules/marketplace/dto"
)

// Controller serves the marketplace routes.
type Controller struct {
	service *MarketplaceService
	client  *api.Client
	log     *slog.Logger
	env     config.Env
}

// NewController builds the controller.
func NewController(service *MarketplaceService, client *api.Client, log *slog.Logger, env config.Env) *Controller {
	return &Controller{service: service, client: client, log: log, env: env}
}

// Register mounts the routes.
func (h *Controller) Register(router fiber.Router) {
	router.Get("/items", h.List)
	router.Get("/filters", h.Filters)
	// Declared before the bare /items route would match it; Fiber matches in
	// registration order, so the two-parameter routes come first.
	router.Get("/items/:tokenId", h.Get)
	router.Get("/items/:tokenId/live", h.GetLive)
}

// List returns one page of live listings.
func (h *Controller) List(c *fiber.Ctx) error {
	query, err := dto.ParseMarketplaceListQuery(c)
	if err != nil {
		return err
	}

	result, err := h.service.List(c.Context(), query)
	if err != nil {
		return err
	}

	if h.env.LogQuery {
		h.log.Info("marketplace list",
			"total", result.Total, "returned", len(result.Data), "page", result.Page)
	}
	return c.JSON(result)
}

// Filters returns the dropdown options.
func (h *Controller) Filters(c *fiber.Ctx) error {
	filters, err := h.service.GetDistinctFilters(c.Context())
	if err != nil {
		return err
	}
	return c.JSON(filters)
}

// Get resolves one listing by token id.
//
// A null body rather than a 404 when the token is unknown: the client
// distinguishes "no such token" from "listed but sold", and a 404 for both would
// lose that.
func (h *Controller) Get(c *fiber.Ctx) error {
	tokenID, err := dto.TokenIDParam(c)
	if err != nil {
		return err
	}

	result, err := h.service.GetByTokenID(c.Context(), tokenID)
	if err != nil {
		return err
	}
	return c.JSON(result)
}

// GetLive proxies the upstream detail for a token. Never persisted.
//
// Display-only: it answers "is this listed right now", and only for tokens that
// were not in our database to begin with, so there is nothing to reconcile. A
// null body means the fetch failed or the token is gone, and the client renders
// that as "sold" -- which is why every failure collapses to null here rather
// than to a 5xx.
func (h *Controller) GetLive(c *fiber.Ctx) error {
	tokenID, err := dto.TokenIDParam(c)
	if err != nil {
		return err
	}

	detail, err := h.client.Detail(c.Context(), tokenID)
	if err != nil || detail == nil {
		return c.JSON(nil)
	}
	return c.JSON(liveItemDetail(detail))
}

// HistoryController serves the transfer-ledger routes.
type HistoryController struct {
	service *HistoryService
	log     *slog.Logger
	env     config.Env
}

// NewHistoryController builds the controller.
func NewHistoryController(service *HistoryService, log *slog.Logger, env config.Env) *HistoryController {
	return &HistoryController{service: service, log: log, env: env}
}

// Register mounts the routes.
func (h *HistoryController) Register(router fiber.Router) {
	router.Get("/transfers", h.List)
	router.Get("/filters", h.Filters)
}

// List returns one page of the ledger.
func (h *HistoryController) List(c *fiber.Ctx) error {
	query, err := dto.ParseHistoryListQuery(c)
	if err != nil {
		return err
	}

	result, err := h.service.List(c.Context(), query)
	if err != nil {
		return err
	}

	if h.env.LogQuery {
		h.log.Info("history list",
			"total", result.Total, "returned", len(result.Data), "page", result.Page)
	}
	return c.JSON(result)
}

// Filters returns the three dropdown options.
func (h *HistoryController) Filters(c *fiber.Ctx) error {
	filters, err := h.service.GetDistinctFilters(c.Context())
	if err != nil {
		return err
	}
	return c.JSON(filters)
}

// FavoritesController serves the per-account saved-filter routes.
//
// The whole group sits behind the auth guard, so every handler here can assume a
// signed-in account. Scope is applied by the service, not the route: an id
// belonging to another account is a 404, not a 403.
type FavoritesController struct {
	service *MarketplaceService
}

// NewFavoritesController builds the controller.
func NewFavoritesController(service *MarketplaceService) *FavoritesController {
	return &FavoritesController{service: service}
}

// Register mounts the routes.
func (h *FavoritesController) Register(router fiber.Router) {
	router.Get("/", h.List)
	router.Get("/:id", h.Get)
	router.Post("/", h.Create)
	router.Patch("/:id", h.Update)
	router.Delete("/:id", h.Delete)
}

// List returns the signed-in account's saved filters.
func (h *FavoritesController) List(c *fiber.Ctx) error {
	favorites, err := h.service.ListFavorites(c.Context(), auth.AccountIDOf(c))
	if err != nil {
		return err
	}
	return c.JSON(favorites)
}

// Get returns one saved filter.
func (h *FavoritesController) Get(c *fiber.Ctx) error {
	id, err := dto.IDParam(c)
	if err != nil {
		return err
	}

	favorite, err := h.service.GetFavorite(c.Context(), auth.AccountIDOf(c), id)
	if err != nil {
		return err
	}
	return c.JSON(favorite)
}

// Create saves a new filter set.
func (h *FavoritesController) Create(c *fiber.Ctx) error {
	input, err := dto.ParseFavoriteInput(c)
	if err != nil {
		return err
	}

	favorite, err := h.service.CreateFavorite(c.Context(), auth.AccountIDOf(c), input)
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(favorite)
}

// Update edits a saved filter set.
func (h *FavoritesController) Update(c *fiber.Ctx) error {
	id, err := dto.IDParam(c)
	if err != nil {
		return err
	}
	input, err := dto.ParseFavoriteInput(c)
	if err != nil {
		return err
	}

	favorite, err := h.service.UpdateFavorite(c.Context(), auth.AccountIDOf(c), id, input)
	if err != nil {
		return err
	}
	return c.JSON(favorite)
}

// Delete removes a saved filter set.
func (h *FavoritesController) Delete(c *fiber.Ctx) error {
	id, err := dto.IDParam(c)
	if err != nil {
		return err
	}
	if err := h.service.DeleteFavorite(c.Context(), auth.AccountIDOf(c), id); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// liveItemDetail renders the upstream payload for the preview dialog.
//
// The whole object, not a projection. The dialog renders whatever the upstream
// sent, and the previous implementation returned the complete response; trimming
// it to the handful of fields this client happens to read today is a silent
// narrowing of a contract that packages/shared/src/types.ts still declares at
// full width. It also drops description, external_url, mintTime, state and the
// rest, none of which any code depends on today and all of which are one
// upstream change away from mattering.
//
// The type carries Raw so the unknown keys survive; see api.ItemDetail.
func liveItemDetail(detail *api.ItemDetail) models.LiveItemDetail {
	if detail == nil {
		return nil
	}
	if len(detail.Raw) == 0 {
		return nil
	}
	return models.LiveItemDetail(detail.Raw)
}
