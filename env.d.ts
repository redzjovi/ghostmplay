/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

interface Window {
  api: {
    marketplace: {
      list: (q?: import('./src/shared/types').MarketplaceListQuery) => Promise<{ data: import('./src/shared/types').MarketplaceItem[]; total: number }>
      get: (tokenId: number) => Promise<import('./src/shared/types').MarketplaceItemDetail | null>
    }
    sync: {
      refresh: (opts?: { page?: number; limit?: number }) => Promise<{ synced: number }>
    }
    system: {
      ping: () => Promise<string>
    }
  }
}
