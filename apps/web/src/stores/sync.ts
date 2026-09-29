import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SyncJob, SyncStatus } from '@/api/http-client'
import { useAuthStore } from './auth'

/**
 * Sync is admin-only and queued, so the UI never awaits a scrape. This store
 * polls the status endpoint while a job is in flight and stops as soon as the
 * job reaches a terminal state.
 */
const POLL_MS = 3000
const TERMINAL = new Set(['done', 'failed', 'interrupted'])

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatus | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const lastEnqueued = ref<SyncJob | null>(null)

  let timer: ReturnType<typeof setTimeout> | null = null

  const auth = useAuthStore()
  const isAdmin = computed(() => auth.isAdmin)

  /** The job the user is most likely watching, if any. */
  const active = computed<SyncJob | null>(() => status.value?.running ?? status.value?.queued ?? null)
  const isBusy = computed(() => active.value !== null)

  const lastSyncedAt = computed(() => status.value?.lastCompleted?.finishedAt ?? null)
  const lastSyncedCount = computed(() => {
    const stats = status.value?.lastCompleted?.stats
    if (!stats) return null
    return typeof stats.synced === 'number' ? stats.synced : null
  })

  function stopPolling() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function schedule() {
    stopPolling()
    if (!isBusy.value) return
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

  /** Loads once on admin mount, then keeps polling only while a job runs. */
  async function start(): Promise<void> {
    if (!isAdmin.value) return
    await refresh()
    schedule()
  }

  /**
   * Queues a scrape. Returns immediately — the job runs server-side. If a job of
   * the same kind is already in flight the server returns that one instead, so a
   * double-click cannot queue a second unbounded scrape.
   */
  async function enqueue(input: {
    kind: 'marketplace' | 'history'
    mode?: 'all' | 'latest' | 'full'
    itemName?: string
    maxPages?: number
  }): Promise<{ job: SyncJob; deduped: boolean }> {
    loading.value = true
    error.value = null
    try {
      const res = await window.api.admin.sync.enqueue(input)
      lastEnqueued.value = res.job
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

  return {
    status,
    loading,
    error,
    isAdmin,
    active,
    isBusy,
    lastSyncedAt,
    lastSyncedCount,
    lastEnqueued,
    refresh,
    start,
    stopPolling,
    enqueue,
    isTerminal: (status?: string | null) => (status ? TERMINAL.has(status) : false),
  }
})
