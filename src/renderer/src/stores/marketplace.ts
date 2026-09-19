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
    // Log BEFORE hit API (renderer → main)
    try { console.log('[UI] → marketplace:list', JSON.stringify(q)) } catch {}
    loading.value = true
    try {
      const res = await window.api.marketplace.list(q)
      try { console.log('[UI] ← marketplace:list', `total=${res.total} returned=${(res.data as unknown[]).length}`) } catch {}
      items.value = res.data as unknown[]
      total.value = res.total
      return res
    } catch (e) {
      try { console.warn('[UI] marketplace:list failed, fallback to mock', e) } catch {}
      // dev without Electron: fallback to mock — supports snake_case sama dengan api & db + camel alias
      const { mockItems } = await import('../mock/data')
      const normArr = (v: unknown): string[] | undefined => {
        if (v === undefined || v === null) return undefined
        if (Array.isArray(v)) return (v as unknown[]).map(String)
        if (typeof v === 'string') {
          const t = v.trim()
          if (!t) return undefined
          return t.includes(',') ? t.split(',').map((s) => s.trim()).filter(Boolean) : [t]
        }
        return [String(v)]
      }
      const eqArr = normArr((q as unknown as Record<string, unknown>).equipment_type ?? (q as unknown as Record<string, unknown>).equipmentType)
      const geArr = normArr((q as unknown as Record<string, unknown>).grade_effect ?? (q as unknown as Record<string, unknown>).gradeEffect)
      let filtered = mockItems as typeof mockItems
      if (q.q) filtered = filtered.filter((i) => i.name.toLowerCase().includes(q.q!.toLowerCase()))
      if (eqArr && eqArr.length) {
        const set = new Set(eqArr)
        filtered = filtered.filter((i) => set.has(i.equipmentType))
      }
      if (geArr && geArr.length) {
        const set = new Set(geArr)
        filtered = filtered.filter((i) => set.has(i.gradeEffect))
      }
      // pagination for mock
      const page = q.page ?? 1
      const limit = q.limit ?? 20
      const start = (page - 1) * limit
      const paged = filtered.slice(start, start + limit)
      items.value = paged as unknown[]
      total.value = filtered.length
      return { data: paged as unknown[], total: filtered.length, page, limit }
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
