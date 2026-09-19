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
    sync: {
      refresh: (opts?: { itemName?: string; q?: string; mode?: 'all' | 'latest'; page?: number; limit?: number }) => Promise<{ synced: number }>
    }
    system: {
      ping: () => Promise<string>
    }
  }
}
