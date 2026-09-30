import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SyncKind, SyncKindStatus, SyncStatus, EnqueueSyncResult, ClearSyncDataResult } from '@/api/http-client'
import { useAuthStore } from './auth'

/**
 * Sync is admin-only and runs in the background, so the UI never awaits a scrape.
 * This store polls the status endpoint while any run is in flight and stops as soon
 * as nothing is running.
 *
 * State is per kind rather than global. The server keeps one row per kind, and each
 * page renders only its own scrape — a shared "is busy" flag would let a history
 * backfill disable the marketplace button and, worse, show history's item count as
 * the marketplace's last sync.
 */
const POLL_MS = 3000

const EMPTY: Record<SyncKind, SyncKindStatus> = {
  marketplace: {
    kind: 'marketplace',
    running: false,
    runningSince: null,
    mode: null,
    lastStatus: null,
    lastFinishedAt: null,
    lastSynced: null,
    lastStats: null,
    lastError: null,
  },
  history: {
    kind: 'history',
    running: false,
    runningSince: null,
    mode: null,
    lastStatus: null,
    lastFinishedAt: null,
    lastSynced: null,
    lastStats: null,
    lastError: null,
  },
}

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatus | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  let timer: ReturnType<typeof setTimeout> | null = null

  const auth = useAuthStore()
  const isAdmin = computed(() => auth.isAdmin)

  /** This kind's slice of the snapshot, falling back to a never-run shape. */
  function forKind(kind: SyncKind): SyncKindStatus {
    return status.value?.[kind] ?? EMPTY[kind]
  }

  /** Poll while *any* kind is running, so both pages stay live. */
  const anyRunning = computed(() => (['marketplace', 'history'] as const).some((k) => forKind(k).running))

  function stopPolling() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function schedule() {
    stopPolling()
    if (!anyRunning.value) return
    timer = setTimeout(() => {
      void refresh().then(schedule)
    }, POLL_MS)
  }

  async function refresh(): Promise<void> {
    if (!isAdmin.value) return
    try {
      status.value = await window.api.admin.sync.status()
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** Loads once on admin mount, then keeps polling only while a run is going. */
  async function start(): Promise<void> {
    if (!isAdmin.value) return
    await refresh()
    schedule()
  }

  /**
   * Asks the server to start a scrape and returns immediately. If a run of the same
   * kind is already going the server joins that one instead, so a double-click
   * cannot launch a second unbounded scrape.
   */
  async function enqueue(input: {
    kind: SyncKind
    mode?: 'all' | 'latest' | 'full'
    itemName?: string
  }): Promise<EnqueueSyncResult> {
    loading.value = true
    error.value = null
    try {
      const res = await window.api.admin.sync.enqueue(input)
      await refresh()
      schedule()
      return res
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  /**
   * Deletes everything one kind of scraper owns. Irreversible.
   *
   * Not queued or retried: a failed clear is reported and stops, because a
   * half-applied delete is not something to replay blindly. `refresh()` follows
   * so the reset state — the row that said "done, 516 synced" over a table that
   * no longer exists — reaches the cards straight away.
   */
  async function clear(kind: SyncKind): Promise<ClearSyncDataResult> {
    loading.value = true
    error.value = null
    try {
      const res = await window.api.admin.sync.clear({ kind, confirm: true })
      await refresh()
      return res
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  return {
    status,
    loading,
    error,
    isAdmin,
    forKind,
    anyRunning,
    refresh,
    start,
    stopPolling,
    enqueue,
    clear,
  }
})
