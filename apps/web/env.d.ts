/// <reference types="vite/client" />

declare global {
  declare module '*.vue' {
    import type { DefineComponent } from 'vue'
    const component: DefineComponent<object, object, unknown>
    export default component
  }

  interface Window {
    /**
     * Installed by src/main.ts. Typed from the HTTP client itself so the surface
     * can never drift from the implementation.
     */
    api: import('./src/api/http-client').WebApi
  }
}

export {}
