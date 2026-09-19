import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: () => import('../views/MarketplaceView.vue') },
    { path: '/marketplace', redirect: '/' },
    { path: '/items/:tokenId', component: () => import('../views/ItemDetailView.vue'), props: true }
  ]
})

export default router
