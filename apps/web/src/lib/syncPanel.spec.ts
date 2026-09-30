import { describe, it, expect } from 'vitest'
import type { SyncKindStatus } from '@/api/http-client'
import {
  PANEL_KINDS,
  backfillMode,
  modeLabel,
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

describe('modeLabel', () => {
  it('labels either backfill as Sync All', () => {
    expect(modeLabel('all')).toBe('Sync All')
    expect(modeLabel('full')).toBe('Sync All')
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
