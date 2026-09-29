import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MarketplaceFavorite, CreateFavoriteInput, UpdateFavoriteInput } from '@ghostmplay/shared'

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
      return sorted
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  async function create(input: CreateFavoriteInput) {
    const name = input.name?.trim()
    if (!name) throw new Error('Favorite name is required')
    try {
      const created = await window.api.favorites.create(input)
      favorites.value = sortByName([...favorites.value, created])
      return created
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  async function update(id: number, input: UpdateFavoriteInput) {
    try {
      const updated = await window.api.favorites.update(id, input)
      favorites.value = sortByName(favorites.value.map((f) => (f.id === id ? updated : f)))
      return updated
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  async function remove(id: number) {
    await window.api.favorites.remove(id)
    favorites.value = favorites.value.filter((f) => f.id !== id)
  }

  return { favorites, loading, error, fetchFavorites, create, update, remove }
})
