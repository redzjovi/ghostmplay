import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MarketplaceFavorite, CreateFavoriteInput, UpdateFavoriteInput } from '@shared/types'

const LS_KEY = 'ghostmplay:favorites:fallback'

function loadLs(): MarketplaceFavorite[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as MarketplaceFavorite[]
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
function saveLs(list: MarketplaceFavorite[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)) } catch {}
}

export const useFavoritesStore = defineStore('favorites', () => {
  const favorites = ref<MarketplaceFavorite[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  function sortByName(list: MarketplaceFavorite[]): MarketplaceFavorite[] {
    return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }
  async function fetchFavorites(force = false) {
    if (!force && favorites.value.length) return favorites.value
    loading.value = true
    error.value = null
    try {
      const res = await window.api.favorites.list()
      const sorted = sortByName(res)
      favorites.value = sorted
      saveLs(sorted)
      return sorted
    } catch (e: unknown) {
      // fallback to localStorage when not in Electron (dev browser)
      const msg = e instanceof Error ? e.message : String(e)
      error.value = msg
      const ls = sortByName(loadLs())
      favorites.value = ls
      return ls
    } finally {
      loading.value = false
    }
  }

  async function create(input: CreateFavoriteInput) {
    const name = input.name?.trim()
    if (!name) throw new Error('Favorite name is required')
    // unique check locally for fallback
    if (favorites.value.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Favorite "${name}" already exists`)
    }
    try {
      const created = await window.api.favorites.create(input)
      favorites.value = sortByName([...favorites.value, created])
      saveLs(favorites.value)
      return created
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('already exists') || msg.includes('required') || msg.includes('max 50')) throw e
      // fallback LS create
      const now = new Date().toISOString()
      const fallback: MarketplaceFavorite = {
        id: Date.now(),
        name,
        q: (input.q ?? null) as string | null,
        equipmentTypes: (input.equipmentTypes ?? (input as unknown as Record<string, unknown>).equipment_type as string[] ?? []) as string[],
        gradeEffects: (input.gradeEffects ?? (input as unknown as Record<string, unknown>).grade_effect as string[] ?? []) as string[],
        sort: (input.sort as string) ?? 'recent',
        createdAt: now,
        updatedAt: now
      }
      // normalize arrays if were strings
      const norm = (v: unknown): string[] => {
        if (!v) return []
        if (Array.isArray(v)) return v.map(String)
        if (typeof v === 'string') return v.includes(',') ? v.split(',').map(s=>s.trim()).filter(Boolean) : [v]
        return []
      }
      fallback.equipmentTypes = norm(fallback.equipmentTypes)
      fallback.gradeEffects = norm(fallback.gradeEffects)
      favorites.value = sortByName([...favorites.value, fallback])
      saveLs(favorites.value)
      return fallback
    }
  }

  async function update(id: number, input: UpdateFavoriteInput) {
    try {
      const updated = await window.api.favorites.update(id, input)
      favorites.value = sortByName(favorites.value.map((f) => (f.id === id ? updated : f)))
      saveLs(favorites.value)
      return updated
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('already exists')) throw e
      // fallback
      const idx = favorites.value.findIndex((f) => f.id === id)
      if (idx === -1) throw e
      if (input.name !== undefined) {
        const newName = input.name.trim()
        if (!newName) throw new Error('Favorite name is required')
        if (favorites.value.some((f) => f.id !== id && f.name.toLowerCase() === newName.toLowerCase())) throw new Error(`Favorite "${newName}" already exists`)
        favorites.value[idx].name = newName
      }
      if ('q' in input) favorites.value[idx].q = (input.q as string | null) ?? null
      if ('equipmentTypes' in input || 'equipment_type' in input) {
        const v = (input.equipmentTypes ?? (input as unknown as Record<string, unknown>).equipment_type) as unknown
        favorites.value[idx].equipmentTypes = Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? v.split(',').map(s=>s.trim()).filter(Boolean) : []
      }
      if ('gradeEffects' in input || 'grade_effect' in input) {
        const v = (input.gradeEffects ?? (input as unknown as Record<string, unknown>).grade_effect) as unknown
        favorites.value[idx].gradeEffects = Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? v.split(',').map(s=>s.trim()).filter(Boolean) : []
      }
      if ('sort' in input) favorites.value[idx].sort = (input.sort as string) ?? 'recent'
      favorites.value[idx].updatedAt = new Date().toISOString()
      favorites.value = sortByName(favorites.value)
      saveLs(favorites.value)
      return favorites.value[idx]
    }
  }

  async function remove(id: number) {
    try {
      await window.api.favorites.remove(id)
    } catch {
      // ignore for fallback
    }
    favorites.value = favorites.value.filter((f) => f.id !== id)
    saveLs(favorites.value)
  }

  return { favorites, loading, error, fetchFavorites, create, update, remove }
})
