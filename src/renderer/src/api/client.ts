/** Typed renderer client — wraps window.api (IPC) for Vue */
export const api = {
  list: (q?: unknown) => window.api.marketplace.list(q as never),
  get: (tokenId: number) => window.api.marketplace.get(tokenId),
  sync: () => window.api.sync.refresh()
}
