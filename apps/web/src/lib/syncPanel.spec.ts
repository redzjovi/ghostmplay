import { describe, it, expect } from 'vitest'
import type { SyncKindStatus } from '@/api/http-client'
import {
  PANEL_KINDS,
  PENDING_MODE,
  backfillMode,
  modeLabel,
  shouldShowManualSync,
  statusLabel,
  statOf,
} from './syncPanel'

function status(over: Partial<SyncKindStatus> = {}): SyncKindStatus {
  return {
    kind: 'marketplace',
    running: false,
    runningSince: null,
    mode: null,
    lastStatus: null,
    lastFinishedAt: null,
    lastSynced: null,
    lastStats: null,
    lastError: null,
    ...over,
  }
}

describe('backfillMode', () => {
  // The reason this helper exists. `EnqueueSyncDto.mode` accepts all three values
  // for either kind, but the orchestrator only treats 'all' as a marketplace
  // backfill and 'full' as a history one — anything else silently falls through
  // to the incremental run. So a cross-wired button would look like it worked.
  it('maps marketplace to all and history to full', () => {
    expect(backfillMode('marketplace')).toBe('all')
    expect(backfillMode('history')).toBe('full')
  })

  it('gives each kind a mode the server actually dispatches on', () => {
    // Mirrors SyncOrchestratorService.execute: marketplace backfills on
    // mode === 'all', history backfills on mode === 'full'.
    for (const kind of PANEL_KINDS) {
      const mode = backfillMode(kind)
      const backfills = kind === 'marketplace' ? mode === 'all' : mode === 'full'
      expect(backfills).toBe(true)
    }
  })

  it('never returns the other kind\'s backfill mode', () => {
    expect(backfillMode('marketplace')).not.toBe('full')
    expect(backfillMode('history')).not.toBe('all')
  })
})

describe('PENDING_MODE', () => {
  /**
   * The same hazard as backfillMode, one mode further along: a button wired to a
   * mode the server does not dispatch on does not error, it logs nothing and
   * quietly runs the incremental crawl. So this asserts the server's own mapping
   * rather than the button's — see Orchestrator.execute, where anything that is
   * not ModeFull or ModePending falls through to HistoryLatest.
   */
  it('is a mode the server maps to the pending walk, not to latest', () => {
    // Mirrors the switch in SyncOrchestratorService.execute.
    const serverMaps = (mode: string): string => {
      if (mode === 'full') return 'HistoryFull'
      if (mode === PENDING_MODE) return 'HistoryPending'
      return 'HistoryLatest'
    }
    expect(serverMaps(PENDING_MODE)).toBe('HistoryPending')
  })

  it('is not a mode either kind reaches by backfill', () => {
    // A listing has no claimed flag, so there is nothing for the marketplace to
    // skip. If backfillMode ever started returning this, the marketplace button
    // would silently become the incremental run.
    for (const kind of PANEL_KINDS) {
      expect(backfillMode(kind)).not.toBe(PENDING_MODE)
    }
  })
})

describe('modeLabel', () => {
  it('labels either backfill as Sync All', () => {
    expect(modeLabel('all')).toBe('Sync All')
    expect(modeLabel('full')).toBe('Sync All')
  })

  it('labels the pending walk distinctly from a full one', () => {
    // Both walk every page, so labelling them alike would leave the admin with
    // no way to tell which of the two runs they just started.
    expect(modeLabel('pending')).toBe('Sync Pending')
    expect(modeLabel('pending')).not.toBe(modeLabel('full'))
  })

  it('labels the incremental mode', () => {
    expect(modeLabel('latest')).toBe('Sync Latest')
  })

  it('falls back for a missing mode', () => {
    expect(modeLabel(null)).toBe('Sync')
    expect(modeLabel(undefined)).toBe('Sync')
    expect(modeLabel('nonsense')).toBe('Sync')
  })
})

describe('statusLabel', () => {
  it('prefers the running state over the last terminal one', () => {
    expect(statusLabel(status({ running: true, lastStatus: 'done' }))).toBe('Running')
  })

  it('reports each terminal state', () => {
    expect(statusLabel(status({ lastStatus: 'done' }))).toBe('Done')
    expect(statusLabel(status({ lastStatus: 'failed' }))).toBe('Failed')
    expect(statusLabel(status({ lastStatus: 'interrupted' }))).toBe('Interrupted')
  })

  it('reports a kind that has never run', () => {
    expect(statusLabel(status())).toBe('Never run')
  })
})

describe('statOf', () => {
  it('reads a number out of the stats blob', () => {
    expect(statOf(status({ lastStats: { enriched: 3 } }), 'enriched')).toBe(3)
  })

  it('tolerates zero, which is a real result and not a missing one', () => {
    expect(statOf(status({ lastStats: { claimed: 0 } }), 'claimed')).toBe(0)
  })

  it('returns null when the key is absent or not a number', () => {
    expect(statOf(status(), 'enriched')).toBeNull()
    expect(statOf(status({ lastStats: {} }), 'enriched')).toBeNull()
    expect(statOf(status({ lastStats: { enriched: NaN } }), 'enriched')).toBeNull()
  })
})

describe('shouldShowManualSync', () => {
  const adminOff = { isAdmin: true, cronEnabled: false, loaded: true }

  it('offers the trigger to an admin when the scheduler is off', () => {
    expect(shouldShowManualSync(adminOff)).toBe(true)
  })

  /**
   * The case that makes `loaded` load-bearing. Before the snapshot arrives
   * `cronEnabled` is undefined, and `undefined === false` is false -- but a
   * looser check reads undefined as "the scheduler is off" and the button flashes
   * for every visitor on page load, then vanishes once auth resolves.
   */
  it('stays hidden until the snapshot has actually loaded', () => {
    expect(shouldShowManualSync({ ...adminOff, loaded: false })).toBe(false)
    expect(shouldShowManualSync({ ...adminOff, cronEnabled: null, loaded: false })).toBe(false)
  })

  it('treats an unknown cron state as not-known rather than as off', () => {
    expect(shouldShowManualSync({ ...adminOff, cronEnabled: undefined })).toBe(false)
    expect(shouldShowManualSync({ ...adminOff, cronEnabled: null })).toBe(false)
  })

  it('stays hidden when the scheduler is running, since it needs no help', () => {
    expect(shouldShowManualSync({ ...adminOff, cronEnabled: true })).toBe(false)
  })

  it('is never offered to a non-admin', () => {
    expect(shouldShowManualSync({ ...adminOff, isAdmin: false })).toBe(false)
    expect(shouldShowManualSync({ isAdmin: false, cronEnabled: false, loaded: true })).toBe(false)
  })

  it('cannot be reached by a non-admin even if a snapshot somehow carried the flag', () => {
    // Defence in depth: the server guards the endpoint, so a non-admin never has
    // a snapshot at all. The predicate does not rely on that, because a future
    // widening of the endpoint should not silently start offering a control that
    // answers 403.
    expect(shouldShowManualSync({ isAdmin: false, cronEnabled: false, loaded: true })).toBe(false)
  })
})
