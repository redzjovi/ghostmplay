/** Typed renderer client — wraps window.api (IPC) for Vue */
export const api = {
  list: (q?: unknown) => window.api.marketplace.list(q as never),
  get: (tokenId: number) => window.api.marketplace.get(tokenId),
  sync: () => window.api.sync.refresh(),
  history: {
    list: (q?: unknown) => window.api.history.list(q as never),
    sync: (opts?: { mode?: 'full' | 'latest'; limit?: number }) => window.api.history.sync(opts),
    filters: () => window.api.history.filters()
  }
}
