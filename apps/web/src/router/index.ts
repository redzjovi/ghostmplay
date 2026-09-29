import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/marketplaces/list' },
    { path: '/marketplace', redirect: '/marketplaces/list' },
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    { path: '/register', name: 'register', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    { path: '/marketplaces/list', component: () => import('../views/MarketplaceView.vue'), meta: { public: true } },
    { path: '/marketplaces/favorites', component: () => import('../views/MarketplaceView.vue'), meta: { requiresAuth: true } },
    { path: '/history/list', component: () => import('../views/HistoryView.vue'), meta: { public: true } },
    { path: '/items/:tokenId', component: () => import('../views/ItemDetailView.vue'), props: true, meta: { public: true } }
  ]
})

/**
 * Browsing is public: the marketplace list, the history list and item detail are
 * all served by endpoints that take no account, so a signed-out visitor sees the
 * same data. Only per-account and admin surfaces need a session — favorites, and
 * the sync buttons (which the API also rejects with 401/403). Gated routes carry
 * `requiresAuth`; login/register carry `public` so they are reachable at all.
 *
 * The session check runs once per page load (see auth.restore), and `next` carries
 * the visitor back to the page they asked for after signing in.
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  await auth.restore()

  if ((to.name === 'login' || to.name === 'register') && auth.isAuthenticated) {
    return { name: 'login', replace: true }
  }

  if (to.meta.public || auth.isAuthenticated) return true

  return { name: 'login', query: { next: to.fullPath }, replace: true }
})

export default router
