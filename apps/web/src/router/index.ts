import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/marketplaces/list' },
    { path: '/marketplace', redirect: '/marketplaces/list' },
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    { path: '/register', name: 'register', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    { path: '/marketplaces/list', component: () => import('../views/MarketplaceView.vue') },
    { path: '/marketplaces/favorites', component: () => import('../views/MarketplaceView.vue') },
    { path: '/history/list', component: () => import('../views/HistoryView.vue') },
    { path: '/items/:tokenId', component: () => import('../views/ItemDetailView.vue'), props: true }
  ]
})

/**
 * Every page except login/register needs a session, because favorites are
 * per-account. The check runs once per page load (see auth.restore).
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  await auth.restore()

  if (to.meta.public) {
    return auth.isAuthenticated && (to.name === 'login' || to.name === 'register')
      ? { name: 'login', replace: true }
      : true
  }

  if (!auth.isAuthenticated) {
    return { name: 'login', query: { next: to.fullPath }, replace: true }
  }

  return true
})

export default router
