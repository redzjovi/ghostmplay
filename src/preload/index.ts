import { contextBridge, ipcRenderer } from 'electron'
import type { MarketplaceListQuery } from '../shared/types'

const api = {
  marketplace: {
    list: (query?: MarketplaceListQuery) => ipcRenderer.invoke('marketplace:list', query) as Promise<{ data: unknown[]; total: number; page: number; limit: number }>,
    get: (tokenId: number) => ipcRenderer.invoke('marketplace:get', tokenId) as Promise<unknown>,
    filters: () => ipcRenderer.invoke('marketplace:filters') as Promise<{ equipmentTypes: string[]; gradeEffects: string[] }>,
    equipmentTypes: () => ipcRenderer.invoke('marketplace:equipmentTypes') as Promise<string[]>,
    gradeEffects: () => ipcRenderer.invoke('marketplace:gradeEffects') as Promise<string[]>
  },
  sync: {
    refresh: (opts?: { itemName?: string; q?: string; page?: number; limit?: number; mode?: 'all' | 'latest' }) =>
      ipcRenderer.invoke('sync:refresh', opts) as Promise<{ synced: number }>
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
