<template>
  <aside
    class="sticky top-0 flex h-screen shrink-0 flex-col border-r bg-card transition-all duration-300"
    :class="isCollapsed ? 'w-14' : 'w-14 md:w-60'"
  >
    <!-- One control for both directions, so the icon can never disagree with the
         action it performs. The collapsed padding and gap are tightened because the
         rail is 56px wide and would not otherwise fit the logo and the button. Both
         branches set the padding: a bare px-0 here would lose to md:px-5, which
         would bring the overflow back. -->
    <div class="flex items-center py-4" :class="isCollapsed ? 'gap-1 px-0' : 'gap-2 px-3 md:px-5'">
      <div class="flex flex-1 items-center gap-2" :class="isCollapsed && 'justify-center'">
        <Gamepad2 class="h-5 w-5 shrink-0 text-primary" />
        <span v-show="!isCollapsed" class="hidden truncate text-lg font-bold md:block">GhostMPlay</span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        class="hidden h-7 w-7 shrink-0 md:inline-flex"
        @click="toggle"
        :title="isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        :aria-label="isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
      >
        <PanelLeftOpen v-if="isCollapsed" class="h-4 w-4" />
        <PanelLeftClose v-else class="h-4 w-4" />
      </Button>
    </div>
    <nav class="flex flex-col gap-1 px-2 md:px-3">
      <!-- Marketplace group - always expanded submenu -->
      <div class="space-y-1">
        <div
          class="flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium md:px-3"
          :class="isMarketplace ? 'text-foreground' : 'text-muted-foreground'"
        >
          <Store class="h-4 w-4 shrink-0" />
          <span v-show="!isCollapsed" class="hidden truncate md:block">Marketplace</span>
        </div>
        <div class="flex flex-col gap-0.5" :class="isCollapsed ? 'items-center' : 'ml-2 md:ml-6 border-l pl-2'">
          <router-link
            to="/marketplaces/list"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            :class="isListActive ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground'"
            :title="isCollapsed ? 'List' : undefined"
          >
            <List class="h-3.5 w-3.5 shrink-0" />
            <span v-show="!isCollapsed" class="hidden truncate md:block">List</span>
          </router-link>
          <router-link
            to="/marketplaces/favorites"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            :class="isFavoriteActive ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground'"
            :title="isCollapsed ? 'Favorite' : undefined"
          >
            <Star class="h-3.5 w-3.5 shrink-0" />
            <span v-show="!isCollapsed" class="hidden truncate md:block">Favorite</span>
            <Badge v-if="!isCollapsed && favoriteCount>0" variant="secondary" class="ml-auto h-5 min-w-5 px-1 text-[10px] leading-none">{{ favoriteCount }}</Badge>
          </router-link>
          <span v-if="isCollapsed && favoriteCount>0" class="mt-0.5 text-[10px] font-medium text-muted-foreground">{{ favoriteCount }}</span>
        </div>
      </div>
      <!-- History group -->
      <div class="space-y-1 pt-2">
        <div
          class="flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium md:px-3"
          :class="isHistory ? 'text-foreground' : 'text-muted-foreground'"
        >
          <History class="h-4 w-4 shrink-0" />
          <span v-show="!isCollapsed" class="hidden truncate md:block">History</span>
        </div>
        <div class="flex flex-col gap-0.5" :class="isCollapsed ? 'items-center' : 'ml-2 md:ml-6 border-l pl-2'">
          <router-link
            to="/history/list"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            :class="isHistoryListActive ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground'"
            :title="isCollapsed ? 'List' : undefined"
          >
            <List class="h-3.5 w-3.5 shrink-0" />
            <span v-show="!isCollapsed" class="hidden truncate md:block">List</span>
          </router-link>
        </div>
      </div>
      <!-- Admin: scraper controls, which is why it is gated here. The server is the
           real boundary (AdminGuard on /api/admin/sync); hiding the link just keeps
           the nav honest about who can use it. -->
      <div class="pt-2">
        <router-link
          v-if="auth.isAdmin"
          to="/admin/data"
          class="flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground md:px-3"
          :class="isDataActive ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground'"
          :title="isCollapsed ? 'Data' : undefined"
        >
          <Database class="h-4 w-4 shrink-0" />
          <span v-show="!isCollapsed" class="hidden truncate md:block">Data</span>
        </router-link>
      </div>
    </nav>
    <div class="mt-auto flex items-center gap-2 p-2 md:p-3" :class="isCollapsed ? 'justify-center' : 'justify-between'">
      <div class="flex min-w-0 items-center gap-2">
        <ThemeToggle />
        <template v-if="!isCollapsed && auth.account">
          <div class="min-w-0 flex-1 truncate text-xs text-muted-foreground" :title="accountLabel">
            {{ accountLabel }}
            <span v-if="auth.isAdmin" class="ml-1 text-[10px] uppercase tracking-wide text-primary">admin</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            class="h-7 w-7 shrink-0"
            title="Sign out"
            aria-label="Sign out"
            @click="signOut"
          >
            <LogOut class="h-4 w-4" />
          </Button>
        </template>
        <!-- Browsing is public, so a guest needs a way in; `next` brings them back here.
             The label hides when collapsed, matching the rest of the sidebar, but the
             button itself must stay — otherwise a collapsed guest cannot sign in. -->
        <Button
          v-else
          variant="outline"
          size="sm"
          class="h-7 shrink-0 gap-1.5 px-2 text-xs"
          title="Sign in"
          aria-label="Sign in"
          @click="signIn"
        >
          <LogIn class="h-4 w-4" />
          <span v-show="!isCollapsed">Sign in</span>
        </Button>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Gamepad2, Store, PanelLeftClose, PanelLeftOpen, List, Star, History, Database, LogIn, LogOut } from 'lucide-vue-next'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useFavoritesStore } from '@/stores/favorites'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const isMarketplace = computed(() => route.path === '/' || route.path.startsWith('/marketplaces') || route.path.startsWith('/items'))
const isHistory = computed(() => route.path.startsWith('/history'))
const isHistoryListActive = computed(() => route.path === '/history/list' || (isHistory.value && !route.path.startsWith('/items')))
const isFavoriteActive = computed(() => {
  if (!isMarketplace.value) return false
  return route.path.startsWith('/marketplaces/favorites')
})
const isListActive = computed(() => route.path === '/marketplaces/list' || (isMarketplace.value && !isFavoriteActive.value && !route.path.startsWith('/items')))
const isDataActive = computed(() => route.path.startsWith('/admin'))

const favStore = useFavoritesStore()
const favoriteCount = computed(() => favStore.favorites.length)
/**
 * What to show as "who am I".
 *
 * Google is the only sign-in, so the verified address is the identifier and there is
 * no username to prefer over it. 'Account' only covers a theoretically email-less
 * session, which the ID token would not produce.
 */
const accountLabel = computed(() => auth.account?.email ?? 'Account')
onMounted(() => {
  // Favorites are per-account, so only fetch once we know who is signed in.
  if (auth.isAuthenticated) favStore.fetchFavorites().catch(() => {})
})

async function signOut() {
  await auth.logout()
  favStore.favorites = []
  await router.push({ name: 'login' })
}

function signIn() {
  return router.push({ name: 'login', query: { next: route.fullPath } })
}

const STORAGE_KEY = 'ghostmplay:sidebar:collapsed'
const isCollapsed = ref<boolean>(localStorage.getItem(STORAGE_KEY) === '1')

function toggle() {
  isCollapsed.value = !isCollapsed.value
}
watch(isCollapsed, (v) => {
  localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
})
</script>
