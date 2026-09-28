import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { HistoryListQuery } from '@shared/types'

export const useHistoryStore = defineStore('history', () => {
  const items = ref<unknown[]>([])
  const total = ref(0)
  const loading = ref(false)
  const sellerNames = ref<string[]>([])
  const buyerNames = ref<string[]>([])
  const filterLoading = ref(false)

  async function fetchList(q: HistoryListQuery = {}) {
    try { console.log('[UI] → history:list', JSON.stringify(q)) } catch {}
    loading.value = true
    try {
      const res = await window.api.history.list(q)
      try { console.log('[UI] ← history:list', `total=${res.total} returned=${(res.data as unknown[]).length}`) } catch {}
      items.value = res.data as unknown[]
      total.value = res.total
      return res
    } finally {
      loading.value = false
    }
  }

  async function sync(mode: 'full' | 'latest' = 'latest', limit = 150) {
    try {
      return await window.api.history.sync({ mode, limit })
    } catch {
      return { synced: 0, total: 0, enriched: 0, claimed: 0, skipped: 0 }
    }
  }

  async function fetchFilterOptions(force = false) {
    if (!force && sellerNames.value.length && buyerNames.value.length) {
      return { sellerNames: sellerNames.value, buyerNames: buyerNames.value }
    }
    filterLoading.value = true
    try {
      const res = await window.api.history.filters()
      sellerNames.value = res.sellerNames ?? []
      buyerNames.value = res.buyerNames ?? []
      return { sellerNames: sellerNames.value, buyerNames: buyerNames.value }
    } catch {
      return { sellerNames: sellerNames.value, buyerNames: buyerNames.value }
    } finally {
      filterLoading.value = false
    }
  }

  return { items, total, loading, sellerNames, buyerNames, filterLoading, fetchList, sync, fetchFilterOptions }
})
