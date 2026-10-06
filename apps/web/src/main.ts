import '@/assets/index.css'
// Side-effect import: applies the saved (or system) theme on import, before mount.
import '@/composables/useTheme'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { api } from './api/http-client'
import type { WebApi } from './api/http-client'

// The renderer still talks to `window.api`, but it is now backed by fetch against
// the same-origin /api routes instead of Electron IPC. This is the single seam
// that would need reimplementing if the UI framework ever changes.
;(window as unknown as { api: WebApi }).api = api

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
