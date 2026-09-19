import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MarketplaceListQuery } from '@shared/types'

export const useMarketplaceStore = defineStore('marketplace', () => {
  const items = ref<unknown[]>([])
  const total = ref(0)
  const loading = ref(false)
  const equipmentTypes = ref<string[]>([])
  const gradeEffects = ref<string[]>([])
  const filterLoading = ref(false)

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

  async function refresh(itemName?: string, mode: 'all' | 'latest' = 'latest') {
    try {
      const r = await window.api.sync.refresh({ itemName, mode } as never)
      return r as { synced: number }
    } catch {
      return { synced: 0 }
    }
  }

  async function fetchFilterOptions(force = false) {
    if (!force && equipmentTypes.value.length && gradeEffects.value.length) return { equipmentTypes: equipmentTypes.value, gradeEffects: gradeEffects.value }
    filterLoading.value = true
    try {
      const res = await window.api.marketplace.filters()
      equipmentTypes.value = res.equipmentTypes ?? []
      gradeEffects.value = res.gradeEffects ?? []
      return res
    } catch {
      // fallback to mock distinct
      try {
        const { mockItems } = await import('../mock/data')
        equipmentTypes.value = [...new Set(mockItems.map((i) => i.equipmentType).filter(Boolean))].sort() as string[]
        gradeEffects.value = [...new Set(mockItems.map((i) => i.gradeEffect).filter(Boolean))].sort() as string[]
      } catch {}
      return { equipmentTypes: equipmentTypes.value, gradeEffects: gradeEffects.value }
    } finally {
      filterLoading.value = false
    }
  }

  return { items, total, loading, equipmentTypes, gradeEffects, filterLoading, fetchList, refresh, fetchFilterOptions }
})
