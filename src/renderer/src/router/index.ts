import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/marketplaces/list' },
    { path: '/marketplace', redirect: '/marketplaces/list' },
    { path: '/marketplaces/list', component: () => import('../views/MarketplaceView.vue') },
    { path: '/marketplaces/favorites', component: () => import('../views/MarketplaceView.vue') },
    { path: '/items/:tokenId', component: () => import('../views/ItemDetailView.vue'), props: true }
  ]
})

export default router
