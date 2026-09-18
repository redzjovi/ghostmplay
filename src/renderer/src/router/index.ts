import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: HomeView },
    { path: '/marketplace', component: () => import('../views/MarketplaceView.vue') },
    { path: '/items/:tokenId', component: () => import('../views/ItemDetailView.vue'), props: true }
  ]
})

export default router
