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
    { path: '/items/:tokenId', component: () => import('../views/ItemDetailView.vue'), props: true, meta: { public: true } },
    { path: '/admin/data', component: () => import('../views/DataView.vue'), meta: { requiresAdmin: true } }
  ]
})

/**
 * Browsing is public: the marketplace list, the history list and item detail are
 * all served by endpoints that take no account, so a signed-out visitor sees the
 * same data. Only per-account and admin surfaces need a session — favorites, and
 * the Data page (whose endpoints the server also rejects with 401/403).
 *
 * Gated routes carry `requiresAuth`; login/register carry `public` so they are
 * reachable at all. Note that `requiresAuth` is documentation only — the guard
 * fails closed on the *absence* of `public`, so a gated route needs no key to be
 * protected, only one to opt out of protection. `requiresAdmin` is read.
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

  if (to.meta.requiresAdmin) {
    if (auth.isAdmin) return true
    // Deliberately no `next` for someone already signed in. Sending them to
    // /login?next=/admin/data would loop: the guard rejects them again the
    // moment they re-authenticate, so they could never reach a page at all.
    return auth.isAuthenticated
      ? { path: '/marketplaces/list', replace: true }
      : { name: 'login', query: { next: to.fullPath }, replace: true }
  }

  if (to.meta.public || auth.isAuthenticated) return true

  return { name: 'login', query: { next: to.fullPath }, replace: true }
})

export default router
