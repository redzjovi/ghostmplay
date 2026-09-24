import { contextBridge, ipcRenderer } from 'electron'
import type { MarketplaceListQuery, MarketplaceFavorite, CreateFavoriteInput, UpdateFavoriteInput } from '../shared/types'

const api = {
  marketplace: {
    list: (query?: MarketplaceListQuery) => ipcRenderer.invoke('marketplace:list', query) as Promise<{ data: unknown[]; total: number; page: number; limit: number }>,
    get: (tokenId: number) => ipcRenderer.invoke('marketplace:get', tokenId) as Promise<unknown>,
    filters: () => ipcRenderer.invoke('marketplace:filters') as Promise<{ equipmentTypes: string[]; gradeEffects: string[] }>,
    equipmentTypes: () => ipcRenderer.invoke('marketplace:equipmentTypes') as Promise<string[]>,
    gradeEffects: () => ipcRenderer.invoke('marketplace:gradeEffects') as Promise<string[]>
  },
  favorites: {
    list: () => ipcRenderer.invoke('favorites:list') as Promise<MarketplaceFavorite[]>,
    create: (input: CreateFavoriteInput) => ipcRenderer.invoke('favorites:create', input) as Promise<MarketplaceFavorite>,
    update: (id: number, input: UpdateFavoriteInput) => ipcRenderer.invoke('favorites:update', { id, input }) as Promise<MarketplaceFavorite>,
    remove: (id: number) => ipcRenderer.invoke('favorites:delete', id) as Promise<void>,
    get: (id: number) => ipcRenderer.invoke('favorites:get', id) as Promise<MarketplaceFavorite | null>
  },
  sync: {
    refresh: (opts?: { itemName?: string; q?: string; page?: number; limit?: number; mode?: 'all' | 'latest' }) =>
      ipcRenderer.invoke('sync:refresh', opts) as Promise<{ synced: number }>
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<void>
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch {}
} else {
  // @ts-ignore
  window.api = api
}

export type PreloadApi = typeof api
