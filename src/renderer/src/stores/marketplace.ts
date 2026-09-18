import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MarketplaceListQuery } from '@shared/types'

export const useMarketplaceStore = defineStore('marketplace', () => {
  const items = ref<unknown[]>([])
  const total = ref(0)
  const loading = ref(false)

  async function fetchList(q: MarketplaceListQuery = {}) {
    loading.value = true
    try {
      const res = await window.api.marketplace.list(q)
      items.value = res.data as unknown[]
      total.value = res.total
      return res
    } catch {
      // dev without Electron: fallback to mock
      const { mockItems } = await import('../mock/data')
      const filtered = q.q ? mockItems.filter((i) => i.name.toLowerCase().includes(q.q!.toLowerCase())) : mockItems
      items.value = filtered as unknown[]
      total.value = filtered.length
      return { data: filtered as unknown[], total: filtered.length, page: 1, limit: 20 }
    } finally {
      loading.value = false
    }
  }

  async function refresh() {
    try {
      const r = await window.api.sync.refresh({ page: 1, limit: 20 })
      return r
    } catch {
      return { synced: 0 }
    }
  }

  return { items, total, loading, fetchList, refresh }
})
