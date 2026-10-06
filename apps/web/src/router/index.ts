import { createRouter, createWebHistory } from 'vue-router'
import type { RouteLocationNormalized } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior,
  routes: [
    { path: '/', redirect: '/marketplaces/list' },
    { path: '/marketplace', redirect: '/marketplaces/list' },
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
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
 * Gated routes carry `requiresAuth`; login carries `public` so it is
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

  // Already signed in and on the login page. Sends them somewhere useful rather
  // than back to login, which would be a navigation to the page they are on.
  if (to.name === 'login' && auth.isAuthenticated) {
    return { path: '/marketplaces/list', replace: true }
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

/**
 * The list views push a history entry for every committed filter or page change,
 * so without this Back would restore the URL but leave the window scrolled
 * wherever it happened to be.
 *
 * A pop restores the offset the browser saved. A push that lands on a different
 * page goes to the top, since the previous page's rows are gone. A push that only
 * changed filters, sort or page size keeps the current offset (`false`), because
 * the rows the user was looking at are still there.
 */
function scrollBehavior(
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
  savedPosition: { left: number; top: number } | null,
) {
  if (savedPosition) return savedPosition
  if (to.hash) return { el: to.hash }
  if (to.path === from.path && to.query.page === from.query.page) return false
  return { top: 0 }
}

export default router
