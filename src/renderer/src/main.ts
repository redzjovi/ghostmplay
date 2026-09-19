import '@/assets/index.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'

// apply theme before mount to avoid FOUC (default light)
const savedTheme = localStorage.getItem('ghostmplay:theme') as 'light' | 'dark' | null
document.documentElement.classList.toggle('dark', savedTheme === 'dark')

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
