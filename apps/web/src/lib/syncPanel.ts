import type { SyncKind, SyncKindStatus } from '@/api/http-client'

/**
 * Presentation logic for the admin Data page, kept out of the component.
 *
 * The vitest config runs in a node environment with no DOM and no component
 * testing library, so anything worth asserting about has to be a plain function
 * that can be called directly. See syncPanel.spec.ts.
 */

/** The two scrape kinds, in the order the server reports them. */
export const PANEL_KINDS = ['marketplace', 'history'] as const

/**
 * The server spells "backfill" differently per kind, and gets it wrong in a way
 * that cannot be caught downstream.
 *
 * `EnqueueSyncDto.mode` is validated with `@IsIn(['all', 'latest', 'full'])`, so
 * all three values pass for either kind. But the orchestrator dispatches on
 * `mode === 'all'` for marketplace and `mode === 'full'` for history, falling
 * back to the incremental run in every other case. Sending `all` to history
 * therefore succeeds, logs nothing, and quietly scrapes one incremental page
 * instead of backfilling. The only safe way to build these buttons is to derive
 * the mode from the kind.
 */
export function backfillMode(kind: SyncKind): 'all' | 'full' {
  return kind === 'history' ? 'full' : 'all'
}

/**
 * The history-only walk that skips transfers already recorded claimed.
 *
 * Not reachable through `backfillMode`, because the marketplace has no
 * equivalent: there is no claimed flag on a listing, so there is nothing for it
 * to skip. `pending` is history's alone and the server maps it to
 * `HistoryPending` — anything else, including `full`, falls through to the
 * incremental run.
 */
export const PENDING_MODE = 'pending' as const

/** How a run is described in the UI. "Sync All" is the label for either backfill. */
export function modeLabel(mode: string | null | undefined): string {
  if (mode === 'all') return 'Sync All'
  if (mode === 'full') return 'Sync All'
  if (mode === 'pending') return 'Sync Pending'
  if (mode === 'latest') return 'Sync Latest'
  return 'Sync'
}

/** Short badge text for a run's terminal (or in-flight) state. */
export function statusLabel(status: SyncKindStatus): string {
  if (status.running) return 'Running'
  switch (status.lastStatus) {
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'interrupted':
      return 'Interrupted'
    default:
      return 'Never run'
  }
}

/** One number out of the stats blob, or null when the run did not report it. */
export function statOf(status: SyncKindStatus, key: string): number | null {
  const v = status.lastStats?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Whether the list views should offer a manual "Sync Latest".
 *
 * A plain function because the vitest config runs in node with no DOM and no
 * component testing library, so anything worth asserting about has to be
 * callable directly. See syncPanel.spec.ts.
 *
 * Three conditions, and the third is the one that is easy to forget. Until the
 * status snapshot has actually loaded, `cronEnabled` is `undefined` -- and a
 * naive `cronEnabled === false` is already false-y enough to read as "the
 * scheduler is off". Without `loaded`, the button would flash for every visitor
 * on page load and then vanish once auth resolved, which is worse than not
 * offering it at all: it advertises a control that may not work.
 *
 * Admin-only is not enforced here so much as inherited: the status endpoint is
 * guarded server-side and the store never calls it for a non-admin, so a
 * non-admin has no snapshot and therefore no `cronEnabled` to act on.
 */
export function shouldShowManualSync(input: {
  isAdmin: boolean
  cronEnabled: boolean | null | undefined
  loaded: boolean
}): boolean {
  return input.loaded && input.isAdmin && input.cronEnabled === false
}
