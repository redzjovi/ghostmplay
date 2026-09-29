import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MarketplaceListQuery } from '@ghostmplay/shared'

export const useMarketplaceStore = defineStore('marketplace', () => {
  const items = ref<unknown[]>([])
  const total = ref(0)
  const loading = ref(false)
  const equipmentTypes = ref<string[]>([])
  const gradeEffects = ref<string[]>([])
  const filterLoading = ref(false)
  const error = ref<string | null>(null)

  async function fetchList(q: MarketplaceListQuery = {}) {
    loading.value = true
    error.value = null
    try {
      const res = await window.api.marketplace.list(q)
      items.value = res.data as unknown[]
      total.value = res.total
      return res
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  async function fetchFilterOptions(force = false) {
    if (!force && equipmentTypes.value.length && gradeEffects.value.length) {
      return { equipmentTypes: equipmentTypes.value, gradeEffects: gradeEffects.value }
    }
    filterLoading.value = true
    try {
      const res = await window.api.marketplace.filters()
      equipmentTypes.value = res.equipmentTypes ?? []
      gradeEffects.value = res.gradeEffects ?? []
      return res
    } finally {
      filterLoading.value = false
    }
  }

  return { items, total, loading, error, equipmentTypes, gradeEffects, filterLoading, fetchList, fetchFilterOptions }
})
