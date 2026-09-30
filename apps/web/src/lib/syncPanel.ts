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

/** How a run is described in the UI. "Sync All" is the label for either backfill. */
export function modeLabel(mode: string | null | undefined): string {
  if (mode === 'all') return 'Sync All'
  if (mode === 'full') return 'Sync All'
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
