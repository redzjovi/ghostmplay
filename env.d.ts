/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

interface Window {
  api: {
    marketplace: {
      list: (q?: import('./src/shared/types').MarketplaceListQuery) => Promise<{ data: import('./src/shared/types').MarketplaceItem[]; total: number; page: number; limit: number }>
      get: (tokenId: number) => Promise<import('./src/shared/types').MarketplaceItemDetail | null>
      filters: () => Promise<{ equipmentTypes: string[]; gradeEffects: string[] }>
      equipmentTypes: () => Promise<string[]>
      gradeEffects: () => Promise<string[]>
    }
    favorites: {
      list: () => Promise<import('./src/shared/types').MarketplaceFavorite[]>
      create: (input: import('./src/shared/types').CreateFavoriteInput) => Promise<import('./src/shared/types').MarketplaceFavorite>
      update: (id: number, input: import('./src/shared/types').UpdateFavoriteInput) => Promise<import('./src/shared/types').MarketplaceFavorite>
      remove: (id: number) => Promise<void>
      get: (id: number) => Promise<import('./src/shared/types').MarketplaceFavorite | null>
    }
    sync: {
      refresh: (opts?: { itemName?: string; q?: string; mode?: 'all' | 'latest'; page?: number; limit?: number }) => Promise<{ synced: number }>
    }
    shell: {
      openExternal: (url: string) => Promise<void>
    }
  }
}
