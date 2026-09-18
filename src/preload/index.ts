import { contextBridge, ipcRenderer } from 'electron'
import type { MarketplaceListQuery } from '../shared/types'

const api = {
  marketplace: {
    list: (query?: MarketplaceListQuery) => ipcRenderer.invoke('marketplace:list', query) as Promise<{ data: unknown[]; total: number; page: number; limit: number }>,
    get: (tokenId: number) => ipcRenderer.invoke('marketplace:get', tokenId) as Promise<unknown>
  },
  sync: {
    refresh: (opts?: { page?: number; limit?: number; q?: string }) =>
      ipcRenderer.invoke('sync:refresh', opts) as Promise<{ synced: number }>
  },
  system: {
    ping: () => ipcRenderer.invoke('system:ping') as Promise<string>
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
